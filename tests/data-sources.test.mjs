import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStrikerXG,matchStrikerXG,parseAPIFootballReports,matchAPIFootballReports} from '../data-sources.mjs';
import {calculateMatchV2} from '../model-v2.mjs';
test('Striker API xG parser preserves source values and ignores missing records',()=>{
 const rows={data:{teams:[
  {display_name:'FC Barcelona',games:10,xg_for:2.1,xg_against:0.8},
  {display_name:'Deportivo Alaves',games:10,xg_for:1.0,xg_against:1.4},
  {display_name:'Real Madrid',games:10,xg_for:1.9,xg_against:1.1},
  {display_name:'Atlético Madrid',games:10,xg_for:1.8,xg_against:0.9},
  {display_name:'Rayo Vallecano',games:10,xg_for:null,xg_against:0}
 ]}};
 const data=parseStrikerXG(rows);
 assert.equal(data.teams.size,4);
 const match={homeName:'Barcelona',awayName:'Alaves'};
 const found=matchStrikerXG(match,data);
 assert.equal(found.verified,true);
 assert.equal(found.home.xgFor,2.1);
 assert.equal(found.away.xgAgainst,1.4);
 assert.equal(matchStrikerXG({homeName:'No Match',awayName:'Alaves'},data),null);
});
test('API-Football reported absences are linked to exact fixture IDs and actual teams',()=>{
 const fixtures={response:[{fixture:{id:999,date:'2026-10-31T19:00:00Z'},teams:{home:{name:'FC Barcelona'},away:{name:'Deportivo Alaves'}}}]};
 const injuries={response:[
  {fixture:{id:999},team:{name:'FC Barcelona'},player:{name:'Test striker',type:'Missing Fixture',reason:'Knee injury'}},
  {fixture:{id:999},team:{name:'Deportivo Alaves'},player:{name:'Test defender',type:'Questionable',reason:'Muscle fatigue'}},
  {fixture:{id:888},team:{name:'FC Barcelona'},player:{name:'Irrelevant',type:'Missing Fixture'}}
 ]};
 const parsed=parseAPIFootballReports(fixtures,injuries);
 assert.equal(parsed.length,1);
 const fixture={homeName:'Barcelona',awayName:'Alaves',date:'2026-10-31T19:00:00Z'};
 const result=matchAPIFootballReports(fixture,parsed);
 assert.equal(result.injuries.home[0].confirmedOut,true);
 assert.equal(result.injuries.away[0].confirmedOut,false);
 assert.equal(result.injuries.home.length,1);
 assert.equal(matchAPIFootballReports({...fixture,date:'2026-11-10T19:00:00Z'},parsed),null);
});
test('verified season xG and xGA blend alters goals rate only when both clubs covered',()=>{
 const league='esp.1',h=[],teams=['Barcelona','Alaves','Real Madrid','Atletico Madrid'];
 for(let i=0;i<48;i++){
  const a=teams[i%4],b=teams[(i+1)%4];
  h.push({leagueId:league,date:new Date(Date.parse('2026-09-01T17:00:00Z')+i*10800000).toISOString(),
   homeName:a,awayName:b,homeId:a,awayId:b,homeScore:2,awayScore:1,complete:true});
 }
 const f={leagueId:league,date:'2026-10-31T19:00:00Z',homeName:'Barcelona',awayName:'Alaves',homeId:'Barcelona',awayId:'Alaves'};
 const plain=calculateMatchV2(f,h);
 const rich=calculateMatchV2(f,h,{xgSeason:{verified:true,source:'Test source from real shot observations',
  home:{xgFor:2.2,xgAgainst:.6,games:10},away:{xgFor:.8,xgAgainst:1.9,games:10},leagueAvgXgAgainst:1.2}});
 assert.ok(rich.lambdaHome>plain.lambdaHome);
 assert.equal(rich.xgSource,'Test source from real shot observations');
 assert.equal(rich.homeXg,2.2);
});
