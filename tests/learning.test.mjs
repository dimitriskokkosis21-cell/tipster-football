import test from 'node:test';
import assert from 'node:assert/strict';
import {archivePrediction,settlePrediction,fitCalibration,applyTemperature,
 resultLabel,forecastMetrics,selectCalibration} from '../learning.mjs';
const fixture=(id,date='2026-11-01T16:00:00.000Z',p={'1':.6,X:.25,'2':.15})=>
 ({id,leagueId:'gre.1',league:'Greek Super League',date,homeName:'Home',awayName:'Away',
 model:{probabilities:p,rawProbabilities:p,lambdaHome:1.9,lambdaAway:.8}});
test('forecast is captured only before kickoff, preserves original and does not overwrite settled results',()=>{
 const records=[],m=fixture('espn:gre.1:999');
 assert.equal(archivePrediction(records,m,'2026-10-31T10:00:00.000Z'),true);
 assert.equal(records.length,1);
 assert.equal(archivePrediction(records,m,'2026-10-31T11:00:00.000Z'),false);
 const changed=fixture('espn:gre.1:999',m.date,{'1':.3,X:.3,'2':.4});
 assert.equal(archivePrediction(records,changed,'2026-10-31T12:00:00.000Z'),true);
 assert.equal(records[0].firstForecast.publishedProbabilities['1'],.6);
 assert.equal(records[0].forecast.publishedProbabilities['1'],.3);
 assert.equal(archivePrediction(records,fixture('espn:gre.1:1000'),'2026-11-01T17:00:00.000Z'),false);
 assert.equal(settlePrediction(records[0],{home:0,away:2,completed:true},'2026-11-01T19:00:00Z','ESPN final'),true);
 assert.equal(records[0].result.outcome,'2');
 assert.equal(archivePrediction(records,fixture('espn:gre.1:999'),'2026-10-31T13:00:00.000Z'),false);
 assert.equal(settlePrediction(records[0],{home:3,away:0,completed:true},'2026-11-01T20:00:00Z','Bad overwrite'),false);
});
test('no guessed result when unverified, completed false, or missing score',()=>{
 const r=[],m=fixture('espn:gre.1:55');archivePrediction(r,m,'2026-10-30T10:00:00Z');
 assert.equal(settlePrediction(r[0],{home:3,away:1,completed:false},'2026-11-01T18:00Z','ESPN'),false);
 assert.equal(settlePrediction(r[0],{home:null,away:1,completed:true},'2026-11-01T18:00Z','ESPN'),false);
 assert.equal(settlePrediction(r[0],{home:0,away:0,completed:true},'2026-11-01T18:00Z',''),false);
 assert.equal(r[0].result,null);
});
test('3-way outcome classifier includes draws and valid temperatures preserve probability sum',()=>{
 assert.equal(resultLabel(1,1),'X');assert.equal(resultLabel(2,1),'1');assert.equal(resultLabel(0,2),'2');
 const raw={'1':.7,X:.2,'2':.1};
 for(const t of [.8,1,1.3,1.6]){
  const p=applyTemperature(raw,t);
  assert.ok(Math.abs(Object.values(p).reduce((a,b)=>a+b,0)-1)<1e-10);
 }
 assert.ok(Math.abs(applyTemperature(raw,1)['1']-raw['1'])<1e-12);
});
test('ledger computes proper loss scores from recorded probabilities, not retroactive calibration',()=>{
 const records=[],m=fixture('espn:gre.1:13');
 archivePrediction(records,m,'2026-10-31T10:00:00Z');
 settlePrediction(records[0],{home:2,away:1,completed:true},'2026-11-01T20:00:00Z','ESPN');
 const a=forecastMetrics(records);
 assert.equal(a.evaluated,1);assert.equal(a.accuracy,1);
 assert.ok(Math.abs(a.brier-(.4**2+.25**2+.15**2))<1e-12);
 assert.ok(Math.abs(a.logLoss-(-Math.log(.6)))<1e-12);
});
test('learning initially stays neutral, never claims statistical improvement without completed matches',()=>{
 const cal=fitCalibration([],'2026-10-31T10:00:00Z');
 assert.equal(cal.global.temperature,1);assert.equal(cal.performance.evaluated,0);
 assert.equal(selectCalibration(cal,'gre.1').scope,'untrained');
 const rows=[];
 for(let i=0;i<30;i++){
  const kickoff=new Date(Date.parse('2026-01-01T17:00:00Z')+i*86400000).toISOString();
  const a=fixture('espn:gre.1:'+i,kickoff);
  const before=new Date(Date.parse(kickoff)-86400000).toISOString();
  archivePrediction(rows,a,before);settlePrediction(rows[i],{home:1,away:0,completed:true},kickoff,'ESPN');
 }
 const learned=fitCalibration(rows,'2026-05-01T12:00:00Z');
 assert.equal(learned.performance.evaluated,30);
 assert.equal(learned.global.temperature,1);
});
test('chronological holdout never trains on future or unrecorded predictions',()=>{
 const rows=[],base=Date.parse('2026-01-01T18:00:00Z');
 for(let i=0;i<110;i++){
  const kickoff=new Date(base+i*86400000).toISOString();
  const a=fixture('espn:gre.1:'+i,kickoff,{'1':.8,X:.1,'2':.1});
  archivePrediction(rows,a,new Date(Date.parse(kickoff)-10800000).toISOString());
  // Intentionally evenly distributed results: the model is severely overconfident.
  const outcomes=[{home:1,away:0},{home:1,away:1},{home:0,away:1}];
  settlePrediction(rows[i],{...outcomes[i%3],completed:true},kickoff,'ESPN');
 }
 const cal=fitCalibration(rows,'2026-05-01T12:00:00Z');
 assert.ok(cal.global.temperature>=1);
 assert.ok(cal.global.holdout>=12);
 assert.ok(cal.global.improvement>=0);
});
