#!/usr/bin/env node
/**
 * TIPSTER scheduled learning worker. Runs in GitHub Actions with write-scoped
 * GITHUB_TOKEN; the repository's monthly JSON ledgers survive Render restarts.
 *
 * Workflow order: fetch pre-match forecasts -> settle only verified finals ->
 * recompute retrospective metrics and next-period calibrators -> commit changes.
 */
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {archivePrediction,settlePrediction,fitCalibration} from '../learning.mjs';
const ROOT=resolve(import.meta.dirname,'..');
const DIR=join(ROOT,'data','ledger');
const LIVE=process.env.TIPSTER_ORIGIN||'https://tipster-football.onrender.com';
const now=new Date(),nowISO=now.toISOString();
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const fetchJSON=async(url,timeout=9000)=>{
 const res=await fetch(url,{signal:AbortSignal.timeout(timeout),headers:{accept:'application/json','user-agent':'tipster-learning-worker/1'}});
 if(!res.ok)throw Error('HTTP '+res.status+' at '+new URL(url).hostname);
 const text=await res.text();
 if(text.length>15000000)throw Error('Unexpected oversized response');
 return JSON.parse(text);
};
const isoDate=s=>new Date(s).toISOString().slice(0,10);
async function readArchive(){
 await mkdir(DIR,{recursive:true});
 const files=(await readdir(DIR)).filter(f=>/^\d{4}-\d{2}\.json$/.test(f));
 const all=[];
 for(const file of files){
  let rows;
  try{rows=JSON.parse(await readFile(join(DIR,file),'utf8'));}catch(e){throw Error('Corrupt ledger '+file+': '+e.message)}
  if(!Array.isArray(rows))throw Error('Invalid ledger '+file);
  all.push(...rows);
 }
 return all;
}
function finalESPN(json){
 const competition=json.header?.competitions?.[0]||json.competitions?.[0];
 const competitors=competition?.competitors||[];
 const home=competitors.find(x=>x.homeAway==='home'),away=competitors.find(x=>x.homeAway==='away');
 const status=competition?.status?.type||json.status?.type||{};
 const score=x=>{
  const raw=x?.score?.value??x?.score?.displayValue??x?.score;
  const n=Number(raw);
  return raw!==null&&raw!==undefined&&raw!==''&&Number.isInteger(n)?n:null;
 };
 const hs=score(home),as=score(away);
 const completed=Boolean(status.completed||status.state==='post'||/final|full.time|ft/i.test(status.name||''));
 return {completed,home:hs,away:as};
}
function finalOpenLiga(json){
 const r=Array.isArray(json)?json[0]:json;
 if(!r?.matchIsFinished)return {completed:false};
 const result=(r.matchResults||[]).find(x=>x.resultTypeID===2)||(r.matchResults||[]).slice(-1)[0];
 return {completed:true,home:result?.pointsTeam1,away:result?.pointsTeam2};
}
function finalSportsDB(json){
 const r=json.events?.[0];
 if(!r)return {completed:false};
 const complete=/match finished|full time|^ft$|^aet$/i.test(r.strStatus||'');
 return {completed:complete,home:r.intHomeScore,away:r.intAwayScore};
}
const doneAt=x=>Date.parse(x.kickoff)+105*60000<=now.getTime();
async function settleViaSource(r){
 const id=r.matchId||'';
 try{
  if(id.startsWith('espn:')){
   const parts=id.split(':'),league=parts[1],game=parts[2];
   if(!/^[a-z0-9.]+$/i.test(league)||!/^\d+$/.test(game))return null;
   const endpoint='https://site.api.espn.com/apis/site/v2/sports/soccer/'+league;
   let data=await fetchJSON(endpoint+'/summary?event='+game,11500);
   let result=finalESPN(data);
   if(!result.completed){
    // Some competitions publish final status in daily scoreboards only.
    const day=isoDate(r.kickoff).replaceAll('-','');
    data=await fetchJSON(endpoint+'/scoreboard?dates='+day+'&limit=200',9500);
    const ev=(data.events||[]).find(x=>String(x.id)===game);
    if(ev)result=finalESPN(ev);
   }
   return result.completed?{...result,source:'ESPN verified final • event '+game}:null;
  }
  if(id.startsWith('openliga:')){
   const matchId=id.split(':')[1];
   if(!/^\d+$/.test(matchId))return null;
   const data=await fetchJSON('https://api.openligadb.de/getmatchdata/'+matchId,10000);
   const result=finalOpenLiga(data);
   return result.completed?{...result,source:'OpenLigaDB verified final • match '+matchId}:null;
  }
  if(id.startsWith('sportsdb:')){
   const matchId=id.split(':')[1];
   if(!/^\d+$/.test(matchId))return null;
   const data=await fetchJSON('https://www.thesportsdb.com/api/v1/json/123/lookupevent.php?id='+matchId,9000);
   const result=finalSportsDB(data);
   return result.completed?{...result,source:'TheSportsDB verified final • event '+matchId}:null;
  }
 }catch(e){console.warn('Outcome not yet verified',id,e.message);}
 return null;
}
async function inBatches(arr,size,handler){
 for(let i=0;i<arr.length;i+=size)await Promise.all(arr.slice(i,i+size).map(handler));
}
async function run(){
 const all=await readArchive();
 const before=all.length,nowEpoch=Date.now();
 const dedup=new Map(all.map(r=>[r.key,r]));
 if(dedup.size!==all.length)throw Error('Duplicate permanent forecast keys');
 // Never archive predictions observed after kickoff, even if the remote cache
 // contains earlier fixture data.
 let incoming=0,added=0,revised=0,feedOK=false;
 try{
  const x=await fetchJSON(LIVE.replace(/\/$/,'')+'/api/matches',80000);
  if(!Array.isArray(x.matches))throw Error('Live service returned invalid fixtures');
  feedOK=true;incoming=x.matches.length;
  for(const m of x.matches){
   const key=m.leagueId+'|'+m.id;
   const existed=dedup.has(key);
   const target=existed?dedup.get(key):null;
   if(archivePrediction(all,m,nowISO,'elo-v2+calibration-v1')){
    if(!existed){added++;dedup.set(key,all[all.length-1]);}else revised++;
   }
  }
 }catch(e){console.error('Live forecasts unavailable; preserving historical records:',e.message);}
 let settled=0,checked=0;
 const eligible=all.filter(r=>!r.result&&doneAt(r)&&Date.parse(r.kickoff)>nowEpoch-16*86400000)
  .sort((a,b)=>Date.parse(a.kickoff)-Date.parse(b.kickoff)).slice(0,85);
 await inBatches(eligible,6,async r=>{
  checked++;
  const final=await settleViaSource(r);
  if(final&&settlePrediction(r,final,nowISO,final.source))settled++;
 });
 // Entries that failed in earlier runs stay unresolved rather than gaining
 // fabricated wins/losses. Manual audits can reconcile very old entries.
 const calibration=fitCalibration(all,nowISO);
 const byMonth=new Map();
 for(const r of all){
  const month=isoDate(r.kickoff).slice(0,7);
  if(!byMonth.has(month))byMonth.set(month,[]);
  byMonth.get(month).push(r);
 }
 for(const [month,records] of byMonth){
  records.sort((a,b)=>a.kickoff.localeCompare(b.kickoff)||a.key.localeCompare(b.key));
  await writeFile(join(DIR,month+'.json'),JSON.stringify(records,null,2)+'\n');
 }
 await writeFile(join(ROOT,'data','calibration.json'),JSON.stringify(calibration,null,2)+'\n');
 console.log('TIPSTER LEARNING',JSON.stringify({at:nowISO,feedOK,incoming,added,revised,checked,settled,
  archived:all.length,evaluated:calibration.performance.evaluated,brier:calibration.performance.brier,
  accuracy:calibration.performance.accuracy,temperature:calibration.global.temperature,
  heldOutImprovements:calibration.global.improvement,leagueModels:Object.keys(calibration.leagues).length}));
 if(!feedOK&&!all.length)throw Error('No forecasts were archived because live source failed');
}
await run();
