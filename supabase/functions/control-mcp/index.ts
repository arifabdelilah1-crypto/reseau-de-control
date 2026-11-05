// control-mcp — serveur MCP (Streamable HTTP, réponses JSON) pour brancher Claude sur le dashboard.
// Lecture seule. Accès protégé par un jeton secret dans l'URL : …/functions/v1/control-mcp?key=<jeton>
// Gestion (depuis le dashboard, utilisateur connecté) : POST {action:"info"} · POST {action:"rotate"}
import { admin, json, requireUser, HttpError, cors } from "../_shared/common.ts";
import { TOOLS, runTool, compact } from "../_shared/tools.ts";

const BASE_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/control-mcp`;
const INSTRUCTIONS = `Serveur « Réseau DE · Control » d'Arif : 13 blogs de recettes allemands (WordPress) automatisés par n8n
(WF1 articles → WF2a/WF2b images → WF3a pins → WF3b publication via Blotato sur Pinterest), pilotés depuis un Google Sheet.
Les outils donnent en lecture seule : trafic Search Console + GA4 (dont sessions Pinterest), indexation Google des articles,
santé des workflows n8n, alertes, pipeline du Sheet (articles, images, pins, coûts en MAD), planning et stats Pinterest via Blotato.
Commence par system_overview ou list_sites. Les données Google ont 2-3 jours de retard. Réponds en français.`;

async function getToken(create = true): Promise<string | null> {
  const { data } = await admin.from("app_secrets").select("value").eq("name", "mcp_token").maybeSingle();
  if (data?.value) return data.value;
  if (!create) return null;
  return await rotate();
}
async function rotate(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const tok = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await admin.from("app_secrets").upsert({ name: "mcp_token", value: tok }, { onConflict: "name" });
  return tok;
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: any) {
  const id = msg?.id;
  const method = String(msg?.method || "");
  if (id === undefined || id === null) return null;     // notification → pas de réponse
  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: msg.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "reseau-de-control", title: "Réseau DE · Control", version: "1.0.0" },
          instructions: INSTRUCTIONS,
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name, description: t.description, inputSchema: t.input_schema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          })),
        });
      case "tools/call": {
        const name = String(msg.params?.name || "");
        try {
          const out = await runTool(name, msg.params?.arguments || {});
          return rpcResult(id, { content: [{ type: "text", text: compact(out, 60000) }] });
        } catch (e) {
          return rpcResult(id, { content: [{ type: "text", text: `Erreur : ${(e as Error).message}` }], isError: true });
        }
      }
      case "resources/list": return rpcResult(id, { resources: [] });
      case "prompts/list": return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, -32601, `Méthode non supportée : ${method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  try {
    let body: any = null;
    if (req.method === "POST") body = await req.json().catch(() => null);

    // Gestion depuis le dashboard
    if (body && !Array.isArray(body) && body.action) {
      await requireUser(req);
      const tok = body.action === "rotate" ? await rotate() : await getToken(true);
      return json({ url: `${BASE_URL}?key=${tok}`, tools: TOOLS.map((t) => t.name) });
    }

    // Protocole MCP
    const given = url.searchParams.get("key") || url.pathname.split("/").filter(Boolean).pop() || "";
    const tok = await getToken(false);
    if (!tok || !safeEq(given, tok)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    if (req.method === "GET") return new Response("Use POST (Streamable HTTP, JSON responses)", { status: 405, headers: { Allow: "POST" } });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST" || !body) return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers: { "Content-Type": "application/json" } });

    if (Array.isArray(body)) {
      const outs = (await Promise.all(body.map(handle))).filter(Boolean);
      if (!outs.length) return new Response(null, { status: 202 });
      return new Response(JSON.stringify(outs), { headers: { "Content-Type": "application/json" } });
    }
    const out = await handle(body);
    if (!out) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
});
