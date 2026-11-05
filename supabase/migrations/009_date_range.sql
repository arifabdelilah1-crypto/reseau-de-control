-- Filtre de dates (calendrier du dashboard) : versions « du … au … » des fonctions de lecture.
-- Les anciennes fonctions (p_days = jours glissants) restent en place : rien ne casse.
-- Jours Pinterest / n8n / indexation comptés à l'heure de Casablanca, jours Google = dates GSC/GA4.

-- Vue d'ensemble par site sur une période, comparée à la période de même durée juste avant.
-- p_spark_from : début de la mini-courbe (par défaut = p_from) ; utile pour un seul jour (contexte 28 j).
create or replace function public.site_overview_range(p_from date, p_to date, p_spark_from date default null)
returns table (
  site_id uuid, domain text, label text, tracked boolean, has_gsc boolean, has_ga4 boolean,
  clicks bigint, clicks_prev bigint, impressions bigint, impressions_prev bigint, avg_position real,
  sessions bigint, sessions_prev bigint, pinterest_sessions bigint, pinterest_sessions_prev bigint,
  spark jsonb, last_sync_at timestamptz, last_sync_error text
) language sql stable set search_path = public as $$
  with r as (
    select p_from as s, p_to as e, p_from - 1 as pe, p_from - (p_to - p_from + 1) as ps,
           least(coalesce(p_spark_from, p_from), p_from) as ss
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
       from r cross join lateral generate_series(r.ss, r.e, interval '1 day') d(d)
       left join gsc_daily g on g.site_id = st.id and g.date = d.d::date),
    st.last_sync_at, st.last_sync_error
  from sites st
  order by st.tracked desc, st.domain;
$$;

-- Gagnants / perdants : période choisie vs période de même durée juste avant (détail quotidien).
create or replace function public.query_movers_range(p_site uuid, p_from date, p_to date, p_limit int default 15)
returns table (query text, clicks_now bigint, clicks_prev bigint, delta bigint)
language sql stable set search_path = public as $$
  with ids as (select id from sites where (p_site is null and tracked) or id = p_site),
  agg as (
    select q.query,
      sum(q.clicks) filter (where q.date between p_from and p_to) now_c,
      sum(q.clicks) filter (where q.date < p_from) prev_c
    from gsc_query_daily q
    where q.site_id in (select id from ids)
      and q.date between p_from - (p_to - p_from + 1) and p_to
    group by q.query
  ),
  d as (select agg.query, coalesce(now_c,0)::bigint n, coalesce(prev_c,0)::bigint p from agg)
  (select d.query, n, p, n - p from d where n - p > 0 order by n - p desc limit p_limit)
  union all
  (select d.query, n, p, n - p from d where n - p < 0 order by n - p asc limit p_limit);
$$;

-- Exécutions n8n par jour (workflows surveillés) entre deux dates.
create or replace function public.n8n_range(p_from date, p_to date)
returns table (date date, success bigint, failed bigint)
language sql stable set search_path = public as $$
  select d::date,
    count(e.id) filter (where e.status = 'success'),
    count(e.id) filter (where e.status in ('error','crashed'))
  from generate_series(p_from, p_to, interval '1 day') d
  left join (select e.* from n8n_executions e join n8n_workflows w on w.id = e.workflow_id and w.watch) e
    on (e.started_at at time zone 'Africa/Casablanca')::date = d::date
  group by d order by d;
$$;

-- Indexation : courbe entre deux dates.
create or replace function public.index_timeline_range(p_site uuid, p_from date, p_to date)
returns table (date date, seen bigint, indexed bigint, inspected bigint)
language sql stable set search_path = public as $$
  select d::date,
    (select count(*) from url_index u join sites s on s.id = u.site_id and s.tracked
      where (p_site is null or u.site_id = p_site) and (u.first_seen_at at time zone 'Africa/Casablanca')::date = d::date),
    (select count(*) from url_index u join sites s on s.id = u.site_id and s.tracked
      where (p_site is null or u.site_id = p_site) and (u.indexed_at at time zone 'Africa/Casablanca')::date = d::date),
    (select count(*) from url_index u join sites s on s.id = u.site_id and s.tracked
      where (p_site is null or u.site_id = p_site) and (u.last_inspected_at at time zone 'Africa/Casablanca')::date = d::date)
  from generate_series(p_from, p_to, interval '1 day') d
  order by 1;
$$;

-- Indexation : URLs avec de l'activité sur la période (nouvelle, vue indexée, ou inspectée).
create or replace function public.index_list_range(p_site uuid, p_from date, p_to date, p_limit int default 1000)
returns table (url text, article_id text, keyword text, bucket text, verdict text, coverage_state text,
  first_seen_at timestamptz, last_inspected_at timestamptz, last_crawl_at timestamptz, indexed_at timestamptz,
  google_canonical text, inspection_link text, error text, domain text, event text)
language sql stable set search_path = public as $$
  with x as (
    select u.*, s.domain dom,
      (u.first_seen_at at time zone 'Africa/Casablanca')::date between p_from and p_to as e_new,
      (u.indexed_at at time zone 'Africa/Casablanca')::date between p_from and p_to as e_idx,
      (u.last_inspected_at at time zone 'Africa/Casablanca')::date between p_from and p_to as e_ins
    from url_index u join sites s on s.id = u.site_id
    where s.tracked and (p_site is null or u.site_id = p_site)
  )
  select url, article_id, keyword, index_bucket(verdict, coverage_state), verdict, coverage_state,
         first_seen_at, last_inspected_at, last_crawl_at, indexed_at, google_canonical, inspection_link, error, dom,
         concat_ws(' · ', case when e_new then 'nouvel article' end, case when e_idx then 'indexé' end, case when e_ins then 'inspecté' end)
    from x
   where coalesce(e_new, false) or coalesce(e_idx, false) or coalesce(e_ins, false)
   order by coalesce(indexed_at, last_inspected_at, first_seen_at) desc
   limit p_limit;
