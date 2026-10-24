// google-auth — connect a Google account (OAuth), discover GSC sites + GA4 properties, disconnect.
//   POST {action:"start", return_to}        (user)  → { url }   (open it in the browser)
//   GET  ?code=…&state=…                    (Google callback) → redirect back to the dashboard
//   POST {action:"discover", account_id?}    (user)  → re-list sites/properties
//   POST {action:"disconnect", account_id}   (user)
import {
  admin, serve, json, requireUser, HttpError, domainOf, gapi, getAccessToken,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, resolveAlert,
} from "../_shared/common.ts";

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
].join(" ");

function back(returnTo: string, params: Record<string, string>): Response {
  const hash = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: `${returnTo.split("#")[0]}#${hash}` } });
}

serve(async (req) => {
  const url = new URL(req.url);

  // ───── OAuth callback from Google ─────
  if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
    const state = url.searchParams.get("state") || "";
    const { data: st } = await admin.from("oauth_states").select("*").eq("state", state).maybeSingle();
    if (!st) return new Response("Lien expiré. Relance « Connecter Google » depuis le dashboard.", { status: 400 });
    await admin.from("oauth_states").delete().eq("state", state);

    const err = url.searchParams.get("error");
    if (err) return back(st.return_to, { google: "error", reason: err });

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code")!,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok) return back(st.return_to, { google: "error", reason: tok.error_description || tok.error || "token" });

    const info = await gapi<{ email: string }>("https://openidconnect.googleapis.com/v1/userinfo", tok.access_token);
    const email = (info.email || "").toLowerCase();
    if (!email) return back(st.return_to, { google: "error", reason: "no_email" });

    const { data: acct, error: aErr } = await admin.from("google_accounts")
      .upsert({ email, status: "active", last_error: null }, { onConflict: "email" })
      .select().single();
    if (aErr || !acct) return back(st.return_to, { google: "error", reason: aErr?.message || "db" });

    const tokenRow: Record<string, unknown> = {
      account_id: acct.id,
      access_token: tok.access_token,
      expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    };
    if (tok.refresh_token) tokenRow.refresh_token = tok.refresh_token;
    const { data: existing } = await admin.from("google_tokens").select("account_id").eq("account_id", acct.id).maybeSingle();
    if (!existing && !tok.refresh_token) {
      return back(st.return_to, { google: "error", reason: "no_refresh_token" });
    }
    await admin.from("google_tokens").upsert(tokenRow, { onConflict: "account_id" });
    await resolveAlert(`google:${acct.id}`);

    let summary = { gsc: 0, ga4: 0, sites: 0 };
    try { summary = await discover(acct.id); } catch (e) {
      return back(st.return_to, { google: "partial", email, reason: (e as Error).message.slice(0, 200) });
    }
    return back(st.return_to, {
      google: "connected", email, gsc: String(summary.gsc), ga4: String(summary.ga4), sites: String(summary.sites),
    });
  }

  if (req.method !== "POST") return json({ ok: true, redirect_uri: GOOGLE_REDIRECT_URI });

  const user = await requireUser(req);
  const body = await req.json().catch(() => ({}));

  if (body.action === "start") {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      throw new HttpError(400, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET ne sont pas encore configurés dans Supabase.");
    }
    const returnTo = String(body.return_to || "");
    if (!/^https?:\/\//.test(returnTo)) throw new HttpError(400, "return_to manquant");
    const state = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    await admin.from("oauth_states").insert({ state, user_id: user.id, return_to: returnTo });
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state,
    }).toString();
    return json({ url: auth.toString() });
  }

  if (body.action === "discover") {
    let ids: string[] = [];
    if (body.account_id) ids = [body.account_id];
    else {
      const { data } = await admin.from("google_accounts").select("id");
      ids = (data || []).map((r) => r.id);
    }
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      try { out[id] = await discover(id); } catch (e) { out[id] = { error: (e as Error).message }; }
    }
    return json({ ok: true, results: out });
  }

  if (body.action === "disconnect") {
    const id = String(body.account_id || "");
    const { data: t } = await admin.from("google_tokens").select("refresh_token").eq("account_id", id).maybeSingle();
    if (t?.refresh_token) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: "POST" })
        .catch(() => null);
    }
    await admin.from("google_accounts").delete().eq("id", id);
    await rebuildSites();
    return json({ ok: true });
  }

  throw new HttpError(400, "Unknown action");
});

