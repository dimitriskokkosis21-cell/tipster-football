import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const page=readFileSync(fileURLToPath(new URL('../public/index.html',import.meta.url)),'utf8');
const script=page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
test('Safari inline script is valid JavaScript',()=>{
 assert.ok(script,'Missing browser script');
 assert.doesNotThrow(()=>new vm.Script(script));
});
test('realistic verified fixture JSON renders a match card without a browser exception',async()=>{
 const elements=new Map();
 const get=id=>{
  if(!elements.has(id))elements.set(id,{value:id==='league'?'all':'kickoff',innerHTML:'',textContent:'',disabled:false,
   classList:{toggle:()=>{}},setAttribute:()=>{},addEventListener:()=>{}});
  return elements.get(id);
 };
 const fixture={id:'test',leagueId:'gre.1',league:'Greek Super League',
  date:'2026-10-31T17:00:00.000Z',homeName:'Test Home',awayName:'Test Away',
  homeLogo:null,awayLogo:null,source:'ESPN',sourceUrl:'https://www.espn.com/',
  model:{
   probabilities:{'1':.45,'X':.27,'2':.28},fairOdds:{'1':2.222,'X':3.704,'2':3.571},
   prediction:'1',tip:'NO VERIFIED PRICE',requiredOdds:{'1':2.88,'X':5,'2':5},
   lambdaHome:1.7,lambdaAway:1.1,topScores:[{score:'1-0',probability:.12}],
   over25:.48,btts:.55,eloHome:1570,eloAway:1490,homeXg:null,homeXga:null,awayXg:null,awayXga:null,
   verifiedXgMatches:0,missing:['Verified xG'],reasoning:'Source-based estimate',
   quality:'RESULTS + ELO',leagueSample:110,homeSample:12,awaySample:11,
   formHome:[],formAway:[],availability:{injuries:{verified:false,home:[],away:[]},
    suspensions:{verified:false,home:[],away:[]},predictedLineups:{verified:false,home:[],away:[]}}
  }
 };
 const data={matches:[fixture],meta:{today:'2026-10-30',updatedAt:'2026-10-30T17:00:00.000Z',
  historyMatches:100,coverageIncomplete:false,sourceStatus:[{league:'Greek Super League',provider:'ESPN',fixtures:1,history:100}]}};
 const errors=[];
 const sandbox={
  document:{getElementById:get,querySelectorAll:()=>[]},
  console:{...console,error:(...args)=>errors.push(args)},
  fetch:async()=>({ok:true,json:async()=>data}),
  setTimeout,clearTimeout,AbortController,
  sessionStorage:{setItem:()=>{},getItem:()=>null}
 };
 // The fixture is shown in 'week' view regardless of the test machine's timezone.
 vm.runInNewContext(script,sandbox,{timeout:2000});
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.deepEqual(errors,[]);
 assert.match(get('cards').innerHTML,/Test Home/);
 assert.match(get('cards').innerHTML,/Test Away/);
 assert.match(get('cards').innerHTML,/45\.0%/);
 assert.match(get('state').textContent,/LIVE/);
 assert.equal(get('numMatches').textContent,1);
});
