/**
 * LaLiga resilience adapter.
 * Each ESPN day is fetched separately because recent ESPN range URLs fail,
 * and the large annual endpoint periodically times out. A second independent
 * OpenLigaDB community schedule is merged, with source-aware de-duplication.
 *
 * No synthetic or manually invented fixture entries.
 */
export function canonicalSpanishTeam(value){
 const name=String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 const keys=[
  [/racing|santander/,'racing-santander'],[/deportivo (de )?la coruna|deportivo a coruna|(?:^|\s)deportivo(?:\s|$)|dep\. a coruna/,'deportivo-coruna'],
  [/real sociedad/,'real-sociedad'],[/real madrid/,'real-madrid'],
  [/atletico madrid|atletico de madrid|club atletico/,'atletico-madrid'],
  [/athletic (club|bilbao)/,'athletic-bilbao'],
  [/rayo vallecano/,'rayo-vallecano'],[/celta/,'celta-vigo'],
  [/real betis|\bbetis\b/,'real-betis'],[/malaga/,'malaga'],
  [/espanyol/,'espanyol'],[/\bbarcelona\b/,'barcelona'],[/alaves/,'alaves'],
  [/getafe/,'getafe'],[/sevilla/,'sevilla'],
  [/elche/,'elche'],[/valencia/,'valencia'],
  [/osasuna/,'osasuna'],[/levante/,'levante'],
  [/villarreal/,'villarreal'],
  [/girona/,'girona'],[/mallorca/,'mallorca'],
  [/oviedo/,'oviedo'],[/las palmas/,'las-palmas'],
  [/granada/,'granada']
 ];
 for(const [rx,id] of keys)if(rx.test(name))return id;
 return name.replace(/[^a-z0-9]/g,'');
}
export function spanishFixtureKey(m,localDate){
 return localDate+'|'+canonicalSpanishTeam(m.homeName)+'|'+canonicalSpanishTeam(m.awayName);
}
export function mergeSpanishFixtures(lists,athens){
 const result=new Map();
 for(const list of lists){
  for(const m of list||[]){
   if(!m||!m.homeName||!m.awayName||!m.date)continue;
   const day=athens(new Date(m.date));
   const k=spanishFixtureKey(m,day);
   if(!result.has(k))result.set(k,m);
   else{
    const prev=result.get(k);
    // Prefer ESPN logos, IDs and observed stats where both feeds agree.
    if(m.source?.startsWith('ESPN')&&!prev.source?.startsWith('ESPN'))result.set(k,m);
   }
  }
 }
 return [...result.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export async function loadLaLiga(l,today,end,force,ctx){
 const {remote,fromESPN,fromOpen,athens,dadd,cache,ESPN}=ctx;
 const dayCount=Math.round((Date.parse(end+'T12:00:00Z')-Date.parse(today+'T12:00:00Z'))/86400000);
 const days=Array.from({length:Math.min(10,dayCount+1)},(_,i)=>dadd(today,i));
 const year=Number(today.slice(0,4))-(Number(today.slice(5,7))<7?1:0);
 const urlOL='https://api.openligadb.de/getmatchdata/la1/'+year;
 const urls=days.map(day=>ESPN+l.id+'/scoreboard?dates='+day.replaceAll('-','')+'&limit=150');
 const settled=await Promise.allSettled([
  remote(urlOL,600000,force,8500),
  ...urls.map(url=>remote(url,600000,force,6500))
 ]);
 const openOk=settled[0].status==='fulfilled'&&Array.isArray(settled[0].value);
 const openMatches=openOk?settled[0].value.map(e=>fromOpen(e,l)).filter(Boolean):[];
 const responses=settled.slice(1);
 const espnOK=responses.filter(x=>x.status==='fulfilled'&&Array.isArray(x.value?.events));
 const espnMatches=espnOK.flatMap(x=>x.value.events.map(e=>fromESPN(e,l)).filter(Boolean));
 const all=mergeSpanishFixtures([openMatches,espnMatches],athens);
 const fixtures=all.filter(m=>!m.complete&&athens(new Date(m.date))>=today&&athens(new Date(m.date))<=end);
 const history=all.filter(m=>m.complete&&athens(new Date(m.date))<today);
 const annual=ESPN+l.id+'/scoreboard?dates='+today.slice(0,4)+'&limit=1000';
 const oldAnnual=cache.get(annual)?.body;
 if(Array.isArray(oldAnnual?.events)){
  history.push(...oldAnnual.events.map(e=>fromESPN(e,l)).filter(m=>m?.complete&&athens(new Date(m.date))<today));
 }else if(espnOK.length){
  // Fetching 16MB of old scores is a *background enrichment*, not a user-facing
  // fixture dependency. It becomes available to models on the next refresh.
  void remote(annual,86400000,false,14500).catch(()=>{});
 }
 const pastYear=year-1,olderUrl='https://api.openligadb.de/getmatchdata/la1/'+pastYear;
 const older=cache.get(olderUrl)?.body;
 if(Array.isArray(older))history.push(...older.map(e=>fromOpen(e,l)).filter(m=>m?.complete));
 else if(openOk)void remote(olderUrl,86400000,false,9000).catch(()=>{});
 const historyMap=new Map();
 for(const m of history)historyMap.set(spanishFixtureKey(m,athens(new Date(m.date))),m);
 const missingDays=responses.length-espnOK.length;
 const sources=[openOk?'OpenLigaDB':'',espnOK.length?'ESPN day-by-day':''].filter(Boolean);
 const report={league:l.name,provider:sources.join(' + ')||'UNAVAILABLE',
  fixtures:fixtures.length,history:historyMap.size,missingDays,
  warning:[
   !openOk?'OpenLigaDB Spanish schedule unavailable':null,
   missingDays?'ESPN daily schedule unavailable for '+missingDays+' of '+days.length+' dates':null,
   fixtures.length===0?'No upcoming LaLiga matches returned from available sources':null
  ].filter(Boolean).join('; ')||null};
 if(!openOk&&!espnOK.length)throw Error('Neither ESPN daily scores nor OpenLigaDB LaLiga fixtures could be retrieved');
 const injuryUrl=ESPN+l.id+'/injuries';
 const injuries=cache.get(injuryUrl)?.body||null;
 if(!injuries)void remote(injuryUrl,7200000,false,5000).catch(()=>{});
 return {fixtures,history:[...historyMap.values()],injuries,report};
}