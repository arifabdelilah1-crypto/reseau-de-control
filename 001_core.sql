-- Réseau DE · Control — core schema
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ───────────── Access control ─────────────
create table public.allowed_users (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table public.allowed_users enable row level security;

create or replace function public.is_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed_users
                 where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function public.is_allowed() from anon;

create policy "allowed read self" on public.allowed_users
  for select to authenticated using (public.is_allowed());

-- ───────────── Settings (editable from the dashboard) ─────────────
create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
create policy "settings read" on public.settings for select to authenticated using (public.is_allowed());
create policy "settings write" on public.settings for all to authenticated
  using (public.is_allowed()) with check (public.is_allowed());

-- ───────────── Server-only tables (RLS on, no policies) ─────────────
create table public.app_secrets (
  name text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

create table public.oauth_states (
  state text primary key,
  user_id uuid not null,
  return_to text not null,
  created_at timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;

-- ───────────── Google accounts ─────────────
create table public.google_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  status text not null default 'active',          -- active | error | revoked
  last_error text,
  connected_at timestamptz not null default now(),
  last_discovery_at timestamptz
);
alter table public.google_accounts enable row level security;
create policy "ga read" on public.google_accounts for select to authenticated using (public.is_allowed());
create policy "ga delete" on public.google_accounts for delete to authenticated using (public.is_allowed());

create table public.google_tokens (
  account_id uuid primary key references public.google_accounts(id) on delete cascade,
  refresh_token text not null,
  access_token text,
  expires_at timestamptz
);
alter table public.google_tokens enable row level security;
revoke all on public.google_tokens from anon, authenticated;

create table public.gsc_sites (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.google_accounts(id) on delete cascade,
  site_url text not null,
  permission_level text,
  domain text not null,
  unique (account_id, site_url)
);
alter table public.gsc_sites enable row level security;
create policy "gsc_sites read" on public.gsc_sites for select to authenticated using (public.is_allowed());

create table public.ga4_properties (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.google_accounts(id) on delete cascade,
  property_id text not null,             -- numeric id, e.g. 412345678
  display_name text,
  account_name text,
  default_uri text,
  domain text,
  unique (account_id, property_id)
);
alter table public.ga4_properties enable row level security;
create policy "ga4 read" on public.ga4_properties for select to authenticated using (public.is_allowed());

-- One row per real website (merged view of GSC + GA4)
create table public.sites (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique,
  label text,
  gsc_site_id uuid references public.gsc_sites(id) on delete set null,
  ga4_property_id uuid references public.ga4_properties(id) on delete set null,
  tracked boolean not null default false,
  backfill_requested_at timestamptz,
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now()
);
alter table public.sites enable row level security;
create policy "sites read" on public.sites for select to authenticated using (public.is_allowed());
create policy "sites update" on public.sites for update to authenticated
  using (public.is_allowed()) with check (public.is_allowed());

-- ───────────── GSC data ─────────────
create table public.gsc_daily (
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  clicks int not null default 0,
  impressions int not null default 0,
  position real,
  primary key (site_id, date)
);
create table public.gsc_query_daily (
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  query text not null,
  clicks int not null default 0,
  impressions int not null default 0,
  position real,
  primary key (site_id, date, query)
);
create table public.gsc_page_daily (
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  page text not null,
  clicks int not null default 0,
  impressions int not null default 0,
  position real,
  primary key (site_id, date, page)
);
create table public.gsc_dim_daily (            -- dim = country | device
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  dim text not null,
  value text not null,
  clicks int not null default 0,
  impressions int not null default 0,
  position real,
  primary key (site_id, date, dim, value)
);
create table public.gsc_query_monthly (
  site_id uuid not null references public.sites(id) on delete cascade,
  month date not null,
  query text not null,
  clicks int not null default 0,
  impressions int not null default 0,
  position real,
  primary key (site_id, month, query)
);
create table public.gsc_page_monthly (
  site_id uuid not null references public.sites(id) on delete cascade,
  month date not null,
  page text not null,
  clicks int not null default 0,
  impressions int not null default 0,
  position real,
  primary key (site_id, month, page)
);

-- ───────────── GA4 data ─────────────
create table public.ga4_daily (
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  sessions int not null default 0,
  users int not null default 0,
  new_users int not null default 0,
  views int not null default 0,
  engaged_sessions int not null default 0,
  avg_session_duration real,
  primary key (site_id, date)
);
create table public.ga4_source_daily (
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  source text not null,
  medium text not null,
  sessions int not null default 0,
  users int not null default 0,
  primary key (site_id, date, source, medium)
);
create table public.ga4_page_monthly (
  site_id uuid not null references public.sites(id) on delete cascade,
  month date not null,
  page text not null,
  views int not null default 0,
  sessions int not null default 0,
  primary key (site_id, month, page)
);

do $$
declare t text;
begin
  foreach t in array array['gsc_daily','gsc_query_daily','gsc_page_daily','gsc_dim_daily',
    'gsc_query_monthly','gsc_page_monthly','ga4_daily','ga4_source_daily','ga4_page_monthly']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "%s read" on public.%I for select to authenticated using (public.is_allowed())', t, t);
  end loop;
end $$;

-- ───────────── Sync queue ─────────────
create table public.sync_jobs (
  id bigserial primary key,
  site_id uuid not null references public.sites(id) on delete cascade,
  kind text not null,          -- gsc_days | gsc_month | ga4_days | ga4_month
  start_date date not null,
  end_date date not null,
  priority int not null default 5,   -- lower = sooner (daily=1, backfill=5)
  status text not null default 'queued',  -- queued | running | done | error
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sync_jobs_queue on public.sync_jobs (status, priority, start_date desc);
create unique index sync_jobs_dedupe on public.sync_jobs (site_id, kind, start_date, end_date)
  where status in ('queued','running');
alter table public.sync_jobs enable row level security;
create policy "jobs read" on public.sync_jobs for select to authenticated using (public.is_allowed());

create or replace function public.claim_sync_jobs(n int)
returns setof public.sync_jobs language plpgsql security definer set search_path = public as $$
begin
  -- recover jobs stuck in running for > 10 min
  update public.sync_jobs set status = 'queued', updated_at = now()
   where status = 'running' and updated_at < now() - interval '10 minutes' and attempts < 4;
  return query
  update public.sync_jobs j set status = 'running', attempts = j.attempts + 1, updated_at = now()
   where j.id in (select id from public.sync_jobs
                   where status = 'queued'
                   order by priority, start_date desc
                   limit n for update skip locked)
  returning j.*;
end $$;
revoke all on function public.claim_sync_jobs(int) from anon, authenticated, public;

-- ───────────── n8n monitoring ─────────────
create table public.n8n_workflows (
  id text primary key,
  name text not null,
  active boolean not null default false,
  tags jsonb not null default '[]',
  updated_at timestamptz,
  watch boolean not null default true,
  expected_every_min int,          -- e.g. 1440 for a daily workflow; null = no staleness check
  synced_at timestamptz not null default now()
);
create table public.n8n_executions (
  id text primary key,
  workflow_id text not null,
  status text not null,
  mode text,
  started_at timestamptz,
  stopped_at timestamptz,
  synced_at timestamptz not null default now()
);
create index n8n_exec_wf on public.n8n_executions (workflow_id, started_at desc);
create index n8n_exec_started on public.n8n_executions (started_at desc);

create table public.health_checks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  expect_status int not null default 200,
  enabled boolean not null default true,
  last_status int,
  last_ok boolean,
  last_ms int,
  last_checked_at timestamptz,
  last_error text
);

create table public.alerts (
  id bigserial primary key,
  fingerprint text not null,
  kind text not null,               -- wf_error | wf_stuck | wf_stale | health_down | seo_drop | sync_error
  severity text not null default 'warn',  -- info | warn | crit
  title text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  notified_at timestamptz,
  resolved_at timestamptz
);
create unique index alerts_open_fp on public.alerts (fingerprint) where resolved_at is null;

do $$
declare t text;
begin
  foreach t in array array['n8n_workflows','n8n_executions','health_checks','alerts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "%s read" on public.%I for select to authenticated using (public.is_allowed())', t, t);
  end loop;
end $$;
create policy "wf update" on public.n8n_workflows for update to authenticated using (public.is_allowed()) with check (public.is_allowed());
create policy "hc write" on public.health_checks for all to authenticated using (public.is_allowed()) with check (public.is_allowed());
create policy "alerts update" on public.alerts for update to authenticated using (public.is_allowed()) with check (public.is_allowed());
