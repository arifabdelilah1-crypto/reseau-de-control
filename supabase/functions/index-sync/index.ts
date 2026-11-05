// index-sync — suit l'indexation Google des articles publiés (GSC URL Inspection API).
//   POST {action:"work"}           (cron 10 min / user) ajoute les nouveaux articles + inspecte un lot, alertes
//   POST {action:"inspect", url}   (user) inspecte une URL tout de suite
//   POST {action:"sitemaps"}       (user) relit les sitemaps WordPress tout de suite
//   POST {action:"aliases"}        (cron 2 min / user) vérifie un lot d'URLs du Sheet
// Vérité = sitemaps WordPress (post-sitemap*.xml) : seules ces URLs sont suivies et inspectées.
// Les URLs du Sheet (souvent ?p=123 ou anciens slugs) vont dans url_alias, résolues (redirection + canonique)
// puis reliées à leur vraie URL pour garder article_id / mot-clé.
// Quota Google : 2 000 inspections / jour / propriété, 600 / min. Réglage : index_daily_per_site (300 par défaut).
import {
  admin, serve, json, requireUser, requireUserOrCron, HttpError, getSetting, getAccessToken, gapi,
  GoogleAuthDead, raiseAlert, resolveAlert,
} from "../_shared/common.ts";

const TIME_BUDGET_MS = 100_000;
const BATCH = 4;   // inspections en parallèle

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const action = body.action || "work";
  if (action === "inspect") {
    await requireUser(req);
    const url = String(body.url || "");
    const { data: row } = await admin.from("url_index")
      .select("url, site_id, sites!inner(gsc_site_id, gsc_sites!inner(site_url, account_id))").eq("url", url).maybeSingle();
    if (!row) throw new HttpError(404, "URL inconnue");
    const g = (row as any).sites.gsc_sites;
    const r = await inspectOne({ url, site_id: row.site_id, site_url: g.site_url, account_id: g.account_id });
    return json(r);
  }
  if (action === "work") {
    await requireUserOrCron(req);
    return json(await work());
  }
  if (action === "aliases") {      // cron 2 min : vérifie les URLs du Sheet (ne fait rien quand la file est vide)
    await requireUserOrCron(req);
    return json(await resolveAliases(Date.now() + 100_000));
  }
  if (action === "sitemaps") {
    await requireUser(req);
    return json({ sitemaps: await syncSitemaps(true), aliases: await resolveAliases(Date.now() + 40_000) });
  }
  throw new HttpError(400, "Unknown action");
});

async function work() {
  const t0 = Date.now();
  const seed = await admin.rpc("index_seed");
  const sitemaps = await syncSitemaps(false).catch((e) => ({ error: String(e) }));
  const aliases = await resolveAliases(t0 + 70_000).catch((e) => ({ error: String(e) }));
  const daily = Number(await getSetting("index_daily_per_site", 300));
  let done = 0, failed = 0;
  const errors: string[] = [];
  while (Date.now() - t0 < TIME_BUDGET_MS) {
    const { data: batch, error } = await admin.rpc("index_claim", { p_n: BATCH * 4, p_daily: daily });
    if (error) throw new Error(error.message);
    if (!batch?.length) break;
    for (let i = 0; i < batch.length && Date.now() - t0 < TIME_BUDGET_MS; i += BATCH) {
      const res = await Promise.all(batch.slice(i, i + BATCH).map((b: any) => inspectOne(b).catch((e) => ({ ok: false, error: String(e) }))));
      for (const r of res as any[]) {
        if (r.ok) done++; else { failed++; if (errors.length < 5) errors.push(r.error); }
        if (r.quota) return { seed: seed.data, sitemaps, aliases, done, failed, errors, stopped: "quota", ms: Date.now() - t0, alerts: await alerts() };
      }
    }
  }
  return { seed: seed.data, sitemaps, aliases, done, failed, errors, ms: Date.now() - t0, alerts: await alerts() };
}

const UA = "Mozilla/5.0 (compatible; ReseauDE-Control/1.0; +https://github.com)";
async function getText(url: string, ms = 25_000) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA, Accept: "text/html,application/xml" }, signal: AbortSignal.timeout(ms) });
  const text = await res.text();
  return { status: res.status, finalUrl: res.url || url, text };
}
const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>(?:\s*<lastmod>\s*([^<\s]+)\s*<\/lastmod>)?/g)].map((m) => ({ loc: m[1].replace(/&amp;/g, "&"), lastmod: m[2] || null }));

