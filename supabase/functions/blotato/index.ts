// blotato — synchro Blotato (Pinterest) + reprogrammer / annuler un post programmé.
//   POST {action:"sync"}                                   (cron 15 min / user)
//   POST {action:"status"}                                 (user)
//   POST {action:"reschedule", schedule_id, scheduled_at}  (user) PATCH /v2/schedules/{id}
//   POST {action:"cancel", schedule_id}                    (user) DELETE /v2/schedules/{id}
// Secret : BLOTATO_API_KEY. Limite Blotato ≈ 60 lectures / min → appels espacés de 1,1 s.
import {
  admin, serve, json, requireUser, requireUserOrCron, HttpError, cleanSecret, raiseAlert, resolveAlert,
} from "../_shared/common.ts";

const KEY = cleanSecret(Deno.env.get("BLOTATO_API_KEY"));
const BASE = "https://backend.blotato.com/v2";
const TIME_BUDGET_MS = 115_000;
let lastCall = 0;

async function blot<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!KEY) throw new HttpError(400, "Secret BLOTATO_API_KEY manquant dans Supabase.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(BASE + path, {
      method: init.method || "GET",
      headers: { "blotato-api-key": KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 4000 * (attempt + 1))); continue; }
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text.slice(0, 200) }; }
    if (!res.ok) {
      const msg = data?.message || data?.error?.message || data?.error || text.slice(0, 200);
      if (res.status === 401) throw new HttpError(400, "Blotato refuse la clé API (401) : vérifie BLOTATO_API_KEY.");
      throw new Error(`Blotato ${init.method || "GET"} ${path.split("?")[0]} → ${res.status} ${msg}`);
    }
    return data as T;
  }
  throw new Error(`Blotato ${path.split("?")[0]} : trop de requêtes, réessaie plus tard`);
}

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? Math.round(x) : null; };
const linkKey = (u?: string | null) =>
  (u || "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "") || null;

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const action = body.action || "sync";

  if (action === "status") {
    await requireUser(req);
    const { data: last } = await admin.from("blotato_accounts").select("synced_at").order("synced_at", { ascending: false }).limit(1).maybeSingle();
    return json({ configured: !!KEY, last_sync: last?.synced_at || null });
  }
  if (action === "sync") {
    await requireUserOrCron(req);
    return json(await sync());
  }
  if (action === "reschedule" || action === "cancel") {
    const user = await requireUser(req);
    const id = String(body.schedule_id || "");
    if (!id) throw new HttpError(400, "schedule_id manquant");
    const { data: row } = await admin.from("blotato_schedules").select("*").eq("id", id).maybeSingle();
    if (!row) throw new HttpError(404, "Post programmé introuvable (déjà publié ou annulé ?). Relance une synchro.");
    if (action === "cancel") {
      try {
        await blot(`/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
        await admin.from("blotato_schedules").delete().eq("id", id);
        await log("cancel", id, { by: user.email, site: row.site, scheduled_at: row.scheduled_at }, true, {});
        return json({ ok: true, message: "Post annulé chez Blotato" });
      } catch (e) {
        await log("cancel", id, { by: user.email }, false, { error: (e as Error).message });
        throw e;
      }
    }
    const when = new Date(String(body.scheduled_at || ""));
    if (isNaN(when.getTime())) throw new HttpError(400, "Date invalide");
    if (when.getTime() < Date.now() + 2 * 60_000) throw new HttpError(400, "La nouvelle date doit être dans le futur (au moins +2 min).");
    try {
      const r = await blot(`/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: { patch: { scheduledTime: when.toISOString() } } });
      await admin.from("blotato_schedules").update({ scheduled_at: when.toISOString(), synced_at: new Date().toISOString() }).eq("id", id);
      await log("reschedule", id, { by: user.email, from: row.scheduled_at, to: when.toISOString() }, true, r || {});
      return json({ ok: true, message: `Reprogrammé au ${when.toLocaleString("fr-FR", { timeZone: "Africa/Casablanca" })}` });
    } catch (e) {
      await log("reschedule", id, { by: user.email, to: when.toISOString() }, false, { error: (e as Error).message });
      throw e;
    }
  }
  throw new HttpError(400, "Unknown action");
});

async function log(action: string, schedule_id: string, params: unknown, ok: boolean, result: unknown) {
  await admin.from("blotato_actions").insert({ action, schedule_id, params, ok, result });
}

