import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePitchShots,pitchMatchIdentity,enrichPitchHistory} from '../pitchapi.mjs';
test('PitchAPI verified shot xG is assigned to the correct side',()=>{
 const m={home_team:{id:'t_a',name:'Home'},away_team:{id:'t_b',name:'Away'}};
 const data={periods:[{shots:[{team_id:'t_a',expected_goals:.3},{team_id:'t_b',expected_goals:.15},{team_id:'t_a',expected_goals:.2}]}]};
 assert.deepEqual(parsePitchShots(m,data),{homeXg:.5,awayXg:.15,xgSource:'PitchAPI verified shot-level xG'});
});
test('PitchAPI never converts missing xG to zero',()=>{
 assert.equal(parsePitchShots({home_team:{id:'a'},away_team:{id:'b'}},{periods:[{shots:[]}]}),null);
});
test('PitchAPI identity requires both clubs and aligned kickoff',()=>{
 const p={home_team:{name:'Home'},away_team:{name:'Away'},time_utc:'2026-11-02T17:00:00Z'};
 assert.equal(pitchMatchIdentity(p,{homeName:'Home',awayName:'Away',date:p.time_utc}),true);
 assert.equal(pitchMatchIdentity(p,{homeName:'Away',awayName:'Home',date:p.time_utc}),false);
});
test('no PitchAPI key leaves all historical records unchanged',async()=>{
 const rows=[{id:'a'}];const r=await enrichPitchHistory(rows,null);
 assert.deepEqual(r.history,rows);assert.equal(r.status.configured,false);
});
