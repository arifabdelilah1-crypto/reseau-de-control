// ops-sync — n8n executions + health checks + alerts + Telegram.
//   POST {action:"run"}          (cron every 5 min / user)  sync n8n, ping health checks, evaluate alerts, notify
//   POST {action:"status"}       (user)  which integrations are configured
//   POST {action:"test_alert"}   (user)  send a Telegram test message
import {
  admin, serve, json, requireUser, requireUserOrCron, HttpError, getSetting, upsertChunks,
  raiseAlert, resolveAlert, telegram, telegramConfigured, esc,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
} from "../_shared/common.ts";

const N8N_URL = (Deno.env.get("N8N_BASE_URL") || "").replace(/\/+$/, "");
const N8N_KEY = Deno.env.get("N8N_API_KEY") || "";
const n8nConfigured = !!(N8N_URL && N8N_KEY);

serve(async (req) => {
  const body = await req.clone().json().catch(() => ({}));
  const action = body.action || "run";

  if (action === "status") {
    await requireUser(req);
    return json({
      google: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      google_redirect_uri: GOOGLE_REDIRECT_URI,
      n8n: n8nConfigured,
      n8n_url: N8N_URL || null,
      telegram: telegramConfigured,
    });
  }
  if (action === "test_alert") {
    await requireUser(req);
    if (!telegramConfigured) throw new HttpError(400, "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID non configurés.");
    const ok = await telegram("✅ <b>Réseau DE · Control</b>\nTest d'alerte OK.");
    return json({ ok });
  }
  if (action === "run") {
    const who = await requireUserOrCron(req);
    const out: Record<string, unknown> = { who };
    if (n8nConfigured) {
      try { out.n8n = await syncN8n(); } catch (e) {
        out.n8n_error = (e as Error).message;
        await raiseAlert({ fingerprint: "n8n_api", kind: "n8n_api", severity: "crit",
          title: "API n8n injoignable", details: { error: out.n8n_error } });
      }
    }
    out.health = await runHealthChecks();
    out.alerts = await evaluateWorkflowAlerts();
    out.notified = await notifyPending();
    return json(out);
  }
  throw new HttpError(400, "Unknown action");
});

