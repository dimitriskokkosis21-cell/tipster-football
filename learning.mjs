/**
 * TIPSTER learning and backtesting primitives.
 *
 * Immutable forecast snapshots are recorded before kickoff; settled scores are
 * never inputs to historical forecasts. Calibration always trains only on
 * previously completed matches. All scores and losses are proper probability
 * scores, not guarantees of betting profitability.
 */
export const LEARNING_VERSION='tipster-learning-v1';
export const LABELS=['1','X','2'];
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
export const validProbs=p=>p&&LABELS.every(k=>Number.isFinite(p[k])&&p[k]>=0&&p[k]<=1)&&Math.abs(LABELS.reduce((s,k)=>s+p[k],0)-1)<.001;
export function applyTemperature(p,temp=1){
 if(!validProbs(p))throw Error('Invalid uncalibrated probabilities');
 const t=clamp(Number.isFinite(temp)?temp:1,.8,1.65);
 const values=LABELS.map(k=>Math.pow(Math.max(.000001,p[k]),1/t));
 const total=values.reduce((s,v)=>s+v,0);
 return Object.fromEntries(LABELS.map((k,i)=>[k,values[i]/total]));
}
export function resultLabel(h,a){
 if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0||h>30||a>30)return null;
 return h>a?'1':h<a?'2':'X';
}
export function forecastMetrics(forecasts){
 const settled=forecasts.filter(x=>x.result&&validProbs(x.forecast?.publishedProbabilities||x.forecast?.rawProbabilities));
 const n=settled.length;
 if(!n)return {evaluated:0,accuracy:null,brier:null,logLoss:null,meanConfidence:null,actualHome:null,actualDraw:null,actualAway:null};
 let correct=0,brier=0,logLoss=0,confidence=0,homes=0,draws=0,aways=0;
 for(const r of settled){
  const p=r.forecast.publishedProbabilities||r.forecast.rawProbabilities;
  const y=r.result.outcome;
  if(!LABELS.includes(y))continue;
  const top=LABELS.slice().sort((a,b)=>p[b]-p[a])[0];if(top===y)correct++;
  brier+=LABELS.reduce((s,k)=>s+(p[k]-(k===y?1:0))**2,0);
  logLoss-=Math.log(Math.max(1e-6,p[y]));
  confidence+=Math.max(...LABELS.map(k=>p[k]));
  if(y==='1')homes++;else if(y==='X')draws++;else aways++;
 }
 return {evaluated:n,accuracy:correct/n,brier:brier/n,logLoss:logLoss/n,
  meanConfidence:confidence/n,actualHome:homes/n,actualDraw:draws/n,actualAway:aways/n};
}
export function applyBinaryTemperature(p,temp=1){
 if(!Number.isFinite(p)||p<0||p>1)throw Error('Invalid binary market probability');
 const t=clamp(Number.isFinite(temp)?temp:1,.8,1.65);
 const q=clamp(p,.00001,.99999);
 const odds=Math.pow(q/(1-q),1/t);
 return odds/(1+odds);
}
export function marketMetrics(forecasts){
 const complete=forecasts.filter(r=>r.result&&Number.isInteger(r.result.home)&&Number.isInteger(r.result.away));
 const counters={over25:{n:0,loss:0},btts:{n:0,loss:0}};
 let exactN=0,exactCorrect=0,goalsN=0,goalError=0;
 for(const r of complete){
  const markets=r.forecast?.markets||{};
  const h=r.result.home,a=r.result.away;
  for(const [market,yes] of [['over25',h+a>=3],['btts',h>0&&a>0]]){
   const p=markets[market];
   if(Number.isFinite(p)&&p>=0&&p<=1){
    counters[market].n++;counters[market].loss+=(p-(yes?1:0))**2;
   }
  }
  if(/^\d+-\d+$/.test(markets.predictedScore||'')){
   exactN++;if(markets.predictedScore===h+'-'+a)exactCorrect++;
  }
  const eg=r.forecast?.expectedGoals;
  if(Number.isFinite(eg?.home)&&Number.isFinite(eg?.away)){
   goalsN++;goalError+=(Math.abs(eg.home-h)+Math.abs(eg.away-a))/2;
  }
 }
 return {over25Evaluated:counters.over25.n,over25Brier:counters.over25.n?counters.over25.loss/counters.over25.n:null,
  bttsEvaluated:counters.btts.n,bttsBrier:counters.btts.n?counters.btts.loss/counters.btts.n:null,
  exactScoreEvaluated:exactN,exactScoreAccuracy:exactN?exactCorrect/exactN:null,
  expectedGoalsEvaluated:goalsN,expectedGoalsMAE:goalsN?goalError/goalsN:null};
}
function binaryCalibrationLoss(rows,market,temp){
 let sum=0,n=0;
 for(const r of rows){
  const raw=r.forecast?.markets?.[market];
  const score=r.result;
  if(!score||!Number.isFinite(raw)||raw<0||raw>1)continue;
  const hit=market==='over25'?score.home+score.away>=3:score.home>0&&score.away>0;
  const p=applyBinaryTemperature(raw,temp);
  sum-=Math.log(Math.max(.000001,hit?p:1-p));n++;
 }
 return n?sum/n:Infinity;
}
function fitBinaryCalibration(rows,market,min=80){
 const sorted=rows.filter(r=>r.result&&Number.isFinite(r.forecast?.markets?.[market]))
  .sort((a,b)=>a.kickoff.localeCompare(b.kickoff));
 if(sorted.length<min)return {temperature:1,trained:sorted.length,holdout:0,improvement:0,reason:'Too few verified forecasts'};
 const split=Math.floor(sorted.length*.75),training=sorted.slice(0,split),holdout=sorted.slice(split);
 if(holdout.length<15)return {temperature:1,trained:training.length,holdout:holdout.length,improvement:0,reason:'Too few held-out forecasts'};
 let best=1,bestScore=Infinity;
 for(const t of GRIDS){
  const score=binaryCalibrationLoss(training,market,t)+12/training.length*(t-1)**2;
  if(score<bestScore){best=t;bestScore=score;}
 }
 if(binaryCalibrationLoss(holdout,market,best)>binaryCalibrationLoss(holdout,market,1)-.002)
  return {temperature:1,trained:training.length,holdout:holdout.length,improvement:0,reason:'No holdout gain'};
 const temp=1+(best-1)*sorted.length/(sorted.length+110);
 return {temperature:Number(temp.toFixed(4)),trained:training.length,holdout:holdout.length,
  improvement:Number((binaryCalibrationLoss(holdout,market,1)-binaryCalibrationLoss(holdout,market,temp)).toFixed(6)),reason:'Chronological holdout gain'};
}
export function selectMarketCalibration(calibration,market){
 const details=calibration?.markets?.[market];
 return details?.trained>=60&&Number.isFinite(details.temperature)?details.temperature:1;
}
export function calibrationLoss(forecasts,temp){
 let total=0,n=0;
 for(const r of forecasts){
  if(!r.result||!validProbs(r.forecast?.rawProbabilities)||!LABELS.includes(r.result.outcome))continue;
  const p=applyTemperature(r.forecast.rawProbabilities,temp);
  total-=Math.log(Math.max(.000001,p[r.result.outcome]));n++;
 }
 return n?total/n:Infinity;
}
const GRIDS=[.85,.9,.95,1,1.05,1.1,1.15,1.2,1.25,1.3,1.35,1.4,1.5];
function selectTemperature(rows,min=60,regularizer=8){
 const sorted=rows.filter(r=>r.result&&validProbs(r.forecast?.rawProbabilities))
  .sort((a,b)=>Date.parse(a.kickoff)-Date.parse(b.kickoff));
 if(sorted.length<min)return {temperature:1,trained:sorted.length,holdout:0,improvement:0,reason:'Insufficient settled pre-match forecasts'};
 // Chronological split is deliberate: the last matches are held out.
 const split=Math.floor(sorted.length*.75),train=sorted.slice(0,split),test=sorted.slice(split);
 if(test.length<12)return {temperature:1,trained:train.length,holdout:test.length,improvement:0,reason:'Insufficient holdout matches'};
 let best=1,bestObjective=Infinity;
 for(const temp of GRIDS){
  const score=calibrationLoss(train,temp)+regularizer/train.length*(temp-1)**2;
  if(score<bestObjective){best=temp;bestObjective=score;}
 }
 const rawLoss=calibrationLoss(test,1),tunedLoss=calibrationLoss(test,best);
 // Never promote a calibration with no observed holdout improvement,
 // and be extra conservative with modest sample size.
 if(!(tunedLoss<rawLoss-.002))return {temperature:1,trained:train.length,holdout:test.length,improvement:0,reason:'Holdout not better than raw model'};
 const shrink=sorted.length/(sorted.length+110);
 const temperature=Number((1+(best-1)*shrink).toFixed(4));
 return {temperature,trained:train.length,holdout:test.length,
  improvement:Number((rawLoss-calibrationLoss(test,temperature)).toFixed(6)),
  reason:'Chronological holdout improvement; temperature shrunk toward 1'};
}
export function fitCalibration(records,now=new Date().toISOString()){
 const settled=records.filter(r=>r.result&&Date.parse(r.kickoff)<Date.parse(now)&&
   Date.parse(r.forecast?.recordedAt)<Date.parse(r.kickoff)&&validProbs(r.forecast?.rawProbabilities));
 const global=selectTemperature(settled,70,12),leagues={},metrics={};
 const markets={over25:fitBinaryCalibration(settled,'over25'),btts:fitBinaryCalibration(settled,'btts')};
 const groups=new Map();
 for(const r of records){
  if(!groups.has(r.leagueId))groups.set(r.leagueId,[]);
  groups.get(r.leagueId).push(r);
 }
 for(const [leagueId,items] of groups){
  const resolved=items.filter(r=>r.result);
  metrics[leagueId]={...forecastMetrics(items),...marketMetrics(items),tracked:items.length,leagueName:items[0]?.league};
  // League-specific adjustments demand stronger evidence than global trends.
  if(resolved.length>=95)leagues[leagueId]=selectTemperature(resolved,95,16);
 }
 return {version:LEARNING_VERSION,updatedAt:now,
  global,leagues,markets,performance:{
   tracked:records.length,awaitingResult:records.filter(r=>!r.result).length,
   ...forecastMetrics(records),...marketMetrics(records),leagues:metrics
  },notes:'Calibration is trained only on archived pre-kickoff forecasts with verified final results; chronological holdout validation and shrinkage. No settled match is retroactively repredicted.'};
}
export function selectCalibration(calibration,leagueId){
 const local=calibration?.leagues?.[leagueId];
 if(local?.trained>=70&&Number.isFinite(local.temperature))return {temperature:local.temperature,scope:'league',sampleSize:local.trained};
 const global=calibration?.global;
 if(global?.trained>=45&&Number.isFinite(global.temperature))return {temperature:global.temperature,scope:'global',sampleSize:global.trained};
 return {temperature:1,scope:'untrained',sampleSize:0};
}
export function archivePrediction(records,match,recordedAt,modelVersion='elo-dixon-coles-v2'){
 const matchId=String(match.id||'');
 const kickoff=String(match.date||'');
 const p=match.model?.rawProbabilities||match.model?.probabilities;
 const pub=match.model?.probabilities;
 if(!matchId||!Number.isFinite(Date.parse(kickoff))||!validProbs(p)||!validProbs(pub))return false;
 const ts=Date.parse(recordedAt);
 if(!Number.isFinite(ts)||ts>=Date.parse(kickoff))return false;
 const key=match.leagueId+'|'+matchId;
 let record=records.find(x=>x.key===key);
 const forecast={
  recordedAt,modelVersion,rawProbabilities:Object.fromEntries(LABELS.map(k=>[k,p[k]])),
  publishedProbabilities:Object.fromEntries(LABELS.map(k=>[k,pub[k]])),
  xgCoverage:match.model?.xgSource||null,
  injuryCoverage:match.model?.availability?.injuries?.verified||false,
  calibration:match.model?.calibration||null,
  markets:{over25:Number.isFinite(match.model?.rawOver25)?match.model.rawOver25:match.model?.over25??null,
   btts:Number.isFinite(match.model?.rawBtts)?match.model.rawBtts:match.model?.btts??null,
   predictedScore:match.model?.topScores?.[0]?.score||null,
   topScores:Array.isArray(match.model?.topScores)?match.model.topScores.slice(0,5):[]},
  expectedGoals:{home:match.model?.lambdaHome??null,away:match.model?.lambdaAway??null}
 };
 if(!record){
  records.push({key,matchId,leagueId:match.leagueId,league:match.league,
   homeName:match.homeName,awayName:match.awayName,kickoff,
   firstRecordedAt:recordedAt,forecast,firstForecast:forecast,revisionCount:1,
   result:null,source:match.source||null});
  return true;
 }
 if(record.result)return false;
 // Existing prediction at a fixed kickoff remains auditable; never overwrite its
 // first forecast, and never revise a post-kickoff outcome.
 if(Date.parse(record.kickoff)!==Date.parse(kickoff)){
  const difference=Math.abs(Date.parse(record.kickoff)-Date.parse(kickoff));
  if(difference>48*3600000){record.postponedOrMoved=true;return false;}
 }
 const prior=record.forecast;
 if(Date.parse(recordedAt)<=Date.parse(prior.recordedAt))return false;
 const dist=LABELS.reduce((s,k)=>s+Math.abs(prior.rawProbabilities[k]-p[k]),0);
 // Save most recent snapshot when meaningful probability or availability changes.
 if(dist<.006&&prior.xgCoverage===forecast.xgCoverage&&prior.injuryCoverage===forecast.injuryCoverage&&prior.markets&&Math.abs((prior.markets.over25??0)-(forecast.markets.over25??0))<.005&&Math.abs((prior.markets.btts??0)-(forecast.markets.btts??0))<.005)return false;
 record.forecast=forecast;record.revisionCount=(record.revisionCount||1)+1;return true;
}
export function settlePrediction(record,score,settledAt,source){
 if(record.result)return false;
 if(!record.forecast||Date.parse(record.forecast.recordedAt)>=Date.parse(record.kickoff))return false;
 if(score?.home===null||score?.home===undefined||score?.home===''||
    score?.away===null||score?.away===undefined||score?.away==='')return false;
 const home=Number(score.home),away=Number(score.away),outcome=resultLabel(home,away);
 if(!outcome||!source||!score?.completed)return false;
 record.result={home,away,outcome,completedAt:settledAt,source};
 return true;
}
