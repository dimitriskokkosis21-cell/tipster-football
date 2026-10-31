import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalSpanishTeam,mergeSpanishFixtures,loadLaLiga} from '../laliga.mjs';
const date=t=>new Date(t).toISOString().slice(0,10);
const mk=(home,away,d,source)=>({id:home+'-'+source,homeName:home,awayName:away,date:d+'T17:00:00Z',leagueId:'esp.1',source,complete:false});
test('canonical names merge provider variants of LaLiga clubs',()=>{
 assert.equal(canonicalSpanishTeam('Real Racing Club de Santander'),canonicalSpanishTeam('Racing Santander'));
 assert.equal(canonicalSpanishTeam('Club Atlético de Madrid'),canonicalSpanishTeam('Atletico Madrid'));
 assert.equal(canonicalSpanishTeam('FC Barcelona'),canonicalSpanishTeam('Barcelona'));
 assert.notEqual(canonicalSpanishTeam('Real Sociedad'),canonicalSpanishTeam('Real Madrid'));
 assert.equal(canonicalSpanishTeam('Deportivo A Coruña'),canonicalSpanishTeam('Deportivo'));
 assert.equal(canonicalSpanishTeam('RC Deportivo'),canonicalSpanishTeam('Deportivo'));
 assert.equal(canonicalSpanishTeam('Espanyol Barcelona'),canonicalSpanishTeam('Espanyol'));
 assert.notEqual(canonicalSpanishTeam('Espanyol Barcelona'),canonicalSpanishTeam('Barcelona'));
});
test('daily ESPN gaps are filled by independent schedule without duplicates',()=>{
 const open=[mk('Levante UD','Club Atlético de Madrid','2026-10-31','OpenLigaDB'),
   mk('Rayo Vallecano','RC Celta Vigo','2026-10-31','OpenLigaDB'),
   mk('Real Betis','Málaga CF','2026-10-31','OpenLigaDB'),
   mk('FC Barcelona','Deportivo Alavés','2026-10-31','OpenLigaDB'),
   mk('Getafe CF','Sevilla FC','2026-11-01','OpenLigaDB'),
   mk('Racing Santander','Real Madrid CF','2026-11-01','OpenLigaDB'),
   mk('Elche CF','Valencia CF','2026-11-01','OpenLigaDB'),
   mk('Athletic Club','Real Sociedad','2026-11-01','OpenLigaDB'),
   mk('RC Deportivo','CA Osasuna','2026-11-02','OpenLigaDB'),
   mk('Espanyol Barcelona','Deportivo A Coruña','2026-11-07','OpenLigaDB')];
 const espn=[mk('Levante','Atletico Madrid','2026-10-31','ESPN (unofficial)'),
  mk('Barcelona','Alaves','2026-10-31','ESPN (unofficial)'),
  mk('Deportivo','Osasuna','2026-11-02','ESPN (unofficial)'),
  mk('Espanyol','Deportivo','2026-11-07','ESPN (unofficial)')];
 const merged=mergeSpanishFixtures([open,espn],date);
 assert.equal(merged.length,10);
 assert.equal(merged.find(x=>canonicalSpanishTeam(x.homeName)==='barcelona').source,'ESPN (unofficial)');
});
test('fixture adapter loads real-shaped independent sources and avoids blocked history and injuries',async()=>{
 const espnEvent=(name,away,dateId,id)=>({id,date:dateId+'T17:00:00Z',status:{type:{completed:false}},
  competitions:[{competitors:[{homeAway:'home',team:{displayName:name,id:name}},
  {homeAway:'away',team:{displayName:away,id:away}}]}]});
 const open=[
  {matchID:123,team1:{teamName:'Levante UD',teamId:1},team2:{teamName:'Atletico Madrid',teamId:2},matchDateTimeUTC:'2026-10-31T17:00:00Z',matchIsFinished:false},
  {matchID:124,team1:{teamName:'Getafe CF',teamId:3},team2:{teamName:'Sevilla FC',teamId:4},matchDateTimeUTC:'2026-11-01T17:00:00Z',matchIsFinished:false}
 ];
 let calls=[];
 const remote=async(url)=>{calls.push(url);
  if(url.includes('la1/2026'))return open;
  if(url.includes('scoreboard?dates=20261031'))return {events:[espnEvent('Levante','Atletico Madrid','2026-10-31','abc')]};
  if(url.includes('/scoreboard?'))return {events:[]};
  throw Error('offline');
 };
 const l={id:'esp.1',name:'La Liga'};
 const fromOpen=e=>mk(e.team1.teamName,e.team2.teamName,e.matchDateTimeUTC.slice(0,10),'OpenLigaDB');
 const fromESPN=e=>mk(e.competitions[0].competitors[0].team.displayName,e.competitions[0].competitors[1].team.displayName,e.date.slice(0,10),'ESPN (unofficial)');
 const ctx={remote,fromOpen,fromESPN,athens:date,dadd:(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10),cache:new Map(),ESPN:'https://fake/'};
 const r=await loadLaLiga(l,'2026-10-31','2026-11-07',false,ctx);
 assert.equal(r.fixtures.length,2);
 assert.equal(r.report.provider,'OpenLigaDB + ESPN day-by-day');
 assert.ok(calls.some(u=>u.includes('scoreboard?dates=20261101')));
});