// ───────────── n8n ─────────────
async function n8n<T = any>(path: string): Promise<T> {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    headers: { "X-N8N-API-KEY": N8N_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`n8n ${path.split("?")[0]} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return await res.json() as T;
}

async function syncN8n() {
  // Workflows
  const wfRows: Record<string, unknown>[] = [];
  let cursor = "";
  do {
    const r = await n8n<any>(`/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const w of r.data || []) {
      wfRows.push({
        id: w.id, name: w.name, active: !!w.active,
        tags: (w.tags || []).map((t: any) => t.name), updated_at: w.updatedAt, synced_at: new Date().toISOString(),
      });
    }
    cursor = r.nextCursor || "";
  } while (cursor);
  // upsert without touching watch / expected_every_min
  await upsertChunks("n8n_workflows", wfRows, "id");
  await resolveAlert("n8n_api");

  // Executions: page back until we pass the last synced start (minus 3 h), max 7 days on first run
  const { data: last } = await admin.from("n8n_executions").select("started_at")
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  const floor = last?.started_at
    ? new Date(new Date(last.started_at).getTime() - 3 * 3600_000)
    : new Date(Date.now() - 7 * 86400_000);

  const exRows: Record<string, unknown>[] = [];
  cursor = "";
  let pages = 0;
  outer: do {
    const r = await n8n<any>(`/executions?limit=250&includeData=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const e of r.data || []) {
      const started = e.startedAt ? new Date(e.startedAt) : null;
      if (started && started < floor) break outer;
      exRows.push(execRow(e));
    }
    cursor = r.nextCursor || "";
    pages++;
  } while (cursor && pages < 20);

  // Re-check executions we still think are running (they may be older than the window)
  const { data: running } = await admin.from("n8n_executions").select("id").in("status", ["running", "waiting", "new"]);
  for (const r of running || []) {
    if (exRows.some((x) => x.id === r.id)) continue;
    try { exRows.push(execRow(await n8n<any>(`/executions/${r.id}?includeData=false`))); }
    catch (_) { await admin.from("n8n_executions").update({ status: "unknown" }).eq("id", r.id); }
  }

  await upsertChunks("n8n_executions", exRows, "id");
  return { workflows: wfRows.length, executions: exRows.length };
}

function execRow(e: any) {
  const status = e.status || (e.finished ? "success" : e.stoppedAt ? "error" : "running");
  return {
    id: String(e.id), workflow_id: String(e.workflowId), status, mode: e.mode,
    started_at: e.startedAt, stopped_at: e.stoppedAt || null, synced_at: new Date().toISOString(),
  };
}

// ───────────── Health checks ─────────────
async function runHealthChecks() {
  const { data: checks } = await admin.from("health_checks").select("*").eq("enabled", true);
  let down = 0;
  for (const c of checks || []) {
    const t0 = Date.now();
    let status = 0, err: string | null = null;
    try {
      const res = await fetch(c.url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(12_000) });
      status = res.status;
      await res.body?.cancel();
    } catch (e) { err = (e as Error).message.slice(0, 200); }
    const ok = !err && status === c.expect_status;
    await admin.from("health_checks").update({
      last_status: status || null, last_ok: ok, last_ms: Date.now() - t0,
      last_checked_at: new Date().toISOString(), last_error: err,
    }).eq("id", c.id);
    const fp = `health:${c.id}`;
    if (ok) await resolveAlert(fp);
    else {
      down++;
      await raiseAlert({ fingerprint: fp, kind: "health_down", severity: "crit",
        title: `${c.name} ne répond pas (${err ? "timeout/erreur" : `HTTP ${status}`})`,
        details: { url: c.url, status, error: err } });
    }
  }
  return { checked: checks?.length || 0, down };
}

// ───────────── Workflow alerts ─────────────
async function evaluateWorkflowAlerts() {
  const stuckMin = Number(await getSetting("alert_stuck_minutes", 90));
  const { data: wfs } = await admin.rpc("workflow_health");
  let open = 0;
  for (const w of (wfs || []) as any[]) {
    const errFp = `wf_error:${w.id}`, staleFp = `wf_stale:${w.id}`, stuckFp = `wf_stuck:${w.id}`;
    if (!w.watch || !w.active) {
      await resolveAlert(errFp); await resolveAlert(staleFp); await resolveAlert(stuckFp);
      continue;
    }
    // last run failed
    if (w.last_status === "error" || w.last_status === "crashed") {
      open++;
      await raiseAlert({ fingerprint: errFp, kind: "wf_error", severity: "crit",
        title: `${w.name} : dernière exécution en échec (${w.errors_24h} erreur(s) / 24 h)`,
        details: { workflow_id: w.id, last_started: w.last_started, errors_24h: w.errors_24h } });
    } else if (w.last_status === "success") await resolveAlert(errFp);

    // stuck run
    if (w.running_since && Date.now() - new Date(w.running_since).getTime() > stuckMin * 60_000) {
      open++;
      await raiseAlert({ fingerprint: stuckFp, kind: "wf_stuck", severity: "warn",
        title: `${w.name} tourne depuis plus de ${stuckMin} min`,
        details: { workflow_id: w.id, running_since: w.running_since } });
    } else await resolveAlert(stuckFp);

    // no success for too long
    if (w.expected_every_min) {
      const lastOk = w.last_success ? new Date(w.last_success).getTime() : 0;
      if (Date.now() - lastOk > 2 * w.expected_every_min * 60_000) {
        open++;
        await raiseAlert({ fingerprint: staleFp, kind: "wf_stale", severity: "warn",
          title: `${w.name} : aucun succès depuis ${w.last_success ? new Date(w.last_success).toLocaleString("fr-FR", { timeZone: "Africa/Casablanca" }) : "jamais"}`,
          details: { workflow_id: w.id, expected_every_min: w.expected_every_min } });
      } else await resolveAlert(staleFp);
    } else await resolveAlert(staleFp);
  }
  return { open };
}

// ───────────── Notifications ─────────────
async function notifyPending() {
  if (!telegramConfigured) return 0;
  let sent = 0;
  const { data: fresh } = await admin.from("alerts").select("*").is("resolved_at", null).is("notified_at", null).limit(20);
  for (const a of fresh || []) {
    const icon = a.severity === "crit" ? "🔴" : a.severity === "warn" ? "🟠" : "🔵";
    if (await telegram(`${icon} <b>${esc(a.title)}</b>`)) {
      await admin.from("alerts").update({ notified_at: new Date().toISOString() }).eq("id", a.id);
      sent++;
    }
  }
  // tell when a notified alert is resolved (once)
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: solved } = await admin.from("alerts").select("*")
    .not("notified_at", "is", null).not("resolved_at", "is", null).gte("resolved_at", since);
  for (const a of solved || []) {
    if (a.details?.resolved_notified) continue;
    if (await telegram(`✅ Résolu : ${esc(a.title)}`)) {
      await admin.from("alerts").update({ details: { ...a.details, resolved_notified: true } }).eq("id", a.id);
      sent++;
    }
  }
  return sent;
}
