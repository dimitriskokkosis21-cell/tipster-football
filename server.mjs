import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {calculateMatchV2,validXg} from './model-v2.mjs';
import {extractESPNxG,espnAvailability,mergeLicensedMatchData} from './features.mjs';
import {loadLaLiga} from './laliga.mjs';
import {optionalLaLigaSources,matchStrikerXG,matchAPIFootballReports} from './data-sources.mjs';
import {applyTemperature,selectCalibration,LEARNING_VERSION} from './learning.mjs';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('.',import.meta.url));

try{
 const tests=execFileSync(process.execPath,['--test'],{cwd:ROOT,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 console.log('TIPSTER V2 SELF-TEST',tests.match(/# (?:tests|pass|fail) \d+/g)?.join(' | ')||tests.slice(-250));
}catch(e){console.error('TIPSTER V2 SELF-TEST FAILED:',String(e.stdout||e.stderr||e.message).slice(0,3000));process.exit(1);}
const PORT=Number(process.env.PORT||3000);
const ESPN='https://site.api.espn.com/apis/site/v2/sports/soccer/';
const SDB='https://www.thesportsdb.com/api/v1/json/123/';
const LEAGUES=[
 ['uefa.champions','Champions League',4480],['uefa.europa','Europa League',4481],
 ['uefa.europa.conf','Conference League',5071],['eng.1','Premier League',4328],
 ['esp.1','La Liga',4335],['ita.1','Serie A',4332],
 ['ger.1','Bundesliga',4331],['fra.1','Ligue 1',4334],
 ['gre.1','Greek Super League',4336],['uefa.nations','Nations League',4490],
 ['uefa.wchampions',"Women's Champions League",4889]
].map(a=>({id:a[0],name:a[1],sdb:a[2]}));
const cache=new Map();let lastSuccessful=null;
const LEARNING_URL=process.env.TIPSTER_CALIBRATION_URL||
 'https://raw.githubusercontent.com/dimitriskokkosis21-cell/tipster-football/main/data/calibration.json';
let learnedCache={until:0,value:null};
async function getLearningReport(force=false){
 if(!force&&learnedCache.value&&learnedCache.until>Date.now())return learnedCache.value;
 try{
  const url=new URL(LEARNING_URL);
  if(url.protocol!=='https:')throw Error('Calibration must use HTTPS');
  const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(3300)});
  if(!response.ok)throw Error('HTTP '+response.status);
  const text=await response.text();
  if(text.length>300000)throw Error('Calibration exceeds size limit');
  const document=JSON.parse(text);
  if(document.version!==LEARNING_VERSION||!document.performance||!document.global)throw Error('Unexpected calibration version');
  learnedCache={until:Date.now()+10*60000,value:document};return document;
 }catch(e){
  console.warn('TIPSTER LEARNING REPORT UNAVAILABLE',e.message);
  learnedCache.until=Date.now()+2*60000;
  return learnedCache.value;
 }
}
function calibratedMatchModel(model,leagueId,learning){
 const raw=Object.fromEntries(Object.entries(model.probabilities));
 const chosen=selectCalibration(learning,leagueId);
 const probs=applyTemperature(raw,chosen.temperature);
 const fair=Object.fromEntries(Object.entries(probs).map(([k,p])=>[k,1/p]));
 const minimum=Object.fromEntries(Object.entries(probs).map(([k,p])=>[k,1.05/Math.max(.005,p-(model.uncertaintyPenalty||.05))]));
 const prediction=Object.keys(probs).sort((a,b)=>probs[b]-probs[a])[0];
 return {...model,rawProbabilities:raw,probabilities:probs,fairOdds:fair,requiredOdds:minimum,prediction,
  modelVersion:'elo-opponent-poisson-v2',calibration:{...chosen,calibrationVersion:learning?.version||null,updatedAt:learning?.updatedAt||null}};
}

const dadd=(day,offset)=>new Date(Date.parse(day+'T12:00:00Z')+86400000*offset).toISOString().slice(0,10);
function athens(d=new Date()){
 const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
 const t=Object.fromEntries(p.map(x=>[x.type,x.value]));return t.year+'-'+t.month+'-'+t.day;
}
const compact=s=>s.replaceAll('-','');
const valid=s=>s && !Number.isNaN(Date.parse(s));
function json(res,status,obj){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify(obj));}
const pendingRemote=new Map();
async function remote(url,ms=600000,force=false,timeoutMs=9500){
 const old=cache.get(url);
 if(!force&&old&&old.until>Date.now())return old.body;
 // Prevent parallel browser refreshes and startup warming from repeatedly
 // downloading the same large provider response.
 if(pendingRemote.has(url))return pendingRemote.get(url);
 const promise=(async()=>{
  try{
   const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
   if(!r.ok)throw Error('HTTP '+r.status);
   const t=await r.text();
   if(t.length>18000000)throw Error('provider oversized response');
   const v=JSON.parse(t);cache.set(url,{body:v,until:Date.now()+ms});return v;
  }catch(e){if(old?.body)return old.body;throw Error(new URL(url).hostname+': '+e.message);}
 })();
 pendingRemote.set(url,promise);
 try{return await promise;}finally{if(pendingRemote.get(url)===promise)pendingRemote.delete(url);}
}
function fromESPN(e,l){
 const c=e.competitions?.[0],t=c?.competitors||[];
 const h=t.find(x=>x.homeAway==='home'),a=t.find(x=>x.homeAway==='away');
 if(!h?.team?.displayName||!a?.team?.displayName||!valid(e.date))return null;
 const st=c?.status?.type||e.status?.type||{};
 const done=Boolean(st.completed),hs=h.score===undefined||h.score===null?null:Number(h.score),as=a.score===undefined||a.score===null?null:Number(a.score);
 return {id:'espn:'+l.id+':'+e.id,leagueId:l.id,league:l.name,date:new Date(e.date).toISOString(),
  homeName:h.team.displayName,awayName:a.team.displayName,homeId:String(h.team.id||h.team.displayName),
  awayId:String(a.team.id||a.team.displayName),homeLogo:h.team.logo||null,awayLogo:a.team.logo||null,
  homeScore:hs,awayScore:as,complete:done&&Number.isFinite(hs)&&Number.isFinite(as),
  status:done?'FINAL':st.state==='in'?'LIVE':'SCHEDULED',
  ...extractESPNxG(c),source:'ESPN (unofficial)',sourceUrl:'https://www.espn.com/soccer/match/_/gameId/'+e.id};
}
function fromSDB(e,l){
 if(!e.strHomeTeam||!e.strAwayTeam)return null;
 const ds=e.strTimestamp||(e.dateEvent+'T'+(e.strTime||'00:00:00')+'Z');
 if(!valid(ds))return null;const hs=e.intHomeScore==null?null:Number(e.intHomeScore),as=e.intAwayScore==null?null:Number(e.intAwayScore);
 const complete=Number.isFinite(hs)&&Number.isFinite(as)&&(e.strStatus==='Match Finished'||e.strStatus==='FT'||e.strStatus==='AET'||(new Date(ds)<new Date(Date.now()-3*3600000)));
 return {id:'sportsdb:'+e.idEvent,leagueId:l.id,league:l.name,date:new Date(ds).toISOString(),homeName:e.strHomeTeam,awayName:e.strAwayTeam,
  homeId:String(e.idHomeTeam||e.strHomeTeam),awayId:String(e.idAwayTeam||e.strAwayTeam),
  homeLogo:e.strHomeTeamBadge||null,awayLogo:e.strAwayTeamBadge||null,
  homeScore:hs,awayScore:as,complete,status:complete?'FINAL':'SCHEDULED',
  source:'TheSportsDB (restricted free coverage)',sourceUrl:'https://www.thesportsdb.com/event/'+e.idEvent};
}
function fromOpen(e,l){
 if(!e.team1?.teamName||!e.team2?.teamName||!valid(e.matchDateTimeUTC))return null;
 const t=(e.matchResults||[]).find(x=>x.resultTypeID===2)||(e.matchResults||[]).slice(-1)[0];
 const hs=e.matchIsFinished?Number(t?.pointsTeam1):null,as=e.matchIsFinished?Number(t?.pointsTeam2):null;
 return {id:'openliga:'+e.matchID,leagueId:l.id,league:l.name,date:new Date(e.matchDateTimeUTC).toISOString(),
  homeName:e.team1.teamName,awayName:e.team2.teamName,
  homeId:String(e.team1.teamId),awayId:String(e.team2.teamId),
  homeLogo:e.team1.teamIconUrl||null,awayLogo:e.team2.teamIconUrl||null,
  homeScore:hs,awayScore:as,complete:!!e.matchIsFinished&&Number.isFinite(hs)&&Number.isFinite(as),status:e.matchIsFinished?'FINAL':'SCHEDULED',
  source:'OpenLigaDB (ODbL)',sourceUrl:'https://www.openligadb.de/'};
}
function unique(arr){
 const seen=new Set();
 return arr.filter(x=>{if(!x)return false;const k=x.leagueId+'|'+x.date.slice(0,10)+'|'+x.homeName.toLowerCase()+'|'+x.awayName.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>a.date.localeCompare(b.date));
}
async function leagueFetch(l,today,end,force){
 let fixtures=[],history=[],provider='',warning=null;
 const past=dadd(today,-420),last=dadd(today,-1);
 if(l.id==='esp.1'){
  try{
   return await loadLaLiga(l,today,end,force,{remote,fromESPN,fromOpen,athens,dadd,cache,ESPN});
  }catch(e){console.warn('TIPSTER LALIGA MULTI-SOURCE FAILED',String(e.message));warning='LaLiga dual-provider fallback failed: '+e.message;}
 }

 if(l.id==='ger.1'){
  try{
   const season=y=>Number(y.slice(0,4))-(Number(y.slice(5,7))<7?1:0);
   const currentYear=season(today);
   const current=await remote('https://api.openligadb.de/getmatchdata/bl1/'+currentYear,21600000,force,11000);
   const olderYears=[...new Set([season(end),season(past)])].filter(y=>y!==currentYear);
   let seasonData=Array.isArray(current)?current:[];
   for(const year of olderYears){
    const url='https://api.openligadb.de/getmatchdata/bl1/'+year;
    const old=cache.get(url)?.body;
    if(Array.isArray(old))seasonData=seasonData.concat(old);
    else void remote(url,86400000,false,9000).catch(()=>{});
   }
   const all=unique(seasonData.map(e=>fromOpen(e,l)));
   fixtures=all.filter(x=>!x.complete&&athens(new Date(x.date))>=today&&athens(new Date(x.date))<=end);
   history=all.filter(x=>x.complete&&athens(new Date(x.date))>=past&&athens(new Date(x.date))<today);
   provider='OpenLigaDB (ODbL)';
   return {fixtures,history,report:{league:l.name,provider,fixtures:fixtures.length,history:history.length,warning:null}};
  }catch(e){warning='OpenLigaDB unavailable: '+e.message;}
 }
 try{
  if(process.env.DISABLE_UNOFFICIAL_ESPN==='1')throw Error('ESPN disabled');
  // ESPN retired dashed date ranges in September 2026 (HTTP 400).
  // A year-scoped scoreboard query works and covers both recent completed results
  // and scheduled fixtures. Filter all returned events against the Athens calendar.
  // Prioritize the current year's fixture query. The older archive is
  // supplementary and must never cause current fixtures to disappear.
  const currentYears=[...new Set([today.slice(0,4),end.slice(0,4)])];
  const currentResponses=await Promise.allSettled(currentYears.map(year=>
   remote(ESPN+l.id+'/scoreboard?dates='+year+'&limit=1000',21600000,force,11500)));
  const currentGood=currentResponses.filter(r=>r.status==='fulfilled'&&Array.isArray(r.value?.events));
  if(!currentGood.length)throw Error(currentResponses.map(r=>r.reason?.message||'scoreboard unavailable').join('; '));
  const currentEvents=new Map();
  for(const r of currentGood)for(const e of r.value.events)if(e.id!=null)currentEvents.set(String(e.id),e);
  const currentData=[...currentEvents.values()].map(e=>fromESPN(e,l)).filter(Boolean);
  fixtures=currentData.filter(x=>!x.complete&&athens(new Date(x.date))>=today&&athens(new Date(x.date))<=end);
  let all=currentData;
  const olderYears=[past.slice(0,4)].filter(y=>!currentYears.includes(y));
  for(const year of olderYears){
   const url=ESPN+l.id+'/scoreboard?dates='+year+'&limit=1000';
   const archived=cache.get(url)?.body;
   if(Array.isArray(archived?.events))all.push(...archived.events.map(e=>fromESPN(e,l)).filter(Boolean));
   // Older seasons are enrichment, NEVER an on-demand fixture blocker.
   else void remote(url,86400000,false,11500).catch(()=>{});
  }
  history=unique(all).filter(x=>x.complete&&athens(new Date(x.date))>=past&&athens(new Date(x.date))<today);
  if(currentGood.length<currentYears.length)warning=(warning?warning+'; ':'')+'Some current-year requests failed';
  if(currentGood.some(r=>r.value.events.length>=1000))warning=(warning?warning+'; ':'')+'Event pagination limit reached';
  provider='ESPN (unofficial)';
  // Injury data enriches a second refresh; it cannot hold up all fixtures.
  const injuryUrl=ESPN+l.id+'/injuries';
  const injuries=cache.get(injuryUrl)?.body||null;
  if(!injuries)void remote(injuryUrl,7200000,false,5500).catch(()=>{});
  if(!history.length)warning=(warning?warning+'; ':'')+'No historical results; league priors only';
  return {fixtures,history,injuries,report:{league:l.name,provider,fixtures:fixtures.length,history:history.length,warning}};
 }catch(e){warning=(warning?warning+'; ':'')+'ESPN failed: '+e.message;}
 try{
  const a=await Promise.allSettled([remote(SDB+'eventsnextleague.php?id='+l.sdb,600000,force,5500),remote(SDB+'eventspastleague.php?id='+l.sdb,21600000,force,5500)]);
  if(a[0].status==='fulfilled')fixtures=(a[0].value.events||[]).map(x=>fromSDB(x,l)).filter(x=>x&&!x.complete&&athens(new Date(x.date))>=today&&athens(new Date(x.date))<=end);
  if(a[1].status==='fulfilled')history=(a[1].value.events||[]).map(x=>fromSDB(x,l)).filter(x=>x&&x.complete);
  if(a.every(x=>x.status==='rejected'))throw Error('both free-tier calls failed');
  provider='TheSportsDB (limited coverage)';
  warning+='; free tier returns only limited events and does not guarantee all fixtures';
 }catch(e){provider='UNAVAILABLE';warning+='; TheSportsDB failed: '+e.message;}
 return {fixtures,history,report:{league:l.name,provider,fixtures:fixtures.length,history:history.length,warning}};
}
let inFlightBuild=null;
async function buildAllMatches(force=false){
 const now=Date.now(),today=athens(),end=dadd(today,7);
 // Only one complete provider sweep may run at a time, even if Render receives
 // simultaneous requests from multiple Safari tabs or startup warmup.
 if(!force&&lastSuccessful&&lastSuccessful.expires>now&&lastSuccessful.date===today)return lastSuccessful.data;
 const reports=await Promise.all(LEAGUES.map(async l=>{try{return await leagueFetch(l,today,end,force)}catch(e){return {fixtures:[],history:[],report:{league:l.name,provider:'UNAVAILABLE',fixtures:0,history:0,warning:String(e)}}}}));
 const fixtures=unique(reports.flatMap(r=>r.fixtures)).filter(r=>new Date(r.date)>new Date()&&athens(new Date(r.date))>=today&&athens(new Date(r.date))<=end);
 const history=unique(reports.flatMap(r=>r.history)).filter(x=>x.complete);

 // Optional licensed private data feed: matching must be anchored by competition,
 // kickoff, home and away identity and explicit data-source provenance.
 let licensed=null;
 if(process.env.TIPSTER_DATA_FEED_URL){
  try{
   const url=new URL(process.env.TIPSTER_DATA_FEED_URL);
   if(url.protocol!=='https:')throw Error('Feed URL must use HTTPS');
   const headers={accept:'application/json'};
   if(process.env.TIPSTER_DATA_FEED_TOKEN)headers.authorization='Bearer '+process.env.TIPSTER_DATA_FEED_TOKEN;
   const response=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
   if(!response.ok)throw Error('HTTP '+response.status);
   const raw=await response.text();if(raw.length>4000000)throw Error('Feed too large');
   licensed=JSON.parse(raw);
   if(!Array.isArray(licensed?.matches)||!licensed?.source)throw Error('Invalid feed provenance or matches');
  }catch(e){console.log('TIPSTER OPTIONAL ENRICHMENT UNAVAILABLE:',e.message);licensed=null;}
 }
 const learning=await getLearningReport(false);
 const eligibleRecords=licensed?.matches||[];
 const findLicensed=(m)=>eligibleRecords.find(r=>
  String(r.leagueId)===String(m.leagueId)&&
  String(r.homeName||'').toLowerCase()===String(m.homeName||'').toLowerCase()&&
  String(r.awayName||'').toLowerCase()===String(m.awayName||'').toLowerCase()&&
  Math.abs(Date.parse(r.date)-Date.parse(m.date))<=7200000);
 // Historical xG is accepted ONLY when the feed includes explicit scores, time,
 // identity, two numeric xG values and a named originating source.
 if(Array.isArray(licensed?.history)&&licensed?.source){
  for(const record of licensed.history){
   if(!record?.source||!record?.observedAt||validXg(record.homeXg)===null||validXg(record.awayXg)===null)continue;
   const matched=history.find(h=>h.leagueId===record.leagueId&&
    String(h.homeName).toLowerCase()===String(record.homeName).toLowerCase()&&
    String(h.awayName).toLowerCase()===String(record.awayName).toLowerCase()&&
    Math.abs(Date.parse(h.date)-Date.parse(record.date))<7200000);
   if(matched){matched.homeXg=validXg(record.homeXg);matched.awayXg=validXg(record.awayXg);matched.xgSource=record.source;}
  }
 }
 const supplemental=await optionalLaLigaSources(today,end);
 const leagueInjuries=new Map(reports.map((r,i)=>[LEAGUES[i].id,r.injuries]));
 const matches=fixtures.map(m=>{
  const base=espnAvailability(leagueInjuries.get(m.leagueId),m);
  const rich=findLicensed(m);
  const custom=rich?mergeLicensedMatchData(m,rich):null;
  const avail=custom??base;
  if(m.leagueId==='esp.1'){
   const report=matchAPIFootballReports(m,supplemental.injuries);
   if(report){
    avail.injuries=report.injuries;
    avail.suspensions=report.suspensions;
   }
   const xgSeason=matchStrikerXG(m,supplemental.xg);
   if(xgSeason)avail.xgSeason=xgSeason;
  }
  const baseModel=calculateMatchV2(m,history,avail);
  return {...m,model:calibratedMatchModel(baseModel,m.leagueId,learning)};
 });
 const sourceStatus=reports.map(r=>r.report);
 const data={matches,meta:{updatedAt:new Date().toISOString(),today,end,timezone:'Europe/Athens',historyMatches:history.length,
  learning:{version:learning?.version||LEARNING_VERSION,updatedAt:learning?.updatedAt||null,
   performance:learning?.performance||null,globalCalibration:learning?.global||null,
   leagueCalibrations:learning?.leagues||{}},
  featureSources:{strikerXgConfigured:supplemental.enabled.striker,apiFootballInjuriesConfigured:supplemental.enabled.apiFootball,xgCoverage:matches.filter(m=>m.model?.xgSource).length,injuriesCoverage:matches.filter(m=>m.model?.availability?.injuries?.verified).length,warnings:supplemental.warnings},
  sourceStatus,coverageIncomplete:sourceStatus.some(s=>s.provider==='UNAVAILABLE'||s.provider.includes('limited')||s.warning),
  notice:'ESPN endpoints are unofficial and may change. xG, injuries, suspensions and projected XIs are included only if verified by named sources; otherwise they are explicitly unavailable. Probabilities are not independently calibrated.'}};
 if(sourceStatus.every(s=>s.provider==='UNAVAILABLE')&&!lastSuccessful)throw Error('All football data sources are currently unavailable. Retry later.');
 if(sourceStatus.some(s=>s.provider!=='UNAVAILABLE'))lastSuccessful={data,expires:now+5*60000,date:today};
 console.log('TIPSTER LALIGA FIXTURE AUDIT',JSON.stringify(matches.filter(m=>m.leagueId==='esp.1').map(m=>({date:m.date,home:m.homeName,away:m.awayName,source:m.source}))));
 const caseStudy=matches.filter(m=>/kifisia/i.test(m.homeName+' '+m.awayName)&&/olymp/i.test(m.homeName+' '+m.awayName));
 if(caseStudy.length)console.log('TIPSTER KIFISIA / OLYMPIACOS V2 CHECK',JSON.stringify(caseStudy.map(x=>({match:x.homeName+' vs '+x.awayName,probabilities:x.model.probabilities,xgSource:x.model.verifiedXgMatches,homeElo:x.model.eloHome,awayElo:x.model.eloAway,lambdaHome:x.model.lambdaHome,lambdaAway:x.model.lambdaAway}))));
 if(!matches.length&&sourceStatus.every(s=>s.provider==='UNAVAILABLE')&&lastSuccessful)return lastSuccessful.data;
 return data;
}
// Fast stale-while-revalidate for a same-day, verified match snapshot.
async function fetchAll(force=false){
 const now=Date.now(),today=athens();
 if(!force&&lastSuccessful?.date===today&&lastSuccessful.expires>now)return lastSuccessful.data;
 if(inFlightBuild){
  if(!force&&lastSuccessful?.date===today)return lastSuccessful.data;
  return inFlightBuild;
 }
 const job=buildAllMatches(force);
 inFlightBuild=job;
 void job.catch(e=>console.error('TIPSTER PROVIDER SWEEP FAILED',e.message)).finally(()=>{
  if(inFlightBuild===job)inFlightBuild=null;
 });
 if(!force&&lastSuccessful?.date===today)return lastSuccessful.data;
 return job;
}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/health')return json(res,200,{ok:true,app:'TIPSTER',time:new Date().toISOString()});
  if(url.pathname==='/api/performance')return json(res,200,{available:!!(await getLearningReport(false)),calibration:await getLearningReport(false)});
  if(url.pathname==='/api/status')return json(res,200,{ok:true,loading:!!inFlightBuild,cached:!!lastSuccessful,cacheDate:lastSuccessful?.date||null,cacheUpdatedAt:lastSuccessful?.data?.meta?.updatedAt||null,fixtureCount:lastSuccessful?.data?.matches?.length||0});
  if(url.pathname==='/api/matches'){
   const start=Date.now();
   try{
    const result=await fetchAll(url.searchParams.get('refresh')==='1');
    console.log('TIPSTER HTTP fixtures',JSON.stringify({count:result.matches.length,elapsedMs:Date.now()-start,at:new Date().toISOString()}));
    return json(res,200,result);
   }catch(e){
    console.error('TIPSTER HTTP fixtures failed',JSON.stringify({elapsedMs:Date.now()-start,error:String(e?.message||e)}));
    return json(res,503,{error:e.message,retryable:true,at:new Date().toISOString()});
   }
  }
  if(url.pathname.startsWith('/api/'))return json(res,404,{error:'Not found'});
  const path=url.pathname==='/'?'/index.html':url.pathname;
  if(!/^\/[a-zA-Z0-9_./-]+$/.test(path)||path.includes('..'))return json(res,400,{error:'Invalid path'});
  const target=resolve(ROOT,'public','.'+path),base=resolve(ROOT,'public');
  if(target!==base&&!target.startsWith(base+sep))return json(res,403,{error:'Forbidden'});
  try{const body=await readFile(target);res.writeHead(200,{'content-type':MIME[extname(target)]||'application/octet-stream','cache-control':extname(target)==='.html'?'no-store':'public, max-age=300'});res.end(body);}
  catch{json(res,404,{error:'Not found'});}
 }catch(e){json(res,500,{error:'Unexpected server error'});}
}).listen(PORT,'0.0.0.0',()=>console.log('TIPSTER serving on '+PORT));


// Non-blocking production verification: logs real provider coverage, never invents data.
setTimeout(async()=>{
 try{
  const result=await fetchAll(false);
  const stats={fixtures:result.matches.length,historicalResults:result.meta.historyMatches,
   leagues:result.meta.sourceStatus.map(s=>({name:s.league,provider:s.provider,fixtures:s.fixtures,history:s.history,warning:s.warning?.slice(0,110)}))};
  let errors=0;
  for(const match of result.matches){
   const p=match.model.probabilities,f=match.model.fairOdds;
   const sum=p['1']+p.X+p['2'];
   if(!Number.isFinite(sum)||Math.abs(sum-1)>1e-9||Object.keys(p).some(k=>Math.abs(f[k]*p[k]-1)>1e-8)){errors++;}
  }
  console.log('TIPSTER LIVE DATA DIAGNOSTIC',JSON.stringify({fixtures:stats.fixtures,historicalResults:stats.historicalResults,leagues:stats.leagues,modelValidationErrors:errors,settledForecasts:result.meta.learning?.performance?.evaluated||0}));
 }catch(e){console.error('TIPSTER LIVE DATA DIAGNOSTIC FAILED:',e.message);}
},1100);
