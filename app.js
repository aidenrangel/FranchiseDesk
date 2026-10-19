/* Franchise Desk · your Madden franchise as a stats site.
   Reads what the companion app exported (via the Cloudflare receiver in /worker) and builds standings,
   scores, box scores, rosters, ratings, season stats and a power index from it. */
(() => {
'use strict';
const VERSION = '1.0';
const view = document.getElementById('view'); const root = document.documentElement;
const store = { get(k, d) { try { const v = localStorage.getItem('fd:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('fd:' + k, JSON.stringify(v)); } catch {} } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sgn = n => (n > 0 ? '+' : '') + n;
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1 && n % 10) || 0] || 'th');
const ago = t => { const m = (Date.now() - t) / 60000; return m < 1 ? 'just now' : m < 60 ? Math.round(m) + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
const pct3 = v => v == null || !Number.isFinite(v) ? '–' : v.toFixed(3).replace(/^0/, '');
let toastT; const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); };
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });

let API = String(store.get('api', '') || window.FRANCHISE_API || '').trim().replace(/\/+$/, '');
let DEMO = store.get('demo', false);

/* ---------- local cache (IndexedDB: rosters are too big for localStorage) ---------- */
const idb = (() => { let dbp; const open = () => dbp ||= new Promise((res, rej) => { const r = indexedDB.open('franchise-desk', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
  return { get: k => tx('readonly', s => s.get(k)).catch(() => undefined), set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => {}), clear: () => tx('readwrite', s => s.clear()).catch(() => {}) }; })();
async function getJSON(url) { let r; try { r = await fetch(url, { cache: 'no-store' }); } catch (e) { throw new Error('Could not reach the receiver (' + e.message + '). Check the URL in Setup.'); } if (!r.ok) throw new Error(`The receiver answered ${r.status}${r.status === 404 ? ' (is the URL right?)' : ''}`); return r.json(); }

/* ---------- teams, colors, logos ---------- */
const NFL_COLOR = { ARI: '97233f', ATL: 'a71930', BAL: '241773', BUF: '00338d', CAR: '0085ca', CHI: '0b162a', CIN: 'fb4f14', CLE: '311d00', DAL: '041e42', DEN: 'fb4f14', DET: '0076b6', GB: '204e32', HOU: '03202f', IND: '002c5f', JAX: '006778', KC: 'e31837', LV: '000000', LAC: '0080c6', LAR: '003594', MIA: '008e97', MIN: '4f2683', NE: '002244', NO: 'd3bc8d', NYG: '0b2265', NYJ: '125740', PHI: '004c54', PIT: 'ffb612', SF: 'aa0000', SEA: '002244', TB: 'd50a0a', TEN: '0c2340', WAS: '5a1414', WSH: '5a1414' };
const ESPN_ABBR = { WAS: 'wsh', JAC: 'jax', OAK: 'lv', SD: 'lac', STL: 'lar' };
const hexOf = c => { if (c == null || c === '') return null; if (typeof c === 'string') return c.replace(/^#/, ''); const n = Number(c); return Number.isFinite(n) ? (n >>> 0 & 0xffffff).toString(16).padStart(6, '0') : null; };
const logoUrl = abbr => abbr && NFL_COLOR[abbr] ? `https://a.espncdn.com/i/teamlogos/nfl/500/${ESPN_ABBR[abbr] || abbr.toLowerCase()}.png` : '';
const colorOf = t => '#' + (t?.color || '556070');
const tLogo = (t, size = 28) => `<span class="tl" style="--tc:${colorOf(t)};width:${size}px;height:${size}px;font-size:${Math.max(8, size * .32)}px"><b>${esc(t?.abbr || '?')}</b>${t?.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
const DEV = ['Normal', 'Star', 'Superstar', 'X-Factor']; const devTag = d => `<span class="dev d${num(d)}">${DEV[num(d)] || 'Normal'}</span>`;
const htOf = h => h ? `${Math.floor(h / 12)}'${h % 12}"` : '–';
const money = v => { v = num(v); if (!v) return '–'; if (v >= 1e5) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 1 : 2) + 'M'; if (v >= 1000) return '$' + (v / 1000).toFixed(0) + 'K'; return '$' + v; };
const initials = p => ((p.firstName || '?')[0] + (p.lastName || '')[0]).toUpperCase();
const avatar = (p, t, size = 36) => `<span class="av" style="--tc:${colorOf(t)};width:${size}px;height:${size}px;font-size:${size * .38}px">${esc(initials(p))}</span>`;
const POS_GROUP = { QB: 'QB', HB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', LT: 'OL', LG: 'OL', C: 'OL', RG: 'OL', RT: 'OL', LE: 'DL', RE: 'DL', DT: 'DL', LEDG: 'DL', REDG: 'DL', LOLB: 'LB', MLB: 'LB', ROLB: 'LB', SAM: 'LB', MIKE: 'LB', WILL: 'LB', CB: 'DB', FS: 'DB', SS: 'DB', K: 'K/P', P: 'K/P' };
const POS_ORDER = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'LEDG', 'DT', 'RE', 'REDG', 'LOLB', 'SAM', 'MLB', 'MIKE', 'ROLB', 'WILL', 'CB', 'FS', 'SS', 'K', 'P'];
const KEY_RATINGS = { QB: ['throwPowerRating', 'throwAccShortRating', 'throwAccMidRating', 'throwAccDeepRating', 'throwOnRunRating', 'playActionRating', 'awareRating', 'speedRating'], HB: ['speedRating', 'accelRating', 'agilityRating', 'carryRating', 'bCVRating', 'breakTackleRating', 'jukeMoveRating', 'truckRating', 'catchRating'], FB: ['runBlockRating', 'impactBlockRating', 'truckRating', 'carryRating'], WR: ['speedRating', 'accelRating', 'catchRating', 'routeRunShortRating', 'routeRunMedRating', 'routeRunDeepRating', 'releaseRating', 'catchInTrafficRating', 'spectacularCatchRating'], TE: ['catchRating', 'routeRunShortRating', 'runBlockRating', 'passBlockRating', 'catchInTrafficRating', 'speedRating'], OL: ['passBlockRating', 'runBlockRating', 'impactBlockRating', 'strengthRating', 'awareRating'], DL: ['powerMovesRating', 'finesseMovesRating', 'blockShedRating', 'strengthRating', 'pursuitRating', 'tackleRating'], LB: ['tackleRating', 'pursuitRating', 'playRecRating', 'hitPowerRating', 'zoneCoverRating', 'speedRating'], DB: ['speedRating', 'manCoverRating', 'zoneCoverRating', 'pressRating', 'playRecRating', 'catchRating'], 'K/P': ['kickPowerRating', 'kickAccRating'] };
const RLABEL = { throwPowerRating: 'Throw power', throwAccShortRating: 'Short accuracy', throwAccMidRating: 'Medium accuracy', throwAccDeepRating: 'Deep accuracy', throwAccRating: 'Throw accuracy', throwOnRunRating: 'Throw on the run', throwUnderPressureRating: 'Throw under pressure', breakSackRating: 'Break sack', playActionRating: 'Play action', awareRating: 'Awareness', accelRating: 'Acceleration', agilityRating: 'Agility', speedRating: 'Speed', strengthRating: 'Strength', jumpRating: 'Jumping', staminaRating: 'Stamina', injuryRating: 'Injury', toughRating: 'Toughness', catchRating: 'Catching', carryRating: 'Carrying', bCVRating: 'Ball carrier vision', breakTackleRating: 'Break tackle', truckRating: 'Trucking', stiffArmRating: 'Stiff arm', jukeMoveRating: 'Juke move', spinMoveRating: 'Spin move', changeOfDirectionRating: 'Change of direction', routeRunShortRating: 'Short route running', routeRunMedRating: 'Medium route running', routeRunDeepRating: 'Deep route running', releaseRating: 'Release', catchInTrafficRating: 'Catch in traffic', spectacularCatchRating: 'Spectacular catch', passBlockRating: 'Pass block', passBlockPowerRating: 'Pass block power', passBlockFinesseRating: 'Pass block finesse', runBlockRating: 'Run block', runBlockPowerRating: 'Run block power', runBlockFinesseRating: 'Run block finesse', leadBlockRating: 'Lead block', impactBlockRating: 'Impact block', tackleRating: 'Tackle', hitPowerRating: 'Hit power', pursuitRating: 'Pursuit', playRecRating: 'Play recognition', manCoverRating: 'Man coverage', zoneCoverRating: 'Zone coverage', pressRating: 'Press', powerMovesRating: 'Power moves', finesseMovesRating: 'Finesse moves', blockShedRating: 'Block shedding', kickPowerRating: 'Kick power', kickAccRating: 'Kick accuracy', kickRetRating: 'Kick return', longSnapRating: 'Long snap' };
const ratingLabel = k => RLABEL[k] || k.replace(/Rating$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();

/* ---------- load + assemble the league ---------- */
const LISTS = { leagueTeamInfoList: 'teams', teamStandingInfoList: 'standings', rosterInfoList: 'roster', gameScheduleInfoList: 'schedule', playerPassingStatInfoList: 'passing', playerRushingStatInfoList: 'rushing', playerReceivingStatInfoList: 'receiving', playerDefensiveStatInfoList: 'defense', playerKickingStatInfoList: 'kicking', playerPuntingStatInfoList: 'punting', teamStatInfoList: 'teamstats' };
const KIND_LABEL = { teams: 'League teams', standings: 'Standings', roster: 'Roster', schedule: 'Schedule', passing: 'Passing', rushing: 'Rushing', receiving: 'Receiving', defense: 'Defense', kicking: 'Kicking', punting: 'Punting', teamstats: 'Team stats' };
let L = null, loading = null;
async function loadLeague(force, onProgress) {
  if (L && !force) return L; if (loading) return loading;
  loading = (async () => {
    let pieces, lids = ['demo'], lid = 'demo';
    if (DEMO) { if (!window.makeDemoLeague) await loadScript('demo.js'); pieces = window.makeDemoLeague(); }
    else {
      if (!API) throw Object.assign(new Error('No receiver set up yet.'), { code: 'NO_API' });
      const list = (await getJSON(API + '/api/list')).keys || [];
      if (!list.length) throw Object.assign(new Error('The receiver has no data yet.'), { code: 'EMPTY' });
      const leagues = {}; list.forEach(k => { const id = k.key.split('/').slice(0, 2).join('/'); (leagues[id] ||= []).push(k); });
      lids = Object.keys(leagues).sort((a, b) => Math.max(...leagues[b].map(k => k.t || 0)) - Math.max(...leagues[a].map(k => k.t || 0)));
      lid = leagues[store.get('league', '')] ? store.get('league', '') : lids[0];
      const keys = leagues[lid]; let done = 0; pieces = [];
      const one = async k => { const c = force ? null : await idb.get(k.key); let v; if (c && c.t === k.t) v = c.v; else { v = await getJSON(API + '/api/get?key=' + encodeURIComponent(k.key)); idb.set(k.key, { t: k.t, v }); } pieces.push({ ...k, v }); };
      for (let i = 0; i < keys.length; i += 10) { await Promise.all(keys.slice(i, i + 10).map(k => one(k).catch(e => console.warn('piece failed', k.key, e)))); done += Math.min(10, keys.length - i); onProgress?.(done / keys.length); }
    }
    L = assemble(pieces); L.leagues = lids; L.lid = lid; L.loadedAt = Date.now(); return L;
  })(); try { return await loading; } finally { loading = null; }
}
const stageOf = path => (String(path || '').match(/week\/(pre|reg|post)/) || [])[1] || 'reg';
const STAT_IDS = new Set(['rosterId', 'teamId', 'scheduleId', 'seasonIndex', 'weekIndex', 'stageIndex', 'si', 'wi', 'stage', 'statId', 'playerId', 'portraitId', 'fullName']);
function normTeam(t) { const abbr = String(t.abbrName || t.abbr || t.teamAbbr || '').toUpperCase(); const city = t.cityName || ''; const nick = t.nickName || t.displayName || t.teamName || ''; const div = t.divName || t.divisionName || '';
  return { id: t.teamId, abbr: abbr || nick.slice(0, 3).toUpperCase(), city, nick, name: [city, nick].filter(Boolean).join(' ') || abbr, div, conf: t.conferenceName || (div.match(/^(AFC|NFC)/) || [])[1] || '', ovr: num(t.ovrRating) || null, user: t.userName || '', color: hexOf(t.primaryColor) || NFL_COLOR[abbr] || null, logo: logoUrl(abbr), raw: t }; }
function normPlayer(p) { return { ...p, id: p.rosterId, name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.fullName || 'Player ' + p.rosterId, pos: p.position || '', grp: POS_GROUP[p.position] || p.position || '', ovr: num(p.playerBestOvr ?? p.overallRating ?? p.playerSchemeOvr), dev: num(p.devTrait), tid: num(p.teamId) }; }
function assemble(pieces) {
  const D = { teams: {}, standings: {}, players: {}, games: {}, lines: { passing: [], rushing: [], receiving: [], defense: [], kicking: [], punting: [] }, teamstats: [], pieces: [] };
  const seenLine = {};
  pieces.forEach(p => { const body = p.v || {}; const path = p.path || p.key; const info = { key: p.key, path, t: p.t, n: p.n, kind: '' };
    Object.entries(body).forEach(([k, arr]) => { if (!Array.isArray(arr)) return; const kind = LISTS[k] || k; info.kind = kind; const stage = stageOf(path);
      const tag = x => ({ ...x, si: num(x.seasonIndex), stage: x.stageIndex === 0 ? 'pre' : stage, wi: num(x.weekIndex) });
      if (kind === 'teams') arr.forEach(t => D.teams[t.teamId] = normTeam(t));
      else if (kind === 'standings') arr.forEach(s => D.standings[s.teamId] = s);
      else if (kind === 'roster') { const m = path.match(/team\/(\d+)\/roster/); const fa = /freeagents/.test(path); arr.forEach(pl => D.players[pl.rosterId] = normPlayer({ ...pl, teamId: fa ? 0 : (pl.teamId ?? (m ? Number(m[1]) : 0)) })); }
      else if (kind === 'schedule') arr.forEach(g => { const x = tag(g); x.id = `${x.si}-${x.stage}-${g.scheduleId}`; D.games[x.id] = x; });
      else if (D.lines[kind]) arr.forEach(l => { const x = tag(l); x.gid = `${x.si}-${x.stage}-${l.scheduleId}`; const k2 = kind + x.gid + ':' + l.rosterId; if (seenLine[k2] != null) D.lines[kind][seenLine[k2]] = x; else { seenLine[k2] = D.lines[kind].length; D.lines[kind].push(x); } });
      else if (kind === 'teamstats') arr.forEach(l => { const x = tag(l); x.gid = `${x.si}-${x.stage}-${l.scheduleId}`; D.teamstats.push(x); }); });
    D.pieces.push(info); });
  // teams that only appear in standings or the schedule
  Object.values(D.standings).forEach(s => { if (!D.teams[s.teamId]) D.teams[s.teamId] = normTeam({ teamId: s.teamId, nickName: s.teamName, divName: s.divisionName, conferenceName: s.conferenceName }); else { const t = D.teams[s.teamId]; t.div ||= s.divisionName || ''; t.conf ||= s.conferenceName || ''; } });
  Object.values(D.games).forEach(g => [g.homeTeamId, g.awayTeamId].forEach(id => { if (id != null && !D.teams[id]) D.teams[id] = normTeam({ teamId: id, abbrName: 'T' + String(id).slice(-2) }); }));
  Object.values(D.games).forEach(g => { g.played = num(g.homeScore) + num(g.awayScore) > 0 || num(g.status) >= 3; });
  const seasons = new Set([...Object.values(D.games).map(g => g.si), ...Object.values(D.lines).flat().map(l => l.si)]); Object.values(D.standings).forEach(s => seasons.add(num(s.seasonIndex)));
  D.seasons = [...seasons].sort((a, b) => a - b); if (!D.seasons.length) D.seasons = [0]; D.cur = D.seasons[D.seasons.length - 1];
  const anyStd = Object.values(D.standings).find(s => s.calendarYear); D.baseYear = anyStd ? num(anyStd.calendarYear) - num(anyStd.seasonIndex) : null;
  const playedCur = Object.values(D.games).filter(g => g.si === D.cur && g.stage === 'reg' && g.played); D.curWeek = playedCur.length ? Math.max(...playedCur.map(g => g.wi)) : (anyStd ? num(anyStd.weekIndex) : 0);
  D.updated = Math.max(0, ...pieces.map(p => p.t || 0));
  return D;
}
const yearOf = si => L?.baseYear != null ? L.baseYear + si : null;
const seasonLabel = si => yearOf(si) ? `${yearOf(si)} season` : `Season ${si + 1}`;
const weekLabel = (stage, wi) => stage === 'pre' ? `Preseason ${wi + 1}` : stage === 'post' ? `Playoffs ${wi + 1}` : wi >= 18 ? (['Wild Card', 'Divisional', 'Conference', 'Pro Bowl', 'Super Bowl'][wi - 18] || `Week ${wi + 1}`) : `Week ${wi + 1}`;
const weekShort = (stage, wi) => stage === 'pre' ? `P${wi + 1}` : wi >= 18 ? (['WC', 'DIV', 'CONF', 'PB', 'SB'][wi - 18] || 'W' + (wi + 1)) : 'W' + (wi + 1);
const isReg = g => g.stage === 'reg' && g.wi < 18;
const team = id => L.teams[id] || { id, abbr: '?', name: 'Unknown', color: null };
const seasonSel = () => { const s = Number(store.get('season', NaN)); return L.seasons.includes(s) ? s : L.cur; };

/* records computed from completed regular-season games (the standings export fills in seeds and splits) */
function records(si) {
  const R = {}; Object.keys(L.teams).forEach(id => R[id] = { w: 0, l: 0, t: 0, pf: 0, pa: 0, g: 0, home: [0, 0, 0], away: [0, 0, 0], div: [0, 0, 0], conf: [0, 0, 0], seq: [] });
  Object.values(L.games).filter(g => g.si === si && isReg(g) && g.played).sort((a, b) => a.wi - b.wi).forEach(g => { const hs = num(g.homeScore), as = num(g.awayScore);
    [[g.homeTeamId, hs, as, g.awayTeamId, 'home'], [g.awayTeamId, as, hs, g.homeTeamId, 'away']].forEach(([id, ms, os, oid, ha]) => { const r = R[id] ||= { w: 0, l: 0, t: 0, pf: 0, pa: 0, g: 0, home: [0, 0, 0], away: [0, 0, 0], div: [0, 0, 0], conf: [0, 0, 0], seq: [] }; const k = ms > os ? 0 : ms < os ? 1 : 2; r.g++; r.pf += ms; r.pa += os; if (k === 0) r.w++; else if (k === 1) r.l++; else r.t++; r[ha][k]++; const a = team(id), b = team(oid); if (a.div && a.div === b.div) r.div[k]++; if (a.conf && a.conf === b.conf) r.conf[k]++; r.seq.push('WLT'[k]); }); });
  const S = si === L.cur ? L.standings : {};
  Object.entries(R).forEach(([id, r]) => { const s = S[id]; if (s && num(s.totalWins) + num(s.totalLosses) + num(s.totalTies) > r.g) { r.w = num(s.totalWins); r.l = num(s.totalLosses); r.t = num(s.totalTies); r.pf = num(s.ptsFor); r.pa = num(s.ptsAgainst); r.g = r.w + r.l + r.t; r.home = [num(s.homeWins), num(s.homeLosses), num(s.homeTies)]; r.away = [num(s.awayWins), num(s.awayLosses), num(s.awayTies)]; r.div = [num(s.divWins), num(s.divLosses), num(s.divTies)]; r.conf = [num(s.confWins), num(s.confLosses), num(s.confTies)]; }
    r.pct = r.g ? (r.w + r.t / 2) / r.g : 0; r.rec = `${r.w}-${r.l}${r.t ? '-' + r.t : ''}`; const z = r.seq[r.seq.length - 1]; let n = 0; for (let i = r.seq.length - 1; i >= 0 && r.seq[i] === z; i--) n++; r.streak = s?.winLossStreak != null && s && r.g === num(s.totalWins) + num(s.totalLosses) + num(s.totalTies) ? (num(s.winLossStreak) > 0 ? 'W' + num(s.winLossStreak) : num(s.winLossStreak) < 0 ? 'L' + -num(s.winLossStreak) : '–') : z ? z + n : '–'; r.seed = num(s?.seed) || 0; });
  return R;
}
const split = a => `${a[0]}-${a[1]}${a[2] ? '-' + a[2] : ''}`;
function seedsFor(si, R) { // fallback seeding when the standings export has none: division winners first, then best records
  const out = {}; ['AFC', 'NFC'].forEach(c => { const ids = Object.keys(L.teams).filter(id => team(id).conf === c); const by = (a, b) => R[b].pct - R[a].pct || (R[b].pf - R[b].pa) - (R[a].pf - R[a].pa); const divs = {}; ids.forEach(id => (divs[team(id).div] ||= []).push(id)); const leaders = Object.values(divs).map(d => d.sort(by)[0]).sort(by); const rest = ids.filter(id => !leaders.includes(id)).sort(by); [...leaders, ...rest].forEach((id, i) => out[id] = i < 7 ? i + 1 : 0); }); return out; }

/* ---------- stats aggregation ---------- */
function sumLines(lines) { const o = { gp: new Set(lines.map(l => l.gid)).size }; lines.forEach(l => { for (const [k, v] of Object.entries(l)) { if (STAT_IDS.has(k) || typeof v !== 'number') continue; if (/Longest|Long$/.test(k)) o[k] = Math.max(o[k] || 0, v); else if (/Pct$|PerAtt$|PerCatch$|Rating$|^passerRating$/.test(k)) continue; else o[k] = (o[k] || 0) + v; } }); return o; }
const passerRating = (c, a, y, td, i) => { if (!a) return 0; const cl = v => Math.max(0, Math.min(2.375, v)); return (cl((c / a - .3) * 5) + cl((y / a - 3) * .25) + cl(td / a * 20) + cl(2.375 - i / a * 25)) / 6 * 100; };
const CATS = {
  passing: { name: 'Passing', main: 'passYds', qual: (r, gp) => num(r.passAtt) >= 10 * gp, d: r => ({ cmpPct: r.passAtt ? r.passComp / r.passAtt * 100 : 0, ya: r.passAtt ? r.passYds / r.passAtt : 0, rtg: passerRating(num(r.passComp), num(r.passAtt), num(r.passYds), num(r.passTDs), num(r.passInts)), ypg: num(r.passYds) / r.gp }),
    cols: [['GP', 'gp'], ['CMP', 'passComp'], ['ATT', 'passAtt'], ['CMP%', 'cmpPct', 1], ['YDS', 'passYds'], ['Y/A', 'ya', 1], ['TD', 'passTDs'], ['INT', 'passInts', 0, 1], ['SACK', 'passSacks', 0, 1], ['LONG', 'passLongest'], ['RTG', 'rtg', 1], ['YDS/G', 'ypg', 1]] },
  rushing: { name: 'Rushing', main: 'rushYds', qual: (r, gp, p) => num(r.rushAtt) >= (p?.grp === 'RB' ? 6 : 3) * gp, d: r => ({ avg: r.rushAtt ? r.rushYds / r.rushAtt : 0, ypg: num(r.rushYds) / r.gp, yac: r.rushAtt ? num(r.rushYdsAfterContact) / r.rushAtt : 0 }),
    cols: [['GP', 'gp'], ['ATT', 'rushAtt'], ['YDS', 'rushYds'], ['AVG', 'avg', 1], ['TD', 'rushTDs'], ['LONG', 'rushLongest'], ['20+', 'rush20PlusYds'], ['BTK', 'rushBrokenTackles'], ['YAC/ATT', 'yac', 1], ['FUM', 'rushFum', 0, 1], ['YDS/G', 'ypg', 1]] },
  receiving: { name: 'Receiving', main: 'recYds', qual: (r, gp, p) => num(r.recCatches) >= (/WR|TE/.test(p?.grp) ? 2 : 1) * gp, d: r => ({ avg: r.recCatches ? r.recYds / r.recCatches : 0, ypg: num(r.recYds) / r.gp, yacc: r.recCatches ? num(r.recYdsAfterCatch) / r.recCatches : 0 }),
    cols: [['GP', 'gp'], ['REC', 'recCatches'], ['YDS', 'recYds'], ['AVG', 'avg', 1], ['TD', 'recTDs'], ['LONG', 'recLongest'], ['YAC', 'recYdsAfterCatch'], ['YAC/REC', 'yacc', 1], ['DROPS', 'recDrops', 0, 1], ['YDS/G', 'ypg', 1]] },
  defense: { name: 'Defense', main: 'defTotalTackles', qual: (r, gp) => num(r.defTotalTackles) + num(r.defSacks) * 3 + num(r.defDeflections) >= 1.5 * gp, d: r => ({ tpg: num(r.defTotalTackles) / r.gp }),
    cols: [['GP', 'gp'], ['TKL', 'defTotalTackles'], ['TKL/G', 'tpg', 1], ['SACK', 'defSacks', 1], ['INT', 'defInts'], ['INT YDS', 'defIntReturnYds'], ['PD', 'defDeflections'], ['FF', 'defForcedFum'], ['FR', 'defFumRec'], ['TD', 'defTDs'], ['SAF', 'defSafeties'], ['CATCH ALW', 'defCatchAllowed', 0, 1]] },
  kicking: { name: 'Kicking', main: 'kickPts', qual: (r, gp) => num(r.fGAtt) + num(r.xPAtt) >= gp, d: r => ({ fgPct: r.fGAtt ? r.fGMade / r.fGAtt * 100 : 0, xpPct: r.xPAtt ? r.xPMade / r.xPAtt * 100 : 0, f50: `${num(r.fG50PlusMade)}/${num(r.fG50PlusAtt)}` }),
    cols: [['GP', 'gp'], ['FGM', 'fGMade'], ['FGA', 'fGAtt'], ['FG%', 'fgPct', 1], ['LONG', 'fGLongest'], ['50+', 'f50', 's'], ['XPM', 'xPMade'], ['XPA', 'xPAtt'], ['XP%', 'xpPct', 1], ['PTS', 'kickPts'], ['TB', 'kickoffTBs']] },
  punting: { name: 'Punting', main: 'avg', qual: (r, gp) => num(r.puntAtt) >= gp, d: r => ({ avg: r.puntAtt ? r.puntYds / r.puntAtt : 0, net: r.puntAtt ? num(r.puntNetYds) / r.puntAtt : 0 }),
    cols: [['GP', 'gp'], ['PUNTS', 'puntAtt'], ['YDS', 'puntYds'], ['AVG', 'avg', 1], ['NET', 'net', 1], ['LONG', 'puntLongest'], ['IN 20', 'puntsIn20'], ['TB', 'puntTBs', 0, 1]] }
};
const PER_GAME_SKIP = /Longest|Pct$|^gp$|^cmpPct$|^ya$|^rtg$|^ypg$|^avg$|^tpg$|^yac|^fgPct$|^xpPct$|^net$|^f50$/;
function seasonRows(cat, si, filter = () => true) {
  const C = CATS[cat]; const by = {}; L.lines[cat].filter(l => l.si === si && l.stage === 'reg' && filter(l)).forEach(l => (by[l.rosterId] ||= []).push(l));
  return Object.entries(by).map(([rid, lines]) => { const s = sumLines(lines); const p = L.players[rid]; const last = lines[lines.length - 1]; const tid = p?.tid || num(last.teamId);
    return { id: rid, p, name: p?.name || last.fullName || 'Player ' + rid, pos: p?.pos || '', grp: p?.grp || '', tid: num(last.teamId) || tid, ...s, ...C.d(s) }; });
}
const teamGames = (si, tid) => Object.values(L.games).filter(g => g.si === si && isReg(g) && g.played && (g.homeTeamId == tid || g.awayTeamId == tid)).length;

/* ---------- power index: opponent-adjusted margin (SRS) ---------- */
function power(si) {
  const R = records(si); const ids = Object.keys(L.teams); const per = {}; ids.forEach(id => per[id] = []);
  Object.values(L.games).filter(g => g.si === si && isReg(g) && g.played).forEach(g => { const m = Math.max(-28, Math.min(28, num(g.homeScore) - num(g.awayScore) - 2)); if (per[g.homeTeamId]) per[g.homeTeamId].push({ o: String(g.awayTeamId), m }); if (per[g.awayTeamId]) per[g.awayTeamId].push({ o: String(g.homeTeamId), m: -m }); });
  const r = {}; ids.forEach(id => r[id] = 0);
  for (let it = 0; it < 400; it++) { const nx = {}; ids.forEach(id => { const gs = per[id]; nx[id] = gs.reduce((s, g) => s + g.m + (r[g.o] ?? 0), 0) / (gs.length + .15); }); const mean = ids.reduce((s, id) => s + nx[id], 0) / ids.length; let d = 0; ids.forEach(id => { nx[id] -= mean; d += Math.abs(nx[id] - r[id]); r[id] = nx[id]; }); if (d < 1e-5) break; }
  return ids.map(id => { const gs = per[id], n = gs.length; return { id, t: team(id), R: R[id], rating: r[id] * (n / (n + 1)), mov: n ? gs.reduce((s, g) => s + g.m, 0) / n : 0, sos: n ? gs.reduce((s, g) => s + r[g.o], 0) / n : 0, n }; }).sort((a, b) => b.rating - a.rating);
}

/* ---------- shared UI ---------- */
const fail = (e) => `<div class="panel"><div class="box"><b style="color:var(--loss)">Couldn't load your league.</b><div class="muted" style="margin-top:6px">${esc(e?.message || e)}</div><div class="row" style="margin-top:12px"><button class="chip" onclick="location.reload()">Reload</button><a class="chip" href="#setup">Setup</a><a class="chip" href="#data">Data received</a></div></div></div>`;
const skel = () => '<div class="panel"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
function gameCard(g) { const a = team(g.awayTeamId), h = team(g.homeTeamId); const as = num(g.awayScore), hs = num(g.homeScore); const row = (t, s, w) => `<div class="team ${g.played ? (w ? 'w' : 'l') : ''}">${tLogo(t, 28)}<b>${esc(t.name)}</b>${t.user ? `<small>${esc(t.user)}</small>` : ''}</div><div class="score ${g.played && !w ? 'lost' : ''}">${g.played ? s : ''}</div>`;
  return `<a class="game ${a.user || h.user ? 'fav' : ''}" href="#game/${esc(g.id)}" style="--ca:${colorOf(a)};--cb:${colorOf(h)}">${row(a, as, as > hs)}${row(h, hs, hs > as)}<div class="meta"><span>${g.played ? 'Final' : 'Scheduled'}</span><span>${esc(weekLabel(g.stage, g.wi))}${g.isGameOfTheWeek ? ' · Game of the week' : ''}</span></div></a>`; }
function sortTable(table, rows, cols, render, key, dir = -1) {
  const draw = () => { const s = [...rows].sort((a, b) => { const va = cols[key](a), vb = cols[key](b); return (typeof va === 'string' ? String(va).localeCompare(vb) : va - vb) * dir; }); table.querySelector('tbody').innerHTML = s.map(render).join('') || `<tr><td colspan="40" class="empty">Nothing here yet.</td></tr>`; table.querySelectorAll('th[data-k]').forEach(th => th.classList.toggle('sorted', th.dataset.k === key)); wire(); };
  table.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => { if (key === th.dataset.k) dir = -dir; else { key = th.dataset.k; dir = th.dataset.asc ? 1 : -1; } draw(); }); draw(); return { redraw: (r) => { rows = r; draw(); } };
}
const wire = () => { view.querySelectorAll('tr[data-p]').forEach(tr => tr.onclick = () => location.hash = 'player/' + tr.dataset.p); view.querySelectorAll('tr[data-t]').forEach(tr => tr.onclick = () => location.hash = 'team/' + tr.dataset.t); view.querySelectorAll('tr[data-g]').forEach(tr => tr.onclick = () => location.hash = 'game/' + tr.dataset.g); };
const seasonPicker = (si, hashFor) => L.seasons.length > 1 ? `<select id="spick" aria-label="Season">${L.seasons.map(s => `<option value="${s}" ${s === si ? 'selected' : ''}>${esc(seasonLabel(s))}</option>`).join('')}</select>` : '';
const bindSeason = hashFor => { const s = document.getElementById('spick'); if (s) s.onchange = e => { store.set('season', Number(e.target.value)); route(); }; };

/* ---------- pages ---------- */
async function home() {
  const si = seasonSel(); const R = records(si); const P = power(si); const users = Object.values(L.teams).filter(t => t.user);
  const regW = Object.values(L.games).filter(g => g.si === si && g.stage === 'reg' && g.played); const lastW = regW.length ? Math.max(...regW.map(g => g.wi)) : null;
  const lastGames = lastW == null ? [] : Object.values(L.games).filter(g => g.si === si && g.stage === 'reg' && g.wi === lastW).sort((a, b) => (team(b.homeTeamId).user || team(b.awayTeamId).user ? 1 : 0) - (team(a.homeTeamId).user || team(a.awayTeamId).user ? 1 : 0));
  const nextOf = tid => Object.values(L.games).filter(g => g.si === si && !g.played && (g.homeTeamId == tid || g.awayTeamId == tid)).sort((a, b) => (a.stage === 'pre') - (b.stage === 'pre') || a.wi - b.wi)[0];
  const lastOf = tid => Object.values(L.games).filter(g => g.si === si && g.played && (g.homeTeamId == tid || g.awayTeamId == tid)).sort((a, b) => b.wi - a.wi)[0];
  const seeds = Object.values(L.standings).some(s => num(s.seed)) && si === L.cur ? Object.fromEntries(Object.entries(R).map(([id, r]) => [id, r.seed])) : seedsFor(si, R);
  const userCard = t => { const r = R[t.id] || {}; const n = nextOf(t.id), l = lastOf(t.id); const divRank = Object.values(L.teams).filter(x => x.div === t.div).sort((a, b) => (R[b.id]?.pct || 0) - (R[a.id]?.pct || 0)).findIndex(x => x.id === t.id) + 1; const pr = P.findIndex(x => x.id == t.id) + 1;
    const res = g => { if (!g) return '–'; const home = g.homeTeamId == t.id; const ms = num(home ? g.homeScore : g.awayScore), os = num(home ? g.awayScore : g.homeScore); return `${ms > os ? 'W' : ms < os ? 'L' : 'T'} ${ms}-${os} ${home ? 'vs' : '@'} ${team(home ? g.awayTeamId : g.homeTeamId).abbr}`; };
    return `<div class="panel ucard" style="--tc:${colorOf(t)}"><a class="uhead" href="#team/${esc(t.id)}">${tLogo(t, 56)}<div><b>${esc(t.name)}</b><small>${esc(t.user)} · ${esc(t.div)}</small></div><span class="rec num">${esc(r.rec || '0-0')}</span></a>
      <div class="kpis"><div class="kpi"><small>Division</small><b>${divRank ? ord(divRank) : '–'}</b></div><div class="kpi"><small>Playoff seed</small><b>${seeds[t.id] ? '#' + seeds[t.id] : 'Out'}</b></div><div class="kpi"><small>Power rank</small><b>${pr || '–'}</b></div><div class="kpi"><small>Team OVR</small><b>${t.ovr ?? '–'}</b></div><div class="kpi"><small>Last game</small><b style="font-size:16px">${l ? `<a href="#game/${esc(l.id)}">${esc(res(l))}</a>` : '–'}</b></div><div class="kpi"><small>Next</small><b style="font-size:16px">${n ? `<a href="#game/${esc(n.id)}">${esc(weekShort(n.stage, n.wi))} ${n.homeTeamId == t.id ? 'vs' : '@'} ${esc(team(n.homeTeamId == t.id ? n.awayTeamId : n.homeTeamId).abbr)}</a>` : '–'}</b></div></div></div>`; };
  const leadCats = [['passing', 'passYds', 'Passing yards'], ['rushing', 'rushYds', 'Rushing yards'], ['receiving', 'recYds', 'Receiving yards'], ['defense', 'defSacks', 'Sacks'], ['defense', 'defInts', 'Interceptions']];
  const leaders = leadCats.map(([cat, k, label]) => { const rows = seasonRows(cat, si).filter(r => num(r[k]) > 0).sort((a, b) => num(b[k]) - num(a[k])).slice(0, 5); if (!rows.length) return ''; return `<div class="panel"><h3>${label}<a class="lnk" style="font-size:12px;letter-spacing:0;text-transform:none" href="#stats/${cat}">All →</a></h3>${rows.map((r, i) => `<a class="leader" href="#player/${esc(r.id)}"><span class="rank num">${i + 1}</span>${avatar(r.p || { firstName: r.name }, team(r.tid), 40)}<div><div class="nm">${esc(r.name)}</div><div class="sub">${esc(r.pos)} · ${esc(team(r.tid).abbr)}</div></div><span class="val">${Number.isInteger(num(r[k])) ? num(r[k]) : num(r[k]).toFixed(1)}</span></a>`).join('')}</div>`; }).join('');
  const playoff = c => { const ids = Object.keys(L.teams).filter(id => team(id).conf === c && seeds[id]).sort((a, b) => seeds[a] - seeds[b]); return ids.length ? `<div class="panel"><h3>${c} playoff picture</h3>${ids.map(id => `<a class="leader" style="grid-template-columns:28px 32px 1fr auto" href="#team/${esc(id)}"><span class="seed ${seeds[id] === 1 ? 'bye' : 'in'}">${seeds[id]}</span>${tLogo(team(id), 30)}<div><div class="nm">${esc(team(id).name)}</div><div class="sub">${esc(team(id).div)}</div></div><span class="num">${esc(R[id].rec)}</span></a>`).join('')}</div>` : ''; };
  view.innerHTML = `<div class="bar"><div><h1>${esc(seasonLabel(si))}</h1><h2>${lastW != null ? esc(weekLabel('reg', lastW)) + ' complete' : 'No games played yet'} · ${Object.keys(L.teams).length} teams · last export ${esc(ago(L.updated))}${DEMO ? ' · <span class="tag">demo league</span>' : ''}</h2></div>${seasonPicker(si)}</div>
    ${users.length ? `<div class="grid ucards">${users.map(userCard).join('')}</div>` : ''}
    <div class="two" style="margin-top:var(--s4)"><div class="stack">${lastGames.length ? `<div class="panel"><h3>${esc(weekLabel('reg', lastW))} results<a class="lnk" style="font-size:12px;letter-spacing:0;text-transform:none" href="#scores/${si}-reg-${lastW}">Scoreboard →</a></h3>${lastGames.map(gameCard).join('')}</div>` : '<div class="panel"><div class="empty">Results show up after you export a played week.</div></div>'}</div>
      <div class="stack"><div class="panel"><h3>Power index<a class="lnk" style="font-size:12px;letter-spacing:0;text-transform:none" href="#power">All 32 →</a></h3>${P.slice(0, 8).map((x, i) => `<a class="leader" style="grid-template-columns:28px 32px 1fr auto" href="#team/${esc(x.id)}"><span class="rank num">${i + 1}</span>${tLogo(x.t, 30)}<div><div class="nm">${esc(x.t.name)}</div><div class="sub">${esc(x.R?.rec || '')}</div></div><span class="val ${x.rating >= 0 ? 'pos' : 'neg'}" style="font-size:18px">${sgn(x.rating.toFixed(1))}</span></a>`).join('')}</div>${leaders}</div></div>
    <div class="half" style="margin-top:var(--s4)">${playoff('AFC')}${playoff('NFC')}</div>`;
  bindSeason();
}

async function scores(wk) {
  const si = seasonSel(); const weeks = [...new Map(Object.values(L.games).filter(g => g.si === si).map(g => [`${g.si}-${g.stage}-${g.wi}`, { key: `${g.si}-${g.stage}-${g.wi}`, stage: g.stage, wi: g.wi }])).values()].sort((a, b) => (a.stage === 'pre' ? -1 : 0) - (b.stage === 'pre' ? -1 : 0) || a.wi - b.wi);
  if (!weeks.length) { view.innerHTML = `<div class="bar"><div><h1>Scores</h1></div></div><div class="panel"><div class="empty">No schedule exported yet. In the companion app, export a week to send its schedule.</div></div>`; return; }
  const lastPlayed = [...weeks].reverse().find(w => Object.values(L.games).some(g => `${g.si}-${g.stage}-${g.wi}` === w.key && g.played)) || weeks[0];
  const cur = weeks.find(w => w.key === wk) || lastPlayed; const i = weeks.indexOf(cur);
  const games = Object.values(L.games).filter(g => `${g.si}-${g.stage}-${g.wi}` === cur.key).sort((a, b) => (team(b.homeTeamId).user || team(b.awayTeamId).user ? 1 : 0) - (team(a.homeTeamId).user || team(a.awayTeamId).user ? 1 : 0) || (b.isGameOfTheWeek ? 1 : 0) - (a.isGameOfTheWeek ? 1 : 0));
  view.innerHTML = `<div class="bar"><div><h1>Scores</h1><h2>${esc(seasonLabel(si))} · ${esc(weekLabel(cur.stage, cur.wi))} · ${games.filter(g => g.played).length} of ${games.length} played</h2></div><div class="row">${seasonPicker(si)}<button class="chip" id="pw" ${i <= 0 ? 'disabled' : ''}>‹</button><select id="wk" aria-label="Week">${weeks.map(w => `<option value="${w.key}" ${w === cur ? 'selected' : ''}>${esc(weekLabel(w.stage, w.wi))}</option>`).join('')}</select><button class="chip" id="nw" ${i >= weeks.length - 1 ? 'disabled' : ''}>›</button></div></div>
    <div class="panel">${games.map(gameCard).join('')}</div>`;
  document.getElementById('wk').onchange = e => location.hash = 'scores/' + e.target.value;
  document.getElementById('pw').onclick = () => location.hash = 'scores/' + weeks[i - 1].key; document.getElementById('nw').onclick = () => location.hash = 'scores/' + weeks[i + 1].key; bindSeason();
}

async function game(id) {
  const g = L.games[id]; if (!g) { view.innerHTML = '<div class="panel"><div class="empty">Game not found.</div></div>'; return; }
  const a = team(g.awayTeamId), h = team(g.homeTeamId); const as = num(g.awayScore), hs = num(g.homeScore);
  const ts = L.teamstats.filter(x => x.gid === id); const tA = ts.find(x => x.teamId == a.id), tH = ts.find(x => x.teamId == h.id);
  const want = [['offTotalYds', 'Total yards'], ['offPassYds', 'Passing yards'], ['offRushYds', 'Rushing yards'], ['off1stDowns', 'First downs'], [x => `${num(x.off3rdDownConv)}/${num(x.off3rdDownAtt)}`, '3rd down', x => num(x.off3rdDownAtt) ? num(x.off3rdDownConv) / num(x.off3rdDownAtt) : 0], [x => `${num(x.off4thDownConv)}/${num(x.off4thDownAtt)}`, '4th down', x => num(x.off4thDownAtt) ? num(x.off4thDownConv) / num(x.off4thDownAtt) : 0], [x => `${num(x.offRedZoneTDs)}/${num(x.offRedZones)}`, 'Red zone TDs', x => num(x.offRedZones) ? num(x.offRedZoneTDs) / num(x.offRedZones) : 0], ['tOGiveaways', 'Turnovers', null, 1], ['offSacks', 'Sacks allowed', null, 1], [x => `${num(x.penalties)}-${num(x.penaltyYds)}`, 'Penalties', x => num(x.penaltyYds), 1]];
  const cmp = tA && tH ? `<div class="panel"><h3>Team stats</h3><div class="cmp">${want.map(([k, l, nf, low]) => { const get = x => typeof k === 'function' ? k(x) : num(x[k]); const n = nf || (x => num(x[k])); const va = n(tA), vh = n(tH); if (typeof k === 'string' && tA[k] == null && tH[k] == null) return ''; const mx = Math.max(va, vh, 1e-9); const aw = low ? va < vh : va > vh, hw = low ? vh < va : vh > va;
    return `<div class="r"><span class="l">${esc(get(tA))}</span><div><div class="lbl">${l}</div><div class="bars"><span class="a"><i class="${aw ? 'w' : ''}" style="width:${va / mx * 100}%"></i></span><span class="b"><i class="${hw ? 'w' : ''}" style="width:${vh / mx * 100}%"></i></span></div></div><span class="rr">${esc(get(tH))}</span></div>`; }).join('')}</div></div>` : '';
  const box = t => ['passing', 'rushing', 'receiving', 'defense', 'kicking', 'punting'].map(cat => { const C = CATS[cat]; const rows = L.lines[cat].filter(l => l.gid === id && l.teamId == t.id).map(l => { const s = sumLines([l]); return { id: l.rosterId, p: L.players[l.rosterId], name: L.players[l.rosterId]?.name || l.fullName, ...s, ...C.d(s) }; }).sort((x, y) => num(y[C.main]) - num(x[C.main])); if (!rows.length) return '';
    const cols = C.cols.filter(c => c[1] !== 'gp' && c[1] !== 'ypg' && c[1] !== 'tpg'); return `<div class="tw"><table class="stats"><thead><tr><th>${C.name}</th>${cols.map(c => `<th class="num">${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr class="clk" data-p="${esc(r.id)}"><td>${esc(r.name)}</td>${cols.map(c => `<td class="num">${fmtCell(r, c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }).join('');
  const top = t => { const pick = (cat, k, lbl) => { const r = L.lines[cat].filter(l => l.gid === id && l.teamId == t.id).sort((x, y) => num(y[k]) - num(x[k]))[0]; if (!r || !num(r[k])) return ''; const p = L.players[r.rosterId]; return `<a class="perf" href="#player/${esc(r.rosterId)}">${avatar(p || { firstName: r.fullName }, t, 32)}<div><b>${esc(p?.name || r.fullName)}</b><small>${lbl(r)}</small></div></a>`; };
    return `<div class="perf-side" style="--tc:${colorOf(t)}"><div class="perf-h">${tLogo(t, 20)}${esc(t.abbr)}</div>${pick('passing', 'passYds', r => `${r.passComp}/${r.passAtt}, ${r.passYds} yds, ${r.passTDs} TD${r.passInts ? ', ' + r.passInts + ' INT' : ''}`)}${pick('rushing', 'rushYds', r => `${r.rushAtt} car, ${r.rushYds} yds${r.rushTDs ? ', ' + r.rushTDs + ' TD' : ''}`)}${pick('receiving', 'recYds', r => `${r.recCatches} rec, ${r.recYds} yds${r.recTDs ? ', ' + r.recTDs + ' TD' : ''}`)}${pick('defense', 'defTotalTackles', r => `${r.defTotalTackles} tkl${r.defSacks ? ', ' + r.defSacks + ' sack' : ''}${r.defInts ? ', ' + r.defInts + ' INT' : ''}`)}</div>`; };
  const hasLines = Object.values(L.lines).some(ls => ls.some(l => l.gid === id));
  view.innerHTML = `<a class="back" href="#scores/${esc(g.si + '-' + g.stage + '-' + g.wi)}">← ${esc(weekLabel(g.stage, g.wi))}</a>
    <div class="scorebug"><a class="sb-team away" href="#team/${esc(a.id)}">${tLogo(a, 48)}<div class="sb-name"><b>${esc(a.abbr)}</b><small>${esc(records(g.si)[a.id]?.rec || '')}</small></div><div class="sb-score">${g.played ? as : ''}</div></a><div class="sb-mid"><b class="sb-clock">${g.played ? 'Final' : 'Scheduled'}</b><small>${esc(seasonLabel(g.si))} · ${esc(weekLabel(g.stage, g.wi))}</small></div><a class="sb-team home" href="#team/${esc(h.id)}">${tLogo(h, 48)}<div class="sb-name"><b>${esc(h.abbr)}</b><small>${esc(records(g.si)[h.id]?.rec || '')}</small></div><div class="sb-score">${g.played ? hs : ''}</div></a></div>
    ${!g.played ? `<div class="panel" style="margin-top:var(--s4)"><div class="empty">${esc(a.name)} at ${esc(h.name)} hasn't been played yet.</div></div>` : !hasLines ? `<div class="panel" style="margin-top:var(--s4)"><div class="empty">Final score only. Export this week's stats from the companion app to fill in the box score.</div></div>` :
    `<div class="panel" style="margin-top:var(--s4)"><h3>Top performers</h3><div class="perfs">${top(a)}${top(h)}</div></div>
    <div class="two" style="margin-top:var(--s4)"><div class="stack"><div class="panel"><h3>${esc(a.name)}</h3>${box(a)}</div><div class="panel"><h3>${esc(h.name)}</h3>${box(h)}</div></div><div class="stack">${cmp}</div></div>`}`;
  wire();
}
const fmtCell = (r, [l, k, dec]) => { const v = r[k]; if (dec === 's') return esc(v ?? '–'); if (v == null) return '0'; return dec ? num(v).toFixed(dec) : String(Math.round(num(v) * 10) / 10); };

async function standings() {
  const si = seasonSel(); const R = records(si); const hasSeeds = si === L.cur && Object.values(L.standings).some(s => num(s.seed)); const seeds = hasSeeds ? Object.fromEntries(Object.entries(R).map(([id, r]) => [id, r.seed])) : seedsFor(si, R);
  const confs = [...new Set(Object.values(L.teams).map(t => t.conf || 'League'))].sort();
  const html = confs.map(c => { const divs = [...new Set(Object.values(L.teams).filter(t => (t.conf || 'League') === c).map(t => t.div || c))].sort();
    return `<h3 class="cap" style="margin:var(--s5) 0 var(--s3);color:var(--muted)">${esc(c)}</h3><div class="stack">${divs.map(d => { const ids = Object.values(L.teams).filter(t => (t.conf || 'League') === c && (t.div || c) === d).map(t => String(t.id)).sort((x, y) => R[y].pct - R[x].pct || (R[y].pf - R[y].pa) - (R[x].pf - R[x].pa));
      return `<div class="panel"><h3>${esc(d)}</h3><div class="tw"><table><thead><tr><th>Team</th><th class="num">W-L-T</th><th class="num">PCT</th><th class="num">PF</th><th class="num">PA</th><th class="num">DIFF</th><th class="num">HOME</th><th class="num">AWAY</th><th class="num">DIV</th><th class="num">CONF</th><th class="num">STRK</th></tr></thead><tbody>${ids.map(id => { const r = R[id], t = team(id); const df = r.pf - r.pa; return `<tr class="clk ${t.user ? 'fav' : ''}" data-t="${esc(id)}"><td class="tm">${seeds[id] ? `<span class="seed ${seeds[id] === 1 ? 'bye' : 'in'}">${seeds[id]}</span>` : '<span class="seed">–</span>'}${tLogo(t, 24)}${esc(t.name)}${t.user ? ` <span class="tag">${esc(t.user)}</span>` : ''}</td><td class="num">${esc(r.rec)}</td><td class="num">${pct3(r.pct)}</td><td class="num">${r.pf}</td><td class="num">${r.pa}</td><td class="num ${df > 0 ? 'pos' : df < 0 ? 'neg' : ''}">${sgn(df)}</td><td class="num">${split(r.home)}</td><td class="num">${split(r.away)}</td><td class="num">${split(r.div)}</td><td class="num">${split(r.conf)}</td><td class="num">${esc(r.streak)}</td></tr>`; }).join('')}</tbody></table></div></div>`; }).join('')}</div>`; }).join('');
  view.innerHTML = `<div class="bar"><div><h1>Standings</h1><h2>${esc(seasonLabel(si))} · ${hasSeeds ? 'seeds from the standings export' : 'seeds projected from records'}</h2></div>${seasonPicker(si)}</div>${html}`;
  wire(); bindSeason();
}

async function teams() {
  const si = seasonSel(); const R = records(si); const list = Object.values(L.teams).sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `<div class="bar"><div><h1>Teams</h1><h2>${list.length} teams · ${list.filter(t => t.user).length} controlled by users</h2></div></div>
    <div class="teams">${list.map(t => `<a class="tcard" href="#team/${esc(t.id)}" style="--tc:${colorOf(t)}${t.user ? ';border-color:var(--gold)' : ''}">${tLogo(t, 56)}<b>${esc(t.name)}</b><small>${esc(R[t.id]?.rec || '0-0')}${t.ovr ? ' · ' + t.ovr + ' OVR' : ''}</small>${t.user ? `<small style="color:var(--gold)">${esc(t.user)}</small>` : ''}</a>`).join('')}</div>`;
}

async function teamPage(id, tab = 'roster') {
  const t = L.teams[id]; if (!t) { view.innerHTML = '<div class="panel"><div class="empty">Team not found.</div></div>'; return; }
  const si = seasonSel(); const R = records(si); const r = R[id] || {}; const P = power(si); const pr = P.findIndex(x => x.id == id) + 1;
  const roster = Object.values(L.players).filter(p => p.tid == id); const games = Object.values(L.games).filter(g => g.si === si && (g.homeTeamId == id || g.awayTeamId == id)).sort((a, b) => (a.stage === 'pre' ? -1 : 0) - (b.stage === 'pre' ? -1 : 0) || a.wi - b.wi);
  const payroll = roster.reduce((s, p) => s + num(p.capHit || p.contractSalary), 0);
  view.innerHTML = `<a class="back" href="#teams">← All teams</a>
    <div class="thero" style="--tc:${colorOf(t)}">${tLogo(t, 88)}<div><h1 style="margin:0">${esc(t.name)}</h1><h2>${esc(t.div)}${t.user ? ' · ' + esc(t.user) : ''}</h2></div><div style="margin-left:auto;text-align:right"><div class="rec">${esc(r.rec || '0-0')}</div><small class="muted">${esc(seasonLabel(si))}</small></div></div>
    <div class="panel" style="margin-bottom:var(--s4)"><div class="kpis"><div class="kpi"><small>Team OVR</small><b>${t.ovr ?? '–'}</b></div><div class="kpi"><small>Points for / against</small><b>${r.pf ?? 0} / ${r.pa ?? 0}</b></div><div class="kpi"><small>Diff</small><b class="${(r.pf - r.pa) >= 0 ? 'pos' : 'neg'}">${sgn((r.pf || 0) - (r.pa || 0))}</b></div><div class="kpi"><small>Home / Away</small><b>${split(r.home || [0, 0, 0])} / ${split(r.away || [0, 0, 0])}</b></div><div class="kpi"><small>Streak</small><b>${esc(r.streak || '–')}</b></div><div class="kpi"><small>Power rank</small><b>${pr || '–'}${pr ? ` <small class="muted">${sgn(P[pr - 1].rating.toFixed(1))}</small>` : ''}</b></div><div class="kpi"><small>Roster / cap hits</small><b>${roster.length} · ${money(payroll)}</b></div></div></div>
    <div class="tabs">${[['roster', `Roster (${roster.length})`], ['depth', 'Depth chart'], ['schedule', 'Schedule'], ['stats', 'Season stats']].map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="ttab"></div>`;
  view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { history.replaceState(null, '', `#team/${id}/${b.dataset.tab}`); teamPage(id, b.dataset.tab); });
  const el = document.getElementById('ttab');
  if (tab === 'roster') {
    if (!roster.length) { el.innerHTML = '<div class="panel"><div class="empty">No roster exported for this team yet. Tick Rosters in the companion app export.</div></div>'; return; }
    el.innerHTML = `<div class="panel"><div class="tw"><table id="rt" class="stats"><thead><tr><th class="sort" data-k="jersey" data-asc="1">#</th><th class="sort" data-k="name" data-asc="1">Player</th><th class="sort" data-k="pos" data-asc="1">Pos</th><th class="num sort" data-k="ovr">OVR</th><th class="num sort" data-k="dev">Dev</th><th class="num sort" data-k="age" data-asc="1">Age</th><th class="num sort" data-k="exp">Exp</th><th class="num sort" data-k="spd">SPD</th><th class="num sort" data-k="awr">AWR</th><th class="num">HT</th><th class="num sort" data-k="wt">WT</th><th class="num sort" data-k="sal">Salary</th><th class="num sort" data-k="yrs">Yrs left</th><th>Status</th></tr></thead><tbody></tbody></table></div></div>`;
    sortTable(document.getElementById('rt'), roster, { jersey: p => num(p.jerseyNum), name: p => p.lastName || p.name, pos: p => POS_ORDER.indexOf(p.pos) * 1000 - p.ovr, ovr: p => p.ovr, dev: p => p.dev * 100 + p.ovr, age: p => num(p.age), exp: p => num(p.yearsPro), spd: p => num(p.speedRating), awr: p => num(p.awareRating), wt: p => num(p.weight), sal: p => num(p.contractSalary), yrs: p => num(p.contractYearsLeft) },
      p => `<tr class="clk" data-p="${esc(p.id)}"><td class="num muted">${esc(p.jerseyNum ?? '')}</td><td class="tm">${avatar(p, t, 30)}<div class="sp"><b>${esc(p.name)}</b><small>${esc(p.college || '')}</small></div></td><td>${esc(p.pos)}</td><td class="num"><b>${p.ovr || '–'}</b></td><td class="num">${devTag(p.dev)}</td><td class="num">${esc(p.age ?? '')}</td><td class="num">${num(p.yearsPro) || 'R'}</td><td class="num">${esc(p.speedRating ?? '')}</td><td class="num">${esc(p.awareRating ?? '')}</td><td class="num">${htOf(num(p.height))}</td><td class="num">${esc(p.weight ?? '')}</td><td class="num">${money(p.contractSalary)}</td><td class="num">${esc(p.contractYearsLeft ?? '')}</td><td>${num(p.injuryLength) ? `<span class="tag out">Injured · ${num(p.injuryLength)} wk</span>` : p.isInjuredReserve ? '<span class="tag out">IR</span>' : ''}</td></tr>`, 'pos', 1);
  } else if (tab === 'depth') {
    const groups = POS_ORDER.map(pos => [pos, roster.filter(p => p.pos === pos).sort((a, b) => b.ovr - a.ovr)]).filter(x => x[1].length);
    el.innerHTML = `<div class="depth">${groups.map(([pos, ps]) => `<div class="panel"><h3>${esc(pos)}<span class="pill">${ps.length}</span></h3>${ps.map((p, i) => `<a class="dc ${i === 0 ? 'st' : ''}" href="#player/${esc(p.id)}"><span class="num muted">${i + 1}</span><span>${esc(p.name)} <small class="muted">#${esc(p.jerseyNum ?? '')}</small></span>${p.dev ? devTag(p.dev) : '<span></span>'}<b class="num">${p.ovr}</b></a>`).join('')}</div>`).join('') || '<div class="panel"><div class="empty">No roster exported for this team yet.</div></div>'}</div>`;
  } else if (tab === 'schedule') {
    el.innerHTML = `<div class="panel"><div class="tw"><table><thead><tr><th>Week</th><th>Opponent</th><th>Result</th><th class="num">Score</th><th class="num">Opp record</th></tr></thead><tbody>${games.map(g => { const home = g.homeTeamId == id; const o = team(home ? g.awayTeamId : g.homeTeamId); const ms = num(home ? g.homeScore : g.awayScore), os = num(home ? g.awayScore : g.homeScore); const res = g.played ? (ms > os ? 'W' : ms < os ? 'L' : 'T') : ''; return `<tr class="clk" data-g="${esc(g.id)}"><td>${esc(weekLabel(g.stage, g.wi))}</td><td class="tm">${tLogo(o, 24)}${home ? 'vs' : '@'} ${esc(o.name)}</td><td><span class="res ${res}">${res}</span></td><td class="num">${g.played ? ms + '–' + os : ''}</td><td class="num muted">${esc(R[o.id]?.rec || '')}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">No schedule exported yet.</td></tr>'}</tbody></table></div></div>`;
    wire();
  } else {
    el.innerHTML = Object.keys(CATS).map(cat => { const C = CATS[cat]; const rows = seasonRows(cat, si, l => l.teamId == id).sort((a, b) => num(b[C.main]) - num(a[C.main])); if (!rows.length) return ''; return `<div class="panel"><h3>${C.name}</h3><div class="tw"><table class="stats"><thead><tr><th>Player</th>${C.cols.map(c => `<th class="num">${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr class="clk" data-p="${esc(r.id)}"><td>${esc(r.name)} <small class="muted">${esc(r.pos)}</small></td>${C.cols.map(c => `<td class="num">${fmtCell(r, c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`; }).join('') || '<div class="panel"><div class="empty">No stats exported for this season yet.</div></div>';
    el.classList.add('stack'); wire();
  }
}

async function stats(cat) {
  const C = CATS[cat] || CATS.passing; cat = CATS[cat] ? cat : 'passing'; const si = seasonSel();
  const rows = seasonRows(cat, si); const R = records(si);
  const positions = [...new Set(rows.map(r => r.pos).filter(Boolean))].sort((a, b) => POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b));
  const S = { pos: '', team: '', q: '', qual: true, pg: false, key: C.main, dir: -1 };
  view.innerHTML = `<div class="bar"><div><h1>Player stats</h1><h2>${esc(seasonLabel(si))} · regular season · summed from every exported week</h2></div><div class="row">${seasonPicker(si)}</div></div>
    <div class="lgroups">${Object.entries(CATS).map(([k, c]) => `<a class="${k === cat ? 'on' : ''}" href="#stats/${k}">${c.name}</a>`).join('')}</div>
    <div class="panel"><div class="lfilters"><span>Pos</span><button class="chip on" data-pos="">All</button>${positions.map(p => `<button class="chip" data-pos="${esc(p)}">${esc(p)}</button>`).join('')}<select id="steam" style="margin-left:auto"><option value="">All teams</option>${Object.values(L.teams).sort((a, b) => a.abbr.localeCompare(b.abbr)).map(t => `<option value="${esc(t.id)}">${esc(t.abbr)}</option>`).join('')}</select><input id="sq" placeholder="Find a player" style="width:150px"></div>
      <div class="lfilters" style="border-top:1px solid var(--line)"><label class="row" style="font-size:13px"><input type="checkbox" id="squal" checked> Qualified only</label><label class="row" style="font-size:13px"><input type="checkbox" id="spg"> Per game</label><span class="muted" style="font-size:12px;margin-left:auto" id="scount"></span></div>
      <div class="tw"><table id="st" class="stats"><thead><tr><th>#</th><th>Player</th>${C.cols.map(([l, k, dec, low]) => `<th class="num sort" data-k="${k}" ${low ? 'data-asc="1" title="lower is better"' : ''}>${l}</th>`).join('')}</tr></thead><tbody></tbody></table></div></div>
    <p class="note">Totals add up every week you've exported, so a week you skipped is missing from them. Qualified means regular use for the position (about 10 attempts, 6 carries for backs, 2 catches for receivers per team game). Passer rating uses the NFL formula.</p>`;
  const val = (r, k) => S.pg && !PER_GAME_SKIP.test(k) && typeof r[k] === 'number' ? r[k] / r.gp : r[k];
  const draw = () => { const list = rows.filter(r => (!S.pos || r.pos === S.pos) && (!S.team || r.tid == S.team) && (!S.qual || C.qual(r, teamGames(si, r.tid) || r.gp, r)) && (!S.q || (r.name + ' ' + team(r.tid).abbr).toLowerCase().includes(S.q))).sort((a, b) => { const va = val(a, S.key), vb = val(b, S.key); return (typeof va === 'string' ? String(va).localeCompare(vb) : num(va) - num(vb)) * S.dir || num(b[C.main]) - num(a[C.main]); });
    document.querySelector('#st tbody').innerHTML = list.slice(0, 400).map((r, i) => `<tr class="clk ${team(r.tid).user ? 'fav' : ''}" data-p="${esc(r.id)}"><td class="num muted">${i + 1}</td><td class="tm">${avatar(r.p || { firstName: r.name }, team(r.tid), 30)}<div class="sp"><b>${esc(r.name)}</b><small>${esc(r.pos)} · ${esc(team(r.tid).abbr)}</small></div></td>${C.cols.map(c => `<td class="num ${c[1] === S.key ? 'sorted' : ''}">${S.pg && !PER_GAME_SKIP.test(c[1]) && typeof r[c[1]] === 'number' ? (r[c[1]] / r.gp).toFixed(1) : fmtCell(r, c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${C.cols.length + 2}" class="empty">${rows.length ? 'No players match.' : 'No ' + C.name.toLowerCase() + ' stats exported for this season yet.'}</td></tr>`;
    document.getElementById('scount').textContent = `${list.length} players`; document.querySelectorAll('#st th[data-k]').forEach(th => th.classList.toggle('sorted', th.dataset.k === S.key)); wire(); };
  draw();
  view.querySelectorAll('#st th[data-k]').forEach(th => th.onclick = () => { if (S.key === th.dataset.k) S.dir = -S.dir; else { S.key = th.dataset.k; S.dir = th.dataset.asc ? 1 : -1; } draw(); });
  view.querySelectorAll('[data-pos]').forEach(b => b.onclick = () => { S.pos = b.dataset.pos; view.querySelectorAll('[data-pos]').forEach(x => x.classList.toggle('on', x === b)); draw(); });
  document.getElementById('steam').onchange = e => { S.team = e.target.value; draw(); }; document.getElementById('sq').oninput = e => { S.q = e.target.value.toLowerCase(); draw(); };
  document.getElementById('squal').onchange = e => { S.qual = e.target.checked; draw(); }; document.getElementById('spg').onchange = e => { S.pg = e.target.checked; draw(); }; bindSeason();
}

async function players(q0, mode) {
  const fa = mode === 'fa'; const all = Object.values(L.players).filter(p => fa ? !p.tid : true);
  const grps = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'DB', 'K/P'];
  const S = { grp: '', dev: '', team: '', q: decodeURIComponent(q0 || '').toLowerCase(), shown: 150 };
  view.innerHTML = `<div class="bar"><div><h1>${fa ? 'Free agents' : 'Players'}</h1><h2>${all.length} ${fa ? 'unsigned players' : 'players on exported rosters'}</h2></div>${fa ? '<a class="chip" href="#players">All players</a>' : '<a class="chip" href="#freeagents">Free agents</a>'}</div>
    ${all.length ? `<div class="panel"><div class="lfilters"><span>Pos</span><button class="chip on" data-g="">All</button>${grps.map(g => `<button class="chip" data-g="${g}">${g}</button>`).join('')}<select id="pdev" style="margin-left:auto"><option value="">Any dev trait</option>${DEV.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select>${fa ? '' : `<select id="pteam"><option value="">All teams</option><option value="0">Free agents</option>${Object.values(L.teams).sort((a, b) => a.abbr.localeCompare(b.abbr)).map(t => `<option value="${esc(t.id)}">${esc(t.abbr)}</option>`).join('')}</select>`}<input id="pq" placeholder="Name" style="width:140px" value="${esc(S.q)}"></div>
      <div class="tw"><table id="pt" class="stats"><thead><tr><th>#</th><th class="sort" data-k="name" data-asc="1">Player</th><th class="sort" data-k="pos" data-asc="1">Pos</th><th>Team</th><th class="num sort" data-k="ovr">OVR</th><th class="num sort" data-k="dev">Dev</th><th class="num sort" data-k="age" data-asc="1">Age</th><th class="num sort" data-k="exp">Exp</th><th class="num sort" data-k="spd">SPD</th><th class="num sort" data-k="str">STR</th><th class="num sort" data-k="awr">AWR</th><th class="num sort" data-k="sal">Salary</th><th class="num sort" data-k="yrs">Yrs</th></tr></thead><tbody></tbody></table></div><div class="empty" id="pmore" style="padding:12px"><button class="chip" id="pmorebtn">Show all</button></div></div>` : '<div class="panel"><div class="empty">No rosters exported yet. In the companion app export, include Rosters.</div></div>'}`;
  if (!all.length) return;
  const cols = { name: p => p.lastName || p.name, pos: p => POS_ORDER.indexOf(p.pos), ovr: p => p.ovr, dev: p => p.dev * 100 + p.ovr, age: p => num(p.age), exp: p => num(p.yearsPro), spd: p => num(p.speedRating), str: p => num(p.strengthRating), awr: p => num(p.awareRating), sal: p => num(p.contractSalary), yrs: p => num(p.contractYearsLeft) };
  let key = 'ovr', dir = -1;
  const draw = () => { const list = all.filter(p => (!S.grp || p.grp === S.grp) && (S.dev === '' || p.dev === Number(S.dev)) && (S.team === '' || String(p.tid) === S.team) && (!S.q || p.name.toLowerCase().includes(S.q))).sort((a, b) => { const va = cols[key](a), vb = cols[key](b); return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir || b.ovr - a.ovr; });
    document.querySelector('#pt tbody').innerHTML = list.slice(0, S.shown).map((p, i) => { const t = team(p.tid); return `<tr class="clk ${t.user ? 'fav' : ''}" data-p="${esc(p.id)}"><td class="num muted">${i + 1}</td><td class="tm">${avatar(p, p.tid ? t : null, 30)}<div class="sp"><b>${esc(p.name)}</b><small>${esc(p.college || '')}</small></div></td><td>${esc(p.pos)}</td><td>${p.tid ? `<span class="tmi">${tLogo(t, 20)}${esc(t.abbr)}</span>` : '<span class="muted">FA</span>'}</td><td class="num"><b>${p.ovr || '–'}</b></td><td class="num">${devTag(p.dev)}</td><td class="num">${esc(p.age ?? '')}</td><td class="num">${num(p.yearsPro) || 'R'}</td><td class="num">${esc(p.speedRating ?? '')}</td><td class="num">${esc(p.strengthRating ?? '')}</td><td class="num">${esc(p.awareRating ?? '')}</td><td class="num">${money(p.contractSalary)}</td><td class="num">${esc(p.contractYearsLeft ?? '')}</td></tr>`; }).join('') || '<tr><td colspan="13" class="empty">No players match.</td></tr>';
    document.getElementById('pmore').hidden = list.length <= S.shown; document.querySelectorAll('#pt th[data-k]').forEach(th => th.classList.toggle('sorted', th.dataset.k === key)); wire(); };
  draw();
  view.querySelectorAll('#pt th[data-k]').forEach(th => th.onclick = () => { if (key === th.dataset.k) dir = -dir; else { key = th.dataset.k; dir = th.dataset.asc ? 1 : -1; } draw(); });
  view.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { S.grp = b.dataset.g; view.querySelectorAll('[data-g]').forEach(x => x.classList.toggle('on', x === b)); draw(); });
  document.getElementById('pdev').onchange = e => { S.dev = e.target.value; draw(); }; const pt = document.getElementById('pteam'); if (pt) pt.onchange = e => { S.team = e.target.value; draw(); };
  document.getElementById('pq').oninput = e => { S.q = e.target.value.toLowerCase(); draw(); }; document.getElementById('pmorebtn').onclick = () => { S.shown = 5000; draw(); };
}

async function player(id) {
  const p = L.players[id]; const anyLine = Object.values(L.lines).flat().find(l => String(l.rosterId) === String(id));
  if (!p && !anyLine) { view.innerHTML = '<div class="panel"><div class="empty">Player not found in the exported data.</div></div>'; return; }
  const pl = p || normPlayer({ rosterId: id, firstName: (anyLine.fullName || '').split(' ')[0], lastName: (anyLine.fullName || '').split(' ').slice(1).join(' '), teamId: anyLine.teamId });
  const t = team(pl.tid); const si = seasonSel();
  const ratingKeys = Object.keys(pl).filter(k => /Rating$/.test(k) && typeof pl[k] === 'number' && pl[k] > 0);
  const keyR = (KEY_RATINGS[pl.grp] || []).filter(k => ratingKeys.includes(k)); const rest = ratingKeys.filter(k => !keyR.includes(k)).sort((a, b) => pl[b] - pl[a]);
  const bar = k => `<div class="rt"><span>${esc(ratingLabel(k))}</span><div class="rb"><i style="width:${pl[k]}%;background:${pl[k] >= 90 ? 'var(--gold)' : pl[k] >= 80 ? 'var(--accent)' : pl[k] >= 70 ? 'var(--fg-2)' : 'var(--muted)'}"></i></div><b class="num">${pl[k]}</b></div>`;
  const cats = Object.keys(CATS).filter(cat => L.lines[cat].some(l => String(l.rosterId) === String(id)));
  const career = cats.map(cat => { const C = CATS[cat]; const bySeason = L.seasons.map(s => { const ls = L.lines[cat].filter(l => String(l.rosterId) === String(id) && l.si === s && l.stage === 'reg'); if (!ls.length) return null; const sm = sumLines(ls); return { s, ...sm, ...C.d(sm), tid: num(ls[ls.length - 1].teamId) }; }).filter(Boolean);
    const log = L.lines[cat].filter(l => String(l.rosterId) === String(id) && l.si === si).sort((a, b) => (a.stage === 'pre' ? -1 : 0) - (b.stage === 'pre' ? -1 : 0) || a.wi - b.wi).map(l => { const sm = sumLines([l]); const g = L.games[l.gid]; const home = g ? g.homeTeamId == l.teamId : true; const o = g ? team(home ? g.awayTeamId : g.homeTeamId) : null; const ms = g ? num(home ? g.homeScore : g.awayScore) : 0, os = g ? num(home ? g.awayScore : g.homeScore) : 0; return { ...sm, ...C.d(sm), l, g, o, home, res: g?.played ? (ms > os ? 'W' : ms < os ? 'L' : 'T') + ' ' + ms + '-' + os : '' }; });
    const cols = C.cols.filter(c => c[1] !== 'ypg' && c[1] !== 'tpg');
    return `<div class="panel"><h3>${C.name}</h3>${bySeason.length > 1 ? `<div class="tw"><table class="stats"><thead><tr><th>Season</th><th>Team</th>${C.cols.map(c => `<th class="num">${c[0]}</th>`).join('')}</tr></thead><tbody>${bySeason.map(r => `<tr><td>${esc(seasonLabel(r.s))}</td><td>${esc(team(r.tid).abbr)}</td>${C.cols.map(c => `<td class="num">${fmtCell(r, c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
      <div class="tw"><table class="stats"><thead><tr><th>${esc(yearOf(si) || '')} game log</th><th>Opp</th><th>Result</th>${cols.filter(c => c[1] !== 'gp').map(c => `<th class="num">${c[0]}</th>`).join('')}</tr></thead><tbody>${log.map(r => `<tr class="clk" data-g="${esc(r.l.gid)}"><td>${esc(weekLabel(r.l.stage, r.l.wi))}</td><td>${r.o ? `<span class="tmi">${tLogo(r.o, 20)}${r.home ? 'vs' : '@'} ${esc(r.o.abbr)}</span>` : ''}</td><td class="num">${esc(r.res)}</td>${cols.filter(c => c[1] !== 'gp').map(c => `<td class="num">${fmtCell(r, c)}</td>`).join('')}</tr>`).join('')}
      ${bySeason.find(r => r.s === si) ? `<tr class="hl"><td colspan="3"><b>Season</b></td>${cols.filter(c => c[1] !== 'gp').map(c => `<td class="num"><b>${fmtCell(bySeason.find(r => r.s === si), c)}</b></td>`).join('')}</tr>` : ''}</tbody></table></div></div>`; }).join('');
  view.innerHTML = `<a class="back" href="${pl.tid ? '#team/' + esc(pl.tid) : '#freeagents'}">← ${pl.tid ? esc(t.name) : 'Free agents'}</a>
    <div class="phero" style="--tc:${colorOf(pl.tid ? t : null)}">${avatar(pl, pl.tid ? t : null, 128)}<div>
      <div class="row"><span class="jer">#${esc(pl.jerseyNum ?? '')}</span><div><h1 style="margin:0">${esc(pl.name)}</h1><h2>${esc(pl.pos)} · ${pl.tid ? `<a href="#team/${esc(pl.tid)}">${esc(t.name)}</a>` : 'Free agent'}</h2></div><div class="ovrbig"><b>${pl.ovr || '–'}</b><small>OVR</small></div></div>
      <div class="bio"><span>Age <b>${esc(pl.age ?? '–')}</b></span><span>HT <b>${htOf(num(pl.height))}</b></span><span>WT <b>${esc(pl.weight ?? '–')}</b></span><span>College <b>${esc(pl.college || '–')}</b></span><span>Exp <b>${num(pl.yearsPro) ? num(pl.yearsPro) + ' yrs' : 'Rookie'}</b></span><span>Dev ${devTag(pl.dev)}</span>${num(pl.injuryLength) ? `<span><span class="tag out">Injured · ${num(pl.injuryLength)} wk</span></span>` : ''}</div>
    </div></div>
    <div class="two"><div class="stack">${career || '<div class="panel"><div class="empty">No stats exported for this player yet.</div></div>'}</div>
      <div class="stack">${num(pl.contractSalary) || num(pl.contractYearsLeft) ? `<div class="panel"><h3>Contract</h3><div class="kpis"><div class="kpi"><small>Salary</small><b>${money(pl.contractSalary)}</b></div><div class="kpi"><small>Bonus</small><b>${money(pl.contractBonus)}</b></div><div class="kpi"><small>Cap hit</small><b>${money(pl.capHit)}</b></div><div class="kpi"><small>Years left</small><b>${esc(pl.contractYearsLeft ?? '–')}${pl.contractLength ? ' of ' + esc(pl.contractLength) : ''}</b></div></div></div>` : ''}
        ${ratingKeys.length ? `<div class="panel"><h3>Ratings<span class="pill">${ratingKeys.length}</span></h3>${keyR.length ? `<div class="lhead" style="grid-template-columns:1fr"><span>Key for ${esc(pl.pos)}</span></div><div class="rts">${keyR.map(bar).join('')}</div>` : ''}<div class="lhead" style="grid-template-columns:1fr"><span>All ratings</span></div><div class="rts">${rest.map(bar).join('')}</div></div>` : ''}</div></div>`;
  wire();
}

async function powerPage() {
  const si = seasonSel(); const P = power(si);
  view.innerHTML = `<div class="bar"><div><h1>Power index</h1><h2>${esc(seasonLabel(si))} · opponent-adjusted margin in points vs. an average team</h2></div>${seasonPicker(si)}</div>
    <div class="panel"><div class="tw"><table id="pwt" class="stats"><thead><tr><th class="sort" data-k="rank" data-asc="1">#</th><th>Team</th><th class="num sort" data-k="pct">Record</th><th class="num sort" data-k="rating">Rating</th><th class="num sort" data-k="mov">MOV</th><th class="num sort" data-k="sos">SOS</th><th class="num sort" data-k="ovr">OVR</th><th class="num sort" data-k="pf">PF/G</th><th class="num sort" data-k="pa" data-asc="1">PA/G</th></tr></thead><tbody></tbody></table></div></div>
    <p class="note">Rating = average margin (2 points of home field removed, blowouts capped at 28) plus the average rating of the opponents played, solved so every result is judged against who it came against. SOS is the average opponent rating. OVR is Madden's team overall from the export.</p>`;
  const rows = P.map((x, i) => ({ ...x, rank: i + 1 }));
  sortTable(document.getElementById('pwt'), rows, { rank: r => r.rank, pct: r => r.R?.pct || 0, rating: r => r.rating, mov: r => r.mov, sos: r => r.sos, ovr: r => r.t.ovr || 0, pf: r => r.R?.g ? r.R.pf / r.R.g : 0, pa: r => r.R?.g ? r.R.pa / r.R.g : 0 },
    r => `<tr class="clk ${r.t.user ? 'fav' : ''}" data-t="${esc(r.id)}"><td class="num">${r.rank}</td><td class="tm">${tLogo(r.t, 24)}${esc(r.t.name)}</td><td class="num">${esc(r.R?.rec || '0-0')}</td><td class="num ${r.rating >= 0 ? 'pos' : 'neg'}"><b>${sgn(r.rating.toFixed(1))}</b></td><td class="num">${sgn(r.mov.toFixed(1))}</td><td class="num">${sgn(r.sos.toFixed(1))}</td><td class="num">${r.t.ovr ?? '–'}</td><td class="num">${r.R?.g ? (r.R.pf / r.R.g).toFixed(1) : '–'}</td><td class="num">${r.R?.g ? (r.R.pa / r.R.g).toFixed(1) : '–'}</td></tr>`, 'rank', 1);
  bindSeason();
}

async function data() {
  const by = {}; L.pieces.forEach(p => (by[p.kind || 'other'] ||= []).push(p));
  const rosterN = (by.roster || []).filter(p => !/freeagents/.test(p.path)).length, faN = (by.roster || []).some(p => /freeagents/.test(p.path));
  const wk = kind => [...new Set((by[kind] || []).map(p => (p.path.match(/week\/(pre|reg|post)\/(\d+)/) || []).slice(1).join(' ')).filter(Boolean))];
  const check = (ok, label, detail) => `<div class="chk ${ok ? 'ok' : ''}"><span>${ok ? '✓' : '–'}</span><b>${label}</b><small>${detail}</small></div>`;
  view.innerHTML = `<div class="bar"><div><h1>Data received</h1><h2>${L.pieces.length} pieces${DEMO ? ' (demo league)' : ` · league ${esc(L.lid)}`} · last export ${esc(ago(L.updated))}</h2></div><div class="row"><button class="chip" id="reload">Reload everything</button><a class="chip" href="#setup">Setup</a></div></div>
    <div class="panel"><h3>Checklist</h3><div class="chks">${check(!!by.teams, 'League info', by.teams ? `${Object.keys(L.teams).length} teams` : 'Tick League Info in the export')}${check(!!by.standings, 'Standings', by.standings ? 'received' : 'Comes with League Info')}${check(rosterN >= 32, 'Rosters', `${rosterN} of 32 teams${faN ? ' + free agents' : ''}`)}${check(!!by.schedule, 'Schedules', wk('schedule').join(', ') || 'Export a week')}${check(['passing', 'rushing', 'receiving', 'defense'].every(k => by[k]), 'Weekly stats', wk('passing').join(', ') || 'Export a week with stats ticked')}</div></div>
    <div class="panel"><h3>Every piece<span class="pill">click to view the raw JSON</span></h3><div class="tw"><table><thead><tr><th>Type</th><th>Path the app sent</th><th class="num">Items</th><th>Updated</th></tr></thead><tbody>${L.pieces.sort((a, b) => String(a.path).localeCompare(String(b.path), undefined, { numeric: true })).map((p, i) => `<tr class="clk" data-raw="${i}"><td>${esc(KIND_LABEL[p.kind] || p.kind || '?')}</td><td class="muted" style="font-family:var(--mono);font-size:12px">${esc(p.path)}</td><td class="num">${esc(p.n ?? '')}</td><td class="muted">${p.t ? esc(ago(p.t)) : ''}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel" id="rawp" hidden><h3 id="rawh"></h3><pre id="raw" class="raw"></pre></div>`;
  document.getElementById('reload').onclick = async () => { await idb.clear(); L = null; toast('Reloading from the receiver…'); route(); };
  view.querySelectorAll('[data-raw]').forEach(tr => tr.onclick = async () => { const p = L.pieces[Number(tr.dataset.raw)]; let v; if (DEMO) v = window.makeDemoLeague().find(x => x.key === p.key)?.v; else { const c = await idb.get(p.key); v = c?.v ?? await getJSON(API + '/api/get?key=' + encodeURIComponent(p.key)).catch(e => ({ error: e.message })); }
    const s = JSON.stringify(v, null, 2); document.getElementById('rawp').hidden = false; document.getElementById('rawh').textContent = p.path; document.getElementById('raw').textContent = s.length > 150000 ? s.slice(0, 150000) + '\n… (truncated)' : s; document.getElementById('rawp').scrollIntoView({ behavior: 'smooth' }); });
}

async function setup(msg) {
  const exportUrl = API ? `${API}/export/YOUR-SECRET` : 'https://<your-worker>.workers.dev/export/YOUR-SECRET';
  view.innerHTML = `<div class="bar"><div><h1>Setup</h1><h2>Connect Franchise Desk to the companion app</h2></div></div>
    ${msg ? `<div class="panel" style="margin-bottom:var(--s4)"><div class="box"><b>${esc(msg)}</b></div></div>` : ''}
    <div class="two"><div class="stack">
      <div class="panel"><h3>1 · Receiver URL</h3><div class="box"><p class="muted" style="margin:0 0 10px">The address of your Cloudflare Worker (from the README). It looks like <span class="num">https://franchise-desk.yourname.workers.dev</span>.</p>
        <div class="row"><input id="api" placeholder="https://…workers.dev" value="${esc(API)}" style="flex:1;min-width:240px"><button class="chip" id="test">Test</button><button class="chip on" id="save">Save</button></div><p class="muted" id="testres" style="font-size:13px;margin:10px 0 0"></p></div></div>
      <div class="panel"><h3>2 · In the companion app</h3><div class="box"><ol class="steps"><li>Open your franchise → <b>Export</b>.</li><li>Web URL for Export: <code id="exurl">${esc(exportUrl)}</code><br><small class="muted">Replace YOUR-SECRET with the SECRET you set on the Worker.</small></li><li>Pick a week, keep League Info, Rosters and Weekly Stats ticked, tap <b>Export</b>.</li><li>Come back here and reload. Check <a class="lnk" href="#data">Data received</a> to see what arrived.</li></ol>
        <p class="muted" style="font-size:13px;margin:8px 0 0">Export once with <b>all weeks</b> to backfill the season, then just the newest week after each advance.</p></div></div>
    </div><div class="stack">
      <div class="panel"><h3>Just looking?</h3><div class="box"><p class="muted" style="margin:0 0 10px">Load a made-up 32-team league in the same format the app sends, to click around before setting up the receiver.</p><button class="chip ${DEMO ? 'on' : ''}" id="demo">${DEMO ? 'Demo league is on · turn off' : 'Try the demo league'}</button></div></div>
      <div class="panel"><h3>What gets built</h3><div class="box" style="font-size:14px;line-height:1.6">Standings and playoff seeds, scores and box scores, team pages with rosters, depth charts and contracts, every player's ratings and game log, season stat tables, free agents and an opponent-adjusted power index, for every season you export.</div></div>
    </div></div>`;
  const val = () => document.getElementById('api').value.trim().replace(/\/+$/, '');
  document.getElementById('api').oninput = () => { document.getElementById('exurl').textContent = (val() || 'https://<your-worker>.workers.dev') + '/export/YOUR-SECRET'; };
  document.getElementById('test').onclick = async () => { const r = document.getElementById('testres'); r.textContent = 'Testing…'; try { const d = await getJSON(val() + '/api/list'); r.innerHTML = `<span class="pos">Connected.</span> ${d.keys?.length || 0} pieces stored so far.`; } catch (e) { r.innerHTML = `<span class="neg">${esc(e.message)}</span>`; } };
  document.getElementById('save').onclick = () => { API = val(); store.set('api', API); DEMO = false; store.set('demo', false); L = null; toast('Saved'); location.hash = 'home'; route(); };
  document.getElementById('demo').onclick = () => { DEMO = !DEMO; store.set('demo', DEMO); L = null; toast(DEMO ? 'Demo league on' : 'Demo league off'); location.hash = DEMO ? 'home' : 'setup'; route(); };
}

/* ---------- search, gear, routing ---------- */
const gs = document.getElementById('gs'), gsdd = document.getElementById('gsdd');
gs.oninput = () => { const q = gs.value.trim().toLowerCase(); if (!L || q.length < 2) { gsdd.hidden = true; return; } const ts = Object.values(L.teams).filter(t => (t.name + ' ' + t.abbr + ' ' + t.user).toLowerCase().includes(q)).slice(0, 4); const ps = Object.values(L.players).filter(p => p.name.toLowerCase().includes(q)).sort((a, b) => b.ovr - a.ovr).slice(0, 8);
  gsdd.innerHTML = (ts.length ? '<div class="hd">Teams</div>' + ts.map(t => `<a href="#team/${esc(t.id)}">${tLogo(t, 24)}<span>${esc(t.name)}</span></a>`).join('') : '') + (ps.length ? '<div class="hd">Players</div>' + ps.map(p => `<a href="#player/${esc(p.id)}">${avatar(p, p.tid ? team(p.tid) : null, 24)}<span>${esc(p.name)} <small class="muted">${esc(p.pos)} · ${p.tid ? esc(team(p.tid).abbr) : 'FA'} · ${p.ovr}</small></span></a>`).join('') : '') || '<div class="hd">No matches</div>'; gsdd.hidden = false; };
gs.onblur = () => setTimeout(() => gsdd.hidden = true, 200); gsdd.onclick = () => { gs.value = ''; gsdd.hidden = true; };
document.addEventListener('keydown', e => { if (e.key === '/' && !/input|select|textarea/i.test(e.target.tagName)) { e.preventDefault(); gs.focus(); } });
const savedTheme = store.get('theme', null); if (savedTheme) root.dataset.theme = savedTheme;
document.getElementById('theme').onclick = () => { const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches; root.dataset.theme = dark ? 'light' : 'dark'; store.set('theme', root.dataset.theme); };
document.getElementById('refresh').onclick = () => { L = null; document.getElementById('gearMenu').removeAttribute('open'); toast('Checking for new exports…'); route(); };
function fillGear() { const ls = document.getElementById('leagueSel'), ss = document.getElementById('seasonSel'); if (!L) return;
  ls.closest('.gear-row').hidden = L.leagues.length < 2; ls.innerHTML = L.leagues.map(l => `<option value="${esc(l)}" ${l === L.lid ? 'selected' : ''}>${esc(l)}</option>`).join(''); ls.onchange = e => { store.set('league', e.target.value); L = null; route(); };
  ss.innerHTML = L.seasons.map(s => `<option value="${s}" ${s === seasonSel() ? 'selected' : ''}>${esc(seasonLabel(s))}</option>`).join(''); ss.onchange = e => { store.set('season', Number(e.target.value)); route(); }; }
const PAGES = { home, scores, game, standings, teams, team: teamPage, stats, players, player, power: powerPage, freeagents: () => players('', 'fa'), data, setup };
const ALIAS = { team: 'teams', player: 'players', game: 'scores', freeagents: 'players' };
async function route() {
  const [r, a, b] = (location.hash.slice(1) || 'home').split('/'); const page = PAGES[r] ? r : 'home';
  document.querySelectorAll('#nav a, #bnav a, .moremenu a').forEach(x => x.classList.toggle('on', x.dataset.r === (ALIAS[page] || page)));
  document.querySelector('.moremenu')?.removeAttribute('open'); document.getElementById('gearMenu')?.removeAttribute('open'); window.scrollTo(0, 0);
  if (page === 'setup') { await setup(); return; }
  if (!L) view.innerHTML = `<div class="bar"><div><h1>Loading your league…</h1><h2>${DEMO ? 'Building the demo league' : 'Reading exports from the receiver'}</h2></div></div><div class="prog"><i id="lprog" style="width:0"></i></div>${skel()}`;
  try { await loadLeague(false, p => { const el = document.getElementById('lprog'); if (el) el.style.width = p * 100 + '%'; }); }
  catch (e) { if (e.code === 'NO_API') return setup('Add your receiver URL to get started, or try the demo league.'); if (e.code === 'EMPTY') return setup('The receiver is connected but empty. Export from the companion app (step 2), then reload.'); view.innerHTML = fail(e); return; }
  fillGear(); document.getElementById('demoBadge').hidden = !DEMO;
  try { await PAGES[page](a, b); } catch (e) { console.error(e); view.innerHTML = fail(e); }
}
window.addEventListener('hashchange', route);
document.getElementById('ver').textContent = 'v' + VERSION;
route();
})();
