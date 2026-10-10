// Vercel serverless function: /api/sync  (runs daily via Vercel Cron, or open it by hand)
// 1. Gets upcoming fixtures from API-Football for the next 3 days.
// 2. Keeps only the leagues on the Stillo list.
// 3. Rates each team's attack and defence against its league's average (Poisson model).
// 4. Saves home/draw/away, BTTS, over 1.5/2.5 and the likeliest score into the Supabase "matches" table.
// Needs these Vercel environment variables: API_FOOTBALL_KEY, SUPABASE_SERVICE_KEY, CRON_SECRET.

const API = 'https://v3.football.api-sports.io';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqvvomsmhtbymctlmamk.supabase.co';
const DAYS_AHEAD = 3;          // today + next 2 days
const MAX_MS = 270000;         // stop before Vercel's time limit; unfinished leagues are picked up on the next run
const SPARE_CALLS = 3;         // never use the last few calls of the daily allowance

// ---- Leagues we want: [country as API-Football writes it, league-name pattern] ----
const WANT = [
  ['England', /^(premier league|championship|fa cup|league cup|community shield)$/i],
  ['Spain', /^(la liga|segunda divisi.n|copa del rey|super cup)$/i],
  ['Italy', /^(serie a|serie b|coppa italia|super cup)$/i],
  ['Germany', /^(bundesliga|dfb pokal|dfl-supercup|super cup)$/i],
  ['France', /^(ligue 1|ligue 2|coupe de france|troph.e des champions)$/i],
  ['Netherlands', /^(eredivisie|knvb beker)$/i],
  ['Portugal', /^(primeira liga|liga portugal.*|ta.a da liga|league cup)$/i],
  ['Belgium', /^(jupiler pro league|pro league|first division a|belgian cup|croky cup)$/i],
  ['Turkey', /^(s.per lig|super lig)$/i],
  ['Scotland', /^(premiership|scottish premiership|fa cup|league cup|scottish cup|scottish league cup)$/i],
  ['Brazil', /^serie a$/i],
  ['Argentina', /^liga profesional.*/i],
  ['USA', /^(major league soccer|mls)$/i],
  ['Russia', /^premier league$/i],
  ['Egypt', /^premier league$/i],
  ['Ukraine', /^premier league$/i],
  ['Israel', /^(ligat ha'?al|premier league)$/i],
  ['Kazakhstan', /^premier league$/i],
  ['Azerbaijan', /^(premier league|cup)$/i],
  ['Greece', /^(super league 1|super league|cup)$/i],
  ['Switzerland', /^super league$/i],
  ['Austria', /^(bundesliga|.fb cup|ofb cup)$/i],
  ['Denmark', /^superliga$/i],
  ['Sweden', /^(allsvenskan|svenska cupen)$/i],
  ['Norway', /^(eliteserien|nm cupen)$/i],
  ['Poland', /^ekstraklasa$/i],
  ['Czech-Republic', /^(czech liga|first league)$/i],
  ['Romania', /^liga i$/i],
  ['Hungary', /^(nb i|otp bank liga|magyar kupa)$/i],
  ['Bulgaria', /^(first league|parva liga)$/i],
  ['Croatia', /^(hnl|1\. hnl|prva hnl)$/i],
  ['Serbia', /^super liga$/i],
  ['Slovakia', /^(super liga|nike liga)$/i],
  ['Cyprus', /^(1\. division|first division|cyta championship|cyprus league)$/i],
  ['China', /^super league$/i],
  ['Kosovo', /^superliga$/i],
  ['World', /^(uefa champions league|uefa europa league|uefa europa conference league|uefa conference league|uefa nations league|uefa super cup|fifa club world cup|world cup|leagues cup|fifa intercontinental cup|africa cup of nations( - qualification)?)$/i]
];
const GENERIC = /^(premier league|serie a|bundesliga|super league|superliga|first league|super liga|liga i|cup|league cup|fa cup|super cup)$/i;
const MAIN_COUNTRIES = ['England', 'Spain', 'Italy', 'Germany', 'France', 'World'];

function wanted(lg) {
  if (!lg || /women|youth|futsal|\bu-?\d\d\b|reserve/i.test(lg.name)) return false;
  return WANT.some(([c, re]) => c === lg.country && re.test(lg.name));
}
function labelFor(lg) {
  return (GENERIC.test(lg.name) && !MAIN_COUNTRIES.includes(lg.country)) ? `${lg.name} (${lg.country})` : lg.name;
}

// ---- Team-name matching (to avoid duplicating matches that are already in the table) ----
const STOP = new Set(['fc','cf','afc','sc','ac','as','ss','ssc','us','rcd','rc','cd','ud','ca','sd','club','de','the','calcio','fk','sk','bk','1','04','05','09','1899','1907']);
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t)).join(' ');
}
function sameTeam(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.includes(short)) return true;
  const st = short.split(' '), lt = long.split(' ');
  return short.length >= 3 && st.every(t => lt.some(u => u.startsWith(t)));
}

