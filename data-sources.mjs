/**
 * Licensed optional LaLiga enrichments. Credentials are kept server-side.
 * No provider return means "unknown", never zero injured players or zero xG.
 * Providers use their documented APIs; no scraping.
 */
import {canonicalSpanishTeam} from './laliga.mjs';
const valid=x=>x!==undefined&&x!==null&&x!==''&&Number.isFinite(Number(x))&&Number(x)>=0&&Number(x)<=8?Number(x):null;
const recordsCache=new Map();
const unaccent=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
export function parseStrikerXG(data){
 const result=data?.data??data;
 if(!Array.isArray(result?.teams))return null;
 const teams=new Map();
 for(const row of result.teams){
  const key=canonicalSpanishTeam(row.display_name||row.team||row.name);
  const xgFor=valid(row.xg_for),xgAgainst=valid(row.xg_against);
  if(!key||xgFor===null||xgAgainst===null||Number(row.games||0)<3)continue;
  teams.set(key,{xgFor,xgAgainst,games:Number(row.games),name:row.display_name});
 }
 if(teams.size<4)return null;
 const avgFor=[...teams.values()].reduce((s,x)=>s+x.xgFor,0)/teams.size;
 const avgAgainst=[...teams.values()].reduce((s,x)=>s+x.xgAgainst,0)/teams.size;
 return {teams,avgFor,avgAgainst,source:'StrikerAPI • own shot-location xG model'};
}
export function matchStrikerXG(match,season){
 if(!season)return null;
 const h=season.teams.get(canonicalSpanishTeam(match.homeName)),a=season.teams.get(canonicalSpanishTeam(match.awayName));
 if(!h||!a)return null;
 return {verified:true,source:season.source,home:h,away:a,leagueAvgXgFor:season.avgFor,leagueAvgXgAgainst:season.avgAgainst};
}
export function parseAPIFootballReports(fixtures,injuries,source='API-Football'){
 const games=Array.isArray(fixtures?.response)?fixtures.response:[];
 const issues=Array.isArray(injuries?.response)?injuries.response:[];
 const byGame=new Map();
 const canon=canonicalSpanishTeam;
 for(const game of games){
  const id=game?.fixture?.id;
  if(id==null)continue;
  const home=canon(game.teams?.home?.name),away=canon(game.teams?.away?.name),date=game.fixture?.date;
  if(!home||!away||!date)continue;
  byGame.set(String(id),{id:String(id),home,away,date});
 }
 const groups=new Map();
 for(const row of issues){
  const fid=String(row?.fixture?.id??'');
  const game=byGame.get(fid);
  if(!game)continue;
  const team=canon(row?.team?.name),name=String(row?.player?.name||'').trim();
  if(!name||![game.home,game.away].includes(team))continue;
  const type=String(row?.player?.type||'').trim(),reason=String(row?.player?.reason||'').trim();
  const confirmedOut=/missing fixture|out|suspended/i.test(type);
  const suspended=/suspend|ban|red card|yellow card/i.test(type+' '+reason);
  if(!groups.has(fid))groups.set(fid,{game,home:[],away:[]});
  groups.get(fid)[team===game.home?'home':'away'].push({
   name,status:type||'Reported unavailable',detail:reason,confirmedOut,suspended
  });
 }
 return [...groups.values()].map(g=>({game:g.game,injuries:{verified:true,source,
  home:g.home,away:g.away},suspensions:{verified:g.home.some(x=>x.suspended)||g.away.some(x=>x.suspended),
  source,home:g.home.filter(x=>x.suspended),away:g.away.filter(x=>x.suspended)},
  predictedLineups:{verified:false,home:[],away:[]}}));
}
export function matchAPIFootballReports(match,reports){
 if(!reports?.length)return null;
 const home=canonicalSpanishTeam(match.homeName),away=canonicalSpanishTeam(match.awayName);
 return reports.find(r=>r.game.home===home&&r.game.away===away&&
  Math.abs(Date.parse(r.game.date)-Date.parse(match.date))<7200000)||null;
}
async function jsonFetch(url,options,ms=7500){
 const response=await fetch(url,{...options,signal:AbortSignal.timeout(ms)});
 if(!response.ok)throw Error('HTTP '+response.status);
 const raw=await response.text();
 if(raw.length>3000000)throw Error('Source response exceeds safe limit');
 return JSON.parse(raw);
}
export async function optionalLaLigaSources(today,end){
 const out={xg:null,injuries:[],warnings:[],enabled:{
  striker:!!process.env.STRIKER_API_KEY,apiFootball:!!process.env.API_FOOTBALL_KEY}};
 const requests=[];
 if(process.env.STRIKER_API_KEY){
  requests.push((async()=>{
   const tag='striker:laliga:'+today.slice(0,4);
   const cached=recordsCache.get(tag);
   if(cached&&cached.expires>Date.now()){out.xg=cached.value;return;}
   try{
    const response=await jsonFetch('https://mcp.strikerapi.com/v1/get_team_stats',{
     method:'POST',
     headers:{'content-type':'application/json','x-api-key':process.env.STRIKER_API_KEY},
     body:JSON.stringify({league:'laliga',season:Number(today.slice(0,4))-(Number(today.slice(5,7))<7?1:0)})
    },7000);
    const parsed=parseStrikerXG(response);
    if(!parsed)throw Error('No covered team xG/xGA returned');
    recordsCache.set(tag,{expires:Date.now()+12*3600000,value:parsed});out.xg=parsed;
   }catch(e){out.warnings.push('StrikerAPI xG unavailable: '+e.message);}
  })());
 }
 if(process.env.API_FOOTBALL_KEY){
  requests.push((async()=>{
   const tag='apifootball:laliga:'+today;
   const cached=recordsCache.get(tag);
   if(cached&&cached.expires>Date.now()){out.injuries=cached.value;return;}
   const head={'x-apisports-key':process.env.API_FOOTBALL_KEY,accept:'application/json'};
   try{
    const season=Number(today.slice(0,4))-(Number(today.slice(5,7))<7?1:0);
    const url='https://v3.football.api-sports.io';
    const [fixtureData,injuryData]=await Promise.all([
     jsonFetch(url+'/fixtures?league=140&season='+season+'&from='+today+'&to='+end,{headers:head},7000),
     jsonFetch(url+'/injuries?league=140&season='+season,{headers:head},7000)
    ]);
    const list=parseAPIFootballReports(fixtureData,injuryData);
    recordsCache.set(tag,{expires:Date.now()+5*3600000,value:list});out.injuries=list;
   }catch(e){out.warnings.push('API-Football injuries unavailable: '+e.message);}
  })());
 }
 await Promise.all(requests);return out;
}