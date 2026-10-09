// Vercel serverless function: GET /api/odds
// Keeps your OddsPapi key on the server (ODDSPAPI_KEY). It reads upcoming matches from your Stillo
// database itself, so the answer is the same for everyone and Vercel's CDN can cache it. That cache is
// what protects the 250-requests-a-month limit: OddsPapi is only called once per cache window.

const BASE = 'https://api.oddspapi.io/v4';
const BOOKMAKER = process.env.ODDS_BOOKMAKER || 'pinnacle';
const CACHE_MIN = Number(process.env.ODDS_CACHE_MIN) || 480;                  // minutes odds are shared (default 8h)
const ODDS_CACHE_MS = CACHE_MIN * 60 * 1000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqvvomsmhtbymctlmamk.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_lSpBd72V5H3c0ve6gRPZOg_a-mnwkds';
const MAX_BATCHES = Number(process.env.ODDS_MAX_BATCHES) || 1;                 // each batch = 5 leagues = 1 request
const FIXTURE_CACHE_MS = 24 * 60 * 60 * 1000;                                  // how long fixture list is reused

const cache = { fixtures: null, fixturesAt: 0, odds: {} };

const STOP = new Set(['fc','cf','afc','sc','ac','as','ss','ssc','us','rcd','rc','cd','ud','ca','sd','club','de','the','calcio','fk','sk','bk','1','04','05','09','1899','1907']);

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(t => t && !STOP.has(t)).join(' ');
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

const apiKeyRe = /apiKey=[^&\s"]+/g;

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).replace(apiKeyRe, 'KEY').slice(0, 200); } catch (e) {}
      throw new Error('OddsPapi responded ' + r.status + ' on ' + url.split('?')[0].split('/').pop() + ' ' + detail);
    }
    return await r.json();
  } finally { clearTimeout(timer); }
}

function asArray(j) {
  if (Array.isArray(j)) return j;
  return (j && (j.data || j.fixtures || j.results)) || [];
}

function ymd(d) { return d.toISOString().slice(0, 10); }

async function getFixtures(key) {
  if (cache.fixtures && Date.now() - cache.fixturesAt < FIXTURE_CACHE_MS) return cache.fixtures;
  const from = new Date(), to = new Date(Date.now() + 4 * 86400000);
  const j = await getJson(`${BASE}/fixtures?sportId=10&from=${ymd(from)}&to=${ymd(to)}&apiKey=${encodeURIComponent(key)}`);
  cache.fixtures = asArray(j);
  cache.fixturesAt = Date.now();
  return cache.fixtures;
}

async function getOddsFor(key, tournamentIds) {
  const id = tournamentIds.slice().sort().join(',');
  const hit = cache.odds[id];
  if (hit && Date.now() - hit.at < ODDS_CACHE_MS) return hit;
  const j = await getJson(`${BASE}/odds-by-tournaments?bookmakers=${encodeURIComponent(BOOKMAKER)}&tournamentIds=${id}&apiKey=${encodeURIComponent(key)}`);
  const byFixture = {};
  asArray(j).forEach(f => { byFixture[f.fixtureId] = f; });
  cache.odds[id] = { at: Date.now(), byFixture };
  return cache.odds[id];
}

function price(markets, marketId, outcomeId) {
  const p = markets && markets[marketId] && markets[marketId].outcomes && markets[marketId].outcomes[outcomeId]
    && markets[marketId].outcomes[outcomeId].players && markets[marketId].outcomes[outcomeId].players['0'];
  if (!p || p.active === false) return null;
  const n = Number(p.price);
  return n > 1 ? n : null;
}

function extract(fixture) {
  const bo = fixture && fixture.bookmakerOdds && fixture.bookmakerOdds[BOOKMAKER];
  const mk = bo && bo.markets;
  if (!mk) return null;
  const o = {
    home: price(mk, '101', '101'), draw: price(mk, '101', '102'), away: price(mk, '101', '103'),
    bttsYes: price(mk, '104', '104'), bttsNo: price(mk, '104', '105'),
    over15: price(mk, '108', '108'), under15: price(mk, '108', '109'),
    over25: price(mk, '1010', '1010'), under25: price(mk, '1010', '1011')
  };
  Object.keys(o).forEach(k => o[k] == null && delete o[k]);
  return Object.keys(o).length ? o : null;
}