// ---- Poisson model ----
function pois(l, n) { const p = [Math.exp(-l)]; for (let k = 1; k <= n; k++) p.push(p[k - 1] * l / k); return p; }
function predict(lh, la) {
  const N = 10, ph = pois(lh, N), pa = pois(la, N);
  let h = 0, d = 0, a = 0, btts = 0, o15 = 0, o25 = 0, tot = 0, best = [0, 0, -1];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const p = ph[i] * pa[j]; tot += p;
    if (i > j) h += p; else if (i === j) d += p; else a += p;
    if (i > 0 && j > 0) btts += p;
    if (i + j > 1) o15 += p;
    if (i + j > 2) o25 += p;
    if (p > best[2]) best = [i, j, p];
  }
  const pc = x => Math.round(x / tot * 1000) / 10;
  return { home_win_pct: pc(h), draw_pct: pc(d), away_win_pct: pc(a), btts_pct: pc(btts),
           over_1_5_pct: pc(o15), over_2_5_pct: pc(o25), correct_score_pick: `${best[0]}-${best[1]}` };
}

// Attack / defence strength from a league table (home and away records), shrunk toward average for small samples
function leagueModel(rows) {
  let hg = 0, hp = 0, ag = 0, ap = 0;
  const byTeam = {};
  rows.forEach(r => {
    if (!r.home || !r.away) return;
    hg += r.home.goals.for; hp += r.home.played; ag += r.away.goals.for; ap += r.away.played;
    byTeam[r.team.id] = r;
  });
  if (hp < 10 || ap < 10) return null; // too early in the season / not a real table
  return { lh: hg / hp, la: ag / ap, byTeam };
}
function expectedGoals(L, homeId, awayId) {
  const H = L.byTeam[homeId], A = L.byTeam[awayId];
  if (!H || !A) return null;
  const k = 4;
  const rate = (goals, played, avg) => played > 0 ? ((played * (goals / played / avg)) + k) / (played + k) : 1;
  const hAtt = rate(H.home.goals.for, H.home.played, L.lh);
  const hDef = rate(H.home.goals.against, H.home.played, L.la);
  const aAtt = rate(A.away.goals.for, A.away.played, L.la);
  const aDef = rate(A.away.goals.against, A.away.played, L.lh);
  return { lh: L.lh * hAtt * aDef, la: L.la * aAtt * hDef };
}

// ---- API-Football calls (paced by the rate-limit headers) ----
const state = { calls: 0, minuteLeft: null, dayLeft: null, start: Date.now() };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeLeft = () => MAX_MS - (Date.now() - state.start);

