'use strict';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Number(value).toLocaleString('en-US');
const shortDate = value => new Date(value + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric'});
const longDate = value => new Date(value + 'T12:00:00').toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'});
const initials = name => name.split(/\s+/).filter(Boolean).map(x=>x[0]).slice(0,2).join('');
const score = row => row.score_to_par === null ? (row.score_text || '—') : row.score_to_par === 0 ? 'E' : row.score_to_par > 0 ? `+${row.score_to_par}` : String(row.score_to_par);
const eventKey = row => `${row.org_id}/${row.season_year}/${row.tournament_id}`;
const playerKey = row => `${row.org_id}/${row.player_id}`;
const state = {data:null, season:'2026', view:'overview', metric:'top_10s', search:'', page:0, sort:'wins', descending:true, event:null, player:null, eventSearch:'', eventSort:'finish_rank', eventDescending:false};
let exportRows = [];
let toastTimer;
let images = {players:{}, tournaments:{}};

function avatar(id, name, size='') {
  const photo = images.players?.[id];
  return photo?.status === 'available'
    ? `<img class="headshot ${size}" src="${escapeHtml(photo.path)}" alt="" loading="lazy">`
    : `<span class="initials ${size}" aria-hidden="true">${escapeHtml(initials(name || ''))}</span>`;
}

function logo(tournamentId, size='') {
  const art = images.tournaments?.[tournamentId];
  return art?.status === 'available' ? `<img class="event-logo ${size}" src="${escapeHtml(art.path)}" alt="" loading="lazy">` : '';
}

const countryOf = id => state.data?.countries?.[id];

function flag(id) {
  const c = countryOf(id);
  if (!c) return '';
  const art = images.flags?.[c.code];
  return art?.status === 'available'
    ? `<img class="flag" src="${escapeHtml(art.path)}" alt="${escapeHtml(c.country)}" title="${escapeHtml(c.country)}" loading="lazy">`
    : `<span class="flag-code" title="${escapeHtml(c.country)}">${escapeHtml(c.code || c.country)}</span>`;
}

const teamMember = p => `<span class="team-member">${avatar(p.playerId, `${p.firstName} ${p.lastName}`, 'small')}${escapeHtml(`${p.firstName} ${p.lastName}`)}${flag(p.playerId)}</span>`;

function seasonData() {
  const players = state.data.players.filter(x=>x.season_year === state.season);
  const teams = state.data.teams.filter(x=>x.season_year === state.season);
  const summaries = state.data.summaries.filter(x=>x.season_year === state.season).map(x=>({...x, top10_rate:x.events_played ? x.top_10s / x.events_played * 100 : 0}));
  const eventMap = new Map();
  for (const row of [...players, ...teams]) {
    const key = eventKey(row);
    if (!eventMap.has(key)) eventMap.set(key, {key, tid:row.tournament_id, name:row.tournament_name, date:row.event_end_date, type:row.team_id ? 'team' : 'individual', rows:[]});
    eventMap.get(key).rows.push(row);
  }
  const events = [...eventMap.values()].sort((a,b)=>b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return {players, teams, summaries, events};
}

function metric(label, value, note, icon, dark=false) {
  return `<div class="metric ${dark?'dark':''}"><div class="metric-label">${label}<span class="metric-icon" aria-hidden="true">${icon}</span></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`;
}

function rankedSummaries(rows) {
  return [...rows].sort((a,b)=> {
    const av = a[state.sort], bv = b[state.sort];
    const compare = typeof av === 'string' ? av.localeCompare(bv) : av-bv;
    return (state.descending ? -compare : compare) || b.wins-a.wins || b.top_10s-a.top_10s || a.player_name.localeCompare(b.player_name);
  });
}

function playerButton(row) {
  return `<button class="name-button" data-player="${escapeHtml(playerKey(row))}">${escapeHtml(row.player_name)}</button>${flag(row.player_id)}`;
}

function sortHeader(label, key, scope='season', numeric=true) {
  const current = scope === 'season' ? state.sort : state.eventSort;
  const desc = scope === 'season' ? state.descending : state.eventDescending;
  return `<th class="${numeric?'num':''}" aria-sort="${current===key?(desc?'descending':'ascending'):'none'}"><button data-sort="${key}" data-scope="${scope}">${label} ${current===key?(desc?'↓':'↑'):'↕'}</button></th>`;
}

function seasonTable(data) {
  const rows = rankedSummaries(data.summaries.filter(x=>x.player_name.toLowerCase().includes(state.search.toLowerCase())));
  const pages = Math.max(1, Math.ceil(rows.length/8));
  state.page = Math.min(state.page, pages-1);
  exportRows = rows.map(({player_id,player_name,events_played,wins,top_10s,cuts,top10_rate})=>({player_name,country:countryOf(player_id)?.country||'',events_played,wins,top_10s,cuts,top_10_percent:top10_rate.toFixed(1)}));
  const visible = rows.slice(state.page*8, state.page*8+8);
  return `<section class="panel overview-table" aria-label="Season leaderboard"><div class="panel-header"><div><h2>Season leaderboard <span class="count-chip">${number(data.summaries.length)} players</span></h2><p class="panel-subtitle">Individual events · Click a player to explore their season.</p></div><div class="search-wrap"><span aria-hidden="true">⌕</span><input class="search" id="player-search" type="search" aria-label="Search season leaderboard" placeholder="Search players…" value="${escapeHtml(state.search)}"></div></div><div class="table-space"></div><div class="table-scroll"><table><thead><tr><th>#</th>${sortHeader('Player','player_name','season',false)}${sortHeader('Events','events_played')}${sortHeader('Wins','wins')}${sortHeader('Top 10s','top_10s')}${sortHeader('Top 10 rate','top10_rate')}${sortHeader('Cuts','cuts')}</tr></thead><tbody>${visible.map((p,i)=>`<tr><td class="rank">${String(state.page*8+i+1).padStart(2,'0')}</td><td><div class="player-cell">${avatar(p.player_id, p.player_name)}${playerButton(p)}</div></td><td class="num">${p.events_played}</td><td class="num"><span class="${p.wins?'badge win':''}">${p.wins}</span></td><td class="num">${p.top_10s}</td><td class="num"><span class="top10-rate" aria-hidden="true"><i style="width:${p.top10_rate}%"></i></span>${Math.round(p.top10_rate)}%</td><td class="num subtle">${p.cuts}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No players match your search.</td></tr>'}</tbody></table></div><div class="panel-footer"><span>${rows.length?`${number(state.page*8+1)}–${number(Math.min((state.page+1)*8,rows.length))} of ${number(rows.length)} players`:'0 players'}</span><div class="pagination"><button data-page="-1" aria-label="Previous page" ${state.page===0?'disabled':''}>←</button><span>${state.page+1} / ${pages}</span><button data-page="1" aria-label="Next page" ${state.page===pages-1?'disabled':''}>→</button></div></div></section>`;
}

function overview(data) {
  const leaders = [...data.summaries].sort((a,b)=>b[state.metric]-a[state.metric] || b.wins-a.wins || b.top_10s-a.top_10s || a.player_name.localeCompare(b.player_name)).slice(0,8);
  const max = Math.max(1,...leaders.map(x=>x[state.metric]));
  const latest = data.events[0];
  const winners = latest?.rows.filter(x=>x.finish_position === '1' || x.finish_position === 'T1') || [];
  const winningNames = winners.map(x=>x.player_name || x.players.map(p=>`${p.firstName} ${p.lastName}`).join(' & ')).join(', ');
  const dates = data.events.map(x=>x.date).sort();
  return `<div class="metrics">${metric('Completed tournaments',number(data.events.length),`${data.events.filter(x=>x.type==='individual').length} individual · ${data.events.filter(x=>x.type==='team').length} team`,'⚑',true)}${metric('Players in the field',number(data.summaries.length),'Across individual tournaments','◎')}${metric('Leaderboard records',number(data.players.length+data.teams.length),`${number(data.players.length)} player · ${number(data.teams.length)} team`,'▤')}${metric('Tournament winners',number(data.summaries.filter(x=>x.wins>0).length),'Unique individual-event winners','♧')}</div>
  <div class="grid-main"><section class="panel"><div class="panel-header"><div><h2>The season’s standouts</h2><p class="panel-subtitle">${state.metric==='top_10s'?'Most top-ten finishes':'Most tournament victories'} · Individual events</p></div><div class="segmented" aria-label="Chart metric"><button data-metric="top_10s" class="${state.metric==='top_10s'?'selected':''}" aria-pressed="${state.metric==='top_10s'}">Top 10s</button><button data-metric="wins" class="${state.metric==='wins'?'selected':''}" aria-pressed="${state.metric==='wins'}">Wins</button></div></div><div class="bars">${leaders.map(p=>`<button class="bar-row" data-player="${escapeHtml(playerKey(p))}" aria-label="${escapeHtml(p.player_name)}, ${p[state.metric]} ${state.metric==='wins'?'wins':'top tens'}. View player."><span class="bar-name">${avatar(p.player_id, p.player_name, 'small')}<span>${escapeHtml(p.player_name)}</span>${flag(p.player_id)}</span><span class="bar-track"><i class="bar-fill" style="width:${p[state.metric]/max*100}%"></i></span><span class="bar-value">${p[state.metric]}</span></button>`).join('')}</div><p class="chart-note">${dates.length?`${shortDate(dates[0])} – ${shortDate(dates[dates.length-1])}, ${escapeHtml(state.season)}`:'No completed events'} · Only events in this dataset</p></section>
  <section class="panel"><div class="panel-header"><div><h2>On the leaderboard</h2><p class="panel-subtitle">The latest completed tournaments</p></div><button class="text-link" data-view="tournaments">View all ↗</button></div>${latest?`<div class="latest-event">${logo(latest.tid, 'corner')}<div class="eyebrow">LATEST FINISH · ${escapeHtml(shortDate(latest.date).toUpperCase())}</div><h3>${escapeHtml(latest.name)}</h3><p>${latest.rows.length} ${latest.type==='team'?'teams':'players'} · Official result</p><div class="latest-winner"><span class="winner-faces">${winners.flatMap(w=>w.player_id?[{id:w.player_id,name:w.player_name}]:w.players.map(p=>({id:p.playerId,name:`${p.firstName} ${p.lastName}`}))).map(p=>avatar(p.id,p.name)).join('')}</span><div class="name">${escapeHtml(winningNames || 'No winner recorded')}<small>${latest.type==='team'?'Winning team':'Tournament winner'}</small></div><span class="score-pill">${winners.length?escapeHtml(score(winners[0])):'—'}</span></div></div><div class="event-list">${data.events.slice(1,4).map(event=>`<button class="event-row" data-event="${escapeHtml(event.key)}"><span class="date-box">${event.date.slice(-2)}<small>${new Date(event.date+'T12:00:00').toLocaleDateString('en-US',{month:'short'}).toUpperCase()}</small></span>${logo(event.tid)}<span class="event-row-title">${escapeHtml(event.name)}<small>${event.rows.length} ${event.type==='team'?'teams':'players'}</small></span><span class="arrow" aria-hidden="true">↗</span></button>`).join('')}</div>`:'<div class="empty">No completed tournaments yet.</div>'}</section></div><div id="season-table">${seasonTable(data)}</div>`;
}

function eventRank(row) {
  if (row.finish_rank !== undefined) return row.finish_rank;
  return /^T?\d+$/.test(row.finish_position || '') ? Number(row.finish_position.replace('T','')) : null;
}

function sortResults(rows) {
  return [...rows].sort((a,b)=> {
    const av = state.eventSort==='finish_rank' ? eventRank(a) : a[state.eventSort];
    const bv = state.eventSort==='finish_rank' ? eventRank(b) : b[state.eventSort];
    if (av===null || av===undefined) return bv===null || bv===undefined ? 0 : 1;
    if (bv===null || bv===undefined) return -1;
    const compare = typeof av === 'string' ? av.localeCompare(bv) : av-bv;
    return (state.eventDescending ? -compare : compare) || (a.player_name||a.team_id).localeCompare(b.player_name||b.team_id);
  });
}

function eventTable(event) {
  const team = event.type==='team';
  const matches = row => (team ? row.players.map(p=>`${p.firstName} ${p.lastName}`).join(' ') : row.player_name).toLowerCase().includes(state.eventSearch.toLowerCase());
  const rows = sortResults(event.rows.filter(matches));
  exportRows = rows.map(row=>({tournament:event.name, date:event.date, type:event.type, name:team?row.players.map(p=>`${p.firstName} ${p.lastName}`).join(' / '):row.player_name, position:row.finish_position, score_to_par:row.score_to_par, score_text:row.score_text, ...(team?{}:{country:countryOf(row.player_id)?.country||'',rounds_played:row.rounds_played,status:row.player_status})}));
  return `<section class="panel"><div class="panel-header"><div><h2>${team?'Team leaderboard':'Final leaderboard'}</h2><p class="panel-subtitle">${team?'Scores belong to the team, not each individual player.':'T = tied finish · CUT = missed cut · WD = withdrawn · E = even par'}</p></div><div class="search-wrap"><span aria-hidden="true">⌕</span><input class="search" id="event-search" type="search" aria-label="Search tournament results" placeholder="${team?'Search team members…':'Search this field…'}" value="${escapeHtml(state.eventSearch)}"></div></div><div class="table-space"></div><div class="table-scroll"><table><thead><tr>${sortHeader('Position','finish_rank','event',false)}<th>${team?'Team members':'Player'}</th>${sortHeader('To par','score_to_par','event')}${team?'':sortHeader('Rounds','rounds_played','event')}${team?'':'<th>Status</th>'}</tr></thead><tbody>${rows.map(row=>`<tr><td><span class="${eventRank(row)===1?'badge win':'rank'}">${escapeHtml(row.finish_position||'—')}</span></td><td>${team?`<div class="team-names">${row.players.map(teamMember).join(' <span class="subtle">/</span> ')}</div>`:`<div class="player-cell">${avatar(row.player_id, row.player_name)}${playerButton(row)}</div>`}</td><td class="num">${escapeHtml(score(row))}</td>${team?'':`<td class="num subtle">${row.rounds_played}</td><td class="subtle">${escapeHtml(row.player_status||'—')}</td>`}</tr>`).join('') || `<tr><td colspan="5" class="empty">No results match your search.</td></tr>`}</tbody></table></div><div class="panel-footer"><span>${rows.length} of ${event.rows.length} ${team?'teams':'players'}</span><span>Official tournament results</span></div></section>`;
}

function tournaments(data) {
  let event = data.events.find(x=>x.key===state.event) || data.events[0];
  if (!event) {exportRows=[];return '<div class="panel empty">No tournament results in this season.</div>';}
  state.event = event.key;
  const winners = event.rows.filter(x=>eventRank(x)===1);
  const winnerNames = winners.map(x=>x.player_name || x.players.map(p=>`${p.firstName} ${p.lastName}`).join(' & ')).join(', ');
  return `<div class="filter-row"><label class="filter-label" for="tournament">Tournament</label><select id="tournament" class="event-select">${data.events.map(x=>`<option value="${escapeHtml(x.key)}" ${x.key===event.key?'selected':''}>${escapeHtml(x.name)}${x.type==='team'?' · Team event':''}</option>`).join('')}</select><span class="tag">${data.events.length} completed events</span></div><section class="event-hero">${logo(event.tid) ? `<div class="hero-logo">${logo(event.tid, 'large')}</div>` : ''}<div class="hero-body"><div class="eyebrow">${escapeHtml(longDate(event.date))} · ${event.type==='team'?'TEAM EVENT':'INDIVIDUAL EVENT'}</div><h2>${escapeHtml(event.name)}</h2><p>${event.rows.length} ${event.type==='team'?'teams':'players'} in the field${winnerNames?`<br>Winner${winners.length>1?'s':''}: ${escapeHtml(winnerNames)}`:''}</p></div><div class="hero-score"><strong>${winners.length?escapeHtml(score(winners[0])):'—'}</strong><span>winning score to par</span></div></section><div id="event-table">${eventTable(event)}</div>`;
}

function trend(rows) {
  const ordered = [...rows].sort((a,b)=>a.event_end_date.localeCompare(b.event_end_date));
  if (!ordered.length) return '<div class="empty">No player results to chart.</div>';
  const W=850,H=210,L=38,R=16,T=23,B=40;
  const max = Math.max(10,...ordered.map(eventRank).filter(x=>x!==null));
  const cap = Math.ceil(max/10)*10;
  const x = i=>L+i*(W-L-R)/Math.max(1,ordered.length-1);
  const y = rank=>T+(rank-1)/Math.max(1,cap-1)*(H-T-B);
  let segments=[], segment=[];
  ordered.forEach((row,i)=> {if(eventRank(row)!==null) segment.push(`${x(i)},${y(eventRank(row))}`);else if(segment.length){segments.push(segment);segment=[];}});
  if(segment.length)segments.push(segment);
  const ticks=[1,Math.round(cap/2),cap];
  return `<div class="trend"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Finishing position across the season. Lower finishing rank is better. Unranked results appear at the bottom.">${ticks.map(t=>`<line x1="${L}" y1="${y(t)}" x2="${W-R}" y2="${y(t)}" stroke="#e0e7ef" stroke-dasharray="3 4"/><text class="trend-label" x="${L-9}" y="${y(t)+3}" text-anchor="end">${t}</text>`).join('')}${segments.map(s=>`<polyline class="trend-line" points="${s.join(' ')}"/>`).join('')}${ordered.map((row,i)=>`<g><title>${escapeHtml(row.tournament_name)} · ${shortDate(row.event_end_date)} · ${escapeHtml(row.finish_position||'Unranked')}</title>${eventRank(row)!==null?`<circle class="trend-point" cx="${x(i)}" cy="${y(eventRank(row))}" r="4.5"/>`:`<text x="${x(i)}" y="${H-B+15}" text-anchor="middle" class="trend-label">${escapeHtml(row.finish_position||'—')}</text>`}</g>`).join('')}<text x="${L}" y="${H-8}" class="trend-label">${shortDate(ordered[0].event_end_date)}</text><text x="${W-R}" y="${H-8}" class="trend-label" text-anchor="end">${shortDate(ordered[ordered.length-1].event_end_date)}</text></svg><p class="chart-note">Finish position · Higher on the chart is better · Hover over a point for its tournament</p></div>`;
}

function players(data) {
  const player = data.summaries.find(x=>playerKey(x)===state.player) || data.summaries[0];
  if(!player){exportRows=[];return '<div class="panel empty">No individual player results in this season.</div>';}
  state.player=playerKey(player);
  const rows=data.players.filter(x=>playerKey(x)===state.player).sort((a,b)=>b.event_end_date.localeCompare(a.event_end_date));
  exportRows=rows.map(({tournament_name,event_end_date,player_name,finish_position,score_to_par,rounds_played})=>({tournament_name,event_end_date,player_name,finish_position,score_to_par,rounds_played}));
  const best=Math.min(...rows.map(eventRank).filter(x=>x!==null));
  return `<section class="panel profile-head-panel"><div class="profile-header">${avatar(player.player_id, player.player_name, 'large')}<div><h2>${escapeHtml(player.player_name)}</h2><p>${countryOf(player.player_id)?`<span class="profile-country">${flag(player.player_id)}${escapeHtml(countryOf(player.player_id).country)}</span> · `:''}${escapeHtml(state.season)} season · Individual tournament results</p></div></div><div class="profile-choose"><label for="player-picker">Explore a player</label><input class="search" id="profile-search" type="search" aria-label="Find player to explore" placeholder="Filter player list…"><select id="player-picker" aria-label="Choose player">${playerOptions(data.summaries)}</select></div></section><div class="metrics">${metric('Events played',player.events_played,'Completed individual events','⚑',true)}${metric('Tournament wins',player.wins,'First-place finishes','♧')}${metric('Top-ten finishes',player.top_10s,`${Math.round(player.top10_rate)}% of appearances`,'↗')}${metric('Best finish',Number.isFinite(best)?`#${best}`:'—',`${player.cuts} missed cuts this season`,'◎')}</div><section class="panel"><div class="panel-header"><div><h2>The shape of a season</h2><p class="panel-subtitle">Every finish, in chronological order. Unranked results break the line.</p></div></div>${trend(rows)}</section><section class="panel" style="margin-top:22px"><div class="panel-header"><div><h2>Tournament history</h2><p class="panel-subtitle">Select a tournament to see the entire field.</p></div><span class="results-count">${rows.length} appearances</span></div><div class="table-space"></div><div class="table-scroll"><table><thead><tr><th>Date</th><th>Tournament</th><th class="num">Finish</th><th class="num">To par</th><th class="num">Rounds</th></tr></thead><tbody>${rows.map(row=>`<tr><td class="subtle">${shortDate(row.event_end_date)}</td><td><div class="player-cell">${logo(row.tournament_id, 'small')}<button class="name-button" data-event="${escapeHtml(eventKey(row))}">${escapeHtml(row.tournament_name)}</button></div></td><td class="num"><span class="${eventRank(row)===1?'badge win':''}">${escapeHtml(row.finish_position||'—')}</span></td><td class="num">${escapeHtml(score(row))}</td><td class="num subtle">${row.rounds_played}</td></tr>`).join('')}</tbody></table></div><div class="panel-footer"><span>Team-event scores are excluded from player statistics.</span><span>Scores are relative to each course’s par.</span></div></section>`;
}

function playerOptions(summaries, query='') {
  const matches=[...summaries].filter(x=>x.player_name.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>a.player_name.localeCompare(b.player_name));
  return matches.map(x=>`<option value="${escapeHtml(playerKey(x))}" ${playerKey(x)===state.player?'selected':''}>${escapeHtml(x.player_name)}</option>`).join('') || '<option value="">No matching players</option>';
}

function render() {
  if(!state.data)return;
  const titles={overview:['Overview','A season in focus.','Follow the field. Find the standouts. Explore every finish.'],tournaments:['Tournaments','Every field. Every finish.','Open a tournament and explore the complete leaderboard.'],players:['Players','Behind the scorecard.','See how a player’s season unfolded, one tournament at a time.']};
  const [nav,title,description]=titles[state.view];
  $('#breadcrumb').textContent=nav;$('#page-title').textContent=title;$('#page-description').textContent=description;
  document.querySelectorAll('nav [data-view]').forEach(el=>{const active=el.dataset.view===state.view;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  const data=seasonData();
  $('#content').innerHTML=({overview,tournaments,players}[state.view])(data);
  $('#content').hidden=false;
  const latest=data.events[0];
  const fetched=state.data.freshness.find(x=>x.season_year===state.season);
  $('#source-note').textContent=`Source: Slash Golf · ${latest?`Results through ${longDate(latest.date)}`:'No completed results'} · Team results kept separate`;
  $('#freshness').textContent=fetched?`Schedule checked ${new Date(fetched.schedule_checked_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})} · Read ${new Date(state.data.retrieved_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`:'';
  $('#export').disabled=exportRows.length===0;
}

function navigate(view) {
  if(!['overview','tournaments','players'].includes(view))view='overview';
  state.view=view;
  history.replaceState(null,'',`#${view}`);
  render();
  window.scrollTo({top:0,behavior:'instant'});
}

function toast(message) {
  clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;
  toastTimer=setTimeout(()=>{$('#toast').hidden=true;},3000);
}

async function load(refresh=false) {
  $('#refresh').disabled=true;$('#error').hidden=true;
  if(!state.data)$('#loading').hidden=false;
  try {
    const response=await fetch('/api/data',{signal:AbortSignal.timeout(30000)});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error || 'Unable to load results.');
    state.data=data;
    try {const manifest=await fetch('/assets/images.json');if(manifest.ok)images={players:{},tournaments:{},flags:{},...await manifest.json()};} catch {}
    const seasons=[...new Set([...data.players,...data.teams].map(x=>x.season_year))].sort().reverse();
    if(!seasons.includes(state.season))state.season=seasons[0]||'2026';
    $('#season').innerHTML=(seasons.length?seasons:['2026']).map(s=>`<option ${s===state.season?'selected':''}>${escapeHtml(s)}</option>`).join('');
    render();if(refresh)toast('Dashboard refreshed from Postgres.');
  } catch(error) {
    $('#error').textContent=(state.data?'Showing the last successfully loaded data. ':'')+(error.name==='TimeoutError'?'The database took too long to respond. Please retry.':error.message);
    $('#error').hidden=false;
  } finally {$('#loading').hidden=true;$('#refresh').disabled=false;}
}

function downloadCSV() {
  if(!exportRows.length)return;
  const fields=Object.keys(exportRows[0]);
  const cell=value=> {
    let str=String(value??'');
    if(typeof value==='string' && /^[=+\-@\t\r]/.test(str))str="'"+str;
    return '"'+str.replaceAll('"','""')+'"';
  };
  const csv='\uFEFF'+[fields.map(cell).join(','),...exportRows.map(row=>fields.map(key=>cell(row[key])).join(','))].join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  const link=document.createElement('a');link.href=url;link.download=`pga-analytics-${state.view}-${state.season}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`Exported ${number(exportRows.length)} rows.`);
}

document.addEventListener('click',event=> {
  const button=event.target.closest('[data-view],[data-player],[data-event],[data-metric],[data-sort],[data-page]');
  if(!button)return;
  if(button.matches('a'))event.preventDefault();
  if(button.dataset.view)navigate(button.dataset.view);
  else if(button.dataset.player){state.player=button.dataset.player;navigate('players');}
  else if(button.dataset.event){state.event=button.dataset.event;state.eventSearch='';state.eventSort='finish_rank';state.eventDescending=false;navigate('tournaments');}
  else if(button.dataset.metric){state.metric=button.dataset.metric;render();}
  else if(button.dataset.sort){
    if(button.dataset.scope==='season'){state.descending=state.sort===button.dataset.sort?!state.descending:button.dataset.sort!=='player_name';state.sort=button.dataset.sort;state.page=0;$('#season-table').innerHTML=seasonTable(seasonData());}
    else {state.eventDescending=state.eventSort===button.dataset.sort?!state.eventDescending:false;state.eventSort=button.dataset.sort;const eventData=seasonData().events.find(x=>x.key===state.event);$('#event-table').innerHTML=eventTable(eventData);}
  } else if(button.dataset.page){state.page+=Number(button.dataset.page);$('#season-table').innerHTML=seasonTable(seasonData());}
});

document.addEventListener('input',event=> {
  const el=event.target;
  if(el.id==='player-search' || el.id==='event-search') {
    const id=el.id, position=el.selectionStart;
    if(id==='player-search'){state.search=el.value;state.page=0;$('#season-table').innerHTML=seasonTable(seasonData());}
    else {state.eventSearch=el.value;$('#event-table').innerHTML=eventTable(seasonData().events.find(x=>x.key===state.event));}
    const next=$('#'+id);next.focus();if(position!==null)next.setSelectionRange(position,position);
    $('#export').disabled=exportRows.length===0;
  }
  if(el.id==='profile-search') {
    const query=el.value;const select=$('#player-picker');
    select.innerHTML='<option value="">Choose a matching player…</option>'+playerOptions(seasonData().summaries,query);
    select.value='';
  }
});

document.addEventListener('change',event=> {
  if(event.target.id==='season'){state.season=event.target.value;state.page=0;state.search='';state.eventSearch='';state.player=null;state.event=null;render();}
  if(event.target.id==='tournament'){state.event=event.target.value;state.eventSearch='';render();}
  if(event.target.id==='player-picker' && event.target.value){state.player=event.target.value;render();}
});
$('#refresh').addEventListener('click',()=>load(true));
$('#export').addEventListener('click',downloadCSV);
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
state.view=['overview','tournaments','players'].includes(location.hash.slice(1))?location.hash.slice(1):'overview';
load();
