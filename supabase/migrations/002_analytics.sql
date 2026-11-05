-- Réseau DE · Control — read functions used by the dashboard (RLS applies: security invoker)

create or replace function public.setting_int(p_key text, p_default int)
returns int language sql stable as $$
  select coalesce((select (value #>> '{}')::int from public.settings where key = p_key), p_default);
$$;

-- Sites table with period-over-period numbers + sparkline
create or replace function public.site_overview(p_days int default 28)
returns table (
  site_id uuid, domain text, label text, tracked boolean, has_gsc boolean, has_ga4 boolean,
  clicks bigint, clicks_prev bigint, impressions bigint, impressions_prev bigint, avg_position real,
  sessions bigint, sessions_prev bigint, pinterest_sessions bigint, pinterest_sessions_prev bigint,
  spark jsonb, last_sync_at timestamptz, last_sync_error text
) language sql stable as $$
  with r as (
    select current_date - 1 as e, current_date - p_days as s,
           current_date - p_days - 1 as pe, current_date - 2 * p_days as ps
  )
  select st.id, st.domain, st.label, st.tracked, st.gsc_site_id is not null, st.ga4_property_id is not null,
    (select coalesce(sum(g.clicks),0) from gsc_daily g, r where g.site_id = st.id and g.date between r.s and r.e),
    (select coalesce(sum(g.clicks),0) from gsc_daily g, r where g.site_id = st.id and g.date between r.ps and r.pe),
    (select coalesce(sum(g.impressions),0) from gsc_daily g, r where g.site_id = st.id and g.date between r.s and r.e),
    (select coalesce(sum(g.impressions),0) from gsc_daily g, r where g.site_id = st.id and g.date between r.ps and r.pe),
    (select (sum(g.position * g.impressions) / nullif(sum(g.impressions),0))::real
       from gsc_daily g, r where g.site_id = st.id and g.date between r.s and r.e),
    (select coalesce(sum(a.sessions),0) from ga4_daily a, r where a.site_id = st.id and a.date between r.s and r.e),
    (select coalesce(sum(a.sessions),0) from ga4_daily a, r where a.site_id = st.id and a.date between r.ps and r.pe),
    (select coalesce(sum(x.sessions),0) from ga4_source_daily x, r
      where x.site_id = st.id and x.date between r.s and r.e and x.source ilike '%pinterest%'),
    (select coalesce(sum(x.sessions),0) from ga4_source_daily x, r
      where x.site_id = st.id and x.date between r.ps and r.pe and x.source ilike '%pinterest%'),
    (select coalesce(jsonb_agg(coalesce(g.clicks,0) order by d.d), '[]'::jsonb)
       from r cross join lateral generate_series(r.s, r.e, interval '1 day') d(d)
       left join gsc_daily g on g.site_id = st.id and g.date = d.d::date),
    st.last_sync_at, st.last_sync_error
  from sites st
  order by st.tracked desc, st.domain;
$$;

-- Daily series for one site, or all tracked sites when p_site is null
create or replace function public.site_series(p_site uuid, p_from date, p_to date)
returns table (date date, clicks bigint, impressions bigint, avg_position real,
               sessions bigint, users bigint, pinterest_sessions bigint)
language sql stable as $$
  with ids as (select id from sites where (p_site is null and tracked) or id = p_site),
  days as (select d::date as date from generate_series(p_from, p_to, interval '1 day') d)
  select days.date,
    coalesce(g.clicks,0)::bigint, coalesce(g.impressions,0)::bigint, g.pos,
    coalesce(a.sessions,0)::bigint, coalesce(a.users,0)::bigint, coalesce(p.sessions,0)::bigint
  from days
  left join (select gd.date, sum(gd.clicks) clicks, sum(gd.impressions) impressions,
                    (sum(gd.position*gd.impressions)/nullif(sum(gd.impressions),0))::real pos
               from gsc_daily gd where gd.site_id in (select id from ids) and gd.date between p_from and p_to
              group by gd.date) g using (date)
  left join (select date, sum(sessions) sessions, sum(users) users
               from ga4_daily where site_id in (select id from ids) and date between p_from and p_to
              group by date) a using (date)
  left join (select date, sum(sessions) sessions
               from ga4_source_daily where site_id in (select id from ids)
                and date between p_from and p_to and source ilike '%pinterest%'
              group by date) p using (date)
  order by days.date;
$$;

create or replace function public.top_queries(p_site uuid, p_from date, p_to date, p_limit int default 100)
returns table (query text, clicks bigint, impressions bigint, ctr real, avg_position real, granularity text)
language plpgsql stable as $$
declare ret int := public.setting_int('gsc_daily_retention_days', 90);
begin
  if p_from >= current_date - ret then
    return query
      select q.query, sum(q.clicks)::bigint, sum(q.impressions)::bigint,
             (sum(q.clicks)::real / nullif(sum(q.impressions),0))::real,
             (sum(q.position*q.impressions)/nullif(sum(q.impressions),0))::real, 'daily'::text
        from gsc_query_daily q
       where q.date between p_from and p_to
         and q.site_id in (select s.id from sites s where (p_site is null and s.tracked) or s.id = p_site)
       group by q.query order by 2 desc, 3 desc limit p_limit;
  else
    return query
      select q.query, sum(q.clicks)::bigint, sum(q.impressions)::bigint,
             (sum(q.clicks)::real / nullif(sum(q.impressions),0))::real,
             (sum(q.position*q.impressions)/nullif(sum(q.impressions),0))::real, 'monthly'::text
        from gsc_query_monthly q
       where q.month between date_trunc('month', p_from)::date and p_to
         and q.site_id in (select s.id from sites s where (p_site is null and s.tracked) or s.id = p_site)
       group by q.query order by 2 desc, 3 desc limit p_limit;
  end if;
end $$;

create or replace function public.top_pages(p_site uuid, p_from date, p_to date, p_limit int default 100)
returns table (page text, clicks bigint, impressions bigint, ctr real, avg_position real, granularity text)
language plpgsql stable as $$
declare ret int := public.setting_int('gsc_daily_retention_days', 90);
begin
  if p_from >= current_date - ret then
    return query
      select q.page, sum(q.clicks)::bigint, sum(q.impressions)::bigint,
             (sum(q.clicks)::real / nullif(sum(q.impressions),0))::real,
             (sum(q.position*q.impressions)/nullif(sum(q.impressions),0))::real, 'daily'::text
        from gsc_page_daily q
       where q.date between p_from and p_to
         and q.site_id in (select s.id from sites s where (p_site is null and s.tracked) or s.id = p_site)
       group by q.page order by 2 desc, 3 desc limit p_limit;
  else
    return query
      select q.page, sum(q.clicks)::bigint, sum(q.impressions)::bigint,
             (sum(q.clicks)::real / nullif(sum(q.impressions),0))::real,
             (sum(q.position*q.impressions)/nullif(sum(q.impressions),0))::real, 'monthly'::text
        from gsc_page_monthly q
       where q.month between date_trunc('month', p_from)::date and p_to
         and q.site_id in (select s.id from sites s where (p_site is null and s.tracked) or s.id = p_site)
       group by q.page order by 2 desc, 3 desc limit p_limit;
  end if;
end $$;

-- Winners / losers: last p_days vs previous p_days (daily table, so p_days <= retention/2)
create or replace function public.query_movers(p_site uuid, p_days int default 28, p_limit int default 15)
returns table (query text, clicks_now bigint, clicks_prev bigint, delta bigint)
language sql stable as $$
  with ids as (select id from sites where (p_site is null and tracked) or id = p_site),
  agg as (
    select q.query,
      sum(q.clicks) filter (where q.date >= current_date - p_days) now_c,
      sum(q.clicks) filter (where q.date <  current_date - p_days) prev_c
    from gsc_query_daily q
    where q.site_id in (select id from ids) and q.date >= current_date - 2 * p_days
    group by q.query
  ),
  d as (select agg.query, coalesce(now_c,0)::bigint n, coalesce(prev_c,0)::bigint p from agg)
  (select d.query, n, p, n - p from d where n - p > 0 order by n - p desc limit p_limit)
  union all
  (select d.query, n, p, n - p from d where n - p < 0 order by n - p asc limit p_limit);
$$;

create or replace function public.gsc_dims(p_site uuid, p_from date, p_to date, p_dim text, p_limit int default 15)
returns table (value text, clicks bigint, impressions bigint, avg_position real)
language sql stable as $$
  select g.value, sum(g.clicks)::bigint, sum(g.impressions)::bigint,
         (sum(g.position*g.impressions)/nullif(sum(g.impressions),0))::real
    from gsc_dim_daily g
   where g.dim = p_dim and g.date between p_from and p_to
     and g.site_id in (select id from sites where (p_site is null and tracked) or id = p_site)
   group by g.value order by 2 desc, 3 desc limit p_limit;
$$;

create or replace function public.ga4_sources(p_site uuid, p_from date, p_to date, p_limit int default 15)
returns table (source text, medium text, sessions bigint, users bigint)
language sql stable as $$
  select x.source, x.medium, sum(x.sessions)::bigint, sum(x.users)::bigint
    from ga4_source_daily x
   where x.date between p_from and p_to
     and x.site_id in (select id from sites where (p_site is null and tracked) or id = p_site)
   group by x.source, x.medium order by 3 desc limit p_limit;
$$;

create or replace function public.ga4_pages(p_site uuid, p_from date, p_to date, p_limit int default 50)
returns table (page text, views bigint, sessions bigint)
language sql stable as $$
  select x.page, sum(x.views)::bigint, sum(x.sessions)::bigint
    from ga4_page_monthly x
   where x.month between date_trunc('month', p_from)::date and p_to
     and x.site_id in (select id from sites where (p_site is null and tracked) or id = p_site)
   group by x.page order by 2 desc limit p_limit;
$$;

create or replace function public.sync_progress()
returns table (site_id uuid, queued bigint, running bigint, done bigint, failed bigint, last_error text)
language sql stable as $$
  select j.site_id,
    count(*) filter (where status = 'queued'),
    count(*) filter (where status = 'running'),
    count(*) filter (where status = 'done'),
    count(*) filter (where status = 'error'),
    (select error from sync_jobs e where e.site_id = j.site_id and e.status = 'error'
      order by updated_at desc limit 1)
  from sync_jobs j
  where j.created_at > now() - interval '30 days'
  group by j.site_id;
$$;

create or replace function public.workflow_health()
returns table (
  id text, name text, active boolean, watch boolean, expected_every_min int, tags jsonb,
  last_started timestamptz, last_status text, last_success timestamptz,
  runs_24h bigint, errors_24h bigint, runs_7d bigint, errors_7d bigint,
  avg_duration_s real, running_now bigint, running_since timestamptz
) language sql stable as $$
  select w.id, w.name, w.active, w.watch, w.expected_every_min, w.tags,
    (select max(started_at) from n8n_executions e where e.workflow_id = w.id),
    (select status from n8n_executions e where e.workflow_id = w.id order by started_at desc limit 1),
    (select max(started_at) from n8n_executions e where e.workflow_id = w.id and status = 'success'),
    (select count(*) from n8n_executions e where e.workflow_id = w.id and started_at > now() - interval '24 hours'),
    (select count(*) from n8n_executions e where e.workflow_id = w.id and started_at > now() - interval '24 hours'
       and status in ('error','crashed')),
    (select count(*) from n8n_executions e where e.workflow_id = w.id and started_at > now() - interval '7 days'),
    (select count(*) from n8n_executions e where e.workflow_id = w.id and started_at > now() - interval '7 days'
       and status in ('error','crashed')),
    (select avg(extract(epoch from stopped_at - started_at))::real from n8n_executions e
      where e.workflow_id = w.id and started_at > now() - interval '7 days' and stopped_at is not null),
    (select count(*) from n8n_executions e where e.workflow_id = w.id and status in ('running','waiting','new')),
    (select min(started_at) from n8n_executions e where e.workflow_id = w.id and status = 'running')
  from n8n_workflows w
  order by w.active desc, w.name;
$$;

create or replace function public.n8n_daily(p_days int default 14)
returns table (date date, success bigint, failed bigint)
language sql stable as $$
  select d::date,
    count(e.id) filter (where e.status = 'success'),
    count(e.id) filter (where e.status in ('error','crashed'))
  from generate_series(current_date - p_days + 1, current_date, interval '1 day') d
  left join (select e.* from n8n_executions e join n8n_workflows w on w.id = e.workflow_id and w.watch) e
    on e.started_at::date = d::date
  group by d order by d;
$$;

-- Housekeeping (called by cron)
create or replace function public.purge_old_data()
returns void language plpgsql security definer set search_path = public as $$
declare ret int := public.setting_int('gsc_daily_retention_days', 90);
begin
  delete from gsc_query_daily where date < current_date - ret;
  delete from gsc_page_daily  where date < current_date - ret;
  delete from n8n_executions  where started_at < now() - interval '60 days';
  delete from sync_jobs where status = 'done' and updated_at < now() - interval '14 days';
  delete from oauth_states where created_at < now() - interval '1 hour';
  delete from alerts where resolved_at < now() - interval '30 days';
end $$;
revoke all on function public.purge_old_data() from anon, authenticated, public;
