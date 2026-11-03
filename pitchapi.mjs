const BASE='https://api.pitchapi.dev/v1';
const names={'Premier League':'eng.1','LaLiga':'esp.1','La Liga':'esp.1','Bundesliga':'ger.1','Serie A':'ita.1','Ligue 1':'fra.1'};
const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
const cache=new Map();
async function get(path,key){
 const prior=cache.get(path);
 if(prior&&prior.until>Date.now())return prior.data;
 const res=await fetch(BASE+path,{headers:{'X-API-KEY':key,accept:'application/json'},signal:AbortSignal.timeout(4800)});
 if(!res.ok){const error=await res.json().catch(()=>({}));throw Error(error.error?.code||'HTTP_'+res.status);}
 const json=await res.json();if(!json||!('data'in json))throw Error('MISSING_DATA');
 cache.set(path,{until:Date.now()+6*3600000,data:json.data});return json.data;
}
export function parsePitchShots(match,body){
 if(!match||!body||!Array.isArray(body.periods))return null;
 const homeId=match.home_team?.id,awayId=match.away_team?.id;
 if(!homeId||!awayId)return null;
 const shots=body.periods.flatMap(p=>Array.isArray(p.shots)?p.shots:[]);
 if(!shots.length)return null;
 let h=0,a=0,valid=0;
 for(const s of shots){
  if(!Number.isFinite(s.expected_goals)||s.expected_goals<0||s.expected_goals>1)continue;
  if(s.team_id===homeId){h+=s.expected_goals;valid++;}
  else if(s.team_id===awayId){a+=s.expected_goals;valid++;}
 }
 return valid?{homeXg:+h.toFixed(3),awayXg:+a.toFixed(3),xgSource:'PitchAPI verified shot-level xG'}:null;
}
export function pitchMatchIdentity(a,b){
 return norm(a.home_team?.name)===norm(b.homeName)&&norm(a.away_team?.name)===norm(b.awayName)
  &&Math.abs(Date.parse(a.time_utc)-Date.parse(b.date))<2*3600000;
}
export async function enrichPitchHistory(history,key,{days=14,maxShots=65}={}){
 const status={configured:Boolean(key),authenticated:false,coveredMatches:0,xgMatches:0,warning:null};
 if(!key)return {history,status};
 try{
  const date=new Date();date.setUTCDate(date.getUTCDate()-1);
  const found=[];
  for(let i=0;i<days;i++){
   const day=new Date(date.getTime()-i*86400000).toISOString().slice(0,10);
   const d=await get('/date/'+day,key);
   status.authenticated=true;
   for(const m of d.matches||[])if(names[m.league?.name]&&m.status==='finished')found.push(m);
  }
  const matched=[];
  for(const p of found){
   const idx=history.findIndex(h=>h.leagueId===names[p.league?.name]&&pitchMatchIdentity(p,h));
   if(idx>=0)matched.push({p,idx});
  }
  status.coveredMatches=matched.length;
  const results=await Promise.all(matched.slice(0,maxShots).map(async ({p,idx})=>{
   try{return {idx,xg:parsePitchShots(p,await get('/matches/'+p.id+'/shots',key))};}
   catch{return {idx,xg:null};}
  }));
  const copy=history.slice();
  for(const {idx,xg} of results)if(xg){
   copy[idx]={...copy[idx],...xg};status.xgMatches++;
  }
  return {history:copy,status};
 }catch(e){status.warning=e.message;return {history,status};}
}