$$;

-- Pinterest : totaux par compte entre deux dates (jours de Casablanca).
create or replace function public.blotato_site_stats_range(p_from date, p_to date)
returns table (site text, account_id text, published bigint, failed bigint, scheduled_next7 bigint,
  impressions bigint, saves bigint, pin_clicks bigint, clicks bigint, ctr real, last_published timestamptz, next_scheduled timestamptz)
language sql stable set search_path = public as $$
  with pub as (
    select * from blotato_published p
     where (p.created_at at time zone 'Africa/Casablanca')::date between p_from and p_to
  )
  select a.site, a.id,
    (select count(*) from pub p where p.account_id = a.id),
    (select count(*) from blotato_failed f where f.account_id = a.id
       and (f.post_time at time zone 'Africa/Casablanca')::date between p_from and p_to),
    (select count(*) from blotato_schedules x where x.account_id = a.id and x.scheduled_at < now() + interval '7 days'),
    (select coalesce(sum(impressions),0) from pub p where p.account_id = a.id),
    (select coalesce(sum(saves),0) from pub p where p.account_id = a.id),
    (select coalesce(sum(pin_clicks),0) from pub p where p.account_id = a.id),
    (select coalesce(sum(clicks),0) from pub p where p.account_id = a.id),
    (select (sum(clicks)::real / nullif(sum(impressions),0))::real from pub p where p.account_id = a.id),
    (select max(created_at) from pub p where p.account_id = a.id),
    (select min(scheduled_at) from blotato_schedules x where x.account_id = a.id)
  from blotato_accounts a
  where a.platform = 'pinterest'
  order by a.site nulls last;
$$;

-- Pinterest : publiés / échecs / programmés par compte et par jour entre deux dates.
create or replace function public.blotato_calendar_range(p_from date, p_to date)
returns table (site text, day date, published bigint, failed bigint, scheduled bigint)
language sql stable set search_path = public as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  sites as (select distinct coalesce(site, id) site from blotato_accounts where platform = 'pinterest')
  select s.site, d.day,
    (select count(*) from blotato_published p where coalesce(p.site, p.account_id) = s.site
       and (p.created_at at time zone 'Africa/Casablanca')::date = d.day),
    (select count(*) from blotato_failed f where coalesce(f.site, f.account_id) = s.site
       and (f.post_time at time zone 'Africa/Casablanca')::date = d.day),
    (select count(*) from blotato_schedules x where coalesce(x.site, x.account_id) = s.site
       and (x.scheduled_at at time zone 'Africa/Casablanca')::date = d.day)
  from sites s cross join days d
  order by s.site, d.day;
$$;

-- Pinterest : pins publiés entre deux dates, triés par performance.
create or replace function public.blotato_top_pins_range(p_site text, p_from date, p_to date, p_order text default 'impressions', p_limit int default 100)
returns table (id text, site text, created_at timestamptz, post_url text, title text, link text, article_id text,
  impressions int, saves int, pin_clicks int, clicks int, navigations int, metrics_at timestamptz)
language sql stable set search_path = public as $$
  select p.id, p.site, p.created_at, p.post_url, coalesce(p.title, left(p.content, 120)), p.link, p.article_id,
         p.impressions, p.saves, p.pin_clicks, p.clicks, p.navigations, p.metrics_at
    from blotato_published p
   where (p_site is null or p.site = p_site)
     and (p.created_at at time zone 'Africa/Casablanca')::date between p_from and p_to
   order by case p_order when 'clicks' then coalesce(p.clicks,0) when 'saves' then coalesce(p.saves,0)
                         when 'pin_clicks' then coalesce(p.pin_clicks,0) else coalesce(p.impressions,0) end desc nulls last,
            p.created_at desc
   limit p_limit;
$$;

-- Pipeline : relevés horaires du Sheet (pipeline_history) résumés par jour : début et fin de journée.
create or replace function public.pipeline_days(p_from date, p_to date)
returns table (day date, first_at timestamptz, last_at timestamptz, first_metrics jsonb, last_metrics jsonb, snapshots bigint)
language sql stable set search_path = public as $$
  with h as (
    select (taken_at at time zone 'Africa/Casablanca')::date d, taken_at, metrics
      from pipeline_history
     where (taken_at at time zone 'Africa/Casablanca')::date between p_from - 1 and p_to
  )
  select d.day::date,
    (select min(taken_at) from h where h.d = d.day::date),
    (select max(taken_at) from h where h.d = d.day::date),
    -- début de journée = dernier relevé de la veille s'il existe, sinon premier du jour
    coalesce((select metrics from h where h.d = d.day::date - 1 order by taken_at desc limit 1),
             (select metrics from h where h.d = d.day::date order by taken_at limit 1)),
    (select metrics from h where h.d = d.day::date order by taken_at desc limit 1),
    (select count(*) from h where h.d = d.day::date)
  from generate_series(p_from, p_to, interval '1 day') d(day)
  order by 1;
$$;
