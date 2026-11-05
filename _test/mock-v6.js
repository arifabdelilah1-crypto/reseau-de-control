/* mock-v6.js — extension de mock-supabase.js pour la v6 (Indexation, Blotato, agent, connecteur MCP).
   À charger juste après mock-supabase.js. Même principe : données en mémoire, rien sur le réseau. */
(function () {
  'use strict';
  const M = supabase.__mock, X = M.ext, DB = M.db, FULL = M.scenario.base !== 'empty';
  const now = Date.now(), H = 3600e3, D = 24 * H;
  const iso = (t) => new Date(t).toISOString();
  let seed = 42; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const slug = (domain) => String(domain).split('.')[0].replace(/rezept$/, '').replace(/-.*/, '') || domain;

  Object.assign(X.SCHEMA, {
    url_index: { cols: { url: 'text', url_key: 'text', site_id: 'uuid', article_id: 'text', keyword: 'text', first_seen_at: 'ts', last_inspected_at: 'ts', next_check_at: 'ts', verdict: 'text', coverage_state: 'text', inspection_link: 'text', indexed_at: 'ts', error: 'text', last_crawl_at: 'ts' }, pk: 'url', nn: [], pol: 's' },
    blotato_accounts: { cols: { id: 'text', fullname: 'text', username: 'text', platform: 'text', site: 'text', last_published_scan_at: 'ts', synced_at: 'ts' }, pk: 'id', nn: [], pol: 's' },
    blotato_schedules: { cols: { id: 'text', account_id: 'text', site: 'text', scheduled_at: 'ts', link: 'text', link_key: 'text', board_id: 'text', title: 'text', text: 'text', media_url: 'text', article_id: 'text', synced_at: 'ts' }, pk: 'id', nn: [], pol: 's' },
    blotato_published: { cols: { id: 'text', account_id: 'text', site: 'text', post_url: 'text', created_at: 'ts', title: 'text', link: 'text', article_id: 'text', impressions: 'int', saves: 'int', pin_clicks: 'int', clicks: 'int' }, pk: 'id', nn: [], pol: 's' },
    blotato_failed: { cols: { id: 'text', account_id: 'text', site: 'text', post_time: 'ts', error: 'text', text: 'text', synced_at: 'ts' }, pk: 'id', nn: [], pol: 's' },
    agent_usage: { cols: { day: 'date', prompt_tokens: 'int', completion_tokens: 'int', calls: 'int' }, pk: 'day', nn: [], pol: 's' },
  });
  ['url_index', 'blotato_accounts', 'blotato_schedules', 'blotato_published', 'blotato_failed', 'agent_usage'].forEach((t) => (DB[t] = DB[t] || []));
  const STATE = { blotato: FULL, lastSync: FULL ? iso(now - 9 * 60e3) : null };

  /* ── Données ── */
  const tracked = () => DB.sites.filter((s) => s.tracked);
  const COV = [['PASS', 'Indexed'], ['PASS', 'Gesendet und indexiert'], ['NEUTRAL', 'URL ist Google nicht bekannt'], ['NEUTRAL', 'Gefunden – zurzeit nicht indexiert'], ['NEUTRAL', 'Gecrawlt – zurzeit nicht indexiert'], ['NEUTRAL', 'Duplikat – Google hat eine andere Seite als kanonische Seite bestimmt']];
  const KW = ['Apfelkuchen vom Blech', 'Zimtschnecken ohne Hefe', 'Hähnchen im Airfryer', 'Waffeln wie bei Oma', 'Gulasch im Schnellkochtopf', 'Käsekuchen ohne Boden', 'Pfannkuchen mit Apfel', 'Nudelpfanne mit Spinat', 'Ausstechplätzchen mit Kindern', 'Kartoffelgratin klassisch'];
  if (FULL) {
    tracked().forEach((s, si) => {
      for (let i = 0; i < 40; i++) {
        const seen = now - Math.floor(rnd() * 50) * D - si * H;
        const r = rnd();
        const c = r < .45 ? (rnd() < .5 ? ['IMPRESSIONS', 'Vue dans les résultats Google (impressions Search Console)'] : COV[Math.floor(rnd() * 2)]) : r < .65 ? [null, null] : COV[2 + Math.floor(rnd() * 4)];
        const url = `https://${s.domain}/${KW[i % KW.length].toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-')}-${si}${i}/`;
        DB.url_index.push({ url, url_key: url.replace(/^https?:\/\//, '').replace(/\/$/, ''), site_id: s.id, article_id: `A-${String(si * 100 + i).padStart(5, '0')}`, keyword: KW[i % KW.length],
          first_seen_at: iso(seen), last_inspected_at: c[0] ? iso(now - rnd() * 3 * D) : null, next_check_at: iso(now + D), verdict: c[0], coverage_state: c[1],
          inspection_link: c[0] && c[0] !== 'IMPRESSIONS' ? `https://search.google.com/search-console/inspect?resource_id=sc-domain:${s.domain}&id=${encodeURIComponent(url)}` : null,
          indexed_at: c[0] === 'PASS' || c[0] === 'IMPRESSIONS' ? iso(seen + (1 + rnd() * 9) * D) : null, error: null, last_crawl_at: c[0] && c[1] !== 'URL ist Google nicht bekannt' ? iso(seen + 2 * D) : null });
      }
    });
    tracked().forEach((s, si) => {
      const id = String(7100 + si * 13), site = slug(s.domain);
      DB.blotato_accounts.push({ id, fullname: s.label || s.domain, username: site, platform: 'pinterest', site, last_published_scan_at: iso(now - H), synced_at: iso(now - 9 * 60e3) });
      const perDay = si % 5 === 4 ? 0 : 3;
      for (let d = 0; d < 10; d++) for (let k = 0; k < perDay; k++) {
        const t = now + d * D + (8 + k * 4 + rnd() * 2) * H - (now % D), kw = pick(KW);
        if (t < now + 10 * 60e3) continue;
        DB.blotato_schedules.push({ id: `sch_${id}_${d}_${k}`, account_id: id, site, scheduled_at: iso(t), link: `https://${s.domain}/${kw.toLowerCase().replace(/\s+/g, '-')}/?utm_source=pinterest`, title: kw + ' – einfach & schnell', text: kw + ' Rezept', article_id: `A-${String(si * 100 + d).padStart(5, '0')}`, synced_at: iso(now) });
      }
      for (let d = 1; d <= 90; d++) for (let k = 0; k < 2 + (d % 2); k++) {
        if (rnd() < .07) { if (d <= 14) DB.blotato_failed.push({ id: `f_${id}_${d}_${k}`, account_id: id, site, post_time: iso(now - d * D), error: pick(['Pinterest API: Board not found', 'Image URL returned 404', 'Rate limit exceeded, retry later']), text: pick(KW), synced_at: iso(now) }); continue; }
        const kw = pick(KW), impr = Math.floor(rnd() * 900 * (1 + (90 - d) / 90));
        DB.blotato_published.push({ id: `p_${id}_${d}_${k}`, account_id: id, site, post_url: `https://www.pinterest.com/pin/10${id}${d}${k}/`, created_at: iso(now - d * D - k * 3 * H), title: kw + ' – einfach & schnell',
          link: `https://${s.domain}/${kw.toLowerCase().replace(/\s+/g, '-')}/`, article_id: `A-${String(si * 100 + (d % 40)).padStart(5, '0')}`, impressions: impr, saves: Math.floor(impr * .02), pin_clicks: Math.floor(impr * .05), clicks: Math.floor(impr * .009) });
      }
    });
    for (let d = 0; d < 5; d++) DB.agent_usage.push({ day: iso(now - d * D).slice(0, 10), prompt_tokens: 21000 + d * 3000, completion_tokens: 2400 + d * 300, calls: 6 - d });
  }

  /* ── RPC ── */
  const bucket = (v, c) => {
    if (v === 'PASS' || v === 'IMPRESSIONS') return 'indexed'; if (v == null) return 'pending'; c = String(c || '').toLowerCase();
    if (/404|not found|nicht gefunden/.test(c)) return 'not_found'; if (/crawled.*not indexed|gecrawlt/.test(c)) return 'crawled_not_indexed';
    if (/discovered.*not indexed|gefunden.*nicht indexiert/.test(c)) return 'discovered_not_indexed'; if (/unknown to google|nicht bekannt/.test(c)) return 'unknown';
    if (/duplicate|canonical|duplikat|kanonisch/.test(c)) return 'duplicate'; if (/redirect|weiterleitung/.test(c)) return 'redirect'; if (/noindex|excluded|ausgeschlossen|blockiert/.test(c)) return 'excluded'; return 'other';
  };
  const sig = (name, args, req = []) => (X.RPC_SIG[name] = { args: args.slice().sort(), req });
  const day0 = (t) => new Date(new Date(t).toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  sig('index_summary', []); sig('index_list', ['p_site', 'p_bucket', 'p_limit'], ['p_site', 'p_bucket']); sig('index_timeline', ['p_site', 'p_days'], ['p_site']);
  sig('blotato_site_stats', ['p_days']); sig('blotato_calendar', ['p_past', 'p_next']); sig('blotato_reconcile', ['p_next']);
  sig('blotato_top_pins', ['p_site', 'p_days', 'p_order', 'p_limit']); sig('blotato_article_stats', ['p_site', 'p_limit']);
  X.RPC.index_summary = () => tracked().map((s) => {
    const L = DB.url_index.filter((u) => u.site_id === s.id), b = (k) => L.filter((u) => bucket(u.verdict, u.coverage_state) === k).length;
    const d = L.filter((u) => u.indexed_at).map((u) => (Date.parse(u.indexed_at) - Date.parse(u.first_seen_at)) / D).sort((a, c) => a - c);
    return { site_id: s.id, domain: s.domain, total: L.length, indexed: b('indexed'), pending: b('pending'), crawled_not_indexed: b('crawled_not_indexed'), discovered_not_indexed: b('discovered_not_indexed'),
      unknown: b('unknown'), excluded: b('excluded') + b('duplicate') + b('redirect') + b('not_found'), other: b('other'),
      stale_not_indexed: L.filter((u) => !['indexed', 'pending'].includes(bucket(u.verdict, u.coverage_state)) && Date.parse(u.first_seen_at) < now - 14 * D).length,
      median_days_to_index: d.length ? d[Math.floor(d.length / 2)] : null, inspected_today: L.filter((u) => u.last_inspected_at && Date.parse(u.last_inspected_at) >= day0(now)).length,
      last_inspected_at: L.map((u) => u.last_inspected_at).filter(Boolean).sort().pop() || null };
  }).filter((r) => r.total);
  X.RPC.index_list = (a) => DB.url_index.filter((u) => (!a.p_site || u.site_id === a.p_site)).map((u) => ({ ...u, bucket: bucket(u.verdict, u.coverage_state), domain: DB.sites.find((s) => s.id === u.site_id)?.domain }))
    .filter((u) => !a.p_bucket || a.p_bucket === 'all' || (a.p_bucket === 'not_indexed' ? !['indexed', 'pending'].includes(u.bucket) : u.bucket === a.p_bucket))
    .sort((x, y) => (x.first_seen_at < y.first_seen_at ? 1 : -1)).slice(0, a.p_limit ?? 200);
  X.RPC.index_timeline = (a) => { const out = [], n = a.p_days ?? 60; for (let i = n - 1; i >= 0; i--) { const d = iso(now - i * D).slice(0, 10), L = DB.url_index.filter((u) => !a.p_site || u.site_id === a.p_site);
    out.push({ date: d, seen: L.filter((u) => u.first_seen_at.slice(0, 10) === d).length, indexed: L.filter((u) => (u.indexed_at || '').slice(0, 10) === d).length }); } return out; };
  const pubIn = (days) => DB.blotato_published.filter((p) => Date.parse(p.created_at) >= now - days * D);
  X.RPC.blotato_site_stats = (a) => { const days = a.p_days ?? 30; return DB.blotato_accounts.map((acc) => {
    const P = pubIn(days).filter((p) => p.account_id === acc.id), S = DB.blotato_schedules.filter((x) => x.account_id === acc.id), s = (k) => P.reduce((t, p) => t + (p[k] || 0), 0);
    return { site: acc.site, account_id: acc.id, published: P.length, failed: DB.blotato_failed.filter((f) => f.account_id === acc.id && Date.parse(f.post_time) >= now - days * D).length,
      scheduled_next7: S.filter((x) => Date.parse(x.scheduled_at) < now + 7 * D).length, impressions: s('impressions'), saves: s('saves'), pin_clicks: s('pin_clicks'), clicks: s('clicks'),
      ctr: s('impressions') ? s('clicks') / s('impressions') : null, last_published: P.map((p) => p.created_at).sort().pop() || null, next_scheduled: S.map((x) => x.scheduled_at).sort()[0] || null };
  }); };
  X.RPC.blotato_calendar = (a) => { const out = []; DB.blotato_accounts.forEach((acc) => { for (let i = (a.p_past ?? 14); i >= -(a.p_next ?? 14); i--) { const d = iso(now - i * D).slice(0, 10);
    out.push({ site: acc.site, day: d, published: DB.blotato_published.filter((p) => p.account_id === acc.id && p.created_at.slice(0, 10) === d).length,
      failed: DB.blotato_failed.filter((p) => p.account_id === acc.id && p.post_time.slice(0, 10) === d).length, scheduled: DB.blotato_schedules.filter((p) => p.account_id === acc.id && p.scheduled_at.slice(0, 10) === d).length }); } }); return out; };
  X.RPC.blotato_reconcile = (a) => { const out = []; DB.blotato_accounts.forEach((acc, ai) => { for (let i = 0; i < (a.p_next ?? 14); i++) { const d = iso(now + i * D).slice(0, 10), bl = DB.blotato_schedules.filter((p) => p.account_id === acc.id && p.scheduled_at.slice(0, 10) === d).length;
    out.push({ site: acc.site, day: d, sheet: ai % 4 === 1 && i > 6 ? bl + 1 : i < 9 ? bl : 0, blotato: bl }); } }); return out; };
  X.RPC.blotato_top_pins = (a) => pubIn(a.p_days ?? 30).filter((p) => !a.p_site || p.site === a.p_site).sort((x, y) => (y[a.p_order || 'impressions'] || 0) - (x[a.p_order || 'impressions'] || 0)).slice(0, a.p_limit ?? 50);
  X.RPC.blotato_article_stats = (a) => { const m = new Map(); DB.blotato_published.filter((p) => p.article_id && (!a.p_site || p.site === a.p_site)).forEach((p) => {
    const o = m.get(p.article_id) || { article_id: p.article_id, site: p.site, keyword: p.title.split(' – ')[0], url: p.link, pins: 0, impressions: 0, saves: 0, pin_clicks: 0, clicks: 0, last_pin: p.created_at, indexed: rnd() > .2 };
    o.pins++; ['impressions', 'saves', 'pin_clicks', 'clicks'].forEach((k) => (o[k] += p[k] || 0)); m.set(p.article_id, o); });
    return [...m.values()].sort((x, y) => y.clicks - x.clicks).slice(0, a.p_limit ?? 100); };


  /* ── v6.1 : fonctions « du … au … » (calendrier) ── */
  const nDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / D) + 1;
  const inR = (t, a, b) => { const k = String(t || '').slice(0, 10); return k >= a && k <= b; };
  sig('site_overview_range', ['p_from', 'p_to', 'p_spark_from'], ['p_from', 'p_to']);
  sig('query_movers_range', ['p_site', 'p_from', 'p_to', 'p_limit'], ['p_site', 'p_from', 'p_to']);
  sig('n8n_range', ['p_from', 'p_to'], ['p_from', 'p_to']);
  sig('index_timeline_range', ['p_site', 'p_from', 'p_to'], ['p_site', 'p_from', 'p_to']);
  sig('index_list_range', ['p_site', 'p_from', 'p_to', 'p_limit'], ['p_site', 'p_from', 'p_to']);
  sig('blotato_site_stats_range', ['p_from', 'p_to'], ['p_from', 'p_to']);
  sig('blotato_calendar_range', ['p_from', 'p_to'], ['p_from', 'p_to']);
  sig('blotato_top_pins_range', ['p_site', 'p_from', 'p_to', 'p_order', 'p_limit'], ['p_site', 'p_from', 'p_to']);
  sig('pipeline_days', ['p_from', 'p_to'], ['p_from', 'p_to']);
  X.RPC.site_overview_range = (a) => X.RPC.site_overview({ p_days: nDays(a.p_from, a.p_to) }).map((r) => ({ ...r, spark: a.p_spark_from ? r.spark.concat(r.spark).slice(-nDays(a.p_spark_from, a.p_to)) : r.spark }));
  X.RPC.query_movers_range = (a) => X.RPC.query_movers({ p_site: a.p_site, p_days: nDays(a.p_from, a.p_to), p_limit: a.p_limit ?? 15 });
  X.RPC.n8n_range = (a) => X.RPC.n8n_daily({ p_days: 60 }).filter((x) => inR(x.date, a.p_from, a.p_to));
  X.RPC.index_timeline_range = (a) => { const out = []; for (let k = a.p_from; k <= a.p_to; k = iso(Date.parse(k) + D).slice(0, 10)) { const L = DB.url_index.filter((u) => !a.p_site || u.site_id === a.p_site);
    out.push({ date: k, seen: L.filter((u) => inR(u.first_seen_at, k, k)).length, indexed: L.filter((u) => inR(u.indexed_at, k, k)).length, inspected: L.filter((u) => inR(u.last_inspected_at, k, k)).length }); } return out; };
  X.RPC.index_list_range = (a) => DB.url_index.filter((u) => !a.p_site || u.site_id === a.p_site).map((u) => {
    const ev = [inR(u.first_seen_at, a.p_from, a.p_to) && 'nouvel article', inR(u.indexed_at, a.p_from, a.p_to) && 'indexé', inR(u.last_inspected_at, a.p_from, a.p_to) && 'inspecté'].filter(Boolean).join(' · ');
    return { ...u, bucket: bucket(u.verdict, u.coverage_state), domain: DB.sites.find((s) => s.id === u.site_id)?.domain, event: ev }; }).filter((u) => u.event).slice(0, a.p_limit ?? 1000);
  X.RPC.blotato_site_stats_range = (a) => DB.blotato_accounts.map((acc) => {
    const P = DB.blotato_published.filter((p) => p.account_id === acc.id && inR(p.created_at, a.p_from, a.p_to)), S = DB.blotato_schedules.filter((x) => x.account_id === acc.id), s = (k) => P.reduce((t, p) => t + (p[k] || 0), 0);
    return { site: acc.site, account_id: acc.id, published: P.length, failed: DB.blotato_failed.filter((f) => f.account_id === acc.id && inR(f.post_time, a.p_from, a.p_to)).length,
      scheduled_next7: S.filter((x) => Date.parse(x.scheduled_at) < now + 7 * D).length, impressions: s('impressions'), saves: s('saves'), pin_clicks: s('pin_clicks'), clicks: s('clicks'),
      ctr: s('impressions') ? s('clicks') / s('impressions') : null, last_published: P.map((p) => p.created_at).sort().pop() || null, next_scheduled: S.map((x) => x.scheduled_at).sort()[0] || null }; });
  X.RPC.blotato_calendar_range = (a) => { const out = []; DB.blotato_accounts.forEach((acc) => { for (let k = a.p_from; k <= a.p_to; k = iso(Date.parse(k) + D).slice(0, 10)) out.push({ site: acc.site, day: k,
    published: DB.blotato_published.filter((p) => p.account_id === acc.id && inR(p.created_at, k, k)).length, failed: DB.blotato_failed.filter((p) => p.account_id === acc.id && inR(p.post_time, k, k)).length,
    scheduled: DB.blotato_schedules.filter((p) => p.account_id === acc.id && inR(p.scheduled_at, k, k)).length }); }); return out; };
  X.RPC.blotato_top_pins_range = (a) => DB.blotato_published.filter((p) => (!a.p_site || p.site === a.p_site) && inR(p.created_at, a.p_from, a.p_to)).sort((x, y) => (y[a.p_order || 'impressions'] || 0) - (x[a.p_order || 'impressions'] || 0)).slice(0, a.p_limit ?? 100);
  X.RPC.pipeline_days = (a) => { const out = []; for (let k = a.p_from, i = 0; k <= a.p_to; k = iso(Date.parse(k) + D).slice(0, 10), i++) {
    const m = (pub, sch) => ({ articles: { published: pub }, pins: { scheduled: sch, posted: 1200 + sch } });
    out.push({ day: k, first_at: k + 'T00:10:00Z', last_at: k + 'T23:10:00Z', first_metrics: m(1360 + i * 6, 300 + i * 20), last_metrics: m(1366 + i * 6, 320 + i * 20), snapshots: 24 }); } return out; };


  /* ── v6.2 : URLs du Sheet à corriger ── */
  sig('sheet_url_fixes', ['p_site']);
  X.RPC.sheet_url_fixes = (a) => DB.url_index.filter((u) => !a.p_site || u.site_id === a.p_site).slice(0, 60).map((u, i) => {
    const issues = ['lien court ?p= au lieu de la vraie URL', 'redirige vers une autre URL (slug changé)', 'page introuvable (404)', 'pas encore vérifiée'];
    const iss = issues[i % 4], dom = DB.sites.find((s) => s.id === u.site_id)?.domain;
    return { article_id: u.article_id, keyword: u.keyword, domain: dom, sheet_url: iss.startsWith('lien') ? `https://${dom}/?p=${7000 + i}` : u.url.replace(/\/$/, '-alt/'),
      real_url: iss.includes('404') || iss.startsWith('pas') ? null : u.url, http_status: iss.includes('404') ? 404 : iss.startsWith('pas') ? null : 200, issue: iss, shared_with: i % 7 === 1 ? 2 : 0 };
  });

  /* ── Edge functions ── */
  const HE = X.HttpError;
  X.FN['index-sync'] = (b) => { X.requireUser();
    if (b.action === 'inspect') { const u = DB.url_index.find((x) => x.url === b.url); if (!u) throw new HE(404, 'URL inconnue'); const c = pick(COV); Object.assign(u, { verdict: c[0], coverage_state: c[1], last_inspected_at: M.nowIso() }); return { ok: true, url: u.url, verdict: c[0], coverage_state: c[1] }; }
    if (b.action === 'work') { const due = DB.url_index.filter((u) => !u.verdict).slice(0, 36); due.forEach((u) => { const c = pick(COV); Object.assign(u, { verdict: c[0], coverage_state: c[1], last_inspected_at: M.nowIso() }); }); return { seed: { added: 0, impressions_shortcut: 0 }, done: due.length, failed: 0, errors: [], ms: 98000 }; }
    throw new HE(400, 'action inconnue'); };
  X.FN.blotato = (b) => { X.requireUser();
    if (b.action === 'status') return { configured: STATE.blotato, last_sync: STATE.lastSync };
    if (b.action === 'sync') { if (!STATE.blotato) return { ok: false, error: 'Secret BLOTATO_API_KEY manquant' }; STATE.lastSync = M.nowIso(); return { ok: true, accounts: DB.blotato_accounts.length, scheduled: DB.blotato_schedules.length, published_seen: 120, failed: DB.blotato_failed.length, details: 40 }; }
    const i = DB.blotato_schedules.findIndex((x) => x.id === b.schedule_id); if (i < 0) throw new HE(404, 'Post introuvable chez Blotato');
    if (b.action === 'cancel') { DB.blotato_schedules.splice(i, 1); return { ok: true, message: 'Post annulé chez Blotato' }; }
    if (b.action === 'reschedule') { const t = Date.parse(b.scheduled_at); if (!(t > now + 2 * 60e3)) throw new HE(400, 'La date doit être dans le futur (≥ 2 min)'); DB.blotato_schedules[i].scheduled_at = iso(t); return { ok: true, message: `Reprogrammé au ${new Date(t).toLocaleString('fr-FR')}` }; }
    throw new HE(400, 'action inconnue'); };
  let tok = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  X.FN['control-mcp'] = (b) => { X.requireUser(); if (b.action === 'rotate') tok = Math.random().toString(16).slice(2).padEnd(32, '0');
    return { url: `https://kuhxuovjlukxdzjnsyzt.supabase.co/functions/v1/control-mcp?key=${tok}`, tools: ['list_sites', 'system_overview', 'seo_timeseries', 'seo_top', 'index_status', 'n8n_workflows', 'alerts', 'pipeline_summary', 'blotato_scheduled', 'blotato_stats'] }; };
  X.FN.agent = (b) => { X.requireUser(); const q = String(b.messages?.slice(-1)[0]?.content || '');
    const nonIdx = DB.url_index.filter((u) => !['indexed', 'pending'].includes(bucket(u.verdict, u.coverage_state))).length;
    const props = /programm|demain|pin/i.test(q) ? [{ action: 'sync_blotato', params: {}, summary: 'Relire Blotato pour confirmer le planning de demain.' }] : /échou|fail|erreur/i.test(q) ? [{ action: 'wf1_retry_failed', params: { sites: ['foodzauber'] }, summary: 'Relancer les 12 articles en échec de foodzauber.' }] : [];
    return { answer: `**Résumé (données de test)**\n\n- ${DB.url_index.length} articles suivis, **${nonIdx} non indexés**\n- ${DB.blotato_schedules.length} pins programmés chez Blotato\n- ${DB.blotato_accounts.filter((a) => !DB.blotato_schedules.some((s) => s.account_id === a.id)).length} compte(s) sans rien de programmé\n\n| Compte | Programmés |\n|---|---|\n${DB.blotato_accounts.slice(0, 3).map((a) => `| ${a.site} | ${DB.blotato_schedules.filter((s) => s.account_id === a.id).length} |`).join('\n')}`,
      proposals: props, steps: [{ tool: 'system_overview', args: {}, ok: true }, { tool: 'blotato_scheduled', args: { days: 1 }, ok: true }], usage: { prompt_tokens: 5400, completion_tokens: 320 } }; };
  X.FN['index-sync'] = ((orig) => (b) => b.action === 'sitemaps' ? (X.requireUser(), { sitemaps: { 'foodzauber.blog': { total: 132, added: 3, removed: 1 } }, aliases: { resolved: 24, problems: 3 } }) : orig(b))(X.FN['index-sync']);

  /* ── v7 ── */
  sig('blotato_volume_reach', ['p_days', 'p_site']); sig('blotato_account_reach', []); sig('article_link_health', []); sig('index_trend', ['p_site', 'p_days']);
  X.RPC.blotato_volume_reach = (a) => { const m = new Map(); DB.blotato_published.filter((p) => !a.p_site || p.site === a.p_site).forEach((p) => { const d = p.created_at.slice(0, 10);
    const o = m.get(d) || { day: d, pins: 0, impressions: 0, clicks: 0, saves: 0, accounts: new Set() }; o.pins++; o.impressions += p.impressions || 0; o.clicks += p.clicks || 0; o.saves += p.saves || 0; o.accounts.add(p.account_id); m.set(d, o); });
    return [...m.values()].sort((x, y) => (x.day < y.day ? -1 : 1)).map((o) => ({ ...o, accounts: o.accounts.size, impr_per_pin: o.impressions / o.pins, ctr: o.impressions ? o.clicks / o.impressions : null, mature: o.day <= iso(now - 7 * D).slice(0, 10) })); };
  X.RPC.blotato_account_reach = () => DB.blotato_accounts.map((acc, i) => { const n7 = 4 + (i * 3) % 12, ir = i % 3 ? 2 + i % 4 : 20 + i, ib = 25 + i * 2;
    return { site: acc.site, account_id: acc.id, pins_7d: n7 * 7, per_day_7d: n7, pins_prev: 120, per_day_prev: 4.3, impr_per_pin_recent: ir, impr_per_pin_before: ib, ctr_recent: 0.008, clicks_recent: 12 + i,
      verdict: n7 > 8 && ir < 5 ? 'trop de pins, portée écrasée' : ir < ib * 0.4 ? 'portée en chute' : 'ok' }; });
  X.RPC.article_link_health = () => DB.url_index.slice(0, 40).map((u, i) => ({ article_id: u.article_id, sheet_url: u.url.replace(/\/$/, '-x/'), sheet_key: u.url.replace(/^https?:\/\//, '').replace(/\/$/, '-x'), real_url: u.url, http_status: i % 4 === 0 ? 404 : 200, issue: i % 4 === 0 ? '404' : i % 4 === 1 ? 'lien court' : 'redirection' }));
  X.RPC.index_trend = (a) => { const out = []; for (let i = 20; i >= 0; i--) out.push({ day: iso(now - i * D).slice(0, 10), total: 520, indexed: 150 + (20 - i) * 4, unknown: 200 - (20 - i) * 3, rate: (150 + (20 - i) * 4) / 520 }); return out; };
})();
