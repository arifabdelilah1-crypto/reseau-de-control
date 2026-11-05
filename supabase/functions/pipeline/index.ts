// pipeline — pont entre le dashboard v4 et le web app Apps Script (API.gs + Dashboard.gs).
//   POST {action:"refresh"}                        (cron 15 min / user) lit « dash », stocke l'état, alertes
//   POST {action:"call", gas:"<action>", params}   (user) relaie une action autorisée vers Apps Script
// Secrets : APPS_SCRIPT_USER, APPS_SCRIPT_PASS · réglage : settings.apps_script_url
import {
  admin, serve, json, requireUserOrCron, HttpError, getSetting, cleanSecret, raiseAlert, resolveAlert,
} from "../_shared/common.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const GAS_USER = cleanSecret(Deno.env.get("APPS_SCRIPT_USER"));
const GAS_PASS = Deno.env.get("APPS_SCRIPT_PASS")?.trim() || "";

// Actions Apps Script relayées depuis le dashboard (lecture + pilotage du pipeline)
const ALLOWED = new Set([
  "dash", "failed", "wf1_diagnostic", "no_pins",
  "wf1_run", "wf1_retry_failed", "wf2_run", "wf2b_run", "wf2_retry_failed", "wf3_run", "reset_failed",
  "set_costs", "plan_pins", "unplan_pins", "send_planned", "auto_on", "auto_off", "auto_status",
  "test_pod", "save_pod",
]);
// Actions qui changent le sheet : on rafraîchit l'état juste après
const MUTATING = new Set([
  "wf1_retry_failed", "wf2_retry_failed", "reset_failed", "set_costs", "plan_pins", "unplan_pins",
  "send_planned", "save_pod",
]);

serve(async (req) => {
  const who = await requireUserOrCron(req);
  const body = await req.json().catch(() => ({}));
  const action = body.action || "refresh";

  if (action === "refresh") return json(await refresh());

  if (action === "call") {
    if (who !== "user") throw new HttpError(403, "user only");
    const gas = String(body.gas || "");
    if (!ALLOWED.has(gas)) throw new HttpError(400, `Action non autorisée : ${gas}`);
    const params = body.params || {};
    const res = await callGas(gas, params);
    const isWrite = MUTATING.has(gas) && !(gas === "plan_pins" && String(params.dry) !== "0");
    if (isWrite) {
      const p = refresh().catch((e) => console.error("refresh after call", e));
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(p);
    }
    return json(res);
  }
  throw new HttpError(400, "Unknown action");
});

async function callGas(action: string, params: Record<string, unknown>, timeoutMs = 140_000) {
  const url = String(await getSetting("apps_script_url", "") || "").trim();
  if (!url) throw new HttpError(400, "URL du web app Apps Script manquante (Connexions → Réglages).");
  if (!GAS_USER || !GAS_PASS) throw new HttpError(400, "Secrets APPS_SCRIPT_USER / APPS_SCRIPT_PASS manquants dans Supabase.");

  // API.gs fait JSON.parse() sur sites / weeks / ids : on envoie toujours des chaînes.
  const payload: Record<string, string> = { u: GAS_USER, p: GAS_PASS, action };
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    payload[k] = typeof v === "string" ? v : (typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch (_) {
    if (/<html|accounts\.google\.com/i.test(text)) {
      throw new Error("Apps Script a renvoyé une page HTML : vérifie que le web app est déployé en accès « Anyone » et que l'URL se termine par /exec.");
    }
    throw new Error(`Réponse Apps Script illisible (HTTP ${res.status}) : ${text.slice(0, 160)}`);
  }
  if (data && data.ok === false && data.error === "Unauthorized") {
    throw new Error("Apps Script refuse les identifiants : vérifie APPS_SCRIPT_USER / APPS_SCRIPT_PASS.");
  }
  return data;
}

async function refresh() {
  const t0 = Date.now();
  try {
    const data = await callGas("dash", {});
    if (!data || data.ok === false) throw new Error(data?.error || "réponse dash invalide");
    const ms = Date.now() - t0;
    await admin.from("pipeline_state").upsert({ id: 1, data, ok: true, error: null, ms, taken_at: new Date().toISOString() });
    await resolveAlert("pipeline_api");
    await history(data);
    const alerts = await pipelineAlerts(data);
    return { ok: true, ms, alerts };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400);
    await admin.from("pipeline_state").upsert({ id: 1, ok: false, error: msg, ms: Date.now() - t0, taken_at: new Date().toISOString() },
      { onConflict: "id", ignoreDuplicates: false });
    await raiseAlert({ fingerprint: "pipeline_api", kind: "pipeline_api", severity: "crit",
      title: "Pipeline : Apps Script injoignable", details: { error: msg } });
    return { ok: false, error: msg };
  }
}

// Une ligne de métriques par heure (courbes long terme)
async function history(d: any) {
  const { data: last } = await admin.from("pipeline_history").select("taken_at").order("taken_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.taken_at).getTime() < 55 * 60_000) return;
  await admin.from("pipeline_history").insert({
    metrics: {
      articles: { total: d.articles?.total, generated: d.articles?.generated, published: d.articles?.published, failed: d.articles?.failed },
      images: { images: d.images?.images, articlesDone: d.images?.articlesDone },
      pins: d.pins?.byStatus || {},
      cost: { total: d.cost?.total, month: d.cost?.month, perPublished: d.cost?.perPublished },
    },
  });
}

async function pipelineAlerts(d: any) {
  let open = 0;
  // 1. Échecs accumulés
  const threshold = Number(await getSetting("pipeline_failed_alert", 10));
  const fa = Number(d.articles?.failed || 0);
  const fi = (d.images?.failedList || []).filter((x: any) => String(x.status).startsWith("failed")).length;
  if (fa + fi >= threshold) {
    open++;
    await raiseAlert({ fingerprint: "pipeline_failed", kind: "pipeline_failed", severity: "warn",
      title: `Pipeline : ${fa} article(s) et ${fi} image(s) en échec`, details: { articles: fa, images: fi } });
  } else await resolveAlert("pipeline_failed");

  // 2. Sites avec des pins prêts mais rien de planifié dans les prochaines heures
  const gapH = Number(await getSetting("pipeline_pin_gap_hours", 48));
  const nDays = Math.max(1, Math.ceil(gapH / 24));
  const days: string[] = (d.nextDays || []).slice(0, nDays);
  for (const s of d.pins?.bySite || []) {
    const fp = `pin_gap:${s.site}`;
    const waiting = Number(s.done || 0);
    const upcoming = days.reduce((n, day) => n + Number(d.pins?.cal?.[s.site]?.[day] || 0), 0);
    if (waiting > 0 && upcoming === 0) {
      open++;
      await raiseAlert({ fingerprint: fp, kind: "pin_gap", severity: "warn",
        title: `${s.site} : aucun pin planifié sous ${gapH} h (${waiting} prêts)`, details: { site: s.site, waiting } });
    } else await resolveAlert(fp);
  }
  return open;
}
