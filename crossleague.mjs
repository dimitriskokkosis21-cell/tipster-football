import {computeTeamRatings,scoreMatrix} from './model-v2.mjs';
const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
const aliases=new Map([['internazionale','inter'],['intermilan','inter'],['feyenoordrotterdam','feyenoord'],['sportingcp','sportinglisbon'],['sportingclubedeportugal','sportinglisbon'],['sportingportugal','sportinglisbon'],['vfb stuttgart','stuttgart'],['vfb1893stuttgart','stuttgart'],['galatasaraysk','galatasaray'],['shakhtardonetsk','shakhtar'],['fcshakhtardonetsk','shakhtar'],['feyenoordrotterdam','feyenoord'],['fcinternazionale','inter']].map(([a,b])=>[norm(a),norm(b)]));
export const teamKey=s=>aliases.get(norm(s))||norm(s);
export const isCrossLeague=id=>['uefa.champions','uefa.europa','uefa.europa.conf','uefa.wchampions','uefa.nations'].includes(id);
export function crossLeagueModel(match,history,base){
 if(!isCrossLeague(match.leagueId))return base;
 const when=Date.parse(match.date);
 const rows=history.filter(r=>r.complete&&Date.parse(r.date)<when&&Number.isFinite(r.homeScore)&&Number.isFinite(r.awayScore))
 .map(r=>({...r,homeName:teamKey(r.homeName),awayName:teamKey(r.awayName),homeId:teamKey(r.homeName),awayId:teamKey(r.awayName)}));
 const h=teamKey(match.homeName),a=teamKey(match.awayName);
 const domesticIds=new Set(['eng.1','esp.1','ita.1','ger.1','fra.1','gre.1']);
 const domesticH=rows.filter(r=>domesticIds.has(r.leagueId)&&(r.homeName===h||r.awayName===h));
 const domesticA=rows.filter(r=>domesticIds.has(r.leagueId)&&(r.homeName===a||r.awayName===a));
 const global=computeTeamRatings(rows);
 const eh=global.elos.get(h)??1500,ea=global.elos.get(a)??1500;
 const nH=global.played.get(h)||0,nA=global.played.get(a)||0;
 // The UEFA-only model uses only a subset of each club's matches. A global
 // Elo shares the same 1500 scale and is connected by real cross-league games.
 // We adjust only for the *difference* between globally and UEFA-only rated
 // strengths, preventing double counting of already observed UEFA results.
 const localDifference=base.eloHome-base.eloAway;
 const globalDifference=eh-ea;
 const coverage=Math.min(1,Math.min(nH,nA)/12);
 const shift=Math.max(-220,Math.min(220,globalDifference-localDifference))*coverage;
 const strength=Math.exp(shift*.00125);
 const lh=Math.max(.25,Math.min(4.6,base.lambdaHome*strength));
 const la=Math.max(.25,Math.min(4.6,base.lambdaAway/strength));
 const grid=scoreMatrix(lh,la);
 const p1=grid.filter(x=>x.home>x.away).reduce((s,x)=>s+x.p,0);
 const px=grid.filter(x=>x.home===x.away).reduce((s,x)=>s+x.p,0);
 const p2=1-p1-px;
 const probs={'1':p1,'X':px,'2':p2};
 const prediction=Object.keys(probs).sort((x,y)=>probs[y]-probs[x])[0];
 const grounded=domesticH.length>=5&&domesticA.length>=5&&nH>=10&&nA>=10;
 const missing=base.missing.filter(x=>!x.includes('Domestic-league strength anchors'));
 if(!grounded)missing.unshift('Insufficient domestic-league records for both clubs');
 missing.push('Cross-league ratings have not passed independent out-of-sample calibration');
 return {...base,probabilities:probs,prediction,fairOdds:Object.fromEntries(Object.entries(probs).map(([k,v])=>[k,1/v])),
 lambdaHome:lh,lambdaAway:la,topScores:grid.slice().sort((x,y)=>y.p-x.p).slice(0,5).map(x=>({score:x.home+'-'+x.away,probability:x.p})),
 over25:grid.reduce((s,x)=>s+(x.home+x.away>=3?x.p:0),0),
 btts:grid.reduce((s,x)=>s+(x.home>0&&x.away>0?x.p:0),0),
 crossLeagueUnanchored:true,quality:grounded?'CROSS-LEAGUE ELO · UNCALIBRATED':'UNRELIABLE · LIMITED CROSS-LEAGUE DATA',
 tip:'NO VERIFIED PRICE · UNCALIBRATED',uncertaintyPenalty:Math.max(.12,base.uncertaintyPenalty),
 missing,eloHome:Math.round(eh),eloAway:Math.round(ea),eloDifference:Math.round(globalDifference),
 crossLeagueDiagnostics:{domesticHome:domesticH.length,domesticAway:domesticA.length,globalHome:nH,globalAway:nA,eloShift:Math.round(shift)},
 reasoning:base.reasoning+' Cross-competition teams are linked by a global Elo fitted to observed domestic and European results, with capped changes to the UEFA-only goal rates. No bookmaker prices were used to set ratings; calibration is not independently validated.'};
}