// ───────────── Discovery ─────────────
async function discover(accountId: string) {
  const token = await getAccessToken(accountId);

  // Search Console sites
  const gsc = await gapi<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(
    "https://www.googleapis.com/webmasters/v3/sites", token,
  ).catch((e) => { throw new Error(`Search Console: ${e.message}`); });
  const gscRows = (gsc.siteEntry || [])
    .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => ({ account_id: accountId, site_url: s.siteUrl, permission_level: s.permissionLevel, domain: domainOf(s.siteUrl) }));

  // GA4 properties + their web stream URL
  const ga4Rows: Record<string, unknown>[] = [];
  let pageToken = "";
  try {
    do {
      const r = await gapi<any>(
        `https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`,
        token,
      );
      for (const acc of r.accountSummaries || []) {
        for (const p of acc.propertySummaries || []) {
          const pid = String(p.property || "").replace("properties/", "");
          let uri = "";
          try {
            const ds = await gapi<any>(`https://analyticsadmin.googleapis.com/v1beta/properties/${pid}/dataStreams`, token);
            const web = (ds.dataStreams || []).find((d: any) => d.webStreamData?.defaultUri);
            uri = web?.webStreamData?.defaultUri || "";
          } catch (_) { /* property without access to streams */ }
          ga4Rows.push({
            account_id: accountId, property_id: pid, display_name: p.displayName,
            account_name: acc.displayName, default_uri: uri, domain: domainOf(uri) || null,
          });
        }
      }
      pageToken = r.nextPageToken || "";
    } while (pageToken);
  } catch (e) {
    throw new Error(`Google Analytics: ${(e as Error).message}`);
  }

  // Replace this account's lists
  if (gscRows.length) await admin.from("gsc_sites").upsert(gscRows, { onConflict: "account_id,site_url" });
  if (ga4Rows.length) await admin.from("ga4_properties").upsert(ga4Rows, { onConflict: "account_id,property_id" });
  const keepGsc = gscRows.map((r) => r.site_url);
  const keepGa = ga4Rows.map((r) => r.property_id as string);
  const { data: oldGsc } = await admin.from("gsc_sites").select("id, site_url").eq("account_id", accountId);
  for (const o of oldGsc || []) if (!keepGsc.includes(o.site_url)) await admin.from("gsc_sites").delete().eq("id", o.id);
  const { data: oldGa } = await admin.from("ga4_properties").select("id, property_id").eq("account_id", accountId);
  for (const o of oldGa || []) if (!keepGa.includes(o.property_id)) await admin.from("ga4_properties").delete().eq("id", o.id);

  await admin.from("google_accounts").update({ last_discovery_at: new Date().toISOString() }).eq("id", accountId);
  const sites = await rebuildSites();
  return { gsc: gscRows.length, ga4: ga4Rows.length, sites };
}

// Merge GSC sites + GA4 properties into one row per domain. Manual choices are kept.
async function rebuildSites(): Promise<number> {
  const { data: gs } = await admin.from("gsc_sites").select("id, domain, site_url, permission_level");
  const { data: gp } = await admin.from("ga4_properties").select("id, domain");
  const { data: sites } = await admin.from("sites").select("id, domain, gsc_site_id, ga4_property_id");

  const rank = (s: any) =>
    (s.site_url.startsWith("sc-domain:") ? 0 : 2) + (s.permission_level === "siteOwner" || s.permission_level === "siteFullUser" ? 0 : 1);
  const bestGsc = new Map<string, any>();
  for (const s of gs || []) {
    if (!s.domain) continue;
    const cur = bestGsc.get(s.domain);
    if (!cur || rank(s) < rank(cur)) bestGsc.set(s.domain, s);
  }
  const firstGa = new Map<string, any>();
  for (const p of gp || []) if (p.domain && !firstGa.has(p.domain)) firstGa.set(p.domain, p);

  const gscIds = new Set((gs || []).map((s) => s.id));
  const gaIds = new Set((gp || []).map((p) => p.id));
  const byDomain = new Map((sites || []).map((s) => [s.domain, s]));
  const domains = new Set([...bestGsc.keys(), ...firstGa.keys()]);

  for (const d of domains) {
    const cur = byDomain.get(d);
    const gscId = cur?.gsc_site_id && gscIds.has(cur.gsc_site_id) ? cur.gsc_site_id : bestGsc.get(d)?.id ?? null;
    const gaId = cur?.ga4_property_id && gaIds.has(cur.ga4_property_id) ? cur.ga4_property_id : firstGa.get(d)?.id ?? null;
    if (cur) {
      if (cur.gsc_site_id !== gscId || cur.ga4_property_id !== gaId) {
        await admin.from("sites").update({ gsc_site_id: gscId, ga4_property_id: gaId }).eq("id", cur.id);
      }
    } else {
      await admin.from("sites").insert({ domain: d, gsc_site_id: gscId, ga4_property_id: gaId, tracked: false });
    }
  }
  const { count } = await admin.from("sites").select("id", { count: "exact", head: true });
  return count || 0;
}
