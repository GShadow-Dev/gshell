/**
 * GSearch — tiered, corroborated evidence lookup.
 *
 * Doctrine (same as local `discover`, extended off-machine): one source is a
 * guess, agreement across independent sources is knowledge. GSearch never
 * returns "the answer" — it returns EVIDENCE tagged with how much it should
 * be trusted, plus the identifiers that multiple independent sources agree on.
 *
 * Trust tiers, highest first. This ordering is the whole point: a blog post
 * must never outrank a definition file shipped by the vendor.
 *   0 local      — files/introspection on this machine (handled by discover)
 *   1 context7   — versioned library/API docs
 *   2 firecrawl  — official documentation sites (map → scrape)
 *   3 web        — general search results
 *
 * Everything degrades: no Firecrawl → Context7 + local. No network → local
 * only. GSearch is never required for gex to work.
 */

export const GS = {
  c7Base: process.env.CONTEXT7_BASE || 'https://context7.com/api/v1',
  c7Key: process.env.CONTEXT7_API_KEY || '',
  fcBase: process.env.FIRECRAWL_BASE || 'http://localhost:3002',
  fcKey: process.env.FIRECRAWL_API_KEY || '',
  timeoutMs: Number(process.env.GSEARCH_TIMEOUT_MS || 12_000),
};

async function jfetch(url, { timeoutMs = GS.timeoutMs, ...opts } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json — keep raw */
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: '', error: err.message };
  } finally {
    clearTimeout(t);
  }
}

/** Which backends are actually reachable right now. Cheap, cached per run. */
let _detected = null;
export async function detectGsearch({ force = false } = {}) {
  if (_detected && !force) return _detected;
  // Detection must be forgiving: a single slow probe used to silently
  // disable the whole tool, which looks identical to "GSearch found nothing".
  // Retry once with a longer budget before declaring a backend down.
  const probe = async (fn) => ((await fn(6000)) ? true : (await fn(12000)));
  const [c7, fc] = await Promise.all([
    probe((ms) =>
      jfetch(`${GS.c7Base}/search?query=test`, { timeoutMs: ms, headers: c7Headers() })
        .then((r) => r.ok)
        .catch(() => false),
    ),
    probe((ms) =>
      jfetch(`${GS.fcBase}/test`, { timeoutMs: ms })
        .then((r) => r.status > 0)
        .catch(() => false),
    ),
  ]);
  _detected = { context7: c7, firecrawl: fc };
  return _detected;
}

function c7Headers() {
  const h = { Accept: 'application/json' };
  if (GS.c7Key) h.Authorization = `Bearer ${GS.c7Key}`;
  return h;
}

function fcHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (GS.fcKey) h.Authorization = `Bearer ${GS.fcKey}`;
  return h;
}

/* ------------------------------------------------------------------ *
 * Context7 — many angles, not one query
 * ------------------------------------------------------------------ */

/**
 * Resolve one angle to candidate libraries, KEEPING the ranking metadata.
 * Context7's own `score` is title-match biased — "react useEffect cleanup"
 * ranks `artifactory-cleanup` above React because "cleanup" is in its name.
 * So we keep stars/trust/verified and re-rank ourselves in c7Resolve().
 */
async function c7Search(angle) {
  const r = await jfetch(
    `${GS.c7Base}/search?query=${encodeURIComponent(angle)}`,
    { headers: c7Headers() },
  );
  if (!r.ok) return [];
  const rows = r.json?.results || r.json?.data || r.json?.libraries || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((x) => ({
      id: x.id || x.libraryId || x.library_id || x.slug || '',
      title: x.title || x.name || '',
      stars: Math.max(Number(x.stars) || 0, 0),
      trust: Number(x.trustScore) || 0,
      verified: Boolean(x.verified || x.vip),
    }))
    .filter((x) => x.id);
}

