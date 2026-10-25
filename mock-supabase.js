/* mock-supabase.js — in-memory stand-in for supabase-js v2 (UMD global `supabase`), for visual
   tests of the « Réseau DE · Control » front. In a TEST COPY of index.html, replace
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js">
   with <script src="mock-supabase.js">. No network, nothing persisted; a reload starts over.

   Scenarios (?mock=…, comma-combinable, e.g. ?mock=error,slow; remembered per tab in sessionStorage,
   ?mock=full resets): full (default) · empty · error · slow · login · denied.

   Fidelity choices (so a wrong name fails here instead of silently in production):
   - RPC args are matched by name like PostgREST: unknown or missing args → PGRST202.
   - Unknown table / column → PGRST205 / 42703; unknown payload key → PGRST204; bad uuid/int/date → 22P02/22007.
   - RLS: insert on a read-only table → 42501; update/delete there → 0 rows, no error.
     UPDATE/DELETE without a filter → 21000 (Supabase safeupdate).
   - Writes return data:null unless .select() is chained (supabase-js default).
   - Edge-function errors are FunctionsHttpError-like: error.context.json() → {error:'…'}.
   - pipeline `call` params are serialised like supabase/functions/pipeline/index.ts:55-60
     (arrays → JSON strings, numbers → String, null dropped); the mock Apps Script JSON.parses sites/weeks.
   - pipeline_state is a snapshot: mutating gas actions refresh it ~3.5 s later (pipeline/index.ts:40-44).
   Inspect state from the console: supabase.__mock. */
