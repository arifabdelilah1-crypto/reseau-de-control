// Outils en lecture seule partagés par le connecteur MCP (control-mcp) et l'agent du dashboard (agent).
// Ils lisent Supabase avec la clé service (aucune écriture).
import { admin } from "./common.ts";

type Args = Record<string, any>;
export type Tool = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (a: Args) => Promise<unknown>;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400_000));
const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
};
const r1 = (x: unknown) => (x == null ? null : Math.round(Number(x) * 10) / 10);
const pct = (x: unknown) => (x == null ? null : Math.round(Number(x) * 1000) / 10);

async function rpc(fn: string, args: Args = {}) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data || []) as any[];
}
async function pipeline() {
  const { data } = await admin.from("pipeline_state").select("data, taken_at, ok, error").eq("id", 1).maybeSingle();
  return data;
}

// « foodzauber », « foodzauber.blog », « airfryer » → { site_id, domain, slug }
type SiteRef = { site_id: string | null; domain: string | null; slug: string | null };
async function resolveSite(input?: unknown): Promise<SiteRef | null> {
  const q = String(input || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!q || q === "all" || q === "tous") return null;
  const { data: sites } = await admin.from("sites").select("id, domain").eq("tracked", true);
  const p = await pipeline();
  const slugs = Object.keys(p?.data?.accounts || {}).concat((p?.data?.articles?.bySite || []).map((s: any) => s.site));
  const hit = (sites || []).find((s) => s.domain === q) || (sites || []).find((s) => s.domain.startsWith(q))
    || (sites || []).find((s) => s.domain.includes(q));
  const domain = hit?.domain || null;
  const slug = slugs.find((s) => s === q) || (domain ? slugs.find((s) => s && domain.startsWith(s)) : null) || (slugs.includes(q) ? q : null);
  if (!hit && !slug) throw new Error(`Site inconnu : « ${input} ». Utilise list_sites.`);
  return { site_id: hit?.id || null, domain, slug: slug || null };
}

const SITE = { type: "string", description: "Site : slug (foodzauber), domaine (foodzauber.blog) ou vide pour tous les sites suivis" };
const DAYS = (def: number, max = 480) => ({ type: "integer", description: `Nombre de jours (défaut ${def}, max ${max})` });

