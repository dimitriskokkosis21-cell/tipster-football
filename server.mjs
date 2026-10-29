import http from 'node:http';
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
  source:'ESPN (unofficial)',sourceUrl:'https://www.espn.com/soccer/match/_/gameId/'+e.id};
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
  const range=compact(today)+'-'+compact(end),rangePast=compact(past)+'-'+compact(last);
  const rows=await Promise.allSettled([
   remote(ESPN+l.id+'/scoreboard?dates='+range+'&limit=500',420000,force),
   remote(ESPN+l.id+'/scoreboard?dates='+rangePast+'&limit=500',21600000,force)
  ]);
  if(rows[0].status==='fulfilled'&&Array.isArray(rows[0].value.events))fixtures=rows[0].value.events.map(x=>fromESPN(x,l)).filter(x=>x&&!x.complete&&athens(new Date(x.date))>=today&&athens(new Date(x.date))<=end);
  else throw Error(rows[0].reason?.message||'ESPN fixtures unavailable');
  if(rows[1].status==='fulfilled'&&Array.isArray(rows[1].value.events))history=rows[1].value.events.map(x=>fromESPN(x,l)).filter(x=>x&&x.complete);
  else warning=(warning?warning+'; ':'')+'Historical ESPN results unavailable';
  provider='ESPN (unofficial)';
  if(!history.length)warning=(warning?warning+'; ':'')+'No historical results; league priors only';
  return {fixtures,history,report:{league:l.name,provider,fixtures:fixtures.length,history:history.length,warning}};
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
 const matches=fixtures.map(m=>({...m,model:model(m,history)}));
 const sourceStatus=reports.map(r=>r.report);
 const data={matches,meta:{updatedAt:new Date().toISOString(),today,end,timezone:'Europe/Athens',historyMatches:history.length,
  sourceStatus,coverageIncomplete:sourceStatus.some(s=>s.provider==='UNAVAILABLE'||s.provider.includes('limited')||s.warning),
  notice:'ESPN endpoints are unofficial and may change. No bookmaker, injury, xG or lineup data is being invented. Predictions are not validated betting advice.'}};
 if(sourceStatus.every(s=>s.provider==='UNAVAILABLE')&&!lastSuccessful)throw Error('All football data sources are currently unavailable. Retry later.');
 if(sourceStatus.some(s=>s.provider!=='UNAVAILABLE'))lastSuccessful={data,expires:now+7*60000,date:today};
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