/**
 * Pick the library by weighted consensus across DIFFERENT phrasings.
 * Weights, in order of influence:
 *   consensus — a library several independent phrasings surface is the
 *               real subject; incidental keyword matches appear in only one
 *   stars     — log-scaled popularity is a strong prior for "what they meant"
 *               (React 245k vs artifactory-cleanup 157)
 *   trust     — Context7's own curation signal
 */
const TOPN = 8;
async function c7Resolve(angles) {
  const votes = new Map();
  await Promise.all(
    (angles || []).map(async (angle) => {
      const libs = await c7Search(angle);
      libs.slice(0, TOPN).forEach((lib, i) => {
        const cur = votes.get(lib.id) || { lib, angles: new Set(), best: 0 };
        cur.angles.add(angle);
        cur.best = Math.max(cur.best, TOPN - i);
        votes.set(lib.id, cur);
      });
    }),
  );
  return [...votes.values()]
    .map((v) => ({
      ...v,
      rank:
        v.angles.size * 100 +
        Math.log10(v.lib.stars + 1) * 18 +
        v.lib.trust * 4 +
        (v.lib.verified ? 8 : 0) +
        v.best,
    }))
    .sort((a, b) => b.rank - a.rank);
}

/** Pull docs text for a library id, optionally focused on a topic. */
async function c7Docs(id, topic) {
  const path = String(id).startsWith('/') ? id : `/${id}`;
  const q = new URLSearchParams({ type: 'txt' });
  if (topic) q.set('topic', topic);
  q.set('tokens', '4000');
  const r = await jfetch(`${GS.c7Base}${path}?${q}`, { headers: c7Headers() });
  if (!r.ok) return '';
  return String(r.json?.content || r.json?.text || r.text || '').slice(0, 20000);
}

/**
 * Run several DIFFERENT phrasings concurrently. Angles that disagree are as
 * informative as angles that agree — both are reported.
 */
/** Words too generic to prove a library is actually about the query. */
const WEAK_TERMS = new Set([
  'app','apps','api','set','get','list','device','devices','file','files','data',
  'code','test','run','play','name','type','use','using','how','the','and','for',
  'with','from','macos','mac','os','system','service','client','server','tool',
]);

/**
 * Does the winning library plausibly concern the question at all?
 * Context7 only indexes CODE LIBRARIES. Ask it about an OS scripting
 * dictionary and it will happily match a CSS package on the word "devices".
 * Returning the best of a bad set is worse than returning nothing, so require
 * a non-generic term shared between the query and the library's identity.
 */
function plausible(lib, angles) {
  const hay = `${lib.id} ${lib.title}`.toLowerCase();
  const terms = new Set(
    (angles || [])
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      // >=3 so short but highly distinctive names (zod, vue, npm) survive
      .filter((w) => w.length >= 3 && !WEAK_TERMS.has(w)),
  );
  for (const t of terms) if (hay.includes(t)) return true;
  return false;
}

export async function context7Angles(angles, { topic = '' } = {}) {
  const ranked = await c7Resolve(angles);
  if (!ranked.length) {
    return [{ tier: 1, source: 'context7 (no library matched)', ok: false, text: '' }];
  }
  const win = ranked[0];
  const consensus = win.angles.size;

  // Refuse rather than mislead: no plausible library means this question is
  // outside Context7's domain (OS/app scripting, shell behaviour, hardware…).
  if (!plausible(win.lib, angles)) {
    return [
      {
        tier: 1,
        origin: 'context7',
        source: `context7: NO RELEVANT LIBRARY (best guess ${win.lib.id} is unrelated — Context7 indexes code libraries only)`,
        ok: false,
        text: '',
      },
    ];
  }

  // Vary the TOPIC against the agreed library — now agreement between
  // results is about the answer, not about which package we landed on.
  const topics = [...new Set([topic, ...(angles || [])].filter(Boolean))].slice(0, 3);
  const out = await Promise.all(
    topics.map(async (t) => {
      const text = await c7Docs(win.lib.id, t);
      return {
        tier: 1,
        origin: win.lib.id,
        source: `context7:${win.lib.id} topic="${clipStr(t, 40)}"${consensus > 1 ? ` [${consensus} angles agree]` : ' [single angle]'}`,
        ok: Boolean(text.trim()),
        text,
      };
    }),
  );

  // Independent cross-check from the next-best DISTINCT library.
  const alt = ranked.find(
    (r) => r.lib.id !== win.lib.id && r.rank > win.rank * 0.6,
  );
  if (alt) {
    const text = await c7Docs(alt.lib.id, topic || angles[0]);
    if (text.trim()) {
      out.push({
        tier: 1,
        origin: alt.lib.id,
        source: `context7:${alt.lib.id} (independent cross-check)`,
        ok: true,
        text,
      });
    }
  }
  return out;
}

