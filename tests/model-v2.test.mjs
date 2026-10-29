import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMatchV2,scoreMatrix,validXg} from '../model-v2.mjs';
import {extractESPNxG,espnAvailability,availabilityGoalFactors,mergeLicensedMatchData} from '../features.mjs';

const kickoff='2026-10-31T17:00:00.000Z';
const league='gre.1';
const game=(home,away,hs,as,index,overrides={})=>({
  leagueId:league,date:new Date(Date.parse('2026-10-01T17:00:00.000Z')+(index*3600000)).toISOString(),
  homeName:home,awayName:away,homeId:home,awayId:away,homeScore:hs,awayScore:as,complete:true,...overrides
});
const strong='Strong Club',weak='Weak Club',middle=['Mid A','Mid B','Mid C','Mid D','Mid E'];
let hist=[];
for(let i=0;i<10;i++){
  const mid=middle[i%middle.length];
  hist.push(game(strong,mid,3,0,i*4));
  hist.push(game(mid,strong,0,2,i*4+1));
  hist.push(game(weak,mid,0,2,i*4+2));
  hist.push(game(mid,weak,2,0,i*4+3));
}
const fixture={leagueId:league,date:kickoff,homeName:weak,awayName:strong,homeId:weak,awayId:strong};

test('Dixon-Coles matrix normalizes to one',()=>{
 const g=scoreMatrix(1.3,1.6);
 assert.ok(Math.abs(g.reduce((s,x)=>s+x.p,0)-1)<1e-10);
});

test('stronger away team outranks weaker home team; no team-specific overrides',()=>{
 const m=calculateMatchV2(fixture,hist);
 assert.ok(m.probabilities['2']>m.probabilities['1'],JSON.stringify(m.probabilities));
 assert.ok(m.eloAway>m.eloHome);
 assert.ok(m.lambdaAway>m.lambdaHome);
});

test('probabilities add to one and fair odds are true reciprocals',()=>{
 const m=calculateMatchV2(fixture,hist);
 const sum=Object.values(m.probabilities).reduce((a,b)=>a+b,0);
 assert.ok(Math.abs(sum-1)<1e-10);
 for(const [k,v] of Object.entries(m.probabilities))assert.ok(Math.abs(m.fairOdds[k]*v-1)<1e-10);
 assert.equal(m.tip,'NO VERIFIED PRICE');
});

test('xG must be actual explicit numeric value, zero is valid, unknown stays null',()=>{
 assert.equal(validXg(null),null);
 assert.equal(validXg(undefined),null);
 assert.equal(validXg(0),0);
 assert.equal(validXg('2.5'),2.5);
 assert.equal(validXg(-1),null);
 assert.deepEqual(extractESPNxG({competitors:[]}),{homeXg:null,awayXg:null,xgSource:null});
 const c={competitors:[
  {homeAway:'home',statistics:[{name:'expectedGoals',displayValue:'1.4'}]},
  {homeAway:'away',statistics:[{name:'expectedGoals',displayValue:'0.6'}]}
 ]};
 assert.equal(extractESPNxG(c).homeXg,1.4);
});

test('reported confirmed player absences cause only bounded changes',()=>{
 const neutral={...fixture,homeName:'Mid A',homeId:'Mid A',awayName:'Mid B',awayId:'Mid B'};
 const base=calculateMatchV2(neutral,hist);
 const availability={injuries:{verified:true,source:'test verified provider',home:[{name:'A',status:'Out',confirmedOut:true,suspended:false}],away:[]},
   suspensions:{verified:false,home:[],away:[]},predictedLineups:{verified:false}};
 const changed=calculateMatchV2(neutral,hist,availability);
 assert.ok(changed.lambdaHome<base.lambdaHome);
 assert.ok(changed.availabilityAdjustments.homeAttack<1);
 assert.ok(changed.availabilityAdjustments.homeAttack>.90);
 assert.equal(availabilityGoalFactors({}).homeAttack,1);
});

test('no source evidence is reported as unknown, not fully fit',()=>{
 const got=espnAvailability({injuries:[]},fixture);
 assert.equal(got.injuries.verified,false);
 assert.equal(got.predictedLineups.verified,false);
});
test('team-identified injury status parses without pretending doubtful is out',()=>{
 const got=espnAvailability({injuries:[
 {team:{id:weak},athlete:{displayName:'A'},status:'Out',detail:'Knee'},
 {team:{id:strong},athlete:{displayName:'B'},status:'Questionable',detail:'Ankle'}
 ]},fixture);
 assert.equal(got.injuries.home.length,1);
 assert.equal(got.injuries.home[0].confirmedOut,true);
 assert.equal(got.injuries.away[0].confirmedOut,false);
});
test('licensed projected XI requires named source, correct team/competition/date and 11 names',()=>{
 const record={leagueId:league,date:kickoff,homeName:weak,awayName:strong,
  source:'Licensed test source',observedAt:kickoff,
  predictedLineups:{home:{predicted:true,players:Array.from({length:11},(_,i)=>'Home '+i)},
    away:{predicted:true,players:Array.from({length:11},(_,i)=>'Away '+i)}}};
 const result=mergeLicensedMatchData(fixture,record);
 assert.equal(result.predictedLineups.verified,true);
 assert.equal(mergeLicensedMatchData(fixture,{...record,date:'2020-01-01T00:00:00Z'}),null);
});