async function loadMatches() {
  const cutoff = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const limit = new Date(Date.now() + 4 * 86400000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/matches?select=home_team,away_team,kickoff_time` +
    `&kickoff_time=gte.${encodeURIComponent(cutoff)}&kickoff_time=lte.${encodeURIComponent(limit)}&order=kickoff_time.asc`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  if (!r.ok) throw new Error('Database responded ' + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.ODDSPAPI_KEY;
  const debug = !!(req.query && req.query.debug);
  const ok = (body) => {
    res.setHeader('Cache-Control', debug ? 'no-store'
      : `public, s-maxage=${CACHE_MIN * 60}, stale-while-revalidate=3600`);
    return res.status(200).json(body);
  };
  const fail = (msg) => {
    res.setHeader('Cache-Control', 'public, s-maxage=300'); // don't hammer the API if something is wrong
    return res.status(200).json({ odds: {}, error: msg });
  };
  if (!key) return fail('ODDSPAPI_KEY is not set in Vercel');

  try {
    const rows = await loadMatches();
    const matches = rows.map(m => ({
      key: [m.home_team, m.away_team, m.kickoff_time].join('|'),
      home: m.home_team, away: m.away_team, kickoff: m.kickoff_time
    }));
    if (!matches.length) return ok({ odds: {}, matched: 0, total: 0 });

    const fixtures = await getFixtures(key);
    const found = {}; // match key -> fixture
    matches.forEach(m => {
      const t = new Date(m.kickoff).getTime();
      const f = fixtures.find(fx =>
        sameTeam(fx.participant1Name, m.home) && sameTeam(fx.participant2Name, m.away) &&
        Math.abs(new Date(fx.startTime).getTime() - t) <= 36 * 3600 * 1000);
      if (f) found[m.key] = f;
    });

    // OddsPapi accepts at most 5 tournaments per odds request, so take the leagues with the most of our matches.
    const counts = {};
    Object.values(found).forEach(f => { if (f.tournamentId) counts[f.tournamentId] = (counts[f.tournamentId] || 0) + 1; });
    const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 5 * MAX_BATCHES);
    const out = { odds: {}, bookmaker: BOOKMAKER, matched: Object.keys(found).length, total: matches.length,
                  leaguesCovered: ranked.length, leaguesTotal: Object.keys(counts).length };

    if (ranked.length) {
      const byFixture = {};
      for (let i = 0; i < ranked.length; i += 5) {
        if (i > 0) await new Promise(r => setTimeout(r, 1100)); // OddsPapi allows one call per second
        const part = await getOddsFor(key, ranked.slice(i, i + 5));
        Object.assign(byFixture, part.byFixture);
        out.updatedAt = Math.min(out.updatedAt || part.at, part.at);
      }
      Object.entries(found).forEach(([k, f]) => {
        const o = extract(byFixture[f.fixtureId]);
        if (o) out.odds[k] = o;
      });
      if (debug) {
        const firstKey = Object.keys(found)[0];
        const fx = firstKey && byFixture[found[firstKey].fixtureId];
        const mk = fx && fx.bookmakerOdds && fx.bookmakerOdds[BOOKMAKER] && fx.bookmakerOdds[BOOKMAKER].markets;
        out.debug = { tournamentIds: ranked, sample: firstKey, markets: mk ? Object.fromEntries(Object.entries(mk).map(([id, m]) =>
          [id, Object.fromEntries(Object.entries(m.outcomes || {}).map(([oid, v]) => [oid, v.players && v.players['0'] && v.players['0'].price]))])) : null,
          fixtureSample: fixtures[0] };
      }
    }
    return ok(out);
  } catch (err) {
    return fail(String((err && err.message) || err));
  }
};