async function siteMap(): Promise<Map<string, string>> {
  const { data } = await admin.from("pipeline_state").select("data").eq("id", 1).maybeSingle();
  const acc = (data?.data?.accounts || {}) as Record<string, string>;
  const m = new Map<string, string>();
  for (const [site, id] of Object.entries(acc)) if (id) m.set(String(id), site);
  return m;
}

async function sync() {
  const t0 = Date.now();
  const left = () => TIME_BUDGET_MS - (Date.now() - t0);
  const out: Record<string, unknown> = {};
  try {
    const sites = await siteMap();

    // 1. Comptes Pinterest
    const acc = await blot<{ items: any[] }>("/users/me/accounts?platform=pinterest");
    const accRows = (acc.items || []).map((a) => ({
      id: String(a.id), fullname: a.fullname, username: a.username, platform: a.platform,
      site: sites.get(String(a.id)) || null, synced_at: new Date().toISOString(),
    }));
    if (accRows.length) await admin.from("blotato_accounts").upsert(accRows, { onConflict: "id" });
    out.accounts = accRows.length;
    const siteOf = (id: string) => sites.get(String(id)) || null;

    // 2. Programmés (futur) — liste complète, puis on retire ce qui a disparu (publié ou annulé)
    const syncStart = new Date().toISOString();
    let cursor = "", pages = 0, schedCount = 0, complete = false;
    while (left() > 30_000 && pages < 40) {
      const r = await blot<any>(`/schedules?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const rows = (r.items || []).filter((s: any) => s?.draft?.target?.targetType === "pinterest").map((s: any) => ({
        id: String(s.id), account_id: String(s.draft?.accountId || s.account?.id || ""), site: siteOf(s.draft?.accountId || s.account?.id),
        scheduled_at: s.scheduledAt, link: s.draft?.target?.link || null, link_key: linkKey(s.draft?.target?.link),
        board_id: s.draft?.target?.boardId || null, title: s.draft?.target?.title || null,
        text: (s.draft?.content?.text || "").slice(0, 600), media_url: (s.draft?.content?.mediaUrls || [])[0] || null,
        synced_at: syncStart,
      }));
      if (rows.length) await admin.from("blotato_schedules").upsert(rows, { onConflict: "id" });
      schedCount += rows.length; pages++;
      cursor = r.cursor || "";
      if (!cursor || !(r.items || []).length) { complete = true; break; }
    }
    if (complete) await admin.from("blotato_schedules").delete().lt("synced_at", syncStart);
    out.scheduled = schedCount; out.schedules_complete = complete;

    // 3. Échecs des 14 derniers jours
    if (left() > 20_000) {
      const since = new Date(Date.now() - 14 * 86400_000).toISOString();
      const until = new Date().toISOString();
      let c = "", fp = 0, failed = 0;
      do {
        const r = await blot<any>(`/posts?status=failed&platform=pinterest&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=100${c ? `&cursor=${encodeURIComponent(c)}` : ""}`);
        const rows = (r.items || []).map((p: any) => ({
          id: String(p.id), account_id: String(p.account?.id || ""), site: siteOf(p.account?.id),
          post_time: p.postTime || null, error: p.state?.errorMessage || null, text: (p.text || "").slice(0, 400),
          synced_at: new Date().toISOString(),
        }));
        if (rows.length) await admin.from("blotato_failed").upsert(rows, { onConflict: "id" });
        failed += rows.length; c = r.cursor || ""; fp++;
      } while (c && fp < 5 && left() > 20_000);
      out.failed = failed;
    }

    // 4. Publiés + stats, compte par compte (rotation : les moins récemment scannés d'abord)
    const { data: accs } = await admin.from("blotato_accounts").select("id, site, last_published_scan_at")
      .eq("platform", "pinterest").order("last_published_scan_at", { ascending: true, nullsFirst: true });
    let pubSeen = 0, scanned = 0;
    for (const a of accs || []) {
      if (left() < 35_000 || scanned >= 4) break;
      const first = !a.last_published_scan_at;
      const maxPages = first ? 5 : 2;
      for (let off = 0, pg = 0; pg < maxPages && left() > 30_000; pg++, off += 100) {
        const r = await blot<any>(`/published-posts?platform=pinterest&accountId=${encodeURIComponent(a.id)}&sortBy=newest&limit=100&offset=${off}`);
        const items = r.items || [];
        const now = new Date().toISOString();
        const rows = items.map((p: any) => {
          const m = p.latestMetrics?.metrics || null;
          return {
            id: String(p.id), account_id: String(a.id), site: a.site || siteOf(a.id),
            post_url: p.postUrl || null, created_at: p.createdAt || null, content: (p.content || "").slice(0, 600),
            media_url: (p.mediaUrls || [])[0] || null,
            impressions: m ? n(m.impressionsCount) : null, saves: m ? n(m.savesCount) : null,
            pin_clicks: m ? n(m.pinterestPinClicksCount) : null, clicks: m ? n(m.clicksCount) : null,
            navigations: m ? n(m.navigationsCount) : null, metrics: m, metrics_at: m ? now : null, synced_at: now,
          };
        });
        if (rows.length) await admin.from("blotato_published").upsert(rows, { onConflict: "id" });
        pubSeen += rows.length;
        if (items.length < 100) break;
      }
      await admin.from("blotato_accounts").update({ last_published_scan_at: new Date().toISOString() }).eq("id", a.id);
      scanned++;
    }
    out.published_seen = pubSeen; out.accounts_scanned = scanned;

    // 5. Détail des publiés (lien de l'article, board) : une fois par post
    let details = 0;
    if (left() > 8_000) {
      const { data: todo } = await admin.from("blotato_published").select("id").is("detail_at", null)
        .order("created_at", { ascending: false }).limit(40);
      for (const t of todo || []) {
        if (left() < 6_000) break;
        try {
          const r = await blot<any>(`/published-posts/${encodeURIComponent(t.id)}`);
          const tg = r.publishedPost?.rawPost?.target || {};
          await admin.from("blotato_published").update({
            link: tg.link || null, link_key: linkKey(tg.link), board_id: tg.boardId || null, title: tg.title || null,
            detail_at: new Date().toISOString(),
          }).eq("id", t.id);
          details++;
        } catch (e) {
          await admin.from("blotato_published").update({ detail_at: new Date().toISOString() }).eq("id", t.id);
          console.error("detail", t.id, (e as Error).message);
        }
      }
    }
    out.details = details;

    await admin.rpc("blotato_link_articles");
    await resolveAlert("blotato_api");
    out.alerts = await alerts();
    out.ms = Date.now() - t0;
    return { ok: true, ...out };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await raiseAlert({ fingerprint: "blotato_api", kind: "blotato_api", severity: "crit", title: "Blotato : synchro en échec", details: { error: msg } });
    return { ok: false, error: msg, ...out };
  }
}

async function alerts() {
  let open = 0;
  const since24 = new Date(Date.now() - 86400_000).toISOString();
  const in24 = new Date(Date.now() + 86400_000).toISOString();
  const { data: accs } = await admin.from("blotato_accounts").select("id, site, fullname").eq("platform", "pinterest");
  for (const a of accs || []) {
    const name = a.site || a.fullname || a.id;
    const { count: failed } = await admin.from("blotato_failed").select("id", { count: "exact", head: true })
      .eq("account_id", a.id).gte("post_time", since24);
    const fpF = `blotato_failed:${a.id}`;
    if ((failed || 0) > 0) {
      open++;
      await raiseAlert({ fingerprint: fpF, kind: "blotato_failed", severity: "warn",
        title: `${name} : ${failed} pin(s) en échec chez Blotato (24 h)`, details: { account_id: a.id } });
    } else await resolveAlert(fpF);

    const { count: recent } = await admin.from("blotato_published").select("id", { count: "exact", head: true })
      .eq("account_id", a.id).gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString());
    const { count: next } = await admin.from("blotato_schedules").select("id", { count: "exact", head: true })
      .eq("account_id", a.id).lte("scheduled_at", in24);
    const fpG = `blotato_gap:${a.id}`;
    if ((recent || 0) > 0 && (next || 0) === 0) {
      open++;
      await raiseAlert({ fingerprint: fpG, kind: "blotato_gap", severity: "warn",
        title: `${name} : rien de programmé chez Blotato pour les prochaines 24 h`, details: { account_id: a.id } });
    } else await resolveAlert(fpG);
  }
  return open;
}
