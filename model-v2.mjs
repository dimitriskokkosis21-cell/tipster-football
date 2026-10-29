/**
 * TIPSTER V2: opponent-adjusted attack/defence + recency + Elo + Dixon–Coles.
 * Only observed, source-tagged xG is ever treated as xG. No team-name ratings,
 * invented missing players, bookmaker inputs, or fixed team-specific overrides.
 */
const norm=s=>String(s??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
const clip=(v,min,max)=>Math.max(min,Math.min(max,v));
const key=(id,name)=>norm(name)||String(id||'');
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
export function validXg(v){
 const n=Number(v);
 return v!==null&&v!==undefined&&v!==''&&Number.isFinite(n)&&n>=0&&n<=8?n:null;
}
function poisson(lambda){
 const arr=[Math.exp(-lambda)];for(let i=1;i<=14;i++)arr[i]=arr[i-1]*lambda/i;return arr;
}
export function scoreMatrix(h,a,rho=-0.07){
 const hp=poisson(h),ap=poisson(a),list=[];let sum=0;
 for(let x=0;x<hp.length;x++)for(let y=0;y<ap.length;y++){
  let correction=1;
  if(x===0&&y===0)correction=1-h*a*rho;
  else if(x===0&&y===1)correction=1+h*rho;
  else if(x===1&&y===0)correction=1+a*rho;
  else if(x===1&&y===1)correction=1-rho;
  const p=Math.max(0,hp[x]*ap[y]*correction);sum+=p;list.push({home:x,away:y,p});
 }
 list.forEach(s=>s.p/=sum);
 return list;
}
export function computeTeamRatings(rows){
 const matches=rows.filter(r=>r.complete&&Number.isFinite(r.homeScore)&&Number.isFinite(r.awayScore))
  .slice().sort((a,b)=>a.date.localeCompare(b.date));
 const elos=new Map(),played=new Map();
 for(const r of matches){
  const h=key(r.homeId,r.homeName),a=key(r.awayId,r.awayName);
  const eh=elos.get(h)??1500,ea=elos.get(a)??1500;
  const expected=1/(1+10**((ea-eh-65)/400));
  const actual=r.homeScore>r.awayScore?1:r.homeScore===r.awayScore?.5:0;
  const margin=Math.abs(r.homeScore-r.awayScore);
  const k=24*(1+0.19*Math.min(margin,4));
  const change=clip(k*(actual-expected),-42,42);
  elos.set(h,eh+change);elos.set(a,ea-change);
  played.set(h,(played.get(h)||0)+1);played.set(a,(played.get(a)||0)+1);
 }
 return {elos,played};
}
function teamsFromRows(rows,at){
 const all=new Map();
 for(const r of rows){
  const days=clip((at-Date.parse(r.date))/86400000,0,300);
  const w=Math.exp(-Math.LN2*days/84);
  for(const side of ['home','away']){
   const id=key(r[side+'Id'],r[side+'Name']);
   if(!all.has(id))all.set(id,{id,games:[],count:0});
   all.get(id).games.push({r,side,w});all.get(id).count++;
  }
 }
 return all;
}
export function calculateMatchV2(match,history,availability={}){
 const when=Date.parse(match.date);
 const league=history.filter(r=>r.complete&&r.leagueId===match.leagueId&&
   Date.parse(r.date)<when&&Number.isFinite(r.homeScore)&&Number.isFinite(r.awayScore)&&
   r.homeScore>=0&&r.awayScore>=0);
 const hKey=key(match.homeId,match.homeName),aKey=key(match.awayId,match.awayName);
 const leagueHome=clip(league.length>=10?mean(league.map(r=>r.homeScore)):1.48,.8,2.4);
 const leagueAway=clip(league.length>=10?mean(league.map(r=>r.awayScore)):1.15,.65,2.2);
 const totalGoalMean=(leagueHome+leagueAway)/2;
 const all=teamsFromRows(league,when);
 const attack=new Map(),defence=new Map();
 for(const t of all.keys()){attack.set(t,1);defence.set(t,1);}
 const prior=5.5;
 let verifiedXgMatches=0;
 // Joint iterative attack/defence fitting: each attack is measured *against
 // opposition defence* rather than simply dividing its goals by league mean.
 for(let iter=0;iter<7;iter++){
  const na=new Map(),nd=new Map();
  for(const [tid,obj] of all){
   let expectedAttack=prior,observedAttack=prior;
   let expectedDef=prior,observedDef=prior;
   for(const {r,side,w} of obj.games){
    const other=side==='home'?'away':'home',oppKey=key(r[other+'Id'],r[other+'Name']);
    const baseFor=side==='home'?leagueHome:leagueAway;
    const baseAgainst=side==='home'?leagueAway:leagueHome;
    const gf=side==='home'?r.homeScore:r.awayScore;
    const ga=side==='home'?r.awayScore:r.homeScore;
    const xf=validXg(side==='home'?r.homeXg:r.awayXg);
    const xa=validXg(side==='home'?r.awayXg:r.homeXg);
    const scoreFor=xf===null?gf:.70*xf+.30*gf;
    const scoreAgainst=xa===null?ga:.70*xa+.30*ga;
    // Exposure is increased when playing tougher defence / attack.
    const expFor=baseFor*clip(defence.get(oppKey)??1,.5,1.8);
    const expAgainst=baseAgainst*clip(attack.get(oppKey)??1,.5,1.8);
    observedAttack+=w*scoreFor/Math.max(.5,expFor);
    observedDef+=w*scoreAgainst/Math.max(.5,expAgainst);
    expectedAttack+=w;expectedDef+=w;
   }
   na.set(tid,clip(observedAttack/expectedAttack,.48,1.78));
   nd.set(tid,clip(observedDef/expectedDef,.48,1.78));
  }
  for(const [k,v] of na)attack.set(k,v);
  for(const [k,v] of nd)defence.set(k,v);
 }
 const own=(id)=>all.get(id)||{games:[],count:0};
 const gamesH=own(hKey).games,gamesA=own(aKey).games;
 const {elos,played}=computeTeamRatings(league);
 const eloHome=elos.get(hKey)??1500,eloAway=elos.get(aKey)??1500;
 const eloDiff=clip(eloHome-eloAway,-370,370);
 // Relative team Elo is a supplementary term rather than the only driver.
 // Home advantage already exists in leagueHome / leagueAway.
 const eloFactor=Math.exp(eloDiff*0.00078);
 // Gently adjust for venue-specific tendencies without allowing 2 home/away
 // matches to override a larger all-venues sample.
 function venueFactor(games,side,rateType,priorMean){
  const local=games.filter(g=>g.side===side);
  let sum=0,exp=0;
  for(const {r,w} of local){
   const score=rateType==='scored'?(side==='home'?r.homeScore:r.awayScore):(side==='home'?r.awayScore:r.homeScore);
   const bg=rateType==='scored'?(side==='home'?leagueHome:leagueAway):(side==='home'?leagueAway:leagueHome);
   sum+=w*score;exp+=w*bg;
  }
  const ratio=(sum+5*priorMean)/(exp+5*priorMean);
  return clip(ratio,.82,1.18);
 }
 const venueH=venueFactor(gamesH,'home','scored',leagueHome);
 const venueA=venueFactor(gamesA,'away','scored',leagueAway);
 const lambdaHome=clip(leagueHome*(attack.get(hKey)??1)*(defence.get(aKey)??1)*eloFactor*venueH,.25,4.6);
 const lambdaAway=clip(leagueAway*(attack.get(aKey)??1)*(defence.get(hKey)??1)/eloFactor*venueA,.25,4.6);
 const grid=scoreMatrix(lambdaHome,lambdaAway);
 const p1=grid.filter(v=>v.home>v.away).reduce((s,v)=>s+v.p,0);
 const px=grid.filter(v=>v.home===v.away).reduce((s,v)=>s+v.p,0);
 const p2=grid.filter(v=>v.home<v.away).reduce((s,v)=>s+v.p,0);
 const z=p1+px+p2,probs={'1':p1/z,'X':px/z,'2':p2/z};
 const fair=Object.fromEntries(Object.entries(probs).map(([k,p])=>[k,1/p]));
 const predicted=Object.entries(probs).sort((a,b)=>b[1]-a[1])[0][0];
 const top=grid.slice().sort((a,b)=>b.p-a.p).slice(0,5).map(v=>({score:v.home+'-'+v.away,probability:v.p}));
 const nH=gamesH.length,nA=gamesA.length;
 const recencyH=gamesH.reduce((s,g)=>s+g.w,0),recencyA=gamesA.reduce((s,g)=>s+g.w,0);
 const uncertainty=clip(0.11/Math.sqrt(1+Math.min(recencyH,recencyA)/3)+0.01,.025,.12);
 const minOdds=Object.fromEntries(Object.entries(probs).map(([k,p])=>[k,1.05/Math.max(.005,p-uncertainty)]));
 const recent=(id)=>{
  return league.filter(r=>key(r.homeId,r.homeName)===id||key(r.awayId,r.awayName)===id)
   .sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5)
   .map(r=>({date:r.date,homeName:r.homeName,awayName:r.awayName,score:r.homeScore+'-'+r.awayScore}));
 };
 for(const r of league)if(validXg(r.homeXg)!==null&&validXg(r.awayXg)!==null)verifiedXgMatches++;
 const avgXg=(games,side,forAgainst)=>{
  let total=0,w=0;
  for(const x of games){
   const r=x.r,home=side==='home';const chosen=forAgainst==='for'?(home?r.homeXg:r.awayXg):(home?r.awayXg:r.homeXg);
   const value=validXg(chosen);if(value!==null){w+=x.w;total+=x.w*value;}
  }
  return w>0?total/w:null;
 };
 const homeXg=avgXg(gamesH,'home','for'),homeXga=avgXg(gamesH,'home','against');
 const awayXg=avgXg(gamesA,'away','for'),awayXga=avgXg(gamesA,'away','against');
 const enough=nH>=5&&nA>=5&&league.length>=30;
 const quality=enough?'RESULTS + ELO':'LIMITED SAMPLE';
 const issues=[];
 if(!verifiedXgMatches)issues.push('Verified xG/xGA for recent matches');
 if(!availability.injuries?.verified)issues.push('Verified injury report');
 if(!availability.suspensions?.verified)issues.push('Verified suspensions');
 if(!availability.predictedLineups?.verified)issues.push('Provider-published predicted XI');
 issues.push('Verified bookmaker prices');
 return {
  probabilities:probs,fairOdds:fair,prediction:predicted,tip:'NO VERIFIED PRICE',
  bookmakerOdds:null,requiredOdds:minOdds,
  lambdaHome,lambdaAway,topScores:top,
  over25:grid.reduce((s,v)=>s+(v.home+v.away>=3?v.p:0),0),
  btts:grid.reduce((s,v)=>s+(v.home>0&&v.away>0?v.p:0),0),
  quality,homeSample:nH,awaySample:nA,leagueSample:league.length,
  uncertaintyPenalty:uncertainty,eloHome:Math.round(eloHome),eloAway:Math.round(eloAway),eloDifference:Math.round(eloDiff),
  homeAttack:attack.get(hKey)??1,awayAttack:attack.get(aKey)??1,
  homeDefence:defence.get(hKey)??1,awayDefence:defence.get(aKey)??1,
  formHome:recent(hKey),formAway:recent(aKey),homeXg,homeXga,awayXg,awayXga,
  verifiedXgMatches,availability,missing:issues,
  reasoning:'All recent league results are weighted by recency. Attack and defence are fitted iteratively against opponent quality, then blended with match-result Elo and conservative venue adjustments. Verified xG influences the fit only where a source reports actual xG.',
  confidenceCalibration:'Not independently calibrated',leagueHomeGoals:leagueHome,leagueAwayGoals:leagueAway
 };
}
