// seo-sync — queue + worker that copies Search Console and GA4 data into Supabase.
//   POST {action:"backfill", site_ids?: string[]}  (user)  queue 16 months of history
//   POST {action:"daily"}                          (cron)  queue the last days + current month, SEO drop alerts
//   POST {action:"work"}                           (cron/user) process queued jobs for ~110 s
import {
  admin, serve, json, requireUserOrCron, HttpError, addDays, isoDate, getSetting, upsertChunks,
  getAccessToken, gapi, GoogleAuthDead, raiseAlert, resolveAlert,
} from "../_shared/common.ts";

const TIME_BUDGET_MS = 110_000;

serve(async (req) => {
  const who = await requireUserOrCron(req);
  const body = await req.json().catch(() => ({}));
  const action = body.action || "work";

  if (action === "backfill") return json(await enqueueBackfill(body.site_ids));
  if (action === "daily") {
    const q = await enqueueDaily();
    const drops = await seoDropAlerts();
    return json({ ...q, drops });
  }
  if (action === "work") return json(await work(who));
  throw new HttpError(400, "Unknown action");
});

type Job = { site_id: string; kind: string; start_date: string; end_date: string; priority: number };

async function trackedSites(ids?: string[]) {
  let q = admin.from("sites").select("id, domain, gsc_site_id, ga4_property_id, tracked");
  q = ids?.length ? q.in("id", ids) : q.eq("tracked", true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function enqueue(jobs: Job[]) {
  let n = 0;
  for (let i = 0; i < jobs.length; i += 500) {
    const { data, error } = await admin.rpc("enqueue_sync_jobs", { p_jobs: jobs.slice(i, i + 500) });
    if (error) throw new Error(`enqueue: ${error.message}`);
    n += Number(data || 0);
  }
  return n;
}

function monthStart(d: string) { return d.slice(0, 8) + "01"; }
function monthEnd(d: string) {
  const x = new Date(monthStart(d) + "T00:00:00Z");
  x.setUTCMonth(x.getUTCMonth() + 1);
  x.setUTCDate(0);
  return isoDate(x);
}
function minDate(a: string, b: string) { return a < b ? a : b; }

async function enqueueBackfill(ids?: string[]) {
  const months = Number(await getSetting("backfill_months", 16));
  const today = isoDate(new Date());
  const yesterday = addDays(today, -1);
  const startD = new Date(today + "T00:00:00Z");
  startD.setUTCMonth(startD.getUTCMonth() - months);
  const start = addDays(isoDate(startD), 3);

  const sites = await trackedSites(ids);
  const jobs: Job[] = [];
  for (const s of sites) {
    if (s.gsc_site_id) {
      for (let d = start; d <= yesterday; d = addDays(d, 7)) {
        jobs.push({ site_id: s.id, kind: "gsc_days", start_date: d, end_date: minDate(addDays(d, 6), yesterday), priority: 5 });
      }
    }
    if (s.ga4_property_id) {
      for (let d = start; d <= yesterday; d = addDays(d, 31)) {
        jobs.push({ site_id: s.id, kind: "ga4_days", start_date: d, end_date: minDate(addDays(d, 30), yesterday), priority: 5 });
      }
    }
    for (let m = monthStart(start); m <= yesterday; m = addDays(monthEnd(m), 1)) {
      const e = minDate(monthEnd(m), yesterday);
      if (s.gsc_site_id) jobs.push({ site_id: s.id, kind: "gsc_month", start_date: m, end_date: e, priority: 6 });
      if (s.ga4_property_id) jobs.push({ site_id: s.id, kind: "ga4_month", start_date: m, end_date: e, priority: 6 });
    }
    await admin.from("sites").update({ backfill_requested_at: new Date().toISOString() }).eq("id", s.id);
  }
  return { sites: sites.length, queued: await enqueue(jobs) };
}

async function enqueueDaily() {
  const today = isoDate(new Date());
  const y = addDays(today, -1);
  const sites = await trackedSites();
  const jobs: Job[] = [];
  for (const s of sites) {
    if (s.gsc_site_id) {
      jobs.push({ site_id: s.id, kind: "gsc_days", start_date: addDays(today, -5), end_date: y, priority: 1 });
      jobs.push({ site_id: s.id, kind: "gsc_month", start_date: monthStart(y), end_date: y, priority: 2 });
    }
    if (s.ga4_property_id) {
      jobs.push({ site_id: s.id, kind: "ga4_days", start_date: addDays(today, -3), end_date: y, priority: 1 });
      jobs.push({ site_id: s.id, kind: "ga4_month", start_date: monthStart(y), end_date: y, priority: 2 });
    }
    // first days of a month: finalise the previous month
    if (Number(today.slice(8, 10)) <= 4) {
      const pm = monthStart(addDays(monthStart(today), -1));
      if (s.gsc_site_id) jobs.push({ site_id: s.id, kind: "gsc_month", start_date: pm, end_date: monthEnd(pm), priority: 2 });
      if (s.ga4_property_id) jobs.push({ site_id: s.id, kind: "ga4_month", start_date: pm, end_date: monthEnd(pm), priority: 2 });
    }
  }
  await admin.rpc("purge_old_data");
  return { sites: sites.length, queued: await enqueue(jobs) };
}

// Alert when a site's GSC clicks drop > 40 % week over week (with enough volume to matter)
async function seoDropAlerts() {
  const { data } = await admin.rpc("site_overview", { p_days: 7 });
  let n = 0;
  for (const s of (data || []) as any[]) {
    if (!s.tracked) continue;
    const fp = `seo_drop:${s.site_id}`;
    if (s.clicks_prev >= 50 && s.clicks < s.clicks_prev * 0.6) {
      n++;
      await raiseAlert({
        fingerprint: fp, kind: "seo_drop", severity: "warn",
        title: `${s.domain} : clics Google −${Math.round(100 - (100 * s.clicks) / s.clicks_prev)} % (7 j)`,
        details: { clicks: s.clicks, clicks_prev: s.clicks_prev },
      });
    } else {
      await resolveAlert(fp);
    }
  }
  return n;
}

// ───────────── Worker ─────────────
async function work(who: string) {
  const t0 = Date.now();
  let done = 0, failed = 0;
  const errors: string[] = [];
  const ctx = new Map<string, any>();

  while (Date.now() - t0 < TIME_BUDGET_MS) {
    const { data: jobs, error } = await admin.rpc("claim_sync_jobs", { n: 3 });
    if (error) throw new Error(error.message);
    if (!jobs?.length) break;
    for (const job of jobs as any[]) {
      try {
        const site = await siteContext(job.site_id, ctx);
        if (job.kind === "gsc_days") await gscDays(site, job.start_date, job.end_date);
        else if (job.kind === "gsc_month") await gscMonth(site, job.start_date, job.end_date);
        else if (job.kind === "ga4_days") await ga4Days(site, job.start_date, job.end_date);
        else if (job.kind === "ga4_month") await ga4Month(site, job.start_date, job.end_date);
        await admin.from("sync_jobs").update({ status: "done", error: null, updated_at: new Date().toISOString() }).eq("id", job.id);
        await admin.from("sites").update({ last_sync_at: new Date().toISOString(), last_sync_error: null }).eq("id", job.site_id);
        done++;
      } catch (e) {
        failed++;
        const msg = (e as Error).message.slice(0, 500);
        errors.push(`${job.kind} ${job.start_date}: ${msg}`);
        const dead = e instanceof GoogleAuthDead;
        const final = dead || job.attempts >= 3;
        await admin.from("sync_jobs").update({
          status: final ? "error" : "queued", error: msg, updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        await admin.from("sites").update({ last_sync_error: msg }).eq("id", job.site_id);
        if (dead) {
          const site = ctx.get(job.site_id);
          for (const acc of [site?.gscAccount, site?.gaAccount].filter(Boolean)) {
            await raiseAlert({
              fingerprint: `google:${acc}`, kind: "google_auth", severity: "crit",
              title: "Compte Google déconnecté : reconnecte-le dans Connexions",
              details: { error: msg },
            });
          }
        }
      }
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
    }
  }
  return { who, done, failed, errors: errors.slice(0, 5), ms: Date.now() - t0 };
}

async function siteContext(siteId: string, cache: Map<string, any>) {
  if (cache.has(siteId)) return cache.get(siteId);
  const { data: s, error } = await admin.from("sites")
    .select("id, domain, gsc_site_id, ga4_property_id, gsc_sites(site_url, account_id), ga4_properties(property_id, account_id)")
    .eq("id", siteId).single();
  if (error || !s) throw new Error("site not found");
  const ctx = {
    id: s.id,
    domain: s.domain,
    siteUrl: (s as any).gsc_sites?.site_url,
    gscAccount: (s as any).gsc_sites?.account_id,
    propertyId: (s as any).ga4_properties?.property_id,
    gaAccount: (s as any).ga4_properties?.account_id,
  };
  cache.set(siteId, ctx);
  return ctx;
}

// ───── Search Console ─────
async function gscQuery(site: any, body: Record<string, unknown>) {
  if (!site.siteUrl) throw new Error("no Search Console property linked");
  const token = await getAccessToken(site.gscAccount);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.siteUrl)}/searchAnalytics/query`;
  const r = await gapi<{ rows?: { keys: string[]; clicks: number; impressions: number; position: number }[] }>(
    url, token, { dataState: "all", ...body },
  );
  return r.rows || [];
}

async function gscDays(site: any, start: string, end: string) {
  const retention = Number(await getSetting("gsc_daily_retention_days", 90));
  const topN = Number(await getSetting("gsc_daily_top_n", 250));
  const cutoff = addDays(isoDate(new Date()), -retention);

  const totals = await gscQuery(site, { startDate: start, endDate: end, dimensions: ["date"], rowLimit: 1000 });
  await upsertChunks("gsc_daily", totals.map((r) => ({
    site_id: site.id, date: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position,
  })), "site_id,date");

  for (const dim of ["country", "device"]) {
    const rows = await gscQuery(site, { startDate: start, endDate: end, dimensions: ["date", dim], rowLimit: 25000 });
    const perDay = new Map<string, any[]>();
    for (const r of rows) {
      const arr = perDay.get(r.keys[0]) || [];
      arr.push(r);
      perDay.set(r.keys[0], arr);
    }
    const keep: Record<string, unknown>[] = [];
    for (const [date, arr] of perDay) {
      arr.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      for (const r of arr.slice(0, 20)) {
        keep.push({ site_id: site.id, date, dim, value: r.keys[1], clicks: r.clicks, impressions: r.impressions, position: r.position });
      }
    }
    await upsertChunks("gsc_dim_daily", keep, "site_id,date,dim,value");
  }

  // Query / page detail per day, only inside the retention window
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (d < cutoff) continue;
    for (const [dim, table, col] of [["query", "gsc_query_daily", "query"], ["page", "gsc_page_daily", "page"]] as const) {
      const rows = await gscQuery(site, { startDate: d, endDate: d, dimensions: [dim], rowLimit: topN });
      await upsertChunks(table, rows.map((r) => ({
        site_id: site.id, date: d, [col]: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position,
      })), `site_id,date,${col}`);
    }
  }
}

async function gscMonth(site: any, start: string, end: string) {
  const topN = Number(await getSetting("monthly_top_n", 1000));
  for (const [dim, table, col] of [["query", "gsc_query_monthly", "query"], ["page", "gsc_page_monthly", "page"]] as const) {
    const rows = await gscQuery(site, { startDate: start, endDate: end, dimensions: [dim], rowLimit: topN });
    await admin.from(table).delete().eq("site_id", site.id).eq("month", start);
    await upsertChunks(table, rows.map((r) => ({
      site_id: site.id, month: start, [col]: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position,
    })), `site_id,month,${col}`);
  }
}

// ───── GA4 ─────
async function ga4Report(site: any, body: Record<string, unknown>) {
  if (!site.propertyId) throw new Error("no GA4 property linked");
  const token = await getAccessToken(site.gaAccount);
  const r = await gapi<any>(
    `https://analyticsdata.googleapis.com/v1beta/properties/${site.propertyId}:runReport`, token, body,
  );
  return (r.rows || []) as { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
}
const gaDate = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
const num = (v: string) => Math.round(Number(v) || 0);

async function ga4Days(site: any, start: string, end: string) {
  const topN = Number(await getSetting("ga4_source_top_n", 50));
  const daily = await ga4Report(site, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "date" }],
    metrics: ["sessions", "totalUsers", "newUsers", "screenPageViews", "engagedSessions", "averageSessionDuration"]
      .map((name) => ({ name })),
    limit: 1000,
  });
  await upsertChunks("ga4_daily", daily.map((r) => ({
    site_id: site.id, date: gaDate(r.dimensionValues[0].value),
    sessions: num(r.metricValues[0].value), users: num(r.metricValues[1].value),
    new_users: num(r.metricValues[2].value), views: num(r.metricValues[3].value),
    engaged_sessions: num(r.metricValues[4].value), avg_session_duration: Number(r.metricValues[5].value) || 0,
  })), "site_id,date");

  const src = await ga4Report(site, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }],
    metrics: [{ name: "sessions" }, { name: "totalUsers" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 100000,
  });
  const perDay = new Map<string, number>();
  const keep: Record<string, unknown>[] = [];
  for (const r of src) {
    const date = gaDate(r.dimensionValues[0].value);
    const c = perDay.get(date) || 0;
    if (c >= topN) continue;
    perDay.set(date, c + 1);
    keep.push({
      site_id: site.id, date, source: r.dimensionValues[1].value || "(not set)",
      medium: r.dimensionValues[2].value || "(not set)",
      sessions: num(r.metricValues[0].value), users: num(r.metricValues[1].value),
    });
  }
  await upsertChunks("ga4_source_daily", keep, "site_id,date,source,medium");
}

async function ga4Month(site: any, start: string, end: string) {
  const topN = Number(await getSetting("monthly_top_n", 1000));
  const rows = await ga4Report(site, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "screenPageViews" }, { name: "sessions" }],
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit: topN,
  });
  await admin.from("ga4_page_monthly").delete().eq("site_id", site.id).eq("month", start);
  await upsertChunks("ga4_page_monthly", rows.map((r) => ({
    site_id: site.id, month: start, page: r.dimensionValues[0].value,
    views: num(r.metricValues[0].value), sessions: num(r.metricValues[1].value),
  })), "site_id,month,page");
}
