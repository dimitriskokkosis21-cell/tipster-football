import test from 'node:test';
import assert from 'node:assert/strict';
import {crossLeagueModel,teamKey} from '../crossleague.mjs';
import {calculateMatchV2} from '../model-v2.mjs';
const start=Date.parse('2026-08-01T12:00:00Z');
const rows=[];
function game(l,h,a,hs,as,i){rows.push({leagueId:l,date:new Date(start+i*86400000).toISOString(),homeName:h,awayName:a,homeScore:hs,awayScore:as,complete:true});}
for(let i=0;i<15;i++){
 game('ita.1','Internazionale','Italian Opponent '+(i%3),3,0,i);
 game('ned.1','Feyenoord','Dutch Opponent '+(i%3),1,1,i);
}
for(let i=0;i<5;i++){
 game('uefa.champions','Internazionale','Feyenoord',2,0,30+i);
 game('uefa.champions','Feyenoord','Internazionale',0,2,36+i);
}
const fixture={leagueId:'uefa.champions',date:'2026-11-03T20:00:00Z',homeName:'Feyenoord Rotterdam',awayName:'Inter Milan'};
test('common team identities link domestic and UEFA fixtures',()=>{
 assert.equal(teamKey('Internazionale'),teamKey('Inter Milan'));
 assert.equal(teamKey('Feyenoord Rotterdam'),teamKey('Feyenoord'));
});
test('cross-league Elo uses actual domestic and European history, never market odds',()=>{
 const base=calculateMatchV2(fixture,rows);
 const updated=crossLeagueModel(fixture,rows,base);
 assert.ok(updated.crossLeagueDiagnostics.domesticHome>=10);
 assert.ok(updated.crossLeagueDiagnostics.domesticAway>=10);
 assert.ok(updated.eloAway>updated.eloHome);
 assert.ok(updated.probabilities['2']>updated.probabilities['1']);
 assert.ok(Math.abs(Object.values(updated.probabilities).reduce((a,b)=>a+b,0)-1)<1e-8);
 assert.equal(updated.tip,'NO VERIFIED PRICE · UNCALIBRATED');
});
test('cross-league sparse data remains marked as unreliable',()=>{
 const model=crossLeagueModel(fixture,[],calculateMatchV2(fixture,[]));
 assert.equal(model.crossLeagueUnanchored,true);
 assert.match(model.quality,/UNRELIABLE/);
});
