import http from 'node:http';
import {calculateMatchV2,validXg} from './model-v2.mjs';
import {extractESPNxG,espnAvailability,mergeLicensedMatchData} from './features.mjs';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('.',import.meta.url));
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
const dadd=(day,offset)=>new Date(Date.parse(day+'T12:00:00Z')+86400000*offset).toISOString().slice(0,10);
function athens(d=new Date()){
 const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
 const t=Object.fromEntries(p.map(x=>[x.type,x.value]));return t.year+'-'+t.month+'-'+t.day;
}
const compact=s=>s.replaceAll('-','');
const valid=s=>s && !Number.isNaN(Date.parse(s));
function json(res,status,obj){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify(obj));}
async function remote(url,ms=600000,force=false){
 const old=cache.get(url);
 if(!force&&old&&old.until>Date.now())return old.body;
 try{
  const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(9500)});
  if(!r.ok)throw Error('HTTP '+r.status);
  const t=await r.text();if(t.length>4500000)throw Error('provider oversized response');
  const v=JSON.parse(t);cache.set(url,{body:v,until:Date.now()+ms});return v;
 }catch(e){if(old?.body)return old.body;throw Error(new URL(url).hostname+': '+e.message);}
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
 const past=dadd(today,-155),last=dadd(today,-1);
 if(l.id==='ger.1'){
  try{
   const season=y=>Number(y.slice(0,4))-(Number(y.slice(5,7))<7?1:0);
   const years=[...new Set([season(today),season(end),season(past)])];
   const res=await Promise.all(years.map(y=>remote('https://api.openligadb.de/getmatchdata/bl1/'+y,21600000,force)));
   const all=unique(res.flatMap(r=>Array.isArray(r)?r.map(e=>fromOpen(e,l)):[]));
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
  const years=[...new Set([past.slice(0,4),today.slice(0,4),end.slice(0,4)])];
  const responses=await Promise.allSettled(years.map(year=>
   remote(ESPN+l.id+'/scoreboard?dates='+year+'&limit=1000',21600000,force)));
  const good=responses.filter(r=>r.status==='fulfilled'&&Array.isArray(r.value?.events));
  if(!good.length)throw Error(responses.map(r=>r.reason?.message||'malformed scoreboard data').join('; '));
  const ev=new Map();
  for(const r of good)for(const e of r.value.events)if(e.id!=null)ev.set(String(e.id),e);
  const all=[...ev.values()].map(e=>fromESPN(e,l)).filter(Boolean);
  fixtures=all.filter(x=>!x.complete&&athens(new Date(x.date))>=today&&athens(new Date(x.date))<=end);
  history=all.filter(x=>x.complete&&athens(new Date(x.date))>=past&&athens(new Date(x.date))<today);
  if(good.length<years.length)warning=(warning?warning+'; ':'')+'Some ESPN year queries failed; coverage may be incomplete';
  if(good.some(r=>r.value.events.length>=1000))warning=(warning?warning+'; ':'')+'Scoreboard reached event limit; coverage may be truncated';
  provider='ESPN (unofficial)';
  let injuries=null;
  try{injuries=await remote(ESPN+l.id+'/injuries',7200000,force);}catch{}
  if(!history.length)warning=(warning?warning+'; ':'')+'No historical results; league priors only';
  return {fixtures,history,injuries,report:{league:l.name,provider,fixtures:fixtures.length,history:history.length,warning}};
 }catch(e){warning=(warning?warning+'; ':'')+'ESPN failed: '+e.message;}
 try{
  const a=await Promise.allSettled([remote(SDB+'eventsnextleague.php?id='+l.sdb,600000,force),remote(SDB+'eventspastleague.php?id='+l.sdb,21600000,force)]);
  if(a[0].status==='fulfilled')fixtures=(a[0].value.events||[]).map(x=>fromSDB(x,l)).filter(x=>x&&!x.complete&&athens(new Date(x.date))>=today&&athens(new Date(x.date))<=end);
  if(a[1].status==='fulfilled')history=(a[1].value.events||[]).map(x=>fromSDB(x,l)).filter(x=>x&&x.complete);
  if(a.every(x=>x.status==='rejected'))throw Error('both free-tier calls failed');
  provider='TheSportsDB (limited coverage)';
  warning+='; free tier returns only limited events and does not guarantee all fixtures';
 }catch(e){provider='UNAVAILABLE';warning+='; TheSportsDB failed: '+e.message;}
 return {fixtures,history,report:{league:l.name,provider,fixtures:fixtures.length,history:history.length,warning}};
}
function poisson(lambda){
 const a=[Math.exp(-lambda)];
 for(let i=1;i<=12;i++)a.push(a[i-1]*lambda/i);
 return a;
}
function scoreGrid(h,a,rho=-0.075){
 const hp=poisson(h),ap=poisson(a),list=[];let sum=0;
 for(let x=0;x<hp.length;x++)for(let y=0;y<ap.length;y++){
  let tau=1;
  if(x===0&&y===0)tau=1-h*a*rho;
  if(x===0&&y===1)tau=1+h*rho;
  if(x===1&&y===0)tau=1+a*rho;
  if(x===1&&y===1)tau=1-rho;
  const v=Math.max(0,hp[x]*ap[y]*tau);sum+=v;list.push({home:x,away:y,p:v});
 }
 list.forEach(x=>x.p/=sum);
 return list;
}
function outcome(h,a){return h>a?'1':h<a?'2':'X';}
const norm=s=>String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
function model(match,results){
 const rows=results.filter(r=>r.complete&&r.leagueId===match.leagueId&&new Date(r.date)<new Date(match.date)&&Number.isFinite(r.homeScore)&&Number.isFinite(r.awayScore));
 const leagueH=rows.length>=12?rows.reduce((s,r)=>s+r.homeScore,0)/rows.length:1.45;
 const leagueA=rows.length>=12?rows.reduce((s,r)=>s+r.awayScore,0)/rows.length:1.15;
 const baseH=Math.max(.5,Math.min(3,leagueH)),baseA=Math.max(.5,Math.min(3,leagueA));
 const same=(r,id,name,side)=>String(r[side+'Id'])===id||norm(r[side+'Name'])===norm(name);
 function samples(side,id,name){
  return rows.filter(r=>same(r,id,name,side)).map(r=>{
   const days=Math.max(0,(new Date(match.date)-new Date(r.date))/86400000);
   const weight=Math.exp(-Math.LN2*days/65);
   return {r,w:weight};
  });
 }
 const home=samples('home',match.homeId,match.homeName),away=samples('away',match.awayId,match.awayName);
 function shrunk(list,prop,prior){
  const total=list.reduce((s,x)=>s+x.w,0);
  return {v:(list.reduce((s,x)=>s+x.w*prop(x.r),0)+prior*5)/(total+5),effective:total};
 }
 const hgf=shrunk(home,r=>r.homeScore,baseH),hga=shrunk(home,r=>r.awayScore,baseA);
 const agf=shrunk(away,r=>r.awayScore,baseA),aga=shrunk(away,r=>r.homeScore,baseH);
 const lambdaH=Math.max(.2,Math.min(5.5,baseH*(hgf.v/baseH)*(aga.v/baseH)));
 const lambdaA=Math.max(.2,Math.min(5.5,baseA*(agf.v/baseA)*(hga.v/baseA)));
 const grid=scoreGrid(lambdaH,lambdaA);
 const p1=grid.filter(g=>g.home>g.away).reduce((s,g)=>s+g.p,0),px=grid.filter(g=>g.home===g.away).reduce((s,g)=>s+g.p,0),p2=1-p1-px;
 const probs={'1':p1,'X':px,'2':p2},fair=Object.fromEntries(Object.entries(probs).map(([k,p])=>[k,1/p]));
 const predicted=Object.entries(probs).sort((a,b)=>b[1]-a[1])[0][0];
 const minEff=Math.min(hgf.effective,agf.effective),uncertainty=Math.min(.13,.02+.095*Math.exp(-minEff/6));
 const thresholds=Object.fromEntries(Object.entries(probs).map(([k,p])=>[k,1.05/Math.max(.005,p-uncertainty)]));
 const top=grid.slice().sort((a,b)=>b.p-a.p).slice(0,5).map(v=>({score:v.home+'-'+v.away,probability:v.p}));
 const recent=(side,id,name)=>rows.filter(r=>same(r,id,name,'home')||same(r,id,name,'away')).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5).map(r=>({
  date:r.date,homeName:r.homeName,awayName:r.awayName,score:r.homeScore+'-'+r.awayScore
 }));
 const quality=rows.length<12||home.length<4||away.length<4?'LOW':'RESULTS-BASED';
 return {probabilities:probs,fairOdds:fair,prediction:predicted,tip:'NO VERIFIED PRICE',bookmakerOdds:null,requiredOdds:thresholds,
  lambdaHome:lambdaH,lambdaAway:lambdaA,topScores:top,over25:grid.filter(g=>g.home+g.away>=3).reduce((s,g)=>s+g.p,0),
  btts:grid.filter(g=>g.home>0&&g.away>0).reduce((s,g)=>s+g.p,0),quality,
  homeSample:home.length,awaySample:away.length,leagueSample:rows.length,uncertaintyPenalty:uncertainty,
  formHome:recent('home',match.homeId,match.homeName),formAway:recent('away',match.awayId,match.awayName),
  reasoning:home.length&&away.length?'Home and away goal rates are time-weighted and shrunk toward competition averages.':'Limited verified results: conservative league-average goal priors have increased influence.',
  missing:['Verified xG/xGA','Injuries and suspensions','Predicted/confirmed lineups','Verified bookmaker prices']};
}
async function fetchAll(force=false){
 const now=Date.now(),today=athens(),end=dadd(today,7);
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
 const leagueInjuries=new Map(reports.map((r,i)=>[LEAGUES[i].id,r.injuries]));
 const matches=fixtures.map(m=>{
  const base=espnAvailability(leagueInjuries.get(m.leagueId),m);
  const rich=findLicensed(m);
  const custom=rich?mergeLicensedMatchData(m,rich):null;
  const avail=custom??base;
  return {...m,model:calculateMatchV2(m,history,avail)};
 });
 const sourceStatus=reports.map(r=>r.report);
 const data={matches,meta:{updatedAt:new Date().toISOString(),today,end,timezone:'Europe/Athens',historyMatches:history.length,
  sourceStatus,coverageIncomplete:sourceStatus.some(s=>s.provider==='UNAVAILABLE'||s.provider.includes('limited')||s.warning),
  notice:'ESPN endpoints are unofficial and may change. xG, injuries, suspensions and projected XIs are included only if verified by named sources; otherwise they are explicitly unavailable. Probabilities are not independently calibrated.'}};
 if(sourceStatus.every(s=>s.provider==='UNAVAILABLE')&&!lastSuccessful)throw Error('All football data sources are currently unavailable. Retry later.');
 if(sourceStatus.some(s=>s.provider!=='UNAVAILABLE'))lastSuccessful={data,expires:now+7*60000,date:today};
 const caseStudy=matches.filter(m=>/kifisia/i.test(m.homeName+' '+m.awayName)&&/olymp/i.test(m.homeName+' '+m.awayName));
 if(caseStudy.length)console.log('TIPSTER KIFISIA / OLYMPIACOS V2 CHECK',JSON.stringify(caseStudy.map(x=>({match:x.homeName+' vs '+x.awayName,probabilities:x.model.probabilities,xgSource:x.model.verifiedXgMatches,homeElo:x.model.eloHome,awayElo:x.model.eloAway,lambdaHome:x.model.lambdaHome,lambdaAway:x.model.lambdaAway}))));
 if(!matches.length&&sourceStatus.every(s=>s.provider==='UNAVAILABLE')&&lastSuccessful)return lastSuccessful.data;
 return data;
}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/health')return json(res,200,{ok:true,app:'TIPSTER',time:new Date().toISOString()});
  if(url.pathname==='/api/matches'){
   try{return json(res,200,await fetchAll(url.searchParams.get('refresh')==='1'));}
   catch(e){return json(res,503,{error:e.message,retryable:true,at:new Date().toISOString()});}
  }
  if(url.pathname.startsWith('/api/'))return json(res,404,{error:'Not found'});
  const path=url.pathname==='/'?'/index.html':url.pathname;
  if(!/^\/[a-zA-Z0-9_./-]+$/.test(path)||path.includes('..'))return json(res,400,{error:'Invalid path'});
  const target=resolve(ROOT,'public','.'+path),base=resolve(ROOT,'public');
  if(target!==base&&!target.startsWith(base+sep))return json(res,403,{error:'Forbidden'});
  try{const body=await readFile(target);res.writeHead(200,{'content-type':MIME[extname(target)]||'application/octet-stream','cache-control':'public, max-age=300'});res.end(body);}
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
  console.log('TIPSTER LIVE DATA DIAGNOSTIC',JSON.stringify({fixtures:stats.fixtures,historicalResults:stats.historicalResults,leagues:stats.leagues,modelValidationErrors:errors}));
 }catch(e){console.error('TIPSTER LIVE DATA DIAGNOSTIC FAILED:',e.message);}
},1100);