async function apiGet(path, params) {
  if (state.minuteLeft !== null && state.minuteLeft <= 0) {
    if (timeLeft() < 70000) throw new Error('OUT_OF_TIME');
    await sleep(62000);
  }
  if (state.dayLeft !== null && state.dayLeft <= SPARE_CALLS) throw new Error('OUT_OF_CALLS');
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${API}${path}?${qs}`, { headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY } });
  state.calls++;
  const m = r.headers.get('x-ratelimit-remaining'), d = r.headers.get('x-ratelimit-requests-remaining');
  state.minuteLeft = m !== null && m !== '' ? Number(m) : null;
  state.dayLeft = d !== null && d !== '' ? Number(d) : null;
  if (!r.ok) throw new Error(`API-Football responded ${r.status} on ${path}`);
  const j = await r.json();
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs && errs.length) throw new Error('API-Football: ' + errs.join('; ').slice(0, 200));
  return j.response || [];
}

// ---- Supabase ----
const sbHeaders = () => ({ apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` });
async function existingMatches() {
  const from = new Date(Date.now() - 6 * 3600e3).toISOString(), to = new Date(Date.now() + (DAYS_AHEAD + 1) * 86400e3).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/matches?select=external_id,home_team,away_team,kickoff_time` +
    `&kickoff_time=gte.${encodeURIComponent(from)}&kickoff_time=lte.${encodeURIComponent(to)}&limit=2000`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase read failed ' + r.status);
  return r.json();
}
async function insertRows(rows) {
  if (!rows.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/matches?on_conflict=external_id`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error('Supabase insert failed ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  const authed = secret && (req.headers.authorization === `Bearer ${secret}` || (req.query && req.query.secret === secret));
  if (!authed) return res.status(401).json({ error: 'Not allowed' });
  if (!process.env.API_FOOTBALL_KEY || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ error: 'API_FOOTBALL_KEY or SUPABASE_SERVICE_KEY is missing in Vercel' });
  }

  const dry = !!(req.query && req.query.dry);
  const out = { dry, inserted: 0, deferred: 0 };
  try {
    // 1) fixtures for the next few days
    let fixtures = [];
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const date = new Date(Date.now() + i * 86400e3).toISOString().slice(0, 10);
      fixtures = fixtures.concat(await apiGet('/fixtures', { date }));
    }
    out.fixturesSeen = fixtures.length;

    const upcoming = fixtures.filter(f => ['NS', 'TBD'].includes(f.fixture.status.short) && new Date(f.fixture.date).getTime() > Date.now());
    const mine = upcoming.filter(f => wanted(f.league));
    out.wanted = mine.length;

    // league-name diagnostics, so the list can be tuned
    const wantedCountries = new Set(WANT.map(w => w[0]));
    const seen = {}, miss = {};
    upcoming.forEach(f => {
      const tag = `${f.league.country}: ${f.league.name}`;
      if (wanted(f.league)) seen[tag] = (seen[tag] || 0) + 1;
      else if (wantedCountries.has(f.league.country) && !/women|youth|futsal|\bu-?\d\d\b|reserve/i.test(f.league.name)) miss[tag] = (miss[tag] || 0) + 1;
    });
    out.matchedLeagues = seen;
    out.notMatched = Object.keys(miss).slice(0, 80);
    if (dry) { out.callsUsed = state.calls; out.callsLeftToday = state.dayLeft; return res.status(200).json(out); }

    // 2) drop matches already in the table
    const have = await existingMatches();
    const haveIds = new Set(have.map(h => h.external_id));
    const todo = mine.filter(f => {
      if (haveIds.has('apif-' + f.fixture.id)) return false;
      const t = new Date(f.fixture.date).getTime();
      return !have.some(h => Math.abs(new Date(h.kickoff_time).getTime() - t) <= 3 * 3600e3 &&
        sameTeam(h.home_team, f.teams.home.name) && sameTeam(h.away_team, f.teams.away.name));
    });
    out.alreadyHave = mine.length - todo.length;

    // 3) group by league+season, soonest first
    const groups = {};
    todo.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date)).forEach(f => {
      const k = f.league.id + ':' + f.league.season;
      (groups[k] = groups[k] || { league: f.league, items: [] }).items.push(f);
    });

    for (const g of Object.values(groups)) {
      if (timeLeft() < 20000) { out.deferred += g.items.length; continue; }
      const rows = [];
      try {
        let L = null;
        try {
          const st = await apiGet('/standings', { league: g.league.id, season: g.league.season });
          const table = st[0] && st[0].league && st[0].league.standings ? [].concat(...st[0].league.standings) : [];
          L = table.length ? leagueModel(table) : null;
        } catch (e) { if (['OUT_OF_TIME', 'OUT_OF_CALLS'].includes(e.message)) throw e; }

        for (const f of g.items) {
          let xg = L ? expectedGoals(L, f.teams.home.id, f.teams.away.id) : null;
          if (!xg) { // cups and early-season leagues: use each team's scoring/conceding averages from /predictions
            if (timeLeft() < 20000) { out.deferred++; continue; }
            const p = await apiGet('/predictions', { fixture: f.fixture.id });
            const T = p[0] && p[0].teams;
            const n = x => Number(x);
            const hFor = T && n(T.home.league.goals.for.average.home), hAg = T && n(T.home.league.goals.against.average.home);
            const aFor = T && n(T.away.league.goals.for.average.away), aAg = T && n(T.away.league.goals.against.average.away);
            if ([hFor, hAg, aFor, aAg].some(x => !isFinite(x) || x <= 0)) { out.deferred++; continue; }
            xg = { lh: (hFor + aAg) / 2 * 1.05, la: (aFor + hAg) / 2 * 0.95 };
          }
          rows.push({
            league: labelFor(f.league), home_team: f.teams.home.name, away_team: f.teams.away.name,
            kickoff_time: f.fixture.date, status: 'scheduled', external_id: 'apif-' + f.fixture.id,
            ...predict(xg.lh, xg.la)
          });
        }
      } catch (e) {
        if (['OUT_OF_TIME', 'OUT_OF_CALLS'].includes(e.message)) { out.deferred += g.items.length - rows.length; await insertRows(rows); out.inserted += rows.length; out.stoppedEarly = e.message; break; }
        throw e;
      }
      await insertRows(rows);
      out.inserted += rows.length;
    }
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  out.callsUsed = state.calls;
  out.callsLeftToday = state.dayLeft;
  return res.status(200).json(out);
};