/** Sitemaps d'articles d'un site : Yoast (sitemap_index.xml → post-sitemap*.xml), WordPress natif (wp-sitemap.xml),
    sinon /sitemap.xml (Shopify, Wix, autres). On suit les index imbriqués et on écarte catégories / tags / auteurs. */
const SKIP_MAP = /(category|categories|tag|tags|author|taxonom|users|attachment|archive|product_cat|collections?)[-_]?(sitemap)?/i;
async function siteUrls(domain: string) {
  const tried: string[] = [];
  for (const root of [`https://${domain}/sitemap_index.xml`, `https://${domain}/wp-sitemap.xml`, `https://${domain}/sitemap.xml`]) {
    let r;
    try { r = await getText(root, 15_000); }
    catch (e) { tried.push(`${root.replace(/^https:\/\/[^/]+/, "")} : ${(e as Error).message.slice(0, 60)}`); break; }   // site injoignable : inutile d'essayer les autres
    if (r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.text)) { tried.push(`${root.replace(/^https:\/\/[^/]+/, "")} : HTTP ${r.status}`); continue; }
    const urls: { loc: string; lastmod: string | null }[] = [];
    const queue: string[] = [];
    if (/<sitemapindex/i.test(r.text)) {
      const kids = locs(r.text).map((x) => x.loc);
      const posts = kids.filter((u) => /post-sitemap\d*\.xml|wp-sitemap-posts-post-\d+\.xml/i.test(u));
      queue.push(...(posts.length ? posts : kids.filter((u) => !SKIP_MAP.test(u.split("/").pop() || ""))).slice(0, 12));
    } else urls.push(...locs(r.text));
    for (let k = 0; k < queue.length && urls.length < 5000; k++) {
      const c = await getText(queue[k]);
      if (c.status !== 200) throw new Error(`${queue[k]} → HTTP ${c.status}`);
      if (/<sitemapindex/i.test(c.text)) { queue.push(...locs(c.text).map((x) => x.loc).filter((u) => !SKIP_MAP.test(u.split("/").pop() || "")).slice(0, 12)); continue; }
      urls.push(...locs(c.text));
    }
    if (urls.length) return { root, urls };
    tried.push(`${root.replace(/^https:\/\/[^/]+/, "")} : vide`);
  }
  throw new Error(`aucun sitemap lisible (${tried.join(" · ")})`);
}

/** Relit les sitemaps d'articles de chaque site suivi (toutes les index_sitemap_hours, ou tout de suite si force). */
async function syncSitemaps(force: boolean) {
  const hours = Number(await getSetting("index_sitemap_hours", 6));
  const { data: last } = await admin.from("settings").select("value").eq("key", "index_sitemaps_at").maybeSingle();
  if (!force && last?.value && Date.now() - new Date(String(last.value)).getTime() < hours * 3600_000) return { skipped: true };
  const { data: sites } = await admin.from("sites").select("id, domain").eq("tracked", true);
  const out: Record<string, unknown> = {};
  await Promise.all((sites || []).map(async (s: any) => {
    try {
      const { root, urls } = await siteUrls(s.domain);
      const { data, error } = await admin.rpc("index_upsert_sitemap", { p_site: s.id, p_urls: urls });
      if (error) throw new Error(error.message);
      out[s.domain] = { ...(data as any), sitemap: root };
      await resolveAlert(`sitemap:${s.id}`);
    } catch (e) {
      const msg = (e as Error).message;
      out[s.domain] = { error: msg.slice(0, 200) };
      const dns = /dns|resolve|lookup|error sending request/i.test(msg);
      await raiseAlert({ fingerprint: `sitemap:${s.id}`, kind: "sitemap_error", severity: "warn",
        title: dns ? `${s.domain} : site injoignable (domaine expiré ou DNS mal configuré ?)` : `${s.domain} : sitemap illisible`,
        details: { site_id: s.id, error: msg.slice(0, 400) } });
    }
  }));
  await admin.from("settings").upsert({ key: "index_sitemaps_at", value: new Date().toISOString(), updated_at: new Date().toISOString() });
  return out;
}

