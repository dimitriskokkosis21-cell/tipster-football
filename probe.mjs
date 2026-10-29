async function probe() {
  const base='https://site.api.espn.com/apis/site/v2/sports/soccer/';
  const fetchJson=async url=>{let r=await fetch(url,{signal:AbortSignal.timeout(9000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json()};
  for(const l of ['gre.1','eng.1']){
    try{
      const j=await fetchJson(base+l+'/scoreboard?dates=2026&limit=1000');
      const ev=(j.events||[]).filter(e=>e.status?.type?.completed||e.competitions?.[0]?.status?.type?.completed).slice(-1)[0];
      const team=ev?.competitions?.[0]?.competitors?.[0];
      console.log('TIPSTER SCHEMA PROBE',JSON.stringify({league:l,event:ev?.id,team:team?.team?.id,compKeys:Object.keys(ev?.competitions?.[0]||{}),teamKeys:Object.keys(team||{}),teamXgStats:team?.statistics?.filter?.(x=>/expected|xg|xga/i.test(x.name+' '+x.label)).slice(0,6),teamStatistics:team?.statistics?.slice?.(0,5)}).slice(0,1300));
      if(ev){
        const s=await fetchJson(base+l+'/summary?event='+ev.id);
        const teams=s.boxscore?.teams||[];
        console.log('TIPSTER SUMMARY PROBE',JSON.stringify({league:l,keys:Object.keys(s),boxTeams:teams.map(x=>({team:x.team?.displayName,xgStats:x.statistics?.filter?.(y=>/expected|xg|xga/i.test(y.name+' '+y.label)),stats:x.statistics?.slice?.(0,4),keys:Object.keys(x)})),statsKeys:s.statistics&&Object.keys(s.statistics),injuryShape:s.injuries&&Object.keys(s.injuries)}).slice(0,2300));
        if(team?.team?.id){
          try{
           const z=await fetchJson(base+l+'/teams/'+team.team.id+'/injuries');
           console.log('TIPSTER TEAM INJURY PROBE',JSON.stringify({league:l,keys:Object.keys(z),first:(z.injuries||[])[0]}).slice(0,1300));
          }catch(e){console.log('TIPSTER TEAM INJURY PROBE ERROR '+l+' '+e.message)}
        }
      }
      try{
        const z=await fetchJson(base+l+'/injuries');
        console.log('TIPSTER LEAGUE INJURY PROBE',JSON.stringify({league:l,keys:Object.keys(z),count:z.injuries?.length,first:(z.injuries||z.teams||[])[0]}).slice(0,1300));
      }catch(e){console.log('TIPSTER LEAGUE INJURY PROBE ERROR '+l+' '+e.message)}
    }catch(e){console.log('TIPSTER SCHEMA PROBE ERROR '+l+' '+e.message)}
  }
}
setTimeout(probe,2000);
