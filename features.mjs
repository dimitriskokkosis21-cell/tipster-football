/**
 * Extract only explicitly published structured data.
 * An empty response is "not verified", never "no injuries".
 */
const norm=s=>String(s??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
const finiteXg=v=>v!==undefined&&v!==null&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=8?Number(v):null;
export function extractESPNxG(competition){
 const teams=competition?.competitors||[];
 const value=side=>{
  const c=teams.find(c=>c.homeAway===side);
  const s=(c?.statistics||[]).find(s=>/^(expectedgoals|expectedgoalsfor|xg)$/i.test(norm(s.name||s.label||'')));
  return finiteXg(s?.value??s?.displayValue);
 };
 const home=value('home'),away=value('away');
 return home!==null&&away!==null?{homeXg:home,awayXg:away,xgSource:'ESPN match statistics (unofficial)'}:{homeXg:null,awayXg:null,xgSource:null};
}
function statusOf(x){
 const s=x.status;
 return String(typeof s==='string'?s:(s?.name||s?.type||s?.description||x.type?.name||'')).trim();
}
function rowsFromInjuryFeed(data){
 if(!data||!Array.isArray(data.injuries))return [];
 const rows=[];
 for(const item of data.injuries){
  if(!item||typeof item!=='object')continue;
  if(Array.isArray(item.injuries)){
   for(const i of item.injuries)rows.push({...i,team:i.team||item.team});
  }else rows.push(item);
 }
 return rows;
}
const sameTeam=(r,id,name)=>{
 const rid=r.team?.id??r.athlete?.team?.id??r.teamId??r.team?.uid;
 const rname=r.team?.displayName??r.team?.name??r.teamName??r.athlete?.team?.displayName;
 return rid!=null&&String(rid)===String(id)||(rname!=null&&norm(rname)===norm(name));
};
const injuryItem=r=>{
 const status=statusOf(r);
 const name=String(r.athlete?.displayName||r.athlete?.fullName||r.player?.name||'').trim();
 if(!name||!status)return null;
 const detail=String(r.detail||r.description||r.type?.description||'').trim().slice(0,110);
 return {name,status,detail,date:r.date||null,confirmedOut:/^(out|inactive|suspended|season ending|injured reserve)$/i.test(status),suspended:/suspend|ban(ned)?|red.card/i.test(status+' '+detail)};
};
export function espnAvailability(data,match){
 const rows=rowsFromInjuryFeed(data);
 const side=(id,name)=>{
  const matches=rows.filter(r=>sameTeam(r,id,name)).map(injuryItem).filter(Boolean);
  return matches.slice(0,30);
 };
 const home=side(match.homeId,match.homeName),away=side(match.awayId,match.awayName);
 // Avoid claiming absence means "fully fit"; ESPN may return empty/partial data.
 const any=home.length+away.length>0;
 const injuries={verified:any,source:any?'ESPN league injury feed (unofficial)':null,home,away,updatedAt:data?.timestamp||null};
 const susp={verified:any&&(home.some(x=>x.suspended)||away.some(x=>x.suspended)),
  source:any?'ESPN league injury feed (unofficial)':null,
  home:home.filter(x=>x.suspended),away:away.filter(x=>x.suspended)};
 return {injuries,suspensions:susp,predictedLineups:{verified:false,source:null,home:[],away:[]}};
}
export function availabilityGoalFactors(info){
 const injuries=info?.injuries;
 if(!injuries?.verified)return {homeAttack:1,awayAttack:1,homeDefence:1,awayDefence:1,source:null};
 const h=injuries.home.filter(p=>p.confirmedOut),a=injuries.away.filter(p=>p.confirmedOut);
 // Conservative generic absence penalty; no player-importance guesses.
 // The effect is explicitly heuristic, not calibrated.
 return {homeAttack:1-Math.min(.075,h.length*.012),
  awayAttack:1-Math.min(.075,a.length*.012),
  homeDefence:1+Math.min(.06,h.length*.008),
  awayDefence:1+Math.min(.06,a.length*.008),
  source:injuries.source};
}
/**
 * Interface for an explicitly licensed enrichment feed, if configured.
 * Expects data matching by league + ISO kickoff + both team names.
 * Never accepts data without provenance or identity. Does not pre-populate
 * unverified values in an ordinary free installation.
 */
export function mergeLicensedMatchData(match,record){
 if(!record||typeof record!=='object'||!record.source||!record.observedAt)return null;
 if(norm(record.homeName)!==norm(match.homeName)||norm(record.awayName)!==norm(match.awayName)
  ||String(record.leagueId)!==String(match.leagueId)||!record.date
  ||Math.abs(Date.parse(record.date)-Date.parse(match.date))>2*3600000)return null;
 const xi=(side)=>{
  const raw=record.predictedLineups?.[side];
  if(!raw||raw.predicted!==true||!Array.isArray(raw.players)||raw.players.length!==11)return [];
  return raw.players.every(x=>typeof x==='string'&&x.trim())?raw.players.slice():[];
 };
 const homeXI=xi('home'),awayXI=xi('away');
 const parsePlayers=side=>Array.isArray(record.injuries?.[side])?
  record.injuries[side].map(x=>({name:String(x.name||'').trim(),status:String(x.status||'').trim(),detail:String(x.reason||'').slice(0,100),
    confirmedOut:/^(out|suspended)$/i.test(x.status||''),suspended:/suspend/i.test(x.status||'')})).filter(x=>x.name&&x.status).slice(0,30):[];
 const home=parsePlayers('home'),away=parsePlayers('away');
 return {injuries:{verified:Boolean(record.injuries?.verified),source:record.source,home,away,updatedAt:record.observedAt},
  suspensions:{verified:Boolean(record.injuries?.verified),source:record.source,home:home.filter(x=>x.suspended),away:away.filter(x=>x.suspended)},
  predictedLineups:{verified:homeXI.length===11&&awayXI.length===11,source:record.source,home:homeXI,away:awayXI},
  source:record.source,observedAt:record.observedAt};
}
