// Shared helpers for Réseau DE · Control edge functions
import { createClient } from "npm:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ───────────── Auth ─────────────
let cronSecretCache: string | null = null;
async function cronSecret(): Promise<string> {
  if (cronSecretCache) return cronSecretCache;
  const { data, error } = await admin.from("app_secrets").select("value").eq("name", "cron_secret").single();
  if (error || !data) throw new HttpError(500, "cron secret missing");
  cronSecretCache = data.value;
  return data.value;
}

export async function isCron(req: Request): Promise<boolean> {
  const h = req.headers.get("x-cron-secret");
  return !!h && h === await cronSecret();
}

export async function requireUser(req: Request): Promise<{ id: string; email: string }> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Not signed in");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user?.email) throw new HttpError(401, "Invalid session");
  const email = data.user.email.toLowerCase();
  const { data: ok } = await admin.from("allowed_users").select("email").eq("email", email).maybeSingle();
  if (!ok) throw new HttpError(403, "This email is not allowed on this dashboard");
  return { id: data.user.id, email };
}

export async function requireUserOrCron(req: Request): Promise<"cron" | "user"> {
  if (await isCron(req)) return "cron";
  await requireUser(req);
  return "user";
}

// ───────────── Helpers ─────────────
export function domainOf(u: string | null | undefined): string {
  if (!u) return "";
  let s = u.trim().toLowerCase();
  s = s.replace(/^sc-domain:/, "").replace(/^[a-z]+:\/\//, "");
  s = s.split("/")[0].split("?")[0].split(":")[0];
  return s.replace(/^www\./, "");
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: string | Date, n: number): string {
  const x = typeof d === "string" ? new Date(d + "T00:00:00Z") : new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return isoDate(x);
}

export async function getSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  const { data } = await admin.from("settings").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? fallback) as T;
}

export async function upsertChunks(table: string, rows: Record<string, unknown>[], onConflict: string, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await admin.from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

// ───────────── Google ─────────────
export const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
export const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
export const GOOGLE_REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-auth`;

export class GoogleAuthDead extends Error {}

export async function getAccessToken(accountId: string): Promise<string> {
  const { data: t, error } = await admin.from("google_tokens").select("*").eq("account_id", accountId).single();
  if (error || !t) throw new Error("No token for Google account");
  if (t.access_token && t.expires_at && new Date(t.expires_at).getTime() > Date.now() + 90_000) {
    return t.access_token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = `Token refresh failed: ${body.error || res.status} ${body.error_description || ""}`.trim();
    if (body.error === "invalid_grant") {
      await admin.from("google_accounts").update({ status: "error", last_error: msg }).eq("id", accountId);
      throw new GoogleAuthDead(msg);
    }
    throw new Error(msg);
  }
  const expires = new Date(Date.now() + (body.expires_in || 3600) * 1000).toISOString();
  await admin.from("google_tokens").update({ access_token: body.access_token, expires_at: expires }).eq("account_id", accountId);
  await admin.from("google_accounts").update({ status: "active", last_error: null }).eq("id", accountId);
  return body.access_token;
}

export async function gapi<T = any>(url: string, token: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = data?.error?.message || text.slice(0, 300);
      throw new Error(`Google API ${res.status}: ${msg}`);
    }
    return data as T;
  }
  throw new Error(`Google API still failing after retries: ${url}`);
}

// ───────────── Alerts ─────────────
export type AlertInput = {
  fingerprint: string;
  kind: string;
  severity?: "info" | "warn" | "crit";
  title: string;
  details?: Record<string, unknown>;
};

export async function raiseAlert(a: AlertInput) {
  const { data: open } = await admin.from("alerts").select("id")
    .eq("fingerprint", a.fingerprint).is("resolved_at", null).maybeSingle();
  if (open) {
    await admin.from("alerts").update({
      last_seen_at: new Date().toISOString(), title: a.title, details: a.details || {},
    }).eq("id", open.id);
    return;
  }
  await admin.from("alerts").insert({
    fingerprint: a.fingerprint, kind: a.kind, severity: a.severity || "warn",
    title: a.title, details: a.details || {},
  });
}

export async function resolveAlert(fingerprint: string) {
  await admin.from("alerts").update({ resolved_at: new Date().toISOString() })
    .eq("fingerprint", fingerprint).is("resolved_at", null);
}

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TG_CHAT = Deno.env.get("TELEGRAM_CHAT_ID") || "";
export const telegramConfigured = !!(TG_TOKEN && TG_CHAT);

export async function telegram(text: string): Promise<boolean> {
  if (!telegramConfigured) return false;
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return res.ok;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Wrap a handler with CORS + error handling
export function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: (e as Error).message || String(e) }, 500);
    }
  });
}