function clipStr(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ------------------------------------------------------------------ *
 * Firecrawl — structural discovery, then clean text
 * ------------------------------------------------------------------ */

/** /map — what pages actually exist on a docs domain (fast, structural). */
export async function firecrawlMap(url, search = '') {
  const body = { url, limit: 40 };
  if (search) body.search = search;
  const r = await jfetch(`${GS.fcBase}/v1/map`, {
    method: 'POST',
    headers: fcHeaders(),
    body: JSON.stringify(body),
  });
  const links = r.json?.links || r.json?.data?.links || r.json?.data || [];
  return (Array.isArray(links) ? links : [])
    .map((l) => (typeof l === 'string' ? l : l?.url))
    .filter(Boolean)
    .slice(0, 40);
}

/** /scrape — one page as clean markdown (no HTML soup). */
export async function firecrawlScrape(url) {
  const r = await jfetch(`${GS.fcBase}/v1/scrape`, {
    method: 'POST',
    headers: fcHeaders(),
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
    timeoutMs: Math.max(GS.timeoutMs, 20_000),
  });
  const md =
    r.json?.data?.markdown || r.json?.markdown || r.json?.data?.content || '';
  return String(md).slice(0, 20000);
}

/** map → pick likely pages → scrape them in parallel (each is an angle). */
export async function firecrawlAngles(site, focus, { max = 3 } = {}) {
  const links = await firecrawlMap(site, focus);
  if (!links.length) {
    return [{ tier: 2, source: `firecrawl:map ${site}`, ok: false, text: '' }];
  }
  const terms = String(focus || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const scored = links
    .map((u) => ({
      u,
      score: terms.reduce((n, t) => n + (u.toLowerCase().includes(t) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  const pages = await Promise.all(
    scored.map(async ({ u }) => ({
      tier: 2,
      origin: (() => { try { return new URL(u).hostname; } catch { return u; } })(),
      source: `firecrawl:${u}`,
      text: await firecrawlScrape(u),
    })),
  );
  return pages.map((p) => ({ ...p, ok: Boolean(p.text.trim()) }));
}

/**
 * /v1/search — real web search, then scrape the hits.
 *
 * This is the tier that answers questions no code-library index and no single
 * docs domain can: OS scripting, shell behaviour, error codes, "what is the
 * actual idiom". Each angle searches independently and different angles
 * surface different domains — so corroboration across them is meaningful
 * rather than three slices of one page.
 */
export async function firecrawlSearch(query, limit = 4) {
  const r = await jfetch(`${GS.fcBase}/v1/search`, {
    method: 'POST',
    headers: fcHeaders(),
    body: JSON.stringify({ query, limit }),
    timeoutMs: Math.max(GS.timeoutMs, 30_000),
  });
  const rows = r.json?.data || r.json?.results || [];
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      url: x.url || x.link || '',
      title: x.title || '',
      description: x.description || x.snippet || '',
    }))
    .filter((x) => x.url);
}

/** Search each angle, then read the best distinct-domain hits. */
export async function webAngles(angles, { maxPages = 4 } = {}) {
  const seen = new Map();
  await Promise.all(
    (angles || []).slice(0, 4).map(async (angle) => {
      for (const hit of await firecrawlSearch(angle, 4)) {
        let host = hit.url;
        try {
          host = new URL(hit.url).hostname;
        } catch {
          /* keep raw */
        }
        const cur = seen.get(hit.url) || { ...hit, host, angles: new Set() };
        cur.angles.add(angle);
        seen.set(hit.url, cur);
      }
    }),
  );
  if (!seen.size) return [];

  // Prefer pages several angles found, then spread across distinct domains so
  // "independent sources" really are independent.
  const ranked = [...seen.values()].sort((a, b) => b.angles.size - a.angles.size);
  const picked = [];
  const hosts = new Set();
  for (const hit of ranked) {
    if (picked.length >= maxPages) break;
    if (hosts.has(hit.host) && picked.length >= 2) continue;
    hosts.add(hit.host);
    picked.push(hit);
  }
  return Promise.all(
    picked.map(async (hit) => {
      const text = await firecrawlScrape(hit.url);
      return {
        tier: 3,
        origin: hit.host,
        source: `web:${hit.url}${hit.angles.size > 1 ? ` [${hit.angles.size} angles found it]` : ''}`,
        ok: Boolean(text.trim()),
        text: text || `${hit.title}\n${hit.description}`,
      };
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Corroboration
 * ------------------------------------------------------------------ */

/**
 * Documentation boilerplate that appears in virtually every repo's docs.
 * Without this, a nonsense query "corroborates" on README.md / license /
 * github.com and reports high confidence about nothing.
 */
const BOILERPLATE = new Set([
  'github.com', 'readme.md', 'license', 'licence', 'changelog.md', 'http', 'https',
  'www', 'npm install', 'yarn add', 'pnpm add', 'package.json', 'index.js',
  'contributing.md', 'code_of_conduct.md', 'src', 'dist', 'lib', 'test', 'tests',
  'docs', 'doc', 'example', 'examples', 'usage', 'install', 'installation',
  'getting started', 'true', 'false', 'null', 'undefined', 'string', 'number',
  'boolean', 'object', 'array', 'function', 'const', 'let', 'var', 'return',
  'import', 'export', 'default', 'main', 'master', 'latest', 'version',
]);

/** Looks like an API identifier rather than prose or a filename/URL. */
function apiShaped(t) {
  if (/^https?:/i.test(t) || /\.(md|txt|json|ya?ml|lock|toml|png|svg)$/i.test(t)) return false;
  if (/\.(com|org|dev|io|net|app|sh)\b/i.test(t)) return false;
  if (/\s/.test(t) && t.length > 28) return false;
  return (
    /[a-z][A-Z]/.test(t) ||          // camelCase
    /\w\.\w/.test(t) ||             // dotted / namespaced
    /_/.test(t) ||                   // snake_case
    /^[A-Z][a-zA-Z0-9]{2,}$/.test(t) // PascalCase
  );
}

/**
 * Identifier-ish tokens: quoted strings, code spans, dotted/camel/snake names.
 * These are what actually matter for "what is this API really called".
 */
export function extractIdentifiers(text) {
  const s = String(text || '');
  const found = new Set();
  const add = (v) => {
    const t = String(v || '').trim();
    if (t.length < 3 || t.length > 64) return;
    if (BOILERPLATE.has(t.toLowerCase())) return;
    if (!apiShaped(t)) return;
    found.add(t);
  };
  for (const m of s.matchAll(/`([^`\n]{3,64})`/g)) add(m[1]);
  for (const m of s.matchAll(/"([A-Za-z][\w .:/-]{2,63})"/g)) add(m[1]);
  for (const m of s.matchAll(/\b([a-z]+(?:[A-Z][a-z0-9]+)+)\b/g)) add(m[1]);
  for (const m of s.matchAll(/\b([a-z0-9]+(?:_[a-z0-9]+)+)\b/g)) add(m[1]);
  for (const m of s.matchAll(/\b(\w+(?:\.\w+){1,4})\b/g)) add(m[1]);
  return found;
}

/**
 * Rank identifiers by how many INDEPENDENT ORIGINS mention them.
 *
 * Origin, not fetch: pulling one library under three different topics is ONE
 * source seen three times, not three sources agreeing. Counting fetches was
 * turning shared boilerplate into fake consensus.
 *   confirmed — 2+ distinct origins (real corroboration)
 *   repeated  — 1 origin, several slices (suggestive, explicitly weaker)
 */
export function corroborate(results) {
  const live = (results || []).filter((r) => r?.ok && r.text);
  const byId = new Map();
  for (const r of live) {
    const origin = r.origin || r.source;
    const weight = r.tier <= 1 ? 3 : r.tier === 2 ? 2 : 1;
    for (const id of extractIdentifiers(r.text)) {
      const cur = byId.get(id) || { id, origins: new Set(), hits: 0, score: 0 };
      cur.hits += 1;
      if (!cur.origins.has(origin)) {
        cur.origins.add(origin);
        cur.score += weight;
      }
      byId.set(id, cur);
    }
  }
  return [...byId.values()]
    .map((c) => {
      const origins = [...c.origins];
      return {
        id: c.id,
        origins,
        agree: origins.length,
        hits: c.hits,
        score: c.score + origins.length * 10,
        confirmed: origins.length >= 2,
      };
    })
    .filter((c) => c.confirmed || c.hits >= 2)
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .slice(0, 25);
}

/* ------------------------------------------------------------------ *
 * Round 2 — refine using the vocabulary round 1 actually revealed
 * ------------------------------------------------------------------ */

/**
 * Multi-word technical phrases (code spans / quoted strings containing
 * spaces). Single-token extraction misses exactly the payload you need —
 * "current AirPlay devices" is three words and never survives a \w+ match.
 * Ranked by how many INDEPENDENT origins used the phrase.
 */
export function derivePhrases(results, { angles = [], topic = '', seen = new Set() } = {}) {
  const asked = (angles || []).join(' ').toLowerCase();
  // A phrase is only a lead if it is ABOUT the question. Without this, page
  // chrome wins on frequency — blog bylines and "Post date" outrank the
  // actual property name, and round 2 hunts for the author.
  const topical = new Set(
    `${topic} ${asked}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !WEAK_TERMS.has(w)),
  );
  const onTopic = (p) => {
    const low = p.toLowerCase();
    for (const t of topical) if (low.includes(t)) return true;
    return false;
  };
  const counts = new Map();
  for (const r of (results || []).filter((x) => x?.ok && x.text)) {
    const origin = r.origin || r.source;
    const local = new Set();
    const add = (raw) => {
      const p = String(raw || '').trim().replace(/\s+/g, ' ');
      if (p.length < 8 || p.length > 60) return;
      if (!/\s/.test(p)) return;                 // must be multi-word
      if (!/[a-zA-Z]/.test(p)) return;
      if (/^https?:/i.test(p) || /[{}<>|]/.test(p)) return;
      const low = p.toLowerCase();
      if (asked.includes(low)) return;            // already asked — no new info
      if (seen.has(low)) return;
      if (!onTopic(p)) return;
      local.add(p);
    };
    for (const m of r.text.matchAll(/`([^`\n]{8,60})`/g)) add(m[1]);
    for (const m of r.text.matchAll(/"([A-Za-z][^"\n]{7,59})"/g)) add(m[1]);
    // property/identifier-ish runs: "current AirPlay devices", "sound volume"
    for (const m of r.text.matchAll(/\b((?:[a-z]+\s+){1,2}(?:[A-Z][A-Za-z]+\s+)?[a-z]+s?)\b/g)) {
      if (/\b(airplay|device|property|volume|track|playlist|output|selected)\b/i.test(m[1])) add(m[1]);
    }
    for (const p of local) {
      const cur = counts.get(p.toLowerCase()) || { phrase: p, origins: new Set() };
      cur.origins.add(origin);
      counts.set(p.toLowerCase(), cur);
    }
  }
  return [...counts.values()]
    .map((c) => ({ phrase: c.phrase, agree: c.origins.size }))
    .sort((a, b) => b.agree - a.agree || a.phrase.length - b.phrase.length)
    .slice(0, 6);
}

/** Turn discovered vocabulary into sharper round-2 queries. */
export function refineAngles(phrases, { topic = '', hints = [] } = {}) {
  const out = [];
  for (const h of (hints || []).filter(Boolean)) out.push(String(h));
  for (const { phrase } of (phrases || []).slice(0, 3)) {
    out.push(`"${phrase}" example syntax`);
    if (topic) out.push(`"${phrase}" ${topic}`);
  }
  return [...new Set(out)].slice(0, 4);
}

/* ------------------------------------------------------------------ *
 * Public entry
 * ------------------------------------------------------------------ */

/**
 * @param {object} q
 * @param {string[]} q.angles   different phrasings of the SAME question
 * @param {string}   q.topic    optional focus passed to docs lookups
 * @param {string[]} q.sites    optional official doc domains for firecrawl
 */
export async function gsearch({
  angles = [],
  topic = '',
  sites = [],
  rounds = 2,
  refine = [],
} = {}) {
  const have = await detectGsearch();

  const runRound = async (qs, tag) => {
    const jobs = [];
    if (have.context7 && qs.length) jobs.push(context7Angles(qs, { topic }));
    if (have.firecrawl && sites.length && tag === 'r1') {
      for (const site of sites.slice(0, 2)) {
        jobs.push(firecrawlAngles(site, topic || qs[0] || ''));
      }
    }
    if (have.firecrawl && qs.length) jobs.push(webAngles(qs));
    const res = (await Promise.all(jobs)).flat();
    return res.map((r) => ({ ...r, round: tag }));
  };

  const first = await runRound(angles, 'r1');

  // Round 2: hunt with the vocabulary round 1 revealed. A first search tells
  // you what things are CALLED; the follow-up is what finds how they are
  // USED — which is where the earlier runs kept failing.
  let second = [];
  let refined = [];
  if (rounds > 1 && have.firecrawl && first.some((r) => r.ok)) {
    const phrases = derivePhrases(first, { angles, topic });
    refined = refineAngles(phrases, { topic, hints: refine });
    if (refined.length) second = await runRound(refined, 'r2');
  }

  const results = [...first, ...second];
  return {
    available: have,
    rounds: second.length ? 2 : 1,
    refinedAngles: refined,
    results,
    agreed: corroborate(results),
  };
}

/** Compact, tier-labelled evidence board for the model. */
export function formatGsearch({ available, results, agreed }) {
  if (!results?.length) {
    return `GSEARCH unavailable or empty (context7=${available?.context7 ? 'up' : 'down'} firecrawl=${available?.firecrawl ? 'up' : 'down'}). Use local discovery instead.`;
  }
  const board = results
    .map(
      (r) =>
        `### [tier ${r.tier}] ${r.source} ${r.ok ? '' : '(empty)'}\n${String(r.text || '').slice(0, 2500) || '(nothing)'}`,
    )
    .join('\n\n');
  const confirmed = (agreed || []).filter((a) => a.confirmed);
  const repeated = (agreed || []).filter((a) => !a.confirmed);
  const agree = [
    confirmed.length
      ? `CONFIRMED (${confirmed.length}) — seen in 2+ INDEPENDENT sources:\n` +
        confirmed.map((a) => `- ${a.id}  [${a.origins.join(', ')}]`).join('\n')
      : 'CONFIRMED: none — nothing was corroborated by independent sources.',
    repeated.length
      ? `\nREPEATED in a single source only (WEAKER — verify before relying on it):\n` +
        repeated.slice(0, 10).map((a) => `- ${a.id}  [${a.origins[0]} x${a.hits}]`).join('\n')
      : '',
  ].filter(Boolean).join('\n');
  const r2 = arguments[0]?.refinedAngles?.length
    ? `\nROUND 2 refined the search using vocabulary round 1 revealed: ${arguments[0].refinedAngles.map((a) => `"${a}"`).join(', ')}\n`
    : '';
  return `AGREED ACROSS SOURCES (trust these first):\n${agree}\n${r2}\nRAW EVIDENCE\n${board}`;
}