export const TOOLS: Tool[] = [
  {
    name: "list_sites",
    description: "Liste les sites suivis (domaine, slug du Sheet, compte Blotato, liaisons GSC/GA4, dernière synchro SEO).",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const { data } = await admin.from("sites").select("domain, tracked, gsc_site_id, ga4_property_id, last_sync_at, last_sync_error").order("domain");
      const p = await pipeline();
      const acc = (p?.data?.accounts || {}) as Record<string, string>;
      return (data || []).map((s) => {
        const slug = Object.keys(acc).find((k) => s.domain.startsWith(k)) || null;
        return { domain: s.domain, slug, tracked: s.tracked, gsc: !!s.gsc_site_id, ga4: !!s.ga4_property_id,
          blotato_account: slug ? acc[slug] : null, last_seo_sync: s.last_sync_at, seo_error: s.last_sync_error };
      });
    },
  },
  {
    name: "system_overview",
    description: "Vue d'ensemble : trafic Google/GA4/Pinterest par site (période vs précédente), alertes ouvertes, workflows n8n en échec, pipeline (articles, images, pins, coûts), Blotato, indexation.",
    input_schema: { type: "object", properties: { days: DAYS(28, 90) } },
    run: async (a) => {
      const days = clampInt(a.days, 28, 1, 90);
      const [sites, alerts, wfs, p, idx, blo] = await Promise.all([
        rpc("site_overview", { p_days: days }),
        admin.from("alerts").select("severity, title, created_at").is("resolved_at", null).order("created_at", { ascending: false }).then((r) => r.data || []),
        rpc("workflow_health"),
        pipeline(),
        rpc("index_summary").catch(() => []),
        rpc("blotato_site_stats", { p_days: days }).catch(() => []),
      ]);
      const d = p?.data;
      return {
        period_days: days,
        traffic: sites.filter((s) => s.tracked).map((s) => ({
          domain: s.domain, clicks: s.clicks, clicks_prev: s.clicks_prev, impressions: s.impressions,
          position: r1(s.avg_position), sessions: s.sessions, sessions_prev: s.sessions_prev,
          pinterest_sessions: s.pinterest_sessions, pinterest_sessions_prev: s.pinterest_sessions_prev,
        })),
        open_alerts: alerts.slice(0, 15),
        failing_workflows: wfs.filter((w) => w.watch && w.active && ["error", "crashed"].includes(w.last_status))
          .map((w) => ({ name: w.name, errors_24h: w.errors_24h, last_started: w.last_started })),
        pipeline: d ? {
          read_at: p.taken_at, articles_published: d.articles?.published, articles_total: d.articles?.total,
          articles_failed: d.articles?.failed, images: d.images?.images, pins_by_status: d.pins?.byStatus,
          cost_total_mad: d.cost?.total, cost_month_mad: d.cost?.month, cost_per_published_mad: d.cost?.perPublished,
        } : null,
        indexation: idx.map((s) => ({ domain: s.domain, total: s.total, indexed: s.indexed, pending: s.pending,
          not_indexed: Number(s.total) - Number(s.indexed) - Number(s.pending) })),
        blotato: blo.map((s) => ({ site: s.site, published: s.published, failed: s.failed, scheduled_next7: s.scheduled_next7,
          impressions: s.impressions, clicks: s.clicks, saves: s.saves })),
      };
    },
  },
  {
    name: "seo_timeseries",
    description: "Série quotidienne Search Console + GA4 (clics, impressions, position, sessions, sessions Pinterest) et totaux vs période précédente.",
    input_schema: { type: "object", properties: { site: SITE, days: DAYS(28) } },
    run: async (a) => {
      const s = await resolveSite(a.site);
      const days = clampInt(a.days, 28, 1, 480);
      const cur = await rpc("site_series", { p_site: s?.site_id ?? null, p_from: daysAgo(days), p_to: daysAgo(1) });
      const prev = await rpc("site_series", { p_site: s?.site_id ?? null, p_from: daysAgo(2 * days), p_to: daysAgo(days + 1) });
      const sum = (arr: any[], k: string) => arr.reduce((x, r) => x + Number(r[k] || 0), 0);
      const tot = (arr: any[]) => ({ clicks: sum(arr, "clicks"), impressions: sum(arr, "impressions"),
        sessions: sum(arr, "sessions"), pinterest_sessions: sum(arr, "pinterest_sessions") });
      return { site: s?.domain || "tous", days, totals: tot(cur), previous: tot(prev),
        daily: days <= 90 ? cur.map((r) => ({ d: r.date, c: r.clicks, i: r.impressions, p: r1(r.avg_position), s: r.sessions, pin: r.pinterest_sessions })) : "trop long : demande ≤ 90 jours pour le détail" };
    },
  },
  {
    name: "seo_top",
    description: "Top requêtes ou top pages Google (clics, impressions, CTR %, position).",
    input_schema: { type: "object", properties: { site: SITE, kind: { type: "string", enum: ["queries", "pages"] }, days: DAYS(28), limit: { type: "integer", description: "max 100" }, contains: { type: "string", description: "filtre texte optionnel" } }, required: ["kind"] },
    run: async (a) => {
      const s = await resolveSite(a.site);
      const days = clampInt(a.days, 28, 1, 480);
      const lim = clampInt(a.limit, 20, 1, 100);
      const fn = a.kind === "pages" ? "top_pages" : "top_queries";
      let rows = await rpc(fn, { p_site: s?.site_id ?? null, p_from: daysAgo(days), p_to: daysAgo(1), p_limit: a.contains ? 1000 : lim });
      if (a.contains) rows = rows.filter((r) => String(r.query || r.page).toLowerCase().includes(String(a.contains).toLowerCase())).slice(0, lim);
      return rows.map((r) => ({ [a.kind === "pages" ? "page" : "query"]: r.query || r.page, clicks: r.clicks, impressions: r.impressions,
        ctr_pct: pct(r.ctr), position: r1(r.avg_position), granularity: r.granularity }));
    },
  },
  {
    name: "seo_movers",
    description: "Requêtes gagnantes et perdantes en clics (période vs précédente, max 45 jours).",
    input_schema: { type: "object", properties: { site: SITE, days: DAYS(28, 45) } },
    run: async (a) => {
      const s = await resolveSite(a.site);
      return rpc("query_movers", { p_site: s?.site_id ?? null, p_days: clampInt(a.days, 28, 1, 45), p_limit: 10 });
    },
  },
  {
    name: "seo_breakdown",
    description: "Répartition : pays ou appareils (Search Console), ou sources de trafic (GA4).",
    input_schema: { type: "object", properties: { site: SITE, dim: { type: "string", enum: ["country", "device", "sources"] }, days: DAYS(28) }, required: ["dim"] },
    run: async (a) => {
      const s = await resolveSite(a.site);
      const days = clampInt(a.days, 28, 1, 480);
      if (a.dim === "sources") return rpc("ga4_sources", { p_site: s?.site_id ?? null, p_from: daysAgo(days), p_to: daysAgo(1), p_limit: 15 });
      return rpc("gsc_dims", { p_site: s?.site_id ?? null, p_from: daysAgo(days), p_to: daysAgo(1), p_dim: a.dim, p_limit: 15 });
    },
  },
  {
    name: "index_status",
    description: "Indexation Google des articles publiés : par site (indexés, en attente d'inspection, explorés non indexés, découverts non indexés…), ou liste d'URLs d'un état.",
    input_schema: { type: "object", properties: { site: SITE,
      bucket: { type: "string", enum: ["summary", "not_indexed", "crawled_not_indexed", "discovered_not_indexed", "unknown", "indexed", "pending"], description: "summary (défaut) ou un état pour lister les URLs" },
      limit: { type: "integer", description: "max 100" } } },
    run: async (a) => {
      const s = await resolveSite(a.site);
      if (!a.bucket || a.bucket === "summary") {
        const rows = await rpc("index_summary");
        return rows.filter((r) => !s?.site_id || r.site_id === s.site_id).map(({ site_id: _x, ...r }) => r);
      }
      const rows = await rpc("index_list", { p_site: s?.site_id ?? null, p_bucket: a.bucket, p_limit: clampInt(a.limit, 30, 1, 100) });
      return rows.map((r) => ({ url: r.url, keyword: r.keyword, state: r.coverage_state || r.bucket, first_seen: r.first_seen_at,
        last_crawl: r.last_crawl_at, last_inspected: r.last_inspected_at, gsc_link: r.inspection_link }));
    },
  },
  {
    name: "n8n_workflows",
    description: "Santé des workflows n8n : dernier statut, dernier succès, échecs 24 h / 7 j, durée moyenne, en cours.",
    input_schema: { type: "object", properties: { only_problems: { type: "boolean" } } },
    run: async (a) => {
      const rows = await rpc("workflow_health");
      return rows.filter((w) => !a.only_problems || (w.watch && w.active && (["error", "crashed"].includes(w.last_status) || Number(w.errors_24h) > 0 || Number(w.running_now) > 0)))
        .map((w) => ({ name: w.name, active: w.active, watched: w.watch, last_status: w.last_status, last_started: w.last_started,
          last_success: w.last_success, runs_24h: w.runs_24h, errors_24h: w.errors_24h, errors_7d: w.errors_7d,
          avg_duration_s: r1(w.avg_duration_s), running_now: w.running_now, expected_every_min: w.expected_every_min }));
    },
  },
  {
    name: "n8n_executions",
    description: "Dernières exécutions n8n, filtrables par nom de workflow (contient) et statut.",
    input_schema: { type: "object", properties: { workflow: { type: "string" }, status: { type: "string", enum: ["success", "error", "crashed", "running", "waiting"] }, limit: { type: "integer", description: "max 50" } } },
    run: async (a) => {
      const { data: wfs } = await admin.from("n8n_workflows").select("id, name");
      const names = new Map((wfs || []).map((w) => [w.id, w.name]));
      let q = admin.from("n8n_executions").select("id, workflow_id, status, mode, started_at, stopped_at").order("started_at", { ascending: false }).limit(clampInt(a.limit, 20, 1, 50));
      if (a.status) q = q.eq("status", a.status);
      if (a.workflow) {
        const ids = (wfs || []).filter((w) => w.name.toLowerCase().includes(String(a.workflow).toLowerCase())).map((w) => w.id);
        q = q.in("workflow_id", ids.length ? ids : ["-"]);
      }
      const { data } = await q;
      return (data || []).map((e) => ({ workflow: names.get(e.workflow_id) || e.workflow_id, status: e.status, mode: e.mode, started_at: e.started_at,
        duration_s: e.stopped_at && e.started_at ? Math.round((new Date(e.stopped_at).getTime() - new Date(e.started_at).getTime()) / 1000) : null, execution_id: e.id }));
    },
  },
  {
    name: "alerts",
    description: "Alertes ouvertes (et option : résolues récemment).",
    input_schema: { type: "object", properties: { include_resolved: { type: "boolean" } } },
    run: async (a) => {
      const open = await admin.from("alerts").select("id, kind, severity, title, created_at, last_seen_at").is("resolved_at", null).order("created_at", { ascending: false });
      const out: Record<string, unknown> = { open: open.data || [] };
      if (a.include_resolved) {
        const r = await admin.from("alerts").select("id, kind, severity, title, created_at, resolved_at").not("resolved_at", "is", null).order("resolved_at", { ascending: false }).limit(15);
        out.recently_resolved = r.data || [];
      }
      return out;
    },
  },
  {
    name: "health_checks",
    description: "Services surveillés (pod GPU, renderer, n8n, blogs…) : dernier code HTTP, temps de réponse, état.",
    input_schema: { type: "object", properties: {} },
    run: async () => (await admin.from("health_checks").select("name, url, last_ok, last_status, last_ms, last_checked_at, last_error").order("name")).data || [],
  },
  {
    name: "pipeline_summary",
    description: "Pipeline de contenu (Google Sheet) : articles par statut, images, pins par statut, coûts (MAD), par site ou global.",
    input_schema: { type: "object", properties: { site: SITE } },
    run: async (a) => {
      const p = await pipeline();
      const d = p?.data; if (!d) return { error: "Pipeline jamais lu (Apps Script non configuré ?)" };
      const s = await resolveSite(a.site);
      const pick = (arr: any[]) => s?.slug ? (arr || []).filter((x) => x.site === s.slug) : (arr || []).filter((x) => x.site !== "—");
      return {
        read_at: p.taken_at, read_ok: p.ok, read_error: p.error,
        costs_unit_mad: d.costs,
        articles: s ? pick(d.articles?.bySite) : { total: d.articles?.total, byStatus: d.articles?.byStatus, published: d.articles?.published, failed: d.articles?.failed, bySite: pick(d.articles?.bySite) },
        images: s ? pick(d.images?.bySite) : { total_images: d.images?.images, articlesDone: d.images?.articlesDone, avg_per_article: d.images?.avg, byStatus: d.images?.byStatus },
        pins: s ? pick(d.pins?.bySite) : { byStatus: d.pins?.byStatus, covered: d.pins?.covered, noPins: d.pins?.noPins, duplicates_same_day: d.pins?.dupCount, bySite: pick(d.pins?.bySite) },
        cost: s ? pick(d.cost?.bySite) : { total: d.cost?.total, month: d.cost?.month, perPublished: d.cost?.perPublished, bySite: d.cost?.bySite },
      };
    },
  },
  {
    name: "pipeline_failures",
    description: "Échecs du pipeline : articles (WF1), images (WF2), pins (WF3), doublons même jour.",
    input_schema: { type: "object", properties: { kind: { type: "string", enum: ["articles", "images", "pins", "duplicates"] }, site: SITE, limit: { type: "integer", description: "max 100" } }, required: ["kind"] },
    run: async (a) => {
      const p = await pipeline(); const d = p?.data; if (!d) return [];
      const s = await resolveSite(a.site);
      const list = a.kind === "articles" ? d.articles?.failedList : a.kind === "images" ? d.images?.failedList : a.kind === "pins" ? d.pins?.errors : d.pins?.dupes;
      return (list || []).filter((x: any) => !s?.slug || x.site === s.slug).slice(0, clampInt(a.limit, 30, 1, 100));
    },
  },
  {
    name: "pins_calendar",
    description: "Planning des pins par site et par jour : ce que prévoit le Sheet vs ce qui est réellement programmé chez Blotato (14 prochains jours), plus publiés et échecs des 14 derniers jours.",
    input_schema: { type: "object", properties: { site: SITE } },
    run: async (a) => {
      const s = await resolveSite(a.site);
      const [rec, cal] = await Promise.all([rpc("blotato_reconcile", { p_next: 14 }), rpc("blotato_calendar", { p_past: 14, p_next: 0 })]);
      const f = (r: any) => !s?.slug || r.site === s.slug;
      return {
        next_14_days_sheet_vs_blotato: rec.filter(f).map((r) => ({ site: r.site, day: r.day, sheet: r.sheet, blotato: r.blotato })),
        past_14_days: cal.filter(f).filter((r) => r.published || r.failed).map((r) => ({ site: r.site, day: r.day, published: r.published, failed: r.failed })),
      };
    },
  },
  {
    name: "blotato_scheduled",
    description: "Posts Pinterest programmés chez Blotato (id de schedule, date, site, titre, lien article). Sert aussi à trouver un schedule_id avant de proposer une reprogrammation ou une annulation.",
    input_schema: { type: "object", properties: { site: SITE, from: { type: "string", description: "ISO date de début (défaut maintenant)" }, to: { type: "string", description: "ISO date de fin" }, contains: { type: "string", description: "filtre sur titre/lien" }, limit: { type: "integer", description: "max 100" } } },
    run: async (a) => {
      const s = await resolveSite(a.site);
      let q = admin.from("blotato_schedules").select("id, site, account_id, scheduled_at, title, link, article_id").order("scheduled_at").limit(clampInt(a.limit, 30, 1, 100));
      q = q.gte("scheduled_at", a.from || new Date().toISOString());
      if (a.to) q = q.lte("scheduled_at", a.to);
      if (s?.slug) q = q.eq("site", s.slug);
      if (a.contains) q = q.or(`title.ilike.%${String(a.contains).replace(/[,%()]/g, " ")}%,link.ilike.%${String(a.contains).replace(/[,%()]/g, " ")}%`);
      return (await q).data || [];
    },
  },
  {
    name: "blotato_stats",
    description: "Stats Pinterest via Blotato par compte (publiés, échecs, programmés 7 j, impressions, enregistrements, clics sur l'épingle, clics, CTR), top pins, ou stats par article.",
    input_schema: { type: "object", properties: { view: { type: "string", enum: ["by_account", "top_pins", "by_article"] }, site: SITE, days: DAYS(30, 365),
      order: { type: "string", enum: ["impressions", "clicks", "saves", "pin_clicks"] }, limit: { type: "integer", description: "max 100" } } },
    run: async (a) => {
      const s = await resolveSite(a.site);
      const days = clampInt(a.days, 30, 1, 365);
      if (a.view === "top_pins") return rpc("blotato_top_pins", { p_site: s?.slug ?? null, p_days: days, p_order: a.order || "impressions", p_limit: clampInt(a.limit, 20, 1, 100) });
      if (a.view === "by_article") return rpc("blotato_article_stats", { p_site: s?.slug ?? null, p_limit: clampInt(a.limit, 30, 1, 100) });
      const rows = await rpc("blotato_site_stats", { p_days: days });
      return rows.filter((r) => !s?.slug || r.site === s.slug).map((r) => ({ ...r, ctr_pct: pct(r.ctr) }));
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export async function runTool(name: string, args: Args) {
  const t = TOOL_MAP.get(name);
  if (!t) throw new Error(`Outil inconnu : ${name}`);
  return await t.run(args || {});
}

// Résultat compact (limite la taille renvoyée au modèle)
export function compact(x: unknown, max = 14000): string {
  let s = JSON.stringify(x);
  if (s.length > max) s = s.slice(0, max) + `… [tronqué, ${s.length} caractères au total : réduis la période ou le limit]`;
  return s;
}