(function (root) {
  'use strict';

  /* ───────── Scenario ───────── */
  const BASES = ['full', 'empty', 'error', 'login', 'denied'];
  function readScenario() {
    let q = '', s = '';
    try { q = new URLSearchParams((root.location && root.location.search) || '').get('mock') || ''; } catch (_) {}
    s = q;
    try { if (q) root.sessionStorage.setItem('mock_scenario', q); else s = root.sessionStorage.getItem('mock_scenario') || ''; } catch (_) {}
    const t = String(s || 'full').toLowerCase().split(/[\s,+]+/).filter(Boolean);
    return { base: t.find((x) => BASES.includes(x)) || 'full', slow: t.includes('slow'), raw: t.join(',') || 'full' };
  }
  const SC = readScenario();
  const FULLISH = SC.base !== 'empty';
  const CFG = { google: FULLISH, n8n: FULLISH, telegram: FULLISH, gasSecrets: FULLISH };

  /* ───────── PRNG + helpers ───────── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(s) { s = String(s); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const noise = (k) => mulberry32(hash(k))();
  const rnd = mulberry32(20261025);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const r2 = (x) => Math.round(x * 100) / 100;
  const real = (x) => (x == null || !isFinite(x) ? null : Number(Number(x).toPrecision(7)));
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const sum = (arr, f) => arr.reduce((n, x) => n + (f ? f(x) : x), 0);
  const cnt = (arr, f) => arr.reduce((n, x) => n + (f(x) ? 1 : 0), 0);
  const groupBy = (arr, f) => { const m = {}; arr.forEach((x) => { const k = f(x); (m[k] = m[k] || []).push(x); }); return m; };
  function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function uuid() {
    let s = ''; for (let i = 0; i < 32; i++) s += Math.floor(rnd() * 16).toString(16);
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${'89ab'[Math.floor(rnd() * 4)]}${s.slice(17, 20)}-${s.slice(20)}`;
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const slug = (s) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[éèê]/g, 'e').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  /* ───────── Time (dates relative to load time; DB dates in UTC like Postgres current_date) ───────── */
  const NOW = Date.now(), DAY = 864e5, MIN = 6e4;
  const isoD = (ms) => new Date(ms).toISOString().slice(0, 10);
  const dayN = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / DAY);
  const nToD = (n) => isoD(n * DAY);
  const addD = (d, k) => nToD(dayN(d) + k);
  const TODAY = isoD(NOW), TODAY_N = dayN(TODAY);
  const ago = (min) => new Date(NOW - min * MIN).toISOString();
  const nowIso = () => new Date().toISOString();
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const monthStart = (d) => d.slice(0, 8) + '01';
  const monthEnd = (d) => { const x = new Date(monthStart(d) + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return isoD(+x); };
  function tzDay(ms, tz) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
    catch (_) { return isoD(ms); }
  }
  function tzOff(tz, ms) {
    try {
      const v = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;
      const m = v.match(/([+-]\d{2}):?(\d{2})/); return m ? `${m[1]}:${m[2]}` : '+00:00';
    } catch (_) { return '+00:00'; }
  }
  const SHEET_TZ = 'Africa/Casablanca';
  const SDAY = tzDay(NOW, SHEET_TZ);
  const sday = (k) => addD(SDAY, k);
  const sAt = (day, hm, tz) => `${day}T${hm}:00${tzOff(tz || SHEET_TZ, Date.parse(day + 'T12:00:00Z'))}`;
  function tzMinutes(ms, tz) {
    try { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)); return +p.find((x) => x.type === 'hour').value * 60 + +p.find((x) => x.type === 'minute').value; }
    catch (_) { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
  }
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const frDate = (iso) => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Casablanca' });

  /* ───────── Catalogue: the 13 sites (03_sheets/Sites_13.csv), Pinterest share, SEO profile ───────── */
  // key, domain, type, label, id prefix, clicks/day, ctr, position, pinterest share, account, articles, ga4, season amp, peak month
  const CAT = [
    ['foodzauber', 'foodzauber.blog', 'hub', 'Foodzauber', 'FZ', 540, 0.034, 13.5, 0.30, '7201', 96, 1, 0.10, 12],
    ['kochliebe', 'kochliebe.online', 'primary', null, 'KL', 380, 0.038, 15, 0.25, '7202', 88, 1, 0.12, 12],
    ['rezeptflow', 'rezeptflow.blog', 'primary', null, 'RF', 240, 0.029, 18, 0.12, '7203', 74, 1, 0.15, 1],
    ['schnelllecker', 'schnelllecker.blog', 'primary', null, 'SL', 320, 0.036, 14, 0.18, '7204', 82, 1, 0.05, 3],
    ['rezeptnest', 'rezeptnest.blog', 'primary', 'Rezeptnest', 'RN', 470, 0.041, 12.5, 0.42, '7205', 104, 1, 0.30, 12],
    ['yumrezept', 'yumrezept.blog', 'primary', null, 'YR', 410, 0.033, 16, 0.35, '7206', 92, 1, 0.06, 7],
    ['airfryer', 'airfryer-rezepte.blog', 'nano', 'Airfryer', 'AF', 640, 0.052, 9.5, 0.10, '7207', 58, 1, 0.12, 1],
    ['plaetzchen', 'plaetzchenrezepte.blog', 'nano', null, 'PL', 170, 0.047, 11, 0.40, '7208', 44, 1, 0.85, 12],
    ['zimtschnecken', 'zimtschneckenrezept.blog', 'nano', null, 'ZS', 110, 0.045, 12, 0.45, '7209', 38, 0, 0.35, 11],
    ['waffeln', 'waffelnrezept.blog', 'nano', null, 'WA', 60, 0.031, 22, 0, null, 32, 1, 0.10, 2],
    ['kaesekuchen', 'kaesekuchenrezept.blog', 'nano', null, 'KK', 210, 0.043, 13, 0.38, '7210', 46, 1, 0.10, 4],
    ['gulasch', 'gulaschrezept.blog', 'nano', null, 'GU', 290, 0.049, 10.5, 0.08, '7211', 40, 1, 0.45, 1],
    ['pfannkuchen', 'pfannkuchenrezept.blog', 'nano', null, 'PK', 140, 0.039, 17, 0.30, '7212', 42, 1, 0.10, 2],
  ].map((r, i) => ({ i, key: r[0], domain: r[1], type: r[2], label: r[3], prefix: r[4], base: r[5], ctr: r[6], pos0: r[7], pin: r[8],
    account: r[9], n: r[10], ga4: !!r[11], amp: r[12], peak: r[13] * 30.4 - 15,
    age: r[2] === 'nano' ? 290 + r[0].length * 3 : 486, mid: r[2] === 'nano' ? 110 : 160, k: r[2] === 'nano' ? 38 : 48, drop: r[0] === 'waffeln' }));
  const DIDX = Object.fromEntries(CAT.map((c) => [c.domain, c.i]));
  const DISH = {
    foodzauber: 'rinderrouladen|sauerbraten|schweinebraten|rinderfilet|entenbrust|lammkeule|hackbraten|schokoladenkuchen|tiramisu|panna cotta|käsespätzle|kartoffelgratin|rotkohl|semmelknödel|lachsfilet|risotto|lasagne|cordon bleu|wiener schnitzel|bratensoße|crème brûlée|mousse au chocolat|ossobuco|zwiebelrostbraten|kalbsbraten',
    kochliebe: 'kartoffelsalat|frikadellen|königsberger klopse|erbsensuppe|linsensuppe|kohlrouladen|bienenstich|apfelkuchen|streuselkuchen|zwetschgenkuchen|kartoffelpuffer|milchreis|grießbrei|hühnerfrikassee|senfeier|labskaus|schmorgurken|bratkartoffeln|marmorkuchen|butterkuchen|nudelauflauf|serviettenknödel|rinderbrühe|bohneneintopf',
    rezeptflow: 'overnight oats|protein bowl|quinoa salat|linsen curry|hähnchen bowl|zucchini nudeln|blumenkohlreis|protein brot|chia pudding|skyr bowl|thunfisch salat|putenbrust|gemüsepfanne|tofu curry|kichererbsen salat|meal prep reis|buddha bowl|shakshuka|gefüllte paprika|hüttenkäse auflauf|lachs bowl|couscous salat|rote linsen suppe',
    schnelllecker: 'nudelpfanne|ofengemüse|gnocchi pfanne|wraps|spaghetti carbonara|flammkuchen|hähnchen pfanne|reispfanne|bratnudeln|tortellini auflauf|ofenkartoffeln|toast hawaii|pasta pesto|blechgemüse|schupfnudeln|gebratener reis|tomatensuppe|käsenudeln|wok gemüse|pasta mit tomatensoße|feierabend pasta|hähnchen geschnetzeltes',
    rezeptnest: 'kürbissuppe|kartoffelsuppe|hühnersuppe|linseneintopf|chili con carne|kartoffelauflauf|brokkoli auflauf|hefezopf|apfelstrudel|bratapfel|porridge|french toast|kürbis risotto|maronensuppe|zwiebelsuppe|ofenkürbis|kaiserschmarrn|dampfnudeln|germknödel|rahmspinat|sauerkraut eintopf|wirsing eintopf|rinderschmorbraten',
    yumrezept: 'smash burger|pulled pork|chicken wings|nachos|mac and cheese|käsefondue|ramen|bao buns|butter chicken|döner selber machen|burrito|hot dog|croque monsieur|onion rings|mozzarella sticks|cookie dough|brownies|no bake cookies|sushi bowl|chili cheese fries|tacos|loaded fries',
    airfryer: 'airfryer pommes|airfryer hähnchenschenkel|airfryer gemüse|airfryer kartoffeln|airfryer lachs|airfryer brötchen|airfryer kuchen|airfryer falafel|airfryer süßkartoffel pommes|airfryer schnitzel|airfryer rosenkohl|airfryer hähnchenbrust|airfryer würstchen|airfryer garnelen|airfryer gnocchi|airfryer blumenkohl|airfryer chicken nuggets|airfryer tofu|heißluftfritteuse rezepte|airfryer rezepte',
    plaetzchen: 'vanillekipferl|spitzbuben|zimtsterne|butterplätzchen|kokosmakronen|lebkuchen|spekulatius|husarenkrapfen|engelsaugen|nussecken|florentiner|schwarz weiß gebäck|haferflockenkekse|terrassenplätzchen|heidesand|ausstechplätzchen|pfeffernüsse|elisenlebkuchen|plätzchen rezepte',
    zimtschnecken: 'zimtschnecken|zimtschnecken hefeteig|zimtschnecken ohne hefe|zimtschnecken vom blech|zimtschnecken mit frischkäse|schwedische zimtschnecken|zimtschnecken quark öl teig|franzbrötchen|zimtschnecken kuchen|cinnamon rolls|apfel zimtschnecken|mohnschnecken|nussschnecken|zimtschnecken glasur|zimtschnecken über nacht|kardamomschnecken',
    waffeln: 'waffeln|belgische waffeln|herzwaffeln|waffeln ohne butter|quarkwaffeln|buttermilch waffeln|waffelteig|dinkel waffeln|schoko waffeln|herzhafte waffeln|kartoffelwaffeln|bubble waffles|waffeln ohne zucker|zimtwaffeln|apfelwaffeln',
    kaesekuchen: 'käsekuchen|käsekuchen ohne boden|käsekuchen mit mürbeteig|new york cheesecake|käsekuchen vom blech|käse sahne torte|russischer zupfkuchen|schmandkuchen|käsekuchen mit mandarinen|quarkkuchen|käsekuchen ohne backen|japanischer käsekuchen|käsekuchen muffins|basque cheesecake|käsekuchen mit kirschen',
    gulasch: 'gulasch|rindergulasch|schweinegulasch|ungarisches gulasch|gulaschsuppe|gulasch im schnellkochtopf|wiener saftgulasch|gulasch mit paprika|putengulasch|hirschgulasch|kesselgulasch|szegediner gulasch|pilzgulasch|gulasch mit rotwein|fiakergulasch',
    pfannkuchen: 'pfannkuchen|pfannkuchen ohne milch|pfannkuchenteig|eierkuchen|crêpes|dinkel pfannkuchen|pfannkuchen ohne ei|herzhafte pfannkuchen|apfelpfannkuchen|quarkpfannkuchen|buttermilch pfannkuchen|bananenpfannkuchen|pfannkuchen torte|palatschinken|ofenpfannkuchen',
  };
  const MODS = ['', ' einfach', ' schnell', ' klassisch', ' saftig', ' thermomix', ' grundrezept', ' mit wenig zutaten', ' für gäste'];
  function kwFor(key, i) {
    const D = DISH[key].split('|'), dish = D[i % D.length], m = Math.floor(i / D.length);
    if (m === 0) return /rezept/.test(dish) ? dish : dish + ' rezept';
    return dish + (MODS[m] || ' variante ' + m);
  }
  // GSC queries per site: its article keywords + branded queries, Zipf weights, momentum, position factor
  const QL = CAT.map((c) => {
    const kws = []; for (let i = 0; i < c.n; i++) kws.push(kwFor(c.key, i));
    const brand = [c.key, c.key + ' blog', c.domain];
    const order = shuffle(kws.slice(), mulberry32(hash('q:' + c.key)));
    const L = order.map((q, r) => ({ q, slug: slug(q), w: 1 / Math.pow(r + 1.6, 0.95), m: noise('m' + q) * 1.4 - 0.7, pf: 0.45 + (r / order.length) * 1.3 + noise('p' + q) * 0.3 }));
    brand.forEach((q, j) => L.push({ q, slug: '', w: 0.12 / (j + 1), m: 0.1, pf: 0.12 }));
    return L;
  });

  /* ───────── SEO model: deterministic per (site, day) ───────── */
  const DOW = [1.18, 1, 0.96, 0.95, 0.97, 0.9, 1.08]; // getUTCDay order (0 = Sunday)
  const dayCache = new Map();
  function seoDay(si, n) {
    const key = si * 1e6 + n;
    if (dayCache.has(key)) return dayCache.get(key);
    const s = CAT[si], a = TODAY_N - n; let v = null;
    if (a >= 0 && a <= s.age) {
      const g = 1 / (1 + Math.exp((a - s.mid) / s.k));
      const y = new Date(n * DAY).getUTCFullYear(), doy = n - dayN(y + '-01-01');
      const season = 1 + s.amp * Math.cos((2 * Math.PI * (doy - s.peak)) / 365);
      const r = noise(s.key + ':' + n), r3 = noise(s.key + '/i' + n);
      let c = s.base * g * DOW[(n + 4) % 7] * season * (0.85 + 0.3 * r);
      if (s.drop && a < 9) c *= 0.52;
      const clicks = Math.max(0, Math.round(c));
      const impressions = Math.round(((c + 0.5) / s.ctr) * (0.9 + 0.2 * r3)) + Math.round(40 * g);
      const pos = clamp(s.pos0 + (Math.min(a, 300) / 300) * 9 + (r3 - 0.5) * 2.4, 8, 35);
      const google = c * 1.07, pg = s.pin ? 1 / (1 + Math.exp((a - 35) / 12)) : 0;
      const pinS = s.pin ? ((google * s.pin) / (1 - s.pin)) * pg * (0.8 + 0.4 * noise(s.key + '/p' + n)) : 0;
      const other = google * 0.24 * (0.85 + 0.3 * noise(s.key + '/o' + n));
      const sessions = Math.round(google + pinS + other), pinterest = Math.round(pinS), gg = Math.round(google);
      v = { clicks, impressions, pos, sessions, users: Math.round(sessions * 0.83), pinterest, google: gg, other: sessions - gg - pinterest };
    }
    dayCache.set(key, v);
    return v;
  }
  const gscDay = (si, n) => (TODAY_N - n >= 2 ? seoDay(si, n) : null);           // GSC lags 2 days: J-1 is empty
  const ga4Day = (si, n) => (CAT[si].ga4 && TODAY_N - n >= 1 ? seoDay(si, n) : null);
  function rangeSum(si, from, to) {
    const o = { clicks: 0, impr: 0, posW: 0, sessions: 0, users: 0, pin: 0, google: 0, other: 0 };
    if (si == null || !from || !to) return o;
    for (let n = Math.max(dayN(from), TODAY_N - 700); n <= Math.min(dayN(to), TODAY_N); n++) {
      const g = gscDay(si, n); if (g) { o.clicks += g.clicks; o.impr += g.impressions; o.posW += g.pos * g.impressions; }
      const a = ga4Day(si, n); if (a) { o.sessions += a.sessions; o.users += a.users; o.pin += a.pinterest; o.google += a.google; o.other += a.other; }
    }
    return o;
  }
  function qWindow(si, from, to) {
    const t = rangeSum(si, from, to); if (!t.impr) return [];
    const x = clamp((TODAY_N - (dayN(from) + dayN(to)) / 2) / 120, 0, 1), pos = t.posW / t.impr, L = QL[si];
    const ws = L.map((o) => o.w * Math.max(0.15, 1 + o.m * (0.5 - x))), sw = sum(ws), wi = ws.map((w) => Math.pow(w, 0.6)), swi = sum(wi);
    return L.map((o, i) => {
      const impressions = Math.round((t.impr * 0.62 * wi[i]) / swi);
      return { key: o.q, slug: o.slug, clicks: Math.min(impressions, Math.round((t.clicks * 0.72 * ws[i]) / sw)), impressions, pos: clamp(pos * o.pf, 1, 80) };
    }).filter((r) => r.impressions > 0);
  }
  function mergeRows(rows) {
    const m = new Map();
    rows.forEach((r) => { const o = m.get(r.key) || { key: r.key, clicks: 0, impressions: 0, posW: 0, extra: r.extra }; o.clicks += r.clicks; o.impressions += r.impressions; o.posW += (r.pos || 0) * r.impressions; m.set(r.key, o); });
    return m;
  }
  const byClicks = (a, b) => b.clicks - a.clicks || b.impressions - a.impressions;
  const COUNTRY = [['deu', 0.795, 0], ['aut', 0.102, 0.8], ['che', 0.061, 1.3], ['lux', 0.007, 2.1], ['bel', 0.006, 3.5], ['nld', 0.005, 4.2], ['ita', 0.004, 6], ['fra', 0.004, 6.5], ['usa', 0.003, 9], ['gbr', 0.003, 8], ['pol', 0.003, 5], ['esp', 0.002, 7], ['mar', 0.002, 4], ['tur', 0.002, 6]];
  const DEVICE = [['MOBILE', 0.74, -0.4], ['DESKTOP', 0.235, 1.2], ['TABLET', 0.025, 0.6]];
  const SRC_OTHER = [['(direct)', '(none)', 0.40], ['bing', 'organic', 0.19], ['ecosia.org', 'organic', 0.09], ['duckduckgo', 'organic', 0.07], ['chatgpt.com', 'referral', 0.06], ['m.facebook.com', 'referral', 0.05], ['yahoo', 'organic', 0.04], ['web.de', 'referral', 0.03], ['flipboard.com', 'referral', 0.03], ['t.co', 'referral', 0.02], ['startpage.com', 'organic', 0.02]];
  const SRC_PIN = [['pinterest.com', 'referral', 0.74], ['de.pinterest.com', 'referral', 0.19], ['pinterest', 'social', 0.07]];
  const PAGES = CAT.map((c, si) => [{ path: '/', w: 0.9 }, { path: '/rezepte/', w: 0.25 }, { path: '/ueber-mich/', w: 0.05 }, { path: '/impressum/', w: 0.02 }]
    .concat(QL[si].filter((q) => q.slug).map((q) => ({ path: '/' + q.slug + '/', w: q.w * (0.6 + c.pin * 2 * noise('pg' + q.q)) }))));

  /* ───────── Fixtures ───────── */
  const DB = {};
  const W = {}; // named fixture ids
  const POD_URL = 'https://k7m2q9x4p1-8000.proxy.runpod.net';
  const WF_ERR = ['Carte WPRM : JSON invalide après 2 réparations', 'DeepSeek v4-pro : timeout après 120 s', 'Refus qualité : H1 contient un mot réservé (« wochenplan »)',
    "WordPress 401 : mot de passe d'application refusé (Wordfence)", "Doublon d'intention détecté avec un autre site du réseau", 'Réponse vide du modèle (finish_reason=length)'];
  const IMG_ERR = { failed: "File d'images : timeout (131 s)", failed_gpu: 'GPU : CUDA out of memory (pod redémarré)', failed_upload: 'WP media 413 Request Entity Too Large', processing: 'Bloqué en processing depuis plus de 3 h' };
  const PIN_ERR = ['Blotato 429 Too Many Requests', 'Board introuvable : « Pizza Rezepte »', 'Renderer 502 Bad Gateway', 'Image manquante (colonne Img URL vide)'];
  const GSC_403 = "Google API 403: User does not have sufficient permission for site 'sc-domain:waffelnrezept.blog'. See also: https://support.google.com/webmasters/answer/2451999.";
  const HTML_ERR = "Apps Script a renvoyé une page HTML : vérifie que le web app est déployé en accès « Anyone » et que l'URL se termine par /exec.";
  const WF_SPECS = [ // name, tags, active, watch, expected_every_min, kind, every (min), duration s [min, max]
    ['WF1 v10 — Articles (clusters)', ['production', 'articles'], true, true, null, 'wf1', 0, [240, 1500]],
    ['WF2a — Images (GPU RunPod)', ['production', 'images', 'gpu'], true, true, 60, 'cron', 30, [240, 540]],
    ['WF2b — Upload WordPress', ['production', 'images', 'wordpress'], true, true, 60, 'cron', 30, [40, 95]],
    ['WF3a — Pins (DeepSeek + renderer)', ['production', 'pinterest'], true, true, 120, 'wf3a', 60, [60, 180]],
    ['WF3b — Publication Blotato', ['production', 'pinterest', 'blotato'], true, true, 30, 'wf3b', 10, [3, 12]],
    ['WF3c — Pins IA (infographies)', ['pinterest', 'ia'], true, true, null, 'cron', 120, [90, 200]],
    ['WF6 — Tendances Pinterest', ['tendance', 'pinterest'], true, true, 1440, 'wf6', 1440, [120, 300]],
    ['TENDANCE — WF1 articles', ['tendance'], true, false, null, 'irregular', 0, [180, 900]],
    ['TENDANCE — Pinterest (pins IA + publication)', ['tendance', 'pinterest'], true, true, null, 'cron', 60, [60, 150]],
    ['Erreurs → Telegram', ['monitoring'], true, false, null, 'errwf', 0, [1, 3]],
    ['WF4 — Vidéos sous-titrées', ['video'], false, true, null, 'none', 0, [0, 0]],
    ['JETABLE test — écriture Master', ['jetable', 'test'], false, false, null, 'jetable', 0, [5, 40]],
    ['JETABLE — lecture onglet Sites', ['jetable'], false, false, null, 'none', 0, [0, 0]],
  ];
  const lastSyncMin = 1 + (Math.floor(NOW / MIN) % 5);
  function wfId() { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; for (let i = 0; i < 16; i++) s += A[Math.floor(rnd() * A.length)]; return s; }

  function buildExecutions(wfs) {
    const out = [], H = 15 * DAY, t0 = NOW - H;
    const add = (wf, start, dur, status, mode) => {
      if (start > NOW - 1000) return;
      const stop = status === 'running' ? null : Math.min(start + dur * 1000, NOW - 500);
      out.push({ workflow_id: wf.id, status, mode, started_at: new Date(start).toISOString(), stopped_at: stop == null ? null : new Date(stop).toISOString() });
    };
    const dur = (s) => between(s[7][0], s[7][1]);
    wfs.forEach((wf, k) => {
      const s = WF_SPECS[k], kind = s[5], every = s[6] * MIN;
      if (kind === 'cron' || kind === 'wf3a' || kind === 'wf3b') {
        const off = (k * 7) % Math.max(1, s[6]) * MIN;
        const runs = []; for (let t = Math.ceil((t0 - off) / every) * every + off; t < NOW; t += every) runs.push(t);
        runs.forEach((t, j) => {
          let st = rnd() < 0.008 ? 'error' : 'success';
          if (kind === 'wf3a' && j >= runs.length - 5) st = 'error';
          if (kind === 'wf3a' && j === runs.length - 100) st = 'crashed';
          if (kind === 'wf3b' && NOW - t < DAY && rnd() < 0.022) st = 'error';
          if (kind === 'wf3b' && j === runs.length - 1) st = 'success';
          if (s[0].startsWith('WF2b') && j === runs.length - 150) st = 'canceled';
          add(wf, t + between(0, 40) * 1000, dur(s), st, kind === 'wf3b' ? 'webhook' : 'trigger');
        });
      } else if (kind === 'wf1' || kind === 'irregular') {
        for (let d = 14; d >= 0; d--) for (let j = 0; j < (kind === 'wf1' ? 6 : 4); j++) add(wf, NOW - d * DAY - between(30, 1380) * MIN, dur(s), rnd() < (kind === 'wf1' ? 0.07 : 0.03) ? 'error' : 'success', 'webhook');
        if (kind === 'wf1') add(wf, NOW - 7 * MIN, 0, 'running', 'webhook');
      } else if (kind === 'wf6') {
        for (let d = 14; d >= 3; d--) { const t = Date.parse(addD(TODAY, -d) + 'T06:00:00Z'); add(wf, t, dur(s), d === 9 ? 'error' : 'success', 'trigger'); }
      } else if (kind === 'errwf') {
        for (let d = 14; d >= 0; d--) add(wf, NOW - d * DAY - between(60, 1300) * MIN, dur(s), 'success', 'error');
      } else if (kind === 'jetable') {
        const t = NOW - 5 * DAY - 200 * MIN; add(wf, t, 12, 'error', 'manual'); add(wf, t + 9 * MIN, 30, 'error', 'manual'); add(wf, t + 21 * MIN, 25, 'success', 'manual');
      }
    });
    out.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    out.forEach((e, i) => {
      e.id = String(182400 + i);
      const st = Date.parse(e.started_at);
      e.synced_at = NOW - st < 3 * 3600e3 || !e.stopped_at ? ago(lastSyncMin) : new Date(Math.min(NOW, Date.parse(e.stopped_at) + between(1, 5) * MIN)).toISOString();
    });
    return out.map((e) => ({ id: e.id, workflow_id: e.workflow_id, status: e.status, mode: e.mode, started_at: e.started_at, stopped_at: e.stopped_at, synced_at: e.synced_at }));
  }

  function backfillJobs(siteId, hasGsc, hasGa4, months, today) {
    const jobs = [], yesterday = addD(today, -1), sd = new Date(today + 'T00:00:00Z');
    sd.setUTCMonth(sd.getUTCMonth() - months);
    const start = addD(isoD(+sd), 3), minD = (a, b) => (a < b ? a : b);
    if (hasGsc) for (let d = start; d <= yesterday; d = addD(d, 7)) jobs.push({ site_id: siteId, kind: 'gsc_days', start_date: d, end_date: minD(addD(d, 6), yesterday), priority: 5 });
    if (hasGa4) for (let d = start; d <= yesterday; d = addD(d, 31)) jobs.push({ site_id: siteId, kind: 'ga4_days', start_date: d, end_date: minD(addD(d, 30), yesterday), priority: 5 });
    for (let m = monthStart(start); m <= yesterday; m = addD(monthEnd(m), 1)) {
      const e = minD(monthEnd(m), yesterday);
      if (hasGsc) jobs.push({ site_id: siteId, kind: 'gsc_month', start_date: m, end_date: e, priority: 6 });
      if (hasGa4) jobs.push({ site_id: siteId, kind: 'ga4_month', start_date: m, end_date: e, priority: 6 });
    }
    return jobs;
  }
  let jobSeq = 1;
  const jobRow = (j, status, created, extra) => Object.assign({ id: jobSeq++, site_id: j.site_id, kind: j.kind, start_date: j.start_date, end_date: j.end_date, priority: j.priority, status, attempts: status === 'queued' ? 0 : 1, error: null, created_at: created, updated_at: created }, extra || {});

  function buildDb() {
    const T = ['alerts', 'google_accounts', 'gsc_sites', 'ga4_properties', 'sites', 'n8n_workflows', 'n8n_executions', 'health_checks', 'settings', 'pipeline_state', 'pipeline_history', 'sync_jobs', 'allowed_users'];
    T.forEach((t) => (DB[t] = []));
    DB.allowed_users.push({ email: 'ikbal@example.test', created_at: ago(40 * 1440) });
    DB.settings.push({ key: 'pipeline_failed_alert', value: 10, updated_at: ago(21 * 1440) }, { key: 'pipeline_pin_gap_hours', value: 48, updated_at: ago(21 * 1440) });
    if (!FULLISH) return;
    [['legacy_dashboard_url', 'https://dashboard-v3.example.test/'], ['apps_script_url', 'https://script.google.com/macros/s/AKfycbMOCKreseauDEmockMOCK/exec'],
      ['gsc_daily_retention_days', 90], ['gsc_daily_top_n', 500], ['monthly_top_n', 1000], ['backfill_months', 16], ['alert_stuck_minutes', 90]]
      .forEach(([key, value]) => DB.settings.push({ key, value, updated_at: ago(20 * 1440) }));
    const accA = { id: uuid(), email: 'reseau.de.seo@example.test', status: 'active', last_error: null, connected_at: ago(21 * 1440), last_discovery_at: ago(2 * 1440 + 130) };
    const accB = { id: uuid(), email: 'ancien.compte@example.test', status: 'error', last_error: 'Token refresh failed: invalid_grant Token has been expired or revoked.', connected_at: ago(40 * 1440), last_discovery_at: ago(30 * 1440) };
    DB.google_accounts.push(accA, accB);
    W.accA = accA.id; W.accB = accB.id;
    const extra = [{ domain: 'alt.foodzauber.blog', url: 'https://alt.foodzauber.blog/', perm: 'siteFullUser' }, { domain: 'staging.kochliebe.online', url: 'sc-domain:staging.kochliebe.online', perm: 'siteRestrictedUser' }];
    CAT.forEach((c) => {
      const g = { id: uuid(), account_id: accA.id, site_url: 'sc-domain:' + c.domain, permission_level: 'siteOwner', domain: c.domain };
      DB.gsc_sites.push(g); c.gscId = g.id;
      if (c.ga4) { const p = { id: uuid(), account_id: accA.id, property_id: String(412300000 + c.i * 7331), display_name: c.domain, account_name: 'Réseau DE', default_uri: 'https://' + c.domain, domain: c.domain }; DB.ga4_properties.push(p); c.gaId = p.id; }
    });
    DB.gsc_sites.push({ id: uuid(), account_id: accA.id, site_url: 'https://foodzauber.blog/', permission_level: 'siteFullUser', domain: 'foodzauber.blog' });
    extra.forEach((e) => { e.id = uuid(); DB.gsc_sites.push({ id: e.id, account_id: accA.id, site_url: e.url, permission_level: e.perm, domain: e.domain }); });
    DB.gsc_sites.push({ id: uuid(), account_id: accB.id, site_url: 'sc-domain:foodzauber.blog', permission_level: 'siteFullUser', domain: 'foodzauber.blog' });
    DB.ga4_properties.push({ id: uuid(), account_id: accA.id, property_id: '398812044', display_name: 'Ancienne propriété (test)', account_name: 'Réseau DE', default_uri: '', domain: null });
    CAT.forEach((c) => {
      const s = { id: uuid(), domain: c.domain, label: c.label, gsc_site_id: c.gscId, ga4_property_id: c.gaId || null, tracked: true, backfill_requested_at: ago(20 * 1440),
        last_sync_at: ago(between(9, 140)), last_sync_error: c.key === 'waffeln' ? GSC_403 : null, created_at: ago(21 * 1440) };
      if (c.key === 'pfannkuchen') s.backfill_requested_at = ago(2 * 1440);
      DB.sites.push(s); c.siteId = s.id;
    });
    extra.forEach((e) => DB.sites.push({ id: uuid(), domain: e.domain, label: null, gsc_site_id: e.id, ga4_property_id: null, tracked: false, backfill_requested_at: null, last_sync_at: null, last_sync_error: null, created_at: ago(21 * 1440) }));
    // sync_jobs → sync_progress
    CAT.forEach((c) => {
      const created = c.key === 'pfannkuchen' ? ago(2 * 1440) : ago(20 * 1440);
      const jobs = backfillJobs(c.siteId, true, c.ga4, 16, c.key === 'pfannkuchen' ? addD(TODAY, -2) : addD(TODAY, -20));
      jobs.forEach((j, k) => {
        let st = 'done', ex = { updated_at: ago(c.key === 'pfannkuchen' ? 300 : 19 * 1440) };
        if (c.key === 'pfannkuchen') st = k < jobs.length * 0.45 ? 'done' : k < jobs.length * 0.45 + 2 ? 'running' : 'queued';
        if (c.key === 'waffeln' && k % 17 === 3) { st = 'error'; ex = { attempts: 4, error: GSC_403, updated_at: ago(between(60, 2000)) }; }
        DB.sync_jobs.push(jobRow(j, st, created, ex));
      });
      [['gsc_days', -5, 1], ['gsc_month', 0, 2]].concat(c.ga4 ? [['ga4_days', -3, 1], ['ga4_month', 0, 2]] : []).forEach(([kind, d, pr]) =>
        DB.sync_jobs.push(jobRow({ site_id: c.siteId, kind, start_date: d ? addD(TODAY, d) : monthStart(addD(TODAY, -1)), end_date: addD(TODAY, -1), priority: pr }, c.key === 'waffeln' && kind.startsWith('gsc') ? 'error' : 'done', ago(between(200, 400)), c.key === 'waffeln' && kind.startsWith('gsc') ? { attempts: 4, error: GSC_403 } : null)));
    });
    // n8n
    WF_SPECS.forEach((s) => DB.n8n_workflows.push({ id: wfId(), name: s[0], active: s[2], tags: s[1], updated_at: ago(between(2, 30) * 1440), watch: s[3], expected_every_min: s[4], synced_at: ago(lastSyncMin) }));
    DB.n8n_executions = buildExecutions(DB.n8n_workflows);
    const hc = (name, url, extraHc) => Object.assign({ id: uuid(), name, url, expect_status: 200, enabled: true, last_status: 200, last_ok: true, last_ms: between(140, 720), last_checked_at: ago(lastSyncMin), last_error: null }, extraHc || {});
    DB.health_checks.push(hc('Pod RunPod /health', POD_URL + '/health', { last_ms: 412 }),
      hc('Renderer VDS :8110', 'http://vds.example.test:8110/health', { last_status: null, last_ok: false, last_ms: 12004, last_error: 'Signal timed out.' }),
      hc('n8n', 'https://n8n.example.test/healthz', SC.base === 'error' ? { last_status: 502, last_ok: false, last_ms: 96 } : null),
      hc('foodzauber.blog', 'https://foodzauber.blog/'), hc('airfryer-rezepte.blog', 'https://airfryer-rezepte.blog/'),
      hc('kochliebe.online (en pause)', 'https://kochliebe.online/', { enabled: false, last_status: 403, last_ok: false, last_checked_at: ago(3 * 1440), last_ms: 380 }));
  }

  /* ───────── The Sheet (mock Apps Script state) + dbAggregate_ ───────── */
  let SHEET = null;
  const GEN = ['text_done', 'drafted', 'scheduled', 'published'];
  const IMGD = ['done', 'scheduled', 'generated', 'uploading', 'failed_upload'];
  function artStatus(w) {
    const r = rnd(), q = rnd();
    if (r < 0.03) return 'failed'; if (r < 0.04) return 'skip'; if (r < 0.045) return 'quarantine';
    if (w <= 5) return q < 0.94 ? 'published' : 'scheduled';
    if (w === 6) return q < 0.6 ? 'published' : q < 0.9 ? 'scheduled' : 'drafted';
    if (w === 7) return q < 0.4 ? 'drafted' : q < 0.7 ? 'scheduled' : 'text_done';
    if (w === 8) return q < 0.5 ? 'text_done' : q < 0.53 ? 'processing' : 'pending';
    return 'pending';
  }
  function imgStatus(st) {
    const q = rnd();
    if (st === 'published' || st === 'scheduled') return q < 0.97 ? 'done' : 'scheduled';
    if (st === 'drafted') return q < 0.7 ? 'done' : q < 0.82 ? 'generated' : q < 0.88 ? 'uploading' : q < 0.94 ? 'failed_upload' : 'failed_gpu';
    if (st === 'text_done') return q < 0.45 ? 'pending' : q < 0.6 ? 'generating' : q < 0.8 ? 'generated' : q < 0.86 ? 'failed' : q < 0.9 ? 'processing' : 'failed_gpu';
    return st === 'skip' || st === 'quarantine' ? '' : 'pending';
  }
  function slotTime(taken, h1, h2, gap, r) {
    for (let k = 0; k < 60; k++) { const t = h1 * 60 + Math.floor(r() * Math.max(1, (h2 - h1) * 60)); if (taken.every((x) => Math.abs(x - t) >= gap)) return t; }
    return null;
  }
  function buildSheet() {
    const A = [], P = []; let pinNo = 10400;
    const nowM = tzMinutes(NOW, SHEET_TZ), due = [Math.max(0, nowM - 95), Math.max(1, nowM - 40)]; // today's planned pins, already due for send_planned
    const pin = (a, site, st, created, extra) => P.push(Object.assign({ pin: 'PIN-' + pinNo++, id: a ? a.id : '', site, account: (SHEET_ACC[site] || ''), st, created, day: '', time: '', at: '', error: '' }, extra || {}));
    const SHEET_ACC = Object.fromEntries(CAT.filter((c) => c.account).map((c) => [c.key, c.account]));
    CAT.forEach((c) => {
      for (let i = 0; i < c.n; i++) {
        const kw = kwFor(c.key, i), week = 1 + Math.floor((i * 10) / c.n), st = artStatus(week), im = imgStatus(st);
        const gen = GEN.includes(st) ? clamp(Math.round((8 - week) * 6.5 + rnd() * 6), 0, 58) : null;
        const imgs = IMGD.includes(im) ? (rnd() < 0.6 ? 8 : between(5, 9)) : 0;
        A.push({ id: `${c.prefix}-${String(i + 1).padStart(4, '0')}`, site: c.key, kw, week, st, im, imgs,
          url: st === 'published' || st === 'scheduled' ? `https://${c.domain}/${slug(kw)}/` : '',
          gen: gen == null ? '' : sday(-gen), imgD: imgs ? sday(-Math.max(0, gen - between(0, 2))) : '',
          error: st === 'failed' ? pick(WF_ERR) : '', imgErr: IMG_ERR[im] || '', genAgo: gen });
      }
    });
    ['rezept test ohne site', 'zeile ohne site', 'kopie manuell'].forEach((kw, i) => A.push({ id: 'XX-000' + (i + 1), site: '', kw, week: 9, st: 'pending', im: 'pending', imgs: 0, url: '', gen: '', imgD: '', error: '', imgErr: '', genAgo: null }));
    // pins: published articles of sites with an account; future calendar with holes; dupes
    const H = { foodzauber: 9, kochliebe: 8, rezeptflow: 7, schnelllecker: 9, rezeptnest: 11, yumrezept: 10, airfryer: 8, plaetzchen: 12, zimtschnecken: 7, kaesekuchen: 8, gulasch: 6, pfannkuchen: 7 };
    const HOLES = { gulasch: [4], zimtschnecken: [3], rezeptflow: [5] };
    CAT.forEach((c) => {
      const pub = A.filter((a) => a.site === c.key && a.st === 'published');
      if (!c.account) { pub.slice(0, 12).forEach((a) => pin(a, c.key, 'done', sday(-between(0, 9)))); return; }
      const start = P.length;
      pub.forEach((a) => { if (rnd() < 0.8) for (let k = between(2, 5); k > 0; k--) pin(a, c.key, null, sday(-between(0, Math.min(30, Math.max(0, a.genAgo - 3))))); });
      const pool = shuffle(P.slice(start), rnd), per = between(2, 4);
      let j = 0;
      for (let d = c.key === 'kaesekuchen' ? 2 : 0; d < H[c.key]; d++) {
        if ((HOLES[c.key] || []).includes(d)) continue;
        const used = new Set(), times = [];
        for (let k = 0; k < per && j < pool.length; j++) {
          const x = pool[j]; if (used.has(x.id)) continue;
          const t = d === 0 && k < 2 ? due[k] : slotTime(times, 7, 22, 30, rnd); times.push(t); used.add(x.id); k++;
          Object.assign(x, { st: d === 0 && k <= 2 ? 'planned' : d <= 2 ? 'scheduled' : 'planned', day: sday(d), time: hm(t) });
        }
      }
      pool.forEach((x) => {
        if (x.st) return;
        const r = rnd();
        if (r < 0.6) { const d = -between(1, 25); Object.assign(x, { st: 'posted', day: sday(d), time: hm(between(420, 1300)) }); }
        else x.st = r < 0.64 ? 'skip' : r < 0.68 ? 'error' : 'done';
        if (x.st === 'error') x.error = pick(PIN_ERR);
      });
      if (c.key === 'zimtschnecken') pool.filter((x) => x.st === 'done').slice(0, 3).forEach((x) => (x.board = false));
      if (c.key === 'yumrezept') pool.filter((x) => x.st === 'done').slice(0, 2).forEach((x) => (x.img = false));
      if (c.key === 'kochliebe') { const x = pool.find((y) => y.st === 'done'); if (x) Object.assign(x, { st: 'planned', day: sday(-1), time: '20:00' }); }
      if (['foodzauber', 'yumrezept', 'rezeptnest'].includes(c.key)) {
        const dd = sday(c.key === 'foodzauber' ? 1 : c.key === 'yumrezept' ? 3 : 5), same = pool.filter((x) => x.day === dd && x.st !== 'posted');
        if (same.length > 1) same[1].id = same[0].id;
      }
    });
    pin(null, '', 'error', sday(-4), { error: 'Ligne sans site (colonne Site vide)' }); pin(null, '', 'error', sday(-2), { error: 'Ligne sans site (colonne Site vide)' });
    P.forEach((x) => { if (x.day) x.at = sAt(x.day, x.time); });
    SHEET = { articles: A, pins: P, accounts: SHEET_ACC, costs: { article: 0.42, image: 0.09, pin: 0.03 }, pod: { url: POD_URL, updated_at: ago(2 * 1440 + 75) },
      auto: { on: true, last: { at: ago(7), sent: 3, expired: 0, ok: true } }, previews: 0 };
  }

  function dash() {
    const sh = SHEET, C = sh.costs, A = sh.articles, P = sh.pins, nm = (x) => x || '—';
    const days = [], nextDays = []; for (let k = -29; k <= 0; k++) days.push(sday(k)); for (let k = 0; k < 14; k++) nextDays.push(sday(k));
    const keys = CAT.map((c) => c.key).concat('—');
    const aBy = groupBy(A, (a) => nm(a.site)), pBy = groupBy(P, (p) => nm(p.site)), pinsOf = groupBy(P, (p) => p.id);
    const isGen = (a) => GEN.includes(a.st), fImg = (a) => String(a.im).startsWith('failed');
    const fut = (p) => (p.st === 'planned' || p.st === 'scheduled') && !!p.day;
    const tally = (arr, f) => arr.reduce((o, x) => { const k = f(x); if (k) o[k] = (o[k] || 0) + 1; return o; }, {});
    const daily = (arr, f, v) => days.map((d) => arr.reduce((n, x) => n + (f(x) === d ? (v ? v(x) : 1) : 0), 0));
    const st = (L, s) => cnt(L, (a) => a.st === s);
    const nImg = sum(A, (a) => a.imgs), withImg = cnt(A, (a) => a.imgs > 0);
    const articles = {
      total: A.length, byStatus: tally(A, (a) => a.st), generated: cnt(A, isGen), published: st(A, 'published'), failed: st(A, 'failed'),
      bySite: keys.filter((k) => aBy[k]).map((k) => { const L = aBy[k]; return { site: k, total: L.length, pending: st(L, 'pending'), published: st(L, 'published'), scheduled: st(L, 'scheduled'), drafted: st(L, 'drafted'), failed: st(L, 'failed'), generated: cnt(L, isGen), cost: r2(cnt(L, isGen) * C.article) }; }),
      byWeek: [...new Set(A.map((a) => a.week))].sort((x, y) => x - y).map((w) => { const L = A.filter((a) => a.week === w); return { week: w, total: L.length, published: st(L, 'published'), generated: cnt(L, isGen), failed: st(L, 'failed') }; }),
      daily: daily(A, (a) => a.gen),
      failedList: A.filter((a) => a.st === 'failed').map((a) => ({ id: a.id, site: nm(a.site), kw: a.kw, status: a.st, error: a.error })),
    };
    const images = {
      byStatus: tally(A, (a) => a.im), articlesDone: cnt(A, (a) => a.im === 'done'), images: nImg, withImages: withImg, avg: withImg ? Math.round((nImg / withImg) * 10) / 10 : 0,
      bySite: keys.filter((k) => aBy[k]).map((k) => { const L = aBy[k], im = (s) => cnt(L, (a) => a.im === s); return { site: k, textDone: cnt(L, isGen), pending: im('pending'), generating: im('generating') + im('processing'), generated: im('generated'), uploading: im('uploading'), done: im('done'), failed: cnt(L, fImg), images: sum(L, (a) => a.imgs), cost: r2(sum(L, (a) => a.imgs) * C.image) }; }),
      daily: daily(A, (a) => a.imgD), dailyImgs: daily(A, (a) => a.imgD, (a) => a.imgs),
      failedList: A.filter((a) => fImg(a) || a.im === 'processing').map((a) => ({ id: a.id, site: nm(a.site), kw: a.kw, status: a.im, error: a.imgErr })),
    };
    const pinSites = keys.filter((k) => pBy[k] || sh.accounts[k]), next7 = nextDays.slice(0, 7), cal = {};
    let covered = 0, noPins = 0, published = 0;
    const bySite = pinSites.map((k) => {
      const L = pBy[k] || [], pub = (aBy[k] || []).filter((a) => a.st === 'published'), cov = cnt(pub, (a) => !!pinsOf[a.id]);
      cal[k] = {}; L.filter(fut).forEach((p) => { if (nextDays.includes(p.day)) cal[k][p.day] = (cal[k][p.day] || 0) + 1; });
      if (k !== '—') { covered += cov; noPins += pub.length - cov; published += pub.length; }
      return { site: k, account: sh.accounts[k] || '', done: st(L, 'done'), planned: st(L, 'planned'), scheduled: st(L, 'scheduled'), posted: st(L, 'posted'), skip: st(L, 'skip'), error: st(L, 'error'),
        total: L.length, cost: r2(L.length * C.pin), next7: cnt(L, (p) => fut(p) && next7.includes(p.day)), nArticles: new Set(L.map((p) => p.id).filter(Boolean)).size,
        pubArticles: pub.length, noPins: pub.length - cov, covered: cov };
    });
    const dupG = groupBy(P.filter(fut), (p) => [p.site, p.account, p.day, p.id].join('|'));
    const dupes = Object.values(dupG).filter((L) => L.length > 1).map((L) => ({ site: nm(L[0].site), account: L[0].account, day: L[0].day, article: L[0].id }));
    const now = Date.now();
    const pins = {
      total: P.length, byStatus: { done: st(P, 'done'), planned: st(P, 'planned'), scheduled: st(P, 'scheduled'), posted: st(P, 'posted'), skip: st(P, 'skip'), error: st(P, 'error') },
      bySite, daily: daily(P, (p) => p.created), cal, dupes, dupCount: dupes.length,
      errors: P.filter((p) => p.st === 'error').map((p) => ({ pin: p.pin, id: p.id, site: nm(p.site), status: p.st, error: p.error })),
      covered, noPins, published, hasPlanCol: true,
    };
    const articleList = A.map((a) => {
      const L = pinsOf[a.id] || [], c = (s) => st(L, s);
      const next = L.filter((p) => fut(p) && Date.parse(p.at) >= now).map((p) => p.at).sort((x, y) => Date.parse(x) - Date.parse(y))[0] || '';
      return { id: a.id, site: nm(a.site), kw: a.kw, url: a.url, st: a.st, im: a.im, imgs: a.imgs, d: c('done'), pl: c('planned'), sc: c('scheduled'), po: c('posted'), sk: c('skip'), er: c('error'), next };
    });
    const month = SDAY.slice(0, 7), inM = (d) => !!d && d.slice(0, 7) === month;
    const tA = r2(articles.generated * C.article), tI = r2(nImg * C.image), tP = r2(P.length * C.pin), total = r2(tA + tI + tP);
    const cost = {
      articles: tA, images: tI, pins: tP, total,
      month: r2(cnt(A, (a) => isGen(a) && inM(a.gen)) * C.article + sum(A, (a) => (inM(a.imgD) ? a.imgs : 0)) * C.image + cnt(P, (p) => inM(p.created)) * C.pin),
      perPublished: articles.published ? r2(total / articles.published) : 0,
      daily: days.map((d) => ({ d, a: r2(cnt(A, (a) => isGen(a) && a.gen === d) * C.article), i: r2(sum(A, (a) => (a.imgD === d ? a.imgs : 0)) * C.image), p: r2(cnt(P, (p) => p.created === d) * C.pin) })),
      bySite: keys.filter((k) => aBy[k] || pBy[k]).map((k) => { const L = aBy[k] || [], a = r2(cnt(L, isGen) * C.article), i = r2(sum(L, (x) => x.imgs) * C.image), p = r2((pBy[k] || []).length * C.pin); return { site: k, a, i, p, t: r2(a + i + p), published: st(L, 'published') }; }),
    };
    return { today: SDAY, tz: SHEET_TZ, costs: Object.assign({}, C), days, nextDays, articles, images, pins, articleList, cost, accounts: Object.assign({}, sh.accounts), pod: Object.assign({}, sh.pod) };
  }

  /* ───────── Alerts (port of _shared/common.ts raiseAlert / resolveAlert) ───────── */
  let alertSeq = 4100;
  function raiseAlert(a, at) {
    const open = DB.alerts.find((x) => x.fingerprint === a.fingerprint && x.resolved_at == null);
    if (open) { Object.assign(open, { last_seen_at: at || nowIso(), title: a.title, details: a.details || {} }); return; }
    DB.alerts.push({ id: alertSeq++, fingerprint: a.fingerprint, kind: a.kind, severity: a.severity || 'warn', title: a.title, details: a.details || {}, created_at: at || nowIso(), last_seen_at: at || nowIso(), notified_at: null, resolved_at: null });
  }
  function resolveAlert(fp) { DB.alerts.forEach((x) => { if (x.fingerprint === fp && x.resolved_at == null) x.resolved_at = nowIso(); }); }
  function settingNum(key, def) { const r = DB.settings.find((x) => x.key === key); const v = r ? parseInt(String(r.value), 10) : NaN; return isNaN(v) ? def : v; }
  function pipelineAlerts(d) { // pipeline/index.ts:117-144
    let open = 0;
    const fa = Number(d.articles.failed || 0), fi = d.images.failedList.filter((x) => String(x.status).startsWith('failed')).length;
    if (fa + fi >= settingNum('pipeline_failed_alert', 10)) { open++; raiseAlert({ fingerprint: 'pipeline_failed', kind: 'pipeline_failed', severity: 'warn', title: `Pipeline : ${fa} article(s) et ${fi} image(s) en échec`, details: { articles: fa, images: fi } }); }
    else resolveAlert('pipeline_failed');
    const gapH = settingNum('pipeline_pin_gap_hours', 48), dd = d.nextDays.slice(0, Math.max(1, Math.ceil(gapH / 24)));
    d.pins.bySite.forEach((s) => {
      const fp = `pin_gap:${s.site}`, waiting = Number(s.done || 0), up = dd.reduce((n, day) => n + Number((d.pins.cal[s.site] || {})[day] || 0), 0);
      if (waiting > 0 && up === 0) { open++; raiseAlert({ fingerprint: fp, kind: 'pin_gap', severity: 'warn', title: `${s.site} : aucun pin planifié sous ${gapH} h (${waiting} prêts)`, details: { site: s.site, waiting } }); }
      else resolveAlert(fp);
    });
    return open;
  }
  function evalWfAlerts() { // ops-sync/index.ts:153-191
    const stuckMin = settingNum('alert_stuck_minutes', 90); let open = 0;
    wfHealth(DB.n8n_workflows).forEach((w) => {
      const e = `wf_error:${w.id}`, sf = `wf_stale:${w.id}`, sk = `wf_stuck:${w.id}`;
      if (!w.watch || !w.active) { [e, sf, sk].forEach(resolveAlert); return; }
      if (w.last_status === 'error' || w.last_status === 'crashed') { open++; raiseAlert({ fingerprint: e, kind: 'wf_error', severity: 'crit', title: `${w.name} : dernière exécution en échec (${w.errors_24h} erreur(s) / 24 h)`, details: { workflow_id: w.id, last_started: w.last_started, errors_24h: w.errors_24h } }); }
      else if (w.last_status === 'success') resolveAlert(e);
      if (w.running_since && Date.now() - Date.parse(w.running_since) > stuckMin * MIN) { open++; raiseAlert({ fingerprint: sk, kind: 'wf_stuck', severity: 'warn', title: `${w.name} tourne depuis plus de ${stuckMin} min`, details: { workflow_id: w.id, running_since: w.running_since } }); }
      else resolveAlert(sk);
      if (w.expected_every_min && Date.now() - (w.last_success ? Date.parse(w.last_success) : 0) > 2 * w.expected_every_min * MIN) {
        open++; raiseAlert({ fingerprint: sf, kind: 'wf_stale', severity: 'warn', title: `${w.name} : aucun succès depuis ${w.last_success ? frDate(w.last_success) : 'jamais'}`, details: { workflow_id: w.id, expected_every_min: w.expected_every_min } });
      } else resolveAlert(sf);
    });
    return open;
  }
  function buildAlerts() {
    if (!FULLISH) return;
    const old = (min, a, resolvedMin) => { raiseAlert(a, ago(min)); const x = DB.alerts[DB.alerts.length - 1]; x.notified_at = ago(min - 1); x.last_seen_at = ago(resolvedMin != null ? resolvedMin + 3 : lastSyncMin); if (resolvedMin != null) x.resolved_at = ago(resolvedMin); };
    const wfs = wfHealth(DB.n8n_workflows), wf = (p) => wfs.find((w) => w.name.startsWith(p));
    old(9 * 1440, { fingerprint: `google:${W.accB}`, kind: 'google_auth', severity: 'crit', title: 'Compte Google déconnecté : reconnecte-le dans Connexions' }, 5 * 1440);
    old(4 * 1440, { fingerprint: 'pipeline_failed', kind: 'pipeline_failed', severity: 'warn', title: 'Pipeline : 12 article(s) et 4 image(s) en échec' }, 3 * 1440);
    old(3 * 1440, { fingerprint: `wf_stuck:${wf('WF1').id}`, kind: 'wf_stuck', severity: 'warn', title: `${wf('WF1').name} tourne depuis plus de 90 min` }, 2 * 1440);
    old(1900, { fingerprint: 'pipeline_api', kind: 'pipeline_api', severity: 'crit', title: 'Pipeline : Apps Script injoignable' }, 1440);
    old(900, { fingerprint: `wf_error:${wf('WF2a').id}`, kind: 'wf_error', severity: 'crit', title: `${wf('WF2a').name} : dernière exécution en échec (2 erreur(s) / 24 h)` }, 360);
    old(250, { fingerprint: `health:${DB.health_checks[1].id}`, kind: 'health_down', severity: 'crit', title: 'Renderer VDS :8110 ne répond pas (timeout/erreur)', details: { url: DB.health_checks[1].url, status: 0, error: 'Signal timed out.' } });
    const w3 = wf('WF3a'), w6 = wf('WF6');
    old(240, { fingerprint: `wf_error:${w3.id}`, kind: 'wf_error', severity: 'crit', title: `${w3.name} : dernière exécution en échec (${w3.errors_24h} erreur(s) / 24 h)` });
    old(2 * 1440 - 300, { fingerprint: `wf_stale:${w6.id}`, kind: 'wf_stale', severity: 'warn', title: `${w6.name} : aucun succès depuis ${frDate(w6.last_success)}` });
    const ov = overview(7, DB.sites).find((s) => s.domain === 'waffelnrezept.blog');
    if (ov && ov.clicks_prev) old(3 * 1440 + 60, { fingerprint: `seo_drop:${ov.site_id}`, kind: 'seo_drop', severity: 'warn', title: `${ov.domain} : clics Google −${Math.round(100 - (100 * ov.clicks) / ov.clicks_prev)} % (7 j)`, details: { clicks: ov.clicks, clicks_prev: ov.clicks_prev } });
    const q = cnt(DB.sync_jobs, (j) => j.status === 'queued');
    old(2 * 1440, { fingerprint: 'sync_info:pfannkuchen', kind: 'sync_info', severity: 'info', title: `Import de l'historique en cours pour pfannkuchenrezept.blog (${q} tâches en file)` });
    if (SC.base === 'error') {
      old(35, { fingerprint: 'n8n_api', kind: 'n8n_api', severity: 'crit', title: 'API n8n injoignable', details: { error: 'n8n /workflows → 401 {"message":"unauthorized"}' } });
      old(64, { fingerprint: 'pipeline_api', kind: 'pipeline_api', severity: 'crit', title: 'Pipeline : Apps Script injoignable', details: { error: HTML_ERR } });
    }
    pipelineAlerts(dash());
    evalWfAlerts(); // whatever the backend rules would still raise (e.g. WF3a is also stale) exists from the start
    DB.alerts.filter((x) => x.resolved_at == null && NOW - Date.parse(x.created_at) < MIN).forEach((x) => { x.created_at = ago(180); x.last_seen_at = ago(lastSyncMin); x.notified_at = ago(179); });
  }
  function buildPipelineState() {
    if (!FULLISH) return;
    const d = dash();
    DB.pipeline_state.push(SC.base === 'error' ? { id: 1, data: d, ok: false, error: HTML_ERR, ms: 2140, taken_at: ago(4) } : { id: 1, data: d, ok: true, error: null, ms: 23840, taken_at: ago(6) });
    for (let h = 167; h >= 0; h--) {
      const f = 1 - (h / 168) * 0.12;
      DB.pipeline_history.push({ taken_at: new Date(NOW - (h + 1) * 3600e3).toISOString(), metrics: { articles: { total: d.articles.total, generated: Math.round(d.articles.generated * f), published: Math.round(d.articles.published * f), failed: d.articles.failed },
        images: { images: Math.round(d.images.images * f), articlesDone: Math.round(d.images.articlesDone * f) }, pins: Object.fromEntries(Object.entries(d.pins.byStatus).map(([k, v]) => [k, Math.round(v * f)])),
        cost: { total: r2(d.cost.total * f), month: r2(d.cost.month * f), perPublished: d.cost.perPublished } } });
    }
  }

  /* ───────── Schema (from supabase/migrations/*.sql) ───────── */
  const SCHEMA = {
    alerts: { cols: { id: 'int', fingerprint: 'text', kind: 'text', severity: 'text', title: 'text', details: 'jsonb', created_at: 'ts', last_seen_at: 'ts', notified_at: 'ts', resolved_at: 'ts' }, pk: 'id', nn: ['fingerprint', 'kind', 'title'], pol: 'su' },
    google_accounts: { cols: { id: 'uuid', email: 'text', status: 'text', last_error: 'text', connected_at: 'ts', last_discovery_at: 'ts' }, pk: 'id', nn: ['email'], pol: 'sd' },
    gsc_sites: { cols: { id: 'uuid', account_id: 'uuid', site_url: 'text', permission_level: 'text', domain: 'text' }, pk: 'id', nn: ['account_id', 'site_url', 'domain'], pol: 's' },
    ga4_properties: { cols: { id: 'uuid', account_id: 'uuid', property_id: 'text', display_name: 'text', account_name: 'text', default_uri: 'text', domain: 'text' }, pk: 'id', nn: ['account_id', 'property_id'], pol: 's' },
    sites: { cols: { id: 'uuid', domain: 'text', label: 'text', gsc_site_id: 'uuid', ga4_property_id: 'uuid', tracked: 'bool', backfill_requested_at: 'ts', last_sync_at: 'ts', last_sync_error: 'text', created_at: 'ts' }, pk: 'id', nn: ['domain', 'tracked'], pol: 'su', fk: { gsc_site_id: 'gsc_sites', ga4_property_id: 'ga4_properties' } },
    n8n_workflows: { cols: { id: 'text', name: 'text', active: 'bool', tags: 'jsonb', updated_at: 'ts', watch: 'bool', expected_every_min: 'int', synced_at: 'ts' }, pk: 'id', nn: ['id', 'name', 'active', 'tags', 'watch'], pol: 'su' },
    n8n_executions: { cols: { id: 'text', workflow_id: 'text', status: 'text', mode: 'text', started_at: 'ts', stopped_at: 'ts', synced_at: 'ts' }, pk: 'id', nn: ['id', 'workflow_id', 'status'], pol: 's' },
    health_checks: { cols: { id: 'uuid', name: 'text', url: 'text', expect_status: 'int', enabled: 'bool', last_status: 'int', last_ok: 'bool', last_ms: 'int', last_checked_at: 'ts', last_error: 'text' }, pk: 'id', nn: ['name', 'url', 'expect_status', 'enabled'], pol: 'siud',
      def: () => ({ id: uuid(), expect_status: 200, enabled: true, last_status: null, last_ok: null, last_ms: null, last_checked_at: null, last_error: null }) },
    settings: { cols: { key: 'text', value: 'jsonb', updated_at: 'ts' }, pk: 'key', nn: ['key', 'value'], pol: 'siud', def: () => ({ updated_at: nowIso() }) },
    pipeline_state: { cols: { id: 'int', data: 'jsonb', ok: 'bool', error: 'text', ms: 'int', taken_at: 'ts' }, pk: 'id', nn: [], pol: 's' },
    pipeline_history: { cols: { taken_at: 'ts', metrics: 'jsonb' }, pk: 'taken_at', nn: ['metrics'], pol: 's' },
    sync_jobs: { cols: { id: 'int', site_id: 'uuid', kind: 'text', start_date: 'date', end_date: 'date', priority: 'int', status: 'text', attempts: 'int', error: 'text', created_at: 'ts', updated_at: 'ts' }, pk: 'id', nn: [], pol: 's' },
    allowed_users: { cols: { email: 'text', created_at: 'ts' }, pk: 'email', nn: ['email'], pol: 's' },
  };
  const UNMOCKED = ['gsc_daily', 'gsc_query_daily', 'gsc_page_daily', 'gsc_dim_daily', 'gsc_query_monthly', 'gsc_page_monthly', 'ga4_daily', 'ga4_source_daily', 'ga4_page_monthly'];
  const REVOKED = ['app_secrets', 'oauth_states', 'google_tokens'];

  /* ───────── Errors, delay, RLS ───────── */
  class PgErr extends Error { constructor(code, message, status, details, hint) { super(message); this.pg = { message, code, details: details || null, hint: hint || null }; this.status = status || 400; } }
  const STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 406: 'Not Acceptable', 409: 'Conflict', 500: 'Internal Server Error' };
  const delayMs = (name) => (SC.slow ? 2500 : 120 + (hash(name) % 281));
  const delay = (name) => new Promise((r) => setTimeout(r, delayMs(name)));
  const AUTH = { session: null, listeners: [] };
  const allowedNow = () => !!AUTH.session && SC.base !== 'denied';
  const vis = (t) => (allowedNow() ? DB[t] || [] : []);
  const warned = new Set();
  const warnOnce = (m) => { if (!warned.has(m)) { warned.add(m); console.warn('[mock-supabase] ' + m); } };

  /* ───────── Query builder ───────── */
  const DATEISH = /^\d{4}-\d{2}-\d{2}/;
  function cmpV(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'boolean' || typeof b === 'boolean') return (a === true) - (b === true);
    if (typeof a === 'string' && typeof b === 'string' && DATEISH.test(a) && DATEISH.test(b)) return Date.parse(a) - Date.parse(b);
    const na = Number(a), nb = Number(b);
    if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b), 'en');
  }
  function testF(row, f) {
    let op = f.op, neg = false; const v = row[f.c];
    if (op.startsWith('not.')) { neg = true; op = op.slice(4); }
    let r;
    switch (op) {
      case 'eq': r = v != null && f.v != null && String(v) === String(f.v); break;
      case 'neq': r = v != null && f.v != null && String(v) !== String(f.v); break;
      case 'gt': r = v != null && cmpV(v, f.v) > 0; break;
      case 'gte': r = v != null && cmpV(v, f.v) >= 0; break;
      case 'lt': r = v != null && cmpV(v, f.v) < 0; break;
      case 'lte': r = v != null && cmpV(v, f.v) <= 0; break;
      case 'is': r = f.v === null || f.v === 'null' ? v == null : String(v) === String(f.v); break;
      case 'in': { const L = Array.isArray(f.v) ? f.v : String(f.v).replace(/^\(|\)$/g, '').split(','); r = v != null && L.map(String).includes(String(v)); break; }
      case 'like': case 'ilike': { const re = new RegExp('^' + String(f.v).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', op === 'ilike' ? 'i' : ''); r = v != null && re.test(String(v)); break; }
      case 'cs': r = Array.isArray(v) && [].concat(f.v).every((x) => v.includes(x)); break;
      default: throw new PgErr('PGRST100', `mock: filter operator "${f.op}" not supported`);
    }
    return neg ? (v == null && op !== 'is' ? false : !r) : r;
  }
  function sortRows(rows, orders) {
    if (!orders.length) return rows;
    return rows.slice().sort((a, b) => {
      for (const o of orders) {
        const x = a[o.c], y = b[o.c];
        if (x == null || y == null) { if (x == null && y == null) continue; const nf = o.nf == null ? !o.asc : o.nf; return (x == null) === nf ? -1 : 1; }
        const d = cmpV(x, y) * (o.asc ? 1 : -1); if (d) return d;
      }
      return 0;
    });
  }
  function parseCols(s) {
    return String(s == null ? '*' : s).split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
      const m = x.match(/^(?:(\w+):)?(\w+|\*)(?:::\w+)?$/);
      if (!m) throw new PgErr('PGRST100', `mock: select "${x}" not supported (no embedded resources)`);
      return { as: m[1] || m[2], col: m[2] };
    });
  }
  function checkType(t, col, type, v) {
    if (v == null) return v;
    const bad = (pg) => { throw new PgErr(type === 'ts' ? '22007' : '22P02', `invalid input syntax for type ${pg}: "${typeof v === 'object' ? JSON.stringify(v) : v}"`); };
    if (type === 'int') { if (typeof v === 'boolean' || v === '' || !Number.isInteger(Number(v))) bad('integer'); return Number(v); }
    if (type === 'bool') { if (v === true || v === false) return v; if (v === 'true' || v === 'false') return v === 'true'; bad('boolean'); }
    if (type === 'uuid') { if (!UUID_RE.test(String(v))) bad('uuid'); return String(v).toLowerCase(); }
    if (type === 'ts' || type === 'date') { if (isNaN(Date.parse(String(v)))) bad(type === 'ts' ? 'timestamp with time zone' : 'date'); return String(v); }
    if (type === 'text' && typeof v === 'object') return JSON.stringify(v);
    return v;
  }

  class Query {
    constructor(table, rpc, args) { Object.assign(this, { t: table, rpc, args, op: 'select', cols: '*', f: [], o: [], lim: null, rng: null, one: 0, payload: null, opts: {}, ret: false, count: null, head: false }); }
    select(cols, o) { if (this.op !== 'select') this.ret = true; this.cols = cols == null ? '*' : cols; if (o && o.count) this.count = o.count; if (o && o.head) this.head = true; return this; }
    insert(v, o) { return Object.assign(this, { op: 'insert', payload: clone(v), opts: o || {} }); }
    upsert(v, o) { return Object.assign(this, { op: 'upsert', payload: clone(v), opts: o || {} }); }
    update(v, o) { return Object.assign(this, { op: 'update', payload: clone(v), opts: o || {} }); }
    delete(o) { return Object.assign(this, { op: 'delete', opts: o || {} }); }
    _f(c, op, v) { this.f.push({ c, op, v: v === undefined ? undefined : clone(v) }); return this; }
    eq(c, v) { return this._f(c, 'eq', v); } neq(c, v) { return this._f(c, 'neq', v); }
    gt(c, v) { return this._f(c, 'gt', v); } gte(c, v) { return this._f(c, 'gte', v); }
    lt(c, v) { return this._f(c, 'lt', v); } lte(c, v) { return this._f(c, 'lte', v); }
    like(c, v) { return this._f(c, 'like', v); } ilike(c, v) { return this._f(c, 'ilike', v); }
    is(c, v) { return this._f(c, 'is', v); } in(c, v) { return this._f(c, 'in', v); } contains(c, v) { return this._f(c, 'cs', v); }
    not(c, op, v) { return this._f(c, 'not.' + op, v); }
    filter(c, op, v) { return this._f(c, op, v); }
    match(obj) { Object.entries(obj || {}).forEach(([c, v]) => this.eq(c, v)); return this; }
    order(c, o) { o = o || {}; this.o.push({ c, asc: o.ascending !== false, nf: o.nullsFirst }); return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    single() { this.one = 1; return this; }
    maybeSingle() { this.one = 2; return this; }
    abortSignal() { return this; } returns() { return this; } throwOnError() { this.throws = true; return this; }
    then(res, rej) { return this._exec().then(res, rej); }
    catch(f) { return this.then(null, f); }
    finally(f) { return this.then((v) => { f(); return v; }, (e) => { f(); throw e; }); }
    _name() { return this.rpc ? 'rpc:' + this.rpc : `from:${this.t}:${this.op}`; }
    async _exec() {
      await delay(this._name());
      let out;
      try { out = this.rpc ? this._runRpc() : this._runTable(); }
      catch (e) {
        if (!(e instanceof PgErr)) throw e;
        out = { data: null, error: e.pg, count: null, status: e.status, statusText: STATUS_TEXT[e.status] || '' };
        console.warn(`[mock-supabase] ${this._name()} →`, e.pg.code, e.pg.message);
      }
      if (this.throws && out.error) throw Object.assign(new Error(out.error.message), out.error);
      return out;
    }
    _shape(rows, known) {
      const cols = parseCols(this.cols);
      if (known) cols.forEach((c) => { if (c.col !== '*' && !(c.col in known)) throw new PgErr('42703', `column ${this.t}.${c.col} does not exist`); });
      return rows.map((r) => { if (cols.some((c) => c.col === '*')) return clone(r); const o = {}; cols.forEach((c) => (o[c.as] = clone(r[c.col]))); return o; });
    }
    _finish(rows, status, known) {
      let list = rows.filter((r) => this.f.every((f) => testF(r, f)));
      list = sortRows(list, this.o);
      const count = this.count ? list.length : null;
      if (this.rng) list = list.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim != null) list = list.slice(0, this.lim);
      let data = this.head ? null : this._shape(list, known);
      if (this.one && data) {
        if (data.length > 1 || (this.one === 1 && data.length === 0)) throw new PgErr('PGRST116', 'JSON object requested, multiple (or no) rows returned', 406, `The result contains ${data.length} rows`);
        data = data[0] || null;
      }
      return { data, error: null, count, status, statusText: STATUS_TEXT[status] };
    }
    _runRpc() {
      const sig = RPC_SIG[this.rpc], a = this.args || {};
      if (REVOKED_RPC.includes(this.rpc)) throw new PgErr('42501', `permission denied for function ${this.rpc}`, 401);
      const keys = Object.keys(a).sort();
      if (!sig || keys.some((k) => !sig.args.includes(k)) || sig.req.some((k) => !(k in a))) {
        throw new PgErr('PGRST202', `Could not find the function public.${this.rpc}${keys.length ? '(' + keys.join(', ') + ')' : ' without parameters'} in the schema cache`, 404, null,
          sig ? `Perhaps you meant to call the function public.${this.rpc}(${sig.args.join(', ')})` : null);
      }
      if (this.rpc === 'is_allowed' && !AUTH.session) throw new PgErr('42501', 'permission denied for function is_allowed', 401);
      if (SC.base === 'error' && SEO_RPCS.includes(this.rpc)) throw new PgErr('57014', 'canceling statement due to statement timeout', 500);
      const res = RPC[this.rpc](a);
      if (!Array.isArray(res)) return { data: res, error: null, count: null, status: 200, statusText: 'OK' };
      return this._finish(res, 200, null);
    }
    _runTable() {
      const t = this.t, sch = SCHEMA[t];
      if (REVOKED.includes(t)) throw new PgErr('42501', `permission denied for table ${t}`, 401);
      if (UNMOCKED.includes(t)) { warnOnce(`table ${t} exists in the backend but is not mocked: returning []`); return { data: [], error: null, count: 0, status: 200, statusText: 'OK' }; }
      if (!sch) throw new PgErr('PGRST205', `Could not find the table 'public.${t}' in the schema cache`, 404);
      [...this.f.map((f) => f.c), ...this.o.map((o) => o.c)].forEach((c) => { if (!(c in sch.cols)) throw new PgErr('42703', `column ${t}.${c} does not exist`); });
      if (this.op === 'select') return this._finish(vis(t), 200, sch.cols);
      const can = (p) => allowedNow() && sch.pol.includes(p);
      const rows = DB[t];
      const checkPayload = (obj) => {
        Object.keys(obj).forEach((k) => { if (!(k in sch.cols)) throw new PgErr('PGRST204', `Could not find the '${k}' column of '${t}' in the schema cache`); });
        Object.keys(obj).forEach((k) => { obj[k] = checkType(t, k, sch.cols[k], obj[k]); if (obj[k] === null && sch.nn.includes(k)) throw new PgErr('23502', `null value in column "${k}" of relation "${t}" violates not-null constraint`); });
        Object.entries(sch.fk || {}).forEach(([k, ref]) => { if (obj[k] != null && !DB[ref].some((r) => r.id === obj[k])) throw new PgErr('23503', `insert or update on table "${t}" violates foreign key constraint "${t}_${k}_fkey"`, 409, `Key (${k})=(${obj[k]}) is not present in table "${ref}".`); });
        return obj;
      };
      const newRow = (obj) => {
        const r = Object.assign(Object.fromEntries(Object.keys(sch.cols).map((k) => [k, null])), sch.def ? sch.def() : {}, checkPayload(obj));
        sch.nn.forEach((k) => { if (r[k] == null) throw new PgErr('23502', `null value in column "${k}" of relation "${t}" violates not-null constraint`); });
        return r;
      };
      if (this.op === 'insert' || this.op === 'upsert') {
        if (!can('i') || (this.op === 'upsert' && !can('u'))) throw new PgErr('42501', `new row violates row-level security policy for table "${t}"`, 403);
        const list = [].concat(this.payload || []), conf = String(this.opts.onConflict || sch.pk).split(',').map((s) => s.trim()), out = [];
        list.forEach((obj) => {
          const ex = rows.find((r) => conf.every((k) => obj[k] != null && String(r[k]) === String(obj[k])));
          if (ex && this.op === 'insert') throw new PgErr('23505', `duplicate key value violates unique constraint "${t}_pkey"`, 409, `Key (${sch.pk})=(${ex[sch.pk]}) already exists.`);
          if (ex) { if (!this.opts.ignoreDuplicates) { Object.assign(ex, checkPayload(obj)); out.push(ex); } }
          else { const r = newRow(obj); rows.push(r); out.push(r); }
        });
        if (t === 'settings') SETTINGS_CHANGED();
        return this.ret ? this._finishOut(out, 201, sch.cols) : { data: null, error: null, count: null, status: 201, statusText: 'Created' };
      }
      if (!this.f.length) throw new PgErr('21000', `${this.op.toUpperCase()} requires a WHERE clause`);
      const hit = can(this.op === 'update' ? 'u' : 'd') ? rows.filter((r) => this.f.every((f) => testF(r, f))) : [];
      if (this.op === 'update') { const p = checkPayload(this.payload || {}); hit.forEach((r) => Object.assign(r, clone(p))); }
      else { hit.forEach((r) => rows.splice(rows.indexOf(r), 1)); if (t === 'google_accounts') hit.forEach((r) => cascadeAccount(r.id)); }
      return this.ret ? this._finishOut(hit, 200, sch.cols) : { data: null, error: null, count: null, status: 204, statusText: 'No Content' };
    }
    _finishOut(rows, status, known) {
      let data = this._shape(rows, known);
      if (this.one) { if (data.length > 1 || (this.one === 1 && !data.length)) throw new PgErr('PGRST116', 'JSON object requested, multiple (or no) rows returned', 406); data = data[0] || null; }
      return { data, error: null, count: null, status, statusText: STATUS_TEXT[status] };
    }
  }
  function cascadeAccount(id) { // on delete cascade (gsc_sites, ga4_properties) + on delete set null (sites)
    const g = DB.gsc_sites.filter((x) => x.account_id === id).map((x) => x.id), p = DB.ga4_properties.filter((x) => x.account_id === id).map((x) => x.id);
    DB.gsc_sites = DB.gsc_sites.filter((x) => x.account_id !== id); DB.ga4_properties = DB.ga4_properties.filter((x) => x.account_id !== id);
    DB.sites.forEach((s) => { if (g.includes(s.gsc_site_id)) s.gsc_site_id = null; if (p.includes(s.ga4_property_id)) s.ga4_property_id = null; });
  }
  function SETTINGS_CHANGED() { /* settings are read live by RPCs and edge functions */ }

  /* ───────── RPCs (supabase/migrations/002_analytics.sql) ───────── */
  const RPC_SIG = {
    is_allowed: { args: [], req: [] }, setting_int: { args: ['p_default', 'p_key'], req: ['p_default', 'p_key'] },
    site_overview: { args: ['p_days'], req: [] }, site_series: { args: ['p_from', 'p_site', 'p_to'], req: ['p_from', 'p_site', 'p_to'] },
    top_queries: { args: ['p_from', 'p_limit', 'p_site', 'p_to'], req: ['p_from', 'p_site', 'p_to'] }, top_pages: { args: ['p_from', 'p_limit', 'p_site', 'p_to'], req: ['p_from', 'p_site', 'p_to'] },
    query_movers: { args: ['p_days', 'p_limit', 'p_site'], req: ['p_site'] }, gsc_dims: { args: ['p_dim', 'p_from', 'p_limit', 'p_site', 'p_to'], req: ['p_dim', 'p_from', 'p_site', 'p_to'] },
    ga4_sources: { args: ['p_from', 'p_limit', 'p_site', 'p_to'], req: ['p_from', 'p_site', 'p_to'] }, ga4_pages: { args: ['p_from', 'p_limit', 'p_site', 'p_to'], req: ['p_from', 'p_site', 'p_to'] },
    workflow_health: { args: [], req: [] }, n8n_daily: { args: ['p_days'], req: [] }, sync_progress: { args: [], req: [] },
  };
  const REVOKED_RPC = ['claim_sync_jobs', 'enqueue_sync_jobs', 'purge_old_data', 'call_function'];
  const SEO_RPCS = ['site_overview', 'site_series', 'top_queries', 'top_pages', 'query_movers', 'gsc_dims', 'ga4_sources', 'ga4_pages'];
  const intArg = (v, name) => { if (v == null) return null; if (typeof v === 'boolean' || v === '' || !Number.isInteger(Number(v))) throw new PgErr('22P02', `invalid input syntax for type integer: "${v}"`); return Number(v); };
  const uuidArg = (v) => { if (v == null) return null; if (!UUID_RE.test(String(v))) throw new PgErr('22P02', `invalid input syntax for type uuid: "${v}"`); return String(v).toLowerCase(); };
  const dateArg = (v) => { if (v == null) return null; const s = String(v); if (!DATEISH.test(s) || isNaN(Date.parse(s.slice(0, 10)))) throw new PgErr('22007', `invalid input syntax for type date: "${v}"`); return s.slice(0, 10); };
  const limArg = (v, d) => (v === undefined ? d : v === null ? Infinity : intArg(v));
  const siteSel = (p) => vis('sites').filter((s) => (p == null && s.tracked) || s.id === p).map((s) => DIDX[s.domain]).filter((i) => i != null);
  function overview(p, sites) {
    const e = addD(TODAY, -1), s = addD(TODAY, -p), pe = addD(TODAY, -p - 1), ps = addD(TODAY, -2 * p);
    return sites.slice().sort((x, y) => (y.tracked - x.tracked) || cmpV(x.domain, y.domain)).map((st) => {
      const si = DIDX[st.domain], c = rangeSum(si, s, e), pv = rangeSum(si, ps, pe), spark = [];
      for (let n = dayN(s); n <= dayN(e); n++) { const g = si == null ? null : gscDay(si, n); spark.push(g ? g.clicks : 0); }
      return { site_id: st.id, domain: st.domain, label: st.label, tracked: st.tracked, has_gsc: st.gsc_site_id != null, has_ga4: st.ga4_property_id != null,
        clicks: c.clicks, clicks_prev: pv.clicks, impressions: c.impr, impressions_prev: pv.impr, avg_position: c.impr ? real(c.posW / c.impr) : null,
        sessions: c.sessions, sessions_prev: pv.sessions, pinterest_sessions: c.pin, pinterest_sessions_prev: pv.pin, spark, last_sync_at: st.last_sync_at, last_sync_error: st.last_sync_error };
    });
  }
  function gscTop(a, kind) {
    const from0 = dateArg(a.p_from), to = dateArg(a.p_to), lim = limArg(a.p_limit, 100), L = siteSel(uuidArg(a.p_site));
    if (!from0 || !to) return [];
    const daily = from0 >= addD(TODAY, -settingNum('gsc_daily_retention_days', 90));
    const from = daily ? from0 : monthStart(from0), to2 = daily ? to : monthEnd(to);
    const rows = [];
    L.forEach((si) => qWindow(si, from, to2).forEach((q) => {
      if (kind === 'query') rows.push(q);
      else rows.push({ key: `https://${CAT[si].domain}/${q.slug ? q.slug + '/' : ''}`, clicks: Math.round(q.clicks * 1.3), impressions: Math.round(q.impressions * 1.15), pos: q.pos });
    }));
    return [...mergeRows(rows).values()].sort(byClicks).slice(0, lim).map((r) => ({ [kind]: r.key, clicks: r.clicks, impressions: r.impressions,
      ctr: r.impressions ? real(r.clicks / r.impressions) : null, avg_position: r.impressions ? real(r.posW / r.impressions) : null, granularity: daily ? 'daily' : 'monthly' }));
  }
  const RPC = {
    is_allowed: () => SC.base !== 'denied',
    setting_int: (a) => settingNum(a.p_key, a.p_default),
    site_overview: (a) => overview(a.p_days == null ? 28 : intArg(a.p_days), vis('sites')),
    site_series(a) {
      const from = dateArg(a.p_from), to = dateArg(a.p_to), L = siteSel(uuidArg(a.p_site)), out = [];
      if (!from || !to) return out;
      for (let n = dayN(from); n <= Math.min(dayN(to), dayN(from) + 4000); n++) {
        let c = 0, i = 0, pw = 0, ses = 0, us = 0, pin = 0, any = false;
        L.forEach((si) => { const g = gscDay(si, n), x = ga4Day(si, n); if (g) { any = true; c += g.clicks; i += g.impressions; pw += g.pos * g.impressions; } if (x) { ses += x.sessions; us += x.users; pin += x.pinterest; } });
        out.push({ date: nToD(n), clicks: c, impressions: i, avg_position: any && i ? real(pw / i) : null, sessions: ses, users: us, pinterest_sessions: pin });
      }
      return out;
    },
    top_queries: (a) => gscTop(a, 'query'),
    top_pages: (a) => gscTop(a, 'page'),
    query_movers(a) {
      const p = a.p_days === undefined ? 28 : intArg(a.p_days), lim = limArg(a.p_limit, 15), L = siteSel(uuidArg(a.p_site));
      if (p == null) return [];
      const floor = addD(TODAY, -settingNum('gsc_daily_retention_days', 90)), mx = (x, y) => (x > y ? x : y);
      const nowF = mx(addD(TODAY, -p), floor), prevF = mx(addD(TODAY, -2 * p), floor), prevT = addD(TODAY, -p - 1);
      const now = mergeRows(L.flatMap((si) => qWindow(si, nowF, TODAY))), prev = mergeRows(prevF <= prevT ? L.flatMap((si) => qWindow(si, prevF, prevT)) : []);
      const rows = [...new Set([...now.keys(), ...prev.keys()])].map((q) => { const n = (now.get(q) || {}).clicks || 0, pv = (prev.get(q) || {}).clicks || 0; return { query: q, clicks_now: n, clicks_prev: pv, delta: n - pv }; });
      return rows.filter((r) => r.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, lim).concat(rows.filter((r) => r.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, lim));
    },
    gsc_dims(a) {
      const from = dateArg(a.p_from), to = dateArg(a.p_to), lim = limArg(a.p_limit, 15), L = siteSel(uuidArg(a.p_site));
      const D = a.p_dim === 'country' ? COUNTRY : a.p_dim === 'device' ? DEVICE : null;
      if (!D || !from || !to) return [];
      const rows = [];
      L.forEach((si) => { const t = rangeSum(si, from, to); if (!t.impr) return; const pos = t.posW / t.impr;
        D.forEach(([v, sh, off]) => { const j = 0.9 + 0.2 * noise(CAT[si].key + v); rows.push({ key: v, clicks: Math.round(t.clicks * sh * j), impressions: Math.round(t.impr * sh * (2 - j)), pos: clamp(pos + off, 1, 90) }); }); });
      return [...mergeRows(rows).values()].filter((r) => r.impressions > 0).sort(byClicks).slice(0, lim)
        .map((r) => ({ value: r.key, clicks: r.clicks, impressions: r.impressions, avg_position: real(r.posW / r.impressions) }));
    },
    ga4_sources(a) {
      const from = dateArg(a.p_from), to = dateArg(a.p_to), lim = limArg(a.p_limit, 15), L = siteSel(uuidArg(a.p_site)), m = new Map();
      if (!from || !to) return [];
      const add = (s, md, ses, ratio) => { if (ses <= 0) return; const k = s + '\u0000' + md, o = m.get(k) || { source: s, medium: md, sessions: 0, users: 0 }; o.sessions += ses; o.users += Math.round(ses * ratio); m.set(k, o); };
      L.forEach((si) => { const t = rangeSum(si, from, to); add('google', 'organic', t.google, 0.82);
        let left = t.pin; SRC_PIN.forEach(([s, md, sh], j) => { const v = j === SRC_PIN.length - 1 ? left : Math.round(t.pin * sh); left -= v; add(s, md, v, 0.9); });
        left = t.other; SRC_OTHER.forEach(([s, md, sh], j) => { const v = j === 0 ? Math.round(t.other * sh) + (t.other - sum(SRC_OTHER, (x) => Math.round(t.other * x[2]))) : Math.round(t.other * sh); add(s, md, v, 0.86); }); });
      return [...m.values()].sort((x, y) => y.sessions - x.sessions).slice(0, lim);
    },
    ga4_pages(a) {
      const from = dateArg(a.p_from), to = dateArg(a.p_to), lim = limArg(a.p_limit, 50), L = siteSel(uuidArg(a.p_site)), m = new Map();
      if (!from || !to) return [];
      L.forEach((si) => { const t = rangeSum(si, monthStart(from), monthEnd(to)); if (!t.sessions) return; const P = PAGES[si], sw = sum(P, (p) => p.w);
        P.forEach((p) => { const ses = Math.round((t.sessions * 0.93 * p.w) / sw); if (!ses) return; const o = m.get(p.path) || { page: p.path, views: 0, sessions: 0 }; o.sessions += ses; o.views += Math.round(ses * (1.18 + 0.4 * noise('v' + p.path))); m.set(p.path, o); }); });
      return [...m.values()].sort((x, y) => y.views - x.views).slice(0, lim);
    },
    workflow_health: () => wfHealth(vis('n8n_workflows')),
    n8n_daily(a) {
      const p = a.p_days === undefined ? 14 : intArg(a.p_days), out = [];
      if (p == null) return out;
      const watched = new Set(vis('n8n_workflows').filter((w) => w.watch).map((w) => w.id)), byDay = groupBy(vis('n8n_executions').filter((e) => watched.has(e.workflow_id) && e.started_at), (e) => e.started_at.slice(0, 10));
      for (let k = p - 1; k >= 0; k--) { const d = addD(TODAY, -k), L = byDay[d] || []; out.push({ date: d, success: cnt(L, (e) => e.status === 'success'), failed: cnt(L, (e) => e.status === 'error' || e.status === 'crashed') }); }
      return out;
    },
    sync_progress() {
      const since = Date.now() - 30 * DAY, g = groupBy(vis('sync_jobs').filter((j) => Date.parse(j.created_at) > since), (j) => j.site_id);
      return Object.entries(g).map(([site_id, L]) => {
        const err = L.filter((j) => j.status === 'error').sort((x, y) => Date.parse(y.updated_at) - Date.parse(x.updated_at))[0];
        return { site_id, queued: cnt(L, (j) => j.status === 'queued'), running: cnt(L, (j) => j.status === 'running'), done: cnt(L, (j) => j.status === 'done'), failed: cnt(L, (j) => j.status === 'error'), last_error: err ? err.error : null };
      });
    },
  };
  function wfHealth(wfs) {
    const now = Date.now(), ex = groupBy(DB.n8n_executions, (e) => e.workflow_id);
    return wfs.slice().sort((a, b) => (b.active - a.active) || cmpV(a.name, b.name)).map((w) => {
      const L = (ex[w.id] || []).slice().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
      const in24 = L.filter((e) => now - Date.parse(e.started_at) < DAY), in7 = L.filter((e) => now - Date.parse(e.started_at) < 7 * DAY), bad = (e) => e.status === 'error' || e.status === 'crashed';
      const durs = in7.filter((e) => e.stopped_at).map((e) => (Date.parse(e.stopped_at) - Date.parse(e.started_at)) / 1000);
      const run = L.filter((e) => e.status === 'running');
      const ok = L.find((e) => e.status === 'success');
      return { id: w.id, name: w.name, active: w.active, watch: w.watch, expected_every_min: w.expected_every_min, tags: clone(w.tags),
        last_started: L[0] ? L[0].started_at : null, last_status: L[0] ? L[0].status : null, last_success: ok ? ok.started_at : null,
        runs_24h: in24.length, errors_24h: cnt(in24, bad), runs_7d: in7.length, errors_7d: cnt(in7, bad), avg_duration_s: durs.length ? real(sum(durs) / durs.length) : null,
        running_now: cnt(L, (e) => ['running', 'waiting', 'new'].includes(e.status)), running_since: run.length ? run[run.length - 1].started_at : null };
    });
  }

  /* ───────── Edge functions (supabase/functions/*) ───────── */
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  class FunctionsHttpError extends Error {
    constructor(status, payload) {
      super('Edge Function returned a non-2xx status code');
      this.name = 'FunctionsHttpError';
      const txt = JSON.stringify(payload), hdr = new Map([['content-type', 'application/json']]);
      this.context = { status, ok: false, statusText: STATUS_TEXT[status] || '', headers: { get: (k) => hdr.get(String(k).toLowerCase()) || null }, json: async () => JSON.parse(txt), text: async () => txt, clone() { return this; } };
    }
  }
  function requireUser() {
    if (!AUTH.session) throw new HttpError(401, 'Invalid session');
    if (SC.base === 'denied') throw new HttpError(403, 'This email is not allowed on this dashboard');
  }
  const getSetting = (k, d) => { const r = DB.settings.find((x) => x.key === k); return r ? r.value : d; };
  function enqueue(jobs) {
    let n = 0;
    jobs.forEach((j) => { if (!DB.sync_jobs.some((x) => x.site_id === j.site_id && x.kind === j.kind && x.start_date === j.start_date && x.end_date === j.end_date && (x.status === 'queued' || x.status === 'running'))) { DB.sync_jobs.push(jobRow(j, 'queued', nowIso())); n++; } });
    return n;
  }
  const trackedSites = (ids) => DB.sites.filter((s) => (ids && ids.length ? ids.includes(s.id) : s.tracked));
  const FN = {
    'google-auth'(b) {
      requireUser();
      if (b.action === 'start') {
        if (!CFG.google) throw new HttpError(400, 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET ne sont pas encore configurés dans Supabase.');
        const rt = String(b.return_to || '');
        if (!/^https?:\/\//.test(rt)) throw new HttpError(400, 'return_to manquant');
        const a = DB.google_accounts[0] || { email: 'nouveau.compte@example.test' };
        const p = SC.base === 'error' ? { google: 'partial', email: a.email, reason: 'Search Console: Google API 403: The caller does not have permission' }
          : { google: 'connected', email: a.email, gsc: String(cnt(DB.gsc_sites, (g) => g.account_id === a.id)), ga4: String(cnt(DB.ga4_properties, (g) => g.account_id === a.id)), sites: String(DB.sites.length) };
        return { url: `${rt.split('#')[0].split('?')[0]}?mock=${encodeURIComponent(SC.raw)}&mock_oauth=${Date.now()}#${new URLSearchParams(p).toString()}` };
      }
      if (b.action === 'discover') {
        const ids = b.account_id ? [b.account_id] : DB.google_accounts.map((a) => a.id), results = {};
        ids.forEach((id) => {
          const acc = DB.google_accounts.find((a) => a.id === id);
          if (!acc) results[id] = { error: 'No token for Google account' };
          else if (acc.status === 'error') results[id] = { error: acc.last_error };
          else { acc.last_discovery_at = nowIso(); results[id] = { gsc: cnt(DB.gsc_sites, (g) => g.account_id === id), ga4: cnt(DB.ga4_properties, (g) => g.account_id === id), sites: DB.sites.length }; }
        });
        return { ok: true, results };
      }
      if (b.action === 'disconnect') {
        const id = String(b.account_id || '');
        if (DB.google_accounts.some((a) => a.id === id)) { DB.google_accounts = DB.google_accounts.filter((a) => a.id !== id); cascadeAccount(id); }
        return { ok: true };
      }
      throw new HttpError(400, 'Unknown action');
    },
    'seo-sync'(b) {
      requireUser();
      const action = b.action || 'work';
      if (action === 'backfill') {
        const sites = trackedSites(b.site_ids), months = Number(getSetting('backfill_months', 16)), jobs = [];
        sites.forEach((s) => { jobs.push(...backfillJobs(s.id, !!s.gsc_site_id, !!s.ga4_property_id, months, TODAY)); s.backfill_requested_at = nowIso(); });
        return { sites: sites.length, queued: enqueue(jobs) };
      }
      if (action === 'daily') {
        const sites = trackedSites(), y = addD(TODAY, -1), jobs = [];
        sites.forEach((s) => { if (s.gsc_site_id) jobs.push({ site_id: s.id, kind: 'gsc_days', start_date: addD(TODAY, -5), end_date: y, priority: 1 }, { site_id: s.id, kind: 'gsc_month', start_date: monthStart(y), end_date: y, priority: 2 });
          if (s.ga4_property_id) jobs.push({ site_id: s.id, kind: 'ga4_days', start_date: addD(TODAY, -3), end_date: y, priority: 1 }, { site_id: s.id, kind: 'ga4_month', start_date: monthStart(y), end_date: y, priority: 2 }); });
        return { sites: sites.length, queued: enqueue(jobs), drops: cnt(DB.alerts, (x) => x.kind === 'seo_drop' && x.resolved_at == null) };
      }
      if (action === 'work') {
        const q = DB.sync_jobs.filter((j) => j.status === 'queued').sort((x, y) => x.priority - y.priority || cmpV(y.start_date, x.start_date)).slice(0, 45);
        let done = 0, failed = 0; const errors = [];
        q.forEach((j) => {
          const s = DB.sites.find((x) => x.id === j.site_id); j.attempts++; j.updated_at = nowIso();
          if (s && s.domain === 'waffelnrezept.blog' && j.kind.startsWith('gsc')) { failed++; errors.push(`${j.kind} ${j.start_date}: ${GSC_403}`); j.status = j.attempts >= 3 ? 'error' : 'queued'; j.error = GSC_403; s.last_sync_error = GSC_403; }
          else { done++; j.status = 'done'; j.error = null; if (s) { s.last_sync_at = nowIso(); s.last_sync_error = null; } }
        });
        return { who: 'user', done, failed, errors: errors.slice(0, 5), ms: Math.min(110000, 2300 * q.length + 900) };
      }
      throw new HttpError(400, 'Unknown action');
    },
    'ops-sync'(b) {
      const action = b.action || 'run';
      if (action === 'status') { requireUser(); return { google: CFG.google, google_redirect_uri: `${CLIENT_URL}/functions/v1/google-auth`, n8n: CFG.n8n, n8n_url: CFG.n8n ? 'https://n8n.example.test' : null, telegram: CFG.telegram }; }
      if (action === 'test_alert') {
        requireUser();
        if (!CFG.telegram) throw new HttpError(400, 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID non configurés.');
        return { ok: true };
      }
      if (action === 'run') {
        requireUser();
        const out = { who: 'user' };
        if (CFG.n8n) {
          if (SC.base === 'error') {
            out.n8n_error = 'n8n /workflows → 401 {"message":"unauthorized"}';
            raiseAlert({ fingerprint: 'n8n_api', kind: 'n8n_api', severity: 'crit', title: 'API n8n injoignable', details: { error: out.n8n_error } });
          } else {
            const ts = nowIso(), recent = DB.n8n_executions.filter((e) => Date.now() - Date.parse(e.started_at) < 3 * 3600e3 || e.status === 'running');
            DB.n8n_workflows.forEach((w) => (w.synced_at = ts)); recent.forEach((e) => (e.synced_at = ts)); resolveAlert('n8n_api');
            out.n8n = { workflows: DB.n8n_workflows.length, executions: recent.length };
          }
        }
        let down = 0; const checks = DB.health_checks.filter((c) => c.enabled);
        checks.forEach((c) => {
          const dead = /:8110|down|invalid/i.test(c.url) || !/^https?:\/\//.test(c.url) || (SC.base === 'error' && /n8n/.test(c.url));
          const status = dead ? (SC.base === 'error' && /n8n/.test(c.url) ? 502 : 0) : 200, err = dead && !status ? 'Signal timed out.' : null, ok = !err && status === c.expect_status;
          Object.assign(c, { last_status: status || null, last_ok: ok, last_ms: err ? 12000 + (hash(c.url) % 30) : 120 + (hash(c.url + Date.now()) % 650), last_checked_at: nowIso(), last_error: err });
          if (ok) resolveAlert(`health:${c.id}`);
          else { down++; raiseAlert({ fingerprint: `health:${c.id}`, kind: 'health_down', severity: 'crit', title: `${c.name} ne répond pas (${err ? 'timeout/erreur' : `HTTP ${status}`})`, details: { url: c.url, status, error: err } }); }
        });
        out.health = { checked: checks.length, down };
        out.alerts = { open: evalWfAlerts() };
        let sent = 0;
        if (CFG.telegram) DB.alerts.forEach((a) => { if (a.resolved_at == null && a.notified_at == null && sent < 20) { a.notified_at = nowIso(); sent++; } });
        out.notified = sent;
        return out;
      }
      throw new HttpError(400, 'Unknown action');
    },
    pipeline(b) {
      requireUser();
      const action = b.action || 'refresh';
      if (action === 'refresh') return pipelineRefresh();
      if (action === 'call') {
        const gas = String(b.gas || '');
        if (!GAS_ALLOWED.includes(gas)) throw new HttpError(400, `Action non autorisée : ${gas}`);
        const params = b.params || {};
        const res = callGas(gas, params);
        if (GAS_MUTATING.includes(gas) && !(gas === 'plan_pins' && String(params.dry) !== '0')) setTimeout(() => pipelineRefresh(), 3500);
        return res;
      }
      throw new HttpError(400, 'Unknown action');
    },
  };
  let CLIENT_URL = 'https://kuhxuovjlukxdzjnsyzt.supabase.co';

  /* ───────── Pipeline bridge + mock Apps Script (API.gs) ───────── */
  const GAS_ALLOWED = ['dash', 'failed', 'wf1_diagnostic', 'no_pins', 'wf1_run', 'wf1_retry_failed', 'wf2_run', 'wf2b_run', 'wf2_retry_failed', 'wf3_run', 'reset_failed',
    'set_costs', 'plan_pins', 'unplan_pins', 'send_planned', 'auto_on', 'auto_off', 'auto_status', 'test_pod', 'save_pod'];
  const GAS_MUTATING = ['wf1_retry_failed', 'wf2_retry_failed', 'reset_failed', 'set_costs', 'plan_pins', 'unplan_pins', 'send_planned', 'save_pod'];
  function gasPrecheck() {
    if (!String(getSetting('apps_script_url', '') || '').trim()) throw new HttpError(400, 'URL du web app Apps Script manquante (Connexions → Réglages).');
    if (!CFG.gasSecrets) throw new HttpError(400, 'Secrets APPS_SCRIPT_USER / APPS_SCRIPT_PASS manquants dans Supabase.');
    if (SC.base === 'error' || !SHEET) throw new HttpError(500, HTML_ERR);
  }
  function callGas(action, params) {
    gasPrecheck();
    const P = {}; // pipeline/index.ts:56-60 — strings as-is, objects JSON.stringify, others String(), null/undefined dropped
    Object.entries(params).forEach(([k, v]) => { if (v === undefined || v === null) return; P[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v); });
    return GAS[action](P);
  }
  function pipelineRefresh() {
    const t0 = 18000 + (hash('refresh' + Date.now()) % 22000);
    try {
      gasPrecheck();
      const data = dash(), row = DB.pipeline_state[0];
      if (row) Object.assign(row, { data, ok: true, error: null, ms: t0, taken_at: nowIso() }); else DB.pipeline_state.push({ id: 1, data, ok: true, error: null, ms: t0, taken_at: nowIso() });
      resolveAlert('pipeline_api');
      return { ok: true, ms: t0, alerts: pipelineAlerts(data) };
    } catch (e) {
      const msg = String(e.message).slice(0, 400), row = DB.pipeline_state[0], ms = 900 + (hash(msg) % 1500);
      if (row) Object.assign(row, { ok: false, error: msg, ms, taken_at: nowIso() }); else DB.pipeline_state.push({ id: 1, data: null, ok: false, error: msg, ms, taken_at: nowIso() });
      raiseAlert({ fingerprint: 'pipeline_api', kind: 'pipeline_api', severity: 'crit', title: 'Pipeline : Apps Script injoignable', details: { error: msg } });
      return { ok: false, error: msg };
    }
  }
  function listParam(raw, name, numeric) { // API.gs does JSON.parse() on sites / weeks
    if (raw == null || raw === '') return [];
    let v; try { v = JSON.parse(raw); } catch (_) { v = undefined; }
    if (!Array.isArray(v)) { warnOnce(`gas param "${name}" must be a JS array (got ${JSON.stringify(raw)})`); return { ok: false, error: `Paramètre « ${name} » illisible : tableau JSON attendu, reçu ${String(raw).slice(0, 40)}` }; }
    const known = CAT.map((c) => c.key);
    if (!numeric) v.filter((s) => !known.includes(s)).forEach((s) => warnOnce(`gas param sites: unknown site "${s}"`));
    return numeric ? v.map(Number) : v.map(String);
  }
  const selArts = (sites, weeks) => SHEET.articles.filter((a) => (!sites.length || sites.includes(a.site)) && (!weeks || !weeks.length || weeks.includes(a.week)));
  const num = (v, d) => (v == null || v === '' ? d : Number(v));
  const GAS = {
    dash: () => dash(),
    failed: () => { const d = dash(); return { ok: true, articles: d.articles.failedList, images: d.images.failedList, pins: d.pins.errors }; },
    no_pins: () => { const L = SHEET.articles.filter((a) => a.st === 'published' && SHEET.accounts[a.site] && !SHEET.pins.some((p) => p.id === a.id)); return { ok: true, total: L.length, list: L.map((a) => ({ id: a.id, site: a.site, kw: a.kw, url: a.url })) }; },
    wf1_diagnostic() {
      const F = SHEET.articles.filter((a) => a.st === 'failed'), proc = cnt(SHEET.articles, (a) => a.st === 'processing');
      const groups = Object.entries(groupBy(F, (a) => a.error)).sort((x, y) => y[1].length - x[1].length).map(([error, L]) => ({ error, count: L.length, examples: L.slice(0, 3).map((a) => ({ id: a.id, keyword: a.kw })) }));
      const top = groups[0] ? groups[0].error : '';
      const rec = !F.length ? 'Aucun échec : rien à relancer.' : /WPRM|JSON/.test(top) ? 'La plupart des échecs viennent de la carte WPRM : relance les échecs, la réparation mécanique passe en général au 2e essai.'
        : /timeout/i.test(top) ? 'Timeouts DeepSeek : relance par petits lots (2 articles) plutôt que tout le réseau.' : 'Relance les échecs ; si le même article échoue deux fois, passe-le en skip.';
      return { ok: true, failed: F.length, processing: proc, error_groups: groups, recommendation: rec + (proc ? ` · ${proc} article(s) bloqué(s) en processing : remets-les en pending.` : '') };
    },
    wf1_run(p) {
      const s = listParam(p.sites, 'sites'); if (s.ok === false) return s;
      const w = listParam(p.weeks, 'weeks', true); if (w.ok === false) return w;
      const n = cnt(selArts(s, w), (a) => a.st === 'pending');
      return n ? { ok: true, code: 200, body: '{"message":"Workflow was started"}' } : { ok: true, message: 'Aucun article pending pour cette sélection.' };
    },
    wf1_retry_failed(p) {
      const s = listParam(p.sites, 'sites'); if (s.ok === false) return s;
      const w = listParam(p.weeks, 'weeks', true); if (w.ok === false) return w;
      const L = selArts(s, w).filter((a) => a.st === 'failed'); L.forEach((a) => Object.assign(a, { st: 'pending', error: '' }));
      return { ok: true, message: L.length ? `${L.length} article(s) remis en pending · WF1 relancé` : 'Aucun article en échec dans cette sélection.' };
    },
    wf2_run(p) { const s = listParam(p.sites, 'sites'); return s.ok === false ? s : { ok: true, code: 200 }; },
    wf2b_run(p) { const s = listParam(p.sites, 'sites'); return s.ok === false ? s : { ok: true, code: 200 }; },
    wf3_run(p) { const s = listParam(p.sites, 'sites'); return s.ok === false ? s : { ok: true, code: 200 }; },
    wf2_retry_failed(p) {
      const s = listParam(p.sites, 'sites'); if (s.ok === false) return s;
      selArts(s).filter((a) => String(a.im).startsWith('failed')).forEach((a) => Object.assign(a, { im: 'generated', imgErr: '', imgs: a.imgs || 8 }));
      return { ok: true, code: 200 };
    },
    reset_failed() {
      let text = 0, img = 0;
      SHEET.articles.forEach((a) => {
        if (a.st === 'failed' || a.st === 'processing') { a.st = 'pending'; a.error = ''; text++; }
        if (String(a.im).startsWith('failed') || a.im === 'processing') { a.im = 'pending'; a.imgErr = ''; img++; }
      });
      return { ok: true, reset: { text, img } };
    },
    save_pod(p) {
      const u = String(p.pod_url || '').trim().replace(/\/+$/, '');
      if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(u)) return { ok: false, error: 'URL de pod invalide (https://xxxx-8000.proxy.runpod.net attendu)' };
      SHEET.pod = { url: u, updated_at: nowIso() };
      return { ok: true, pod_url: u };
    },
    test_pod() {
      const u = SHEET.pod.url;
      if (!u) return { ok: false, pod_url: '', error: 'Aucune URL de pod enregistrée', tests: [] };
      if (u !== POD_URL) return { ok: false, pod_url: u, error: 'Pod injoignable', tests: [{ path: '/health', code: 0, ms: 10002, body: 'Timeout (10 s)' }, { path: '/models', code: 0, ms: 10001, body: 'Timeout (10 s)' }] };
      return { ok: true, pod_url: u, tests: [{ path: '/health', code: 200, ms: 412, body: '{"status":"ok","gpu":"NVIDIA RTX 4090","vram_free_gb":19.6,"queue":0}' },
        { path: '/models', code: 200, ms: 388, body: '["flux-dev-fp8","ernie-vl"]' }, { path: '/exif', code: 200, ms: 141, body: '{"ok":true,"exiftool":"12.76"}' }] };
    },
    set_costs(p) {
      const c = { article: num(p.article, NaN), image: num(p.image, NaN), pin: num(p.pin, NaN) };
      const bad = Object.keys(c).find((k) => !(isFinite(c[k]) && c[k] >= 0));
      if (bad) return { ok: false, error: `Coût invalide : ${bad}` };
      SHEET.costs = c; return { ok: true, costs: Object.assign({}, c) };
    },
    plan_pins: planPins,
    unplan_pins(p) {
      const s = listParam(p.sites, 'sites'); if (s.ok === false) return s;
      const now = Date.now(), L = SHEET.pins.filter((x) => x.st === 'planned' && (!s.length || s.includes(x.site)) && Date.parse(x.at) >= now);
      L.forEach((x) => Object.assign(x, { st: 'done', day: '', time: '', at: '' }));
      return { ok: true, cleared: L.length };
    },
    send_planned() {
      const now = Date.now(); let sent = 0, expired = 0;
      SHEET.pins.filter((x) => x.st === 'planned' && x.at && Date.parse(x.at) <= now).forEach((x) => {
        if (now - Date.parse(x.at) > 6 * 3600e3) { Object.assign(x, { st: 'done', day: '', time: '', at: '' }); expired++; } else { x.st = 'scheduled'; sent++; }
      });
      SHEET.auto.last = { at: nowIso(), sent, expired, ok: true };
      return { ok: true, sent, expired, message: sent || expired ? `${sent} pin(s) envoyé(s) à Blotato${expired ? ` · ${expired} expiré(s), remis en attente` : ''}` : 'Aucun pin dû pour le moment.' };
    },
    auto_on() { SHEET.auto.on = true; return { ok: true, on: true, last: Object.assign({}, SHEET.auto.last) }; },
    auto_off() { SHEET.auto.on = false; return { ok: true, on: false, last: Object.assign({}, SHEET.auto.last) }; },
    auto_status() { return { ok: true, on: SHEET.auto.on, last: Object.assign({}, SHEET.auto.last) }; },
  };
  function planPins(p) {
    const sites = listParam(p.sites, 'sites'); if (sites.ok === false) return sites;
    const start = String(p.start || ''), days = num(p.days, 7), per = num(p.per_day, 3), h1 = num(p.h_start, 7), h2 = num(p.h_end, 22), gap = num(p.min_gap, 30), avoid = num(p.avoid_days, 2), tz = String(p.tz || 'Europe/Berlin');
    if (!DATE_RE.test(start) || isNaN(Date.parse(start))) return { ok: false, error: 'Premier jour invalide (AAAA-MM-JJ attendu)' };
    if (start < SDAY) return { ok: false, error: `Le premier jour (${start}) est déjà passé` };
    if (!(days >= 1 && days <= 60)) return { ok: false, error: 'Nombre de jours : entre 1 et 60' };
    if (!(per >= 1 && per <= 25)) return { ok: false, error: 'Pins par jour et par compte : entre 1 et 25' };
    if (!(h1 >= 0 && h2 <= 24 && h1 < h2)) return { ok: false, error: 'Plage horaire invalide' };
    const opts = { sites, start, days, per_day: per, h_start: h1, h_end: h2, min_gap: gap, avoid_days: avoid, tz };
    const seed = String(p.seed || '') || (hash(JSON.stringify(opts) + '#' + SHEET.previews++) % 2176782336).toString(36).padStart(6, '0');
    const rng = mulberry32(hash(seed)), dayList = Array.from({ length: days }, (_, k) => addD(start, k)), write = p.dry === '0';
    const known = CAT.map((c) => c.key), targets = (sites.length ? sites : known).filter((s) => known.includes(s));
    const plan = [], perSite = [], shortage = [], skipped = { noAccount: 0, noBoard: 0, noImage: 0 };
    targets.forEach((site) => {
      const mine = SHEET.pins.filter((x) => x.site === site), waiting = mine.filter((x) => x.st === 'done'), account = SHEET.accounts[site];
      if (!account) { skipped.noAccount += waiting.length; return; }
      skipped.noBoard += cnt(waiting, (x) => x.board === false); skipped.noImage += cnt(waiting, (x) => x.img === false && x.board !== false);
      const pool = shuffle(waiting.filter((x) => x.board !== false && x.img !== false).sort((a, b) => cmpV(a.pin, b.pin)), rng);
      const exist = {}, add = {}, last = {};
      mine.forEach((x) => { if ((x.st === 'planned' || x.st === 'scheduled') && dayList.includes(x.day)) exist[x.day] = (exist[x.day] || 0) + 1; });
      dayList.forEach((day, di) => {
        const need = Math.max(0, per - (exist[day] || 0)), used = new Set(), times = []; let got = 0;
        for (let j = 0; j < pool.length && got < need; j++) {
          const x = pool[j]; if (!x || used.has(x.id) || (last[x.id] != null && di - last[x.id] <= avoid)) continue;
          const t = slotTime(times, h1, h2, gap, rng); if (t == null) break;
          times.push(t); used.add(x.id); last[x.id] = di; pool[j] = null; got++;
          const kw = (SHEET.articles.find((a) => a.id === x.id) || {}).kw || '';
          plan.push({ site, account, pin: x.pin, article: x.id, kw, day, time: hm(t), at: sAt(day, hm(t), tz) });
        }
        if (got) add[day] = got;
        if (got < need) shortage.push({ site, day, missing: need - got });
      });
      perSite.push({ site, account, planned: sum(Object.values(add)), waiting: cnt(pool, Boolean), days: add, exist });
    });
    if (write) plan.forEach((e) => { const x = SHEET.pins.find((y) => y.pin === e.pin); if (x) Object.assign(x, { st: 'planned', day: e.day, time: e.time, at: e.at }); });
    return Object.assign({ ok: true, total: plan.length }, write ? { written: plan.length } : {}, { days: dayList, plan, perSite, shortage, skipped, options: Object.assign({}, opts, { seed }) });
  }

  /* ───────── Auth ───────── */
  const authKey = 'mock_auth_' + SC.base;
  function mkSession(email) {
    return { access_token: 'mock-access-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'mock-refresh-token',
      user: { id: '0b5e2c1a-7d4f-4e8a-9c3b-1f2e3d4c5b6a', aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: ago(30 * 1440), last_sign_in_at: ago(90),
        app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: ago(40 * 1440) } };
  }
  (function initAuth() {
    let st = null; try { st = root.sessionStorage.getItem(authKey); } catch (_) {}
    if (st ? st !== 'out' : SC.base !== 'login') AUTH.session = mkSession(st && st !== 'out' ? st : 'ikbal@example.test');
  })();
  const remember = (v) => { try { root.sessionStorage.setItem(authKey, v); } catch (_) {} };
  const emit = (evt) => AUTH.listeners.slice().forEach((cb) => setTimeout(() => cb(evt, clone(AUTH.session)), 0));
  const authErr = (message, status, code, name) => ({ name: name || 'AuthApiError', message, status, code, __isAuthError: true });
  const auth = {
    async getSession() { await delay('auth:getSession'); return { data: { session: clone(AUTH.session) }, error: null }; },
    async getUser() {
      await delay('auth:getUser');
      return AUTH.session ? { data: { user: clone(AUTH.session.user) }, error: null } : { data: { user: null }, error: authErr('Auth session missing!', 400, undefined, 'AuthSessionMissingError') };
    },
    onAuthStateChange(cb) {
      AUTH.listeners.push(cb);
      setTimeout(() => cb('INITIAL_SESSION', clone(AUTH.session)), 0);
      return { data: { subscription: { id: 'mock-sub-' + AUTH.listeners.length, callback: cb, unsubscribe() { AUTH.listeners = AUTH.listeners.filter((x) => x !== cb); } } } };
    },
    async signInWithPassword(c) {
      c = c || {}; await delay('auth:signInWithPassword');
      if (!c.email || !c.password) return { data: { user: null, session: null }, error: authErr('missing email or phone', 400, 'validation_failed') };
      if (c.password === 'wrong') return { data: { user: null, session: null }, error: authErr('Invalid login credentials', 400, 'invalid_credentials') };
      AUTH.session = mkSession(String(c.email).toLowerCase()); remember(AUTH.session.user.email); emit('SIGNED_IN');
      return { data: { user: clone(AUTH.session.user), session: clone(AUTH.session) }, error: null };
    },
    async signInWithOtp(c) {
      c = c || {}; await delay('auth:signInWithOtp');
      if (!c.email) return { data: { user: null, session: null }, error: authErr('missing email or phone', 400, 'validation_failed') };
      if (/ratelimit/i.test(c.email)) return { data: { user: null, session: null }, error: authErr('email rate limit exceeded', 429, 'over_email_send_rate_limit') };
      return { data: { user: null, session: null }, error: null };
    },
    async signOut() { await delay('auth:signOut'); AUTH.session = null; remember('out'); emit('SIGNED_OUT'); return { error: null }; },
    async updateUser(attrs) {
      attrs = attrs || {}; await delay('auth:updateUser');
      if (!AUTH.session) return { data: { user: null }, error: authErr('Auth session missing!', 400, undefined, 'AuthSessionMissingError') };
      if (attrs.password != null && String(attrs.password).length < 6) return { data: { user: null }, error: authErr('Password should be at least 6 characters.', 422, 'weak_password', 'AuthWeakPasswordError') };
      if (attrs.email) AUTH.session.user.email = attrs.email;
      emit('USER_UPDATED');
      return { data: { user: clone(AUTH.session.user) }, error: null };
    },
    async refreshSession() { await delay('auth:refreshSession'); return { data: { session: clone(AUTH.session), user: AUTH.session ? clone(AUTH.session.user) : null }, error: null }; },
  };

  /* ───────── Boot fixtures + client ───────── */
  buildDb();
  if (FULLISH) buildSheet();
  buildPipelineState();
  buildAlerts();

  async function invoke(name, opts) {
    opts = opts || {};
    const body = opts.body === undefined ? {} : clone(opts.body);
    await delay(`fn:${name}:${(body && body.action) || ''}${body && body.gas ? ':' + body.gas : ''}`);
    const h = FN[name];
    if (!h) return { data: null, error: new FunctionsHttpError(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }) };
    try { return { data: clone(h(body || {})), error: null }; }
    catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      console.warn(`[mock-supabase] functions.invoke(${name}) → ${status}`, e.message);
      return { data: null, error: new FunctionsHttpError(status, { error: e.message || String(e) }) };
    }
  }
  function createClient(url, key, opts) {
    if (url) CLIENT_URL = String(url).replace(/\/+$/, '');
    if (key && !/^sb_publishable_/.test(String(key))) console.warn('[mock-supabase] the front should only ship an sb_publishable_ key');
    const ch = { on() { return ch; }, subscribe(cb) { if (cb) setTimeout(() => cb('SUBSCRIBED'), 0); return ch; }, unsubscribe: async () => 'ok' };
    return {
      supabaseUrl: CLIENT_URL, supabaseKey: key, options: opts || {}, auth,
      from: (t) => new Query(String(t), null, null),
      rpc: (fn, args) => new Query(null, String(fn), clone(args || {})),
      schema() { return this; },
      functions: { invoke, setAuth() {} },
      channel: () => ch, removeChannel: async () => 'ok', removeAllChannels: async () => [], getChannels: () => [],
    };
  }
  root.supabase = {
    createClient, FunctionsHttpError,
    __mock: { scenario: SC, db: DB, get sheet() { return SHEET; }, dash: () => (SHEET ? dash() : null), refreshPipeline: () => pipelineRefresh(), delayMs },
  };
  console.info(`[mock-supabase] scenario=${SC.raw} · ${DB.sites.length} sites · ${DB.n8n_workflows.length} workflows · ${DB.n8n_executions.length} executions · ${SHEET ? SHEET.articles.length + ' articles / ' + SHEET.pins.length + ' pins' : 'no sheet'}`);
})(typeof window !== 'undefined' ? window : globalThis);