/** Résout les URLs du Sheet (redirections + canonique) jusqu'à l'échéance, puis relie aux vraies URLs. */
async function resolveAliases(deadline: number) {
  let done = 0, bad = 0;
  while (Date.now() < deadline - 20_000) {
    const { data: batch } = await admin.rpc("alias_claim", { p_n: 4 });   // 4 à la fois : le serveur WordPress sature vite
    if (!batch?.length) break;
    await Promise.all(batch.map(async (b: any) => {
      const now = new Date();
      try {
        const r = await getText(b.sheet_url, 18_000);
        const canon = r.status === 200 ? (r.text.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] || null) : null;
        const target = r.status === 200 ? (canon || r.finalUrl) : null;
        await admin.from("url_alias").update({
          final_url: r.finalUrl, canonical: canon, http_status: r.status, checked_at: now.toISOString(), error: null,
          target_key: target ? target.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase() : null,
          next_check_at: new Date(now.getTime() + 7 * 86400_000).toISOString(),
        }).eq("sheet_url", b.sheet_url);
        done++; if (r.status !== 200) bad++;
      } catch (e) {
        await admin.from("url_alias").update({ error: String(e).slice(0, 200), checked_at: now.toISOString(),
          next_check_at: new Date(now.getTime() + 6 * 3600_000).toISOString() }).eq("sheet_url", b.sheet_url);
        bad++;
      }
    }));
    await new Promise((r) => setTimeout(r, 1500));
  }
  const link = done ? (await admin.rpc("index_link_aliases")).data : null;
  return { resolved: done, problems: bad, link };
}

async function inspectOne(b: { url: string; site_id: string; site_url: string; account_id: string }) {
  const now = new Date();
  try {
    const token = await getAccessToken(b.account_id);
    const r = await gapi<any>("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", token,
      { inspectionUrl: b.url, siteUrl: b.site_url, languageCode: "de-DE" });
    const s = r.inspectionResult?.indexStatusResult || {};
    const verdict = s.verdict || "VERDICT_UNSPECIFIED";
    const indexed = verdict === "PASS";
    const { data: prev } = await admin.from("url_index").select("indexed_at, first_seen_at").eq("url", b.url).single();
    const ageDays = prev ? (now.getTime() - new Date(prev.first_seen_at).getTime()) / 86400_000 : 0;
    const nextDays = indexed ? 30 : ageDays < 30 ? 2 : 7;
    await admin.from("url_index").update({
      verdict, coverage_state: s.coverageState || null, indexing_state: s.indexingState || null,
      page_fetch_state: s.pageFetchState || null, robots_state: s.robotsTxtState || null,
      last_crawl_at: s.lastCrawlTime || null, google_canonical: s.googleCanonical || null,
      user_canonical: s.userCanonical || null, inspection_link: r.inspectionResult?.inspectionResultLink || null,
      indexed_at: indexed ? (prev?.indexed_at || now.toISOString()) : prev?.indexed_at || null,
      last_inspected_at: now.toISOString(), next_check_at: new Date(now.getTime() + nextDays * 86400_000).toISOString(),
      error: null, attempts: 0,
    }).eq("url", b.url);
    return { ok: true, url: b.url, verdict, coverage_state: s.coverageState };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    const quota = /429|quota|rate/i.test(msg);
    await admin.from("url_index").update({
      error: msg, last_inspected_at: now.toISOString(),
      next_check_at: new Date(now.getTime() + (quota ? 6 : 24) * 3600_000).toISOString(),
    }).eq("url", b.url);
    if (e instanceof GoogleAuthDead) {
      await raiseAlert({ fingerprint: `google:${b.account_id}`, kind: "google_auth", severity: "crit",
        title: "Compte Google déconnecté : reconnecte-le dans Connexions", details: { error: msg } });
    }
    return { ok: false, url: b.url, error: msg, quota };
  }
}

async function alerts() {
  const min = Number(await getSetting("index_alert_min", 25));
  const { data } = await admin.rpc("index_summary");
  let open = 0;
  for (const s of (data || []) as any[]) {
    const fp = `index_stale:${s.site_id}`;
    if (Number(s.stale_not_indexed) >= min) {
      open++;
      await raiseAlert({ fingerprint: fp, kind: "index_stale", severity: "warn",
        title: `${s.domain} : ${s.stale_not_indexed} articles non indexés après 14 jours`,
        details: { site_id: s.site_id, stale: s.stale_not_indexed, total: s.total } });
    } else await resolveAlert(fp);
  }
  return open;
}
