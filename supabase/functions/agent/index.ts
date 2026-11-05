// agent — assistant du dashboard (DeepSeek, appel d'outils). Il LIT les données et PROPOSE des actions ;
// le dashboard affiche un bouton « Exécuter » et c'est l'utilisateur qui confirme. L'agent n'exécute jamais rien seul.
//   POST {messages:[{role:"user"|"assistant", content}], context?:{view, site}}  (user)
// Secret : DEEPSEEK_API_KEY · Réglages : agent_daily_tokens (plafond / jour), agent_model
import { admin, serve, json, requireUser, HttpError, cleanSecret, getSetting } from "../_shared/common.ts";
import { TOOLS, runTool, compact } from "../_shared/tools.ts";

const KEY = cleanSecret(Deno.env.get("DEEPSEEK_API_KEY"));
const MAX_ROUNDS = 6;

const ACTIONS = {
  wf1_run: "Lancer WF1 (articles) — params: sites[] (slugs, vide = tous), weeks[]",
  wf1_retry_failed: "Remettre en pending et relancer les articles en échec — params: sites[]",
  wf2_run: "Lancer WF2a (génération des images sur le pod GPU) — params: sites[]",
  wf2b_run: "Lancer WF2b (envoi des images vers WordPress) — params: sites[]",
  wf2_retry_failed: "Relancer les images en échec — params: sites[]",
  wf3_run: "Lancer WF3a (génération des pins) — params: sites[]",
  reset_failed: "Remettre en pending tous les articles et images en échec",
  send_planned: "Envoyer maintenant à WF3b les pins planifiés dont l'heure est passée",
  blotato_cancel: "Annuler un post programmé chez Blotato — params: schedule_id",
  blotato_reschedule: "Reprogrammer un post Blotato — params: schedule_id, scheduled_at (ISO 8601, futur)",
  resolve_alert: "Marquer une alerte résolue — params: alert_id",
  index_inspect: "Inspecter tout de suite une URL dans Search Console — params: url",
  sync_n8n: "Synchroniser n8n maintenant",
  sync_blotato: "Synchroniser Blotato maintenant",
  refresh_pipeline: "Relire le Google Sheet maintenant",
} as const;

const PROPOSE = {
  type: "function",
  function: {
    name: "propose_action",
    description: "Propose UNE action à l'utilisateur (il devra cliquer « Exécuter » pour confirmer). N'utilise que si l'utilisateur demande d'agir ou si une action évidente règle le problème. Actions : " +
      Object.entries(ACTIONS).map(([k, v]) => `${k} = ${v}`).join(" · "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.keys(ACTIONS) },
        params: { type: "object", description: "Paramètres de l'action", properties: {
          sites: { type: "array", items: { type: "string" } }, weeks: { type: "array", items: { type: "integer" } },
          schedule_id: { type: "string" }, scheduled_at: { type: "string" }, alert_id: { type: "integer" }, url: { type: "string" } } },
        summary: { type: "string", description: "Phrase courte en français : ce que fait l'action et pourquoi" },
      },
      required: ["action", "summary"],
    },
  },
};

const SYSTEM = (ctx: any) => `Tu es l'assistant du dashboard « Réseau DE · Control » d'Arif.
Contexte : 13 blogs de recettes allemands (WordPress). n8n automatise WF1 articles (DeepSeek) → WF2a images (pod GPU RunPod) → WF2b upload WordPress → WF3a pins Pinterest → WF3b publication via Blotato. Le Google Sheet (Master, Pins, Sites) est la source de vérité, lu toutes les 15 min.
Tu as des outils en lecture seule (Search Console, GA4, indexation Google, n8n, alertes, pipeline, Blotato). Utilise-les avant de répondre ; n'invente jamais un chiffre. Si une donnée manque, dis-le.
Pour agir, appelle propose_action : l'utilisateur confirmera. Ne prétends jamais avoir exécuté quelque chose.
Style : français, direct, concis. Chiffres précis, listes courtes, pas de blabla. Monnaie MAD. Données Google : 2-3 jours de retard.
Date du jour : ${new Date().toISOString().slice(0, 10)} (fuseau Africa/Casablanca).${ctx?.view ? `\nL'utilisateur regarde la vue « ${String(ctx.view).slice(0, 40)} »${ctx.site ? ` (site ${String(ctx.site).slice(0, 60)})` : ""}.` : ""}`;

serve(async (req) => {
  const user = await requireUser(req);
  if (!KEY) throw new HttpError(400, "Secret DEEPSEEK_API_KEY manquant dans Supabase.");
  const body = await req.json().catch(() => ({}));
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12).map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!history.length || history[history.length - 1].role !== "user") throw new HttpError(400, "Message manquant");

  // Plafond quotidien
  const today = new Date().toISOString().slice(0, 10);
  const cap = Number(await getSetting("agent_daily_tokens", 400000));
  const { data: used } = await admin.from("agent_usage").select("*").eq("day", today).maybeSingle();
  if (used && Number(used.prompt_tokens) + Number(used.completion_tokens) >= cap) {
    throw new HttpError(429, `Plafond quotidien de l'agent atteint (${cap} tokens). Modifiable dans Connexions → Réglages.`);
  }
  const model = String(await getSetting("agent_model", "deepseek-chat"));

  const tools = [...TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })), PROPOSE];
  const messages: any[] = [{ role: "system", content: SYSTEM(body.context) }, ...history];
  const proposals: any[] = [];
  const steps: { tool: string; args: unknown; ok: boolean }[] = [];
  let pt = 0, ct = 0, answer = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 1500 }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `DeepSeek ${res.status} : ${data?.error?.message || "erreur"}`);
    pt += Number(data.usage?.prompt_tokens || 0); ct += Number(data.usage?.completion_tokens || 0);
    const msg = data.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) { answer = msg.content || ""; break; }
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    for (const c of calls) {
      let args: any = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch (_) { args = {}; }
      const name = c.function?.name;
      let content: string;
      if (name === "propose_action") {
        if (!(args.action in ACTIONS)) content = "Action inconnue.";
        else { proposals.push({ action: args.action, params: args.params || {}, summary: String(args.summary || ACTIONS[args.action as keyof typeof ACTIONS]).slice(0, 300) }); content = "Proposition affichée à l'utilisateur, en attente de sa confirmation. Ne dis pas qu'elle est exécutée."; }
        steps.push({ tool: "propose_action", args, ok: true });
      } else {
        try { content = compact(await runTool(name, args), 12000); steps.push({ tool: name, args, ok: true }); }
        catch (e) { content = `Erreur : ${(e as Error).message}`; steps.push({ tool: name, args, ok: false }); }
      }
      messages.push({ role: "tool", tool_call_id: c.id, content });
    }
    if (round === MAX_ROUNDS - 1) answer = "J'ai atteint la limite d'étapes pour cette question : reformule plus précisément.";
  }

  await admin.rpc("agent_track", { p_day: today, p_prompt: pt, p_completion: ct });
  return json({ answer, proposals, steps, usage: { prompt_tokens: pt, completion_tokens: ct }, by: user.email });
});
