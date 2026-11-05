-- Blotato : comptes, programmés (futur), publiés (+ stats Pinterest), échecs
create table public.blotato_accounts (
  id text primary key,
  fullname text, username text, platform text,
  site text,                                  -- slug du blog (via Sites.pin_account du Sheet)
  last_published_scan_at timestamptz,
  synced_at timestamptz not null default now()
);
create table public.blotato_schedules (
  id text primary key,                        -- id de schedule (PATCH / DELETE /v2/schedules/{id})
  account_id text, site text,
  scheduled_at timestamptz not null,
  link text, link_key text, board_id text, title text, text text, media_url text,
  article_id text,
  synced_at timestamptz not null default now()
);
create index blotato_sched_at on public.blotato_schedules (scheduled_at);
create table public.blotato_published (
  id text primary key,
  account_id text, site text,
  post_url text, created_at timestamptz, content text, media_url text,
  link text, link_key text, board_id text, title text, article_id text,
  impressions int, saves int, pin_clicks int, clicks int, navigations int,
  metrics jsonb, metrics_at timestamptz,
  detail_at timestamptz,
  synced_at timestamptz not null default now()
);
create index blotato_pub_created on public.blotato_published (created_at desc);
create index blotato_pub_link on public.blotato_published (link_key);
create table public.blotato_failed (
  id text primary key,
  account_id text, site text, post_time timestamptz, error text, text text,
  synced_at timestamptz not null default now()
);
create table public.blotato_actions (
  id bigserial primary key,
  at timestamptz not null default now(),
  action text not null, schedule_id text, params jsonb, ok boolean, result jsonb
);
do $$
declare t text;
begin
  foreach t in array array['blotato_accounts','blotato_schedules','blotato_published','blotato_failed','blotato_actions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "%s read" on public.%I for select to authenticated using (public.is_allowed())', t, t);
  end loop;
end $$;

-- Rattache liens → articles (url_index) ; appelé par la fonction après chaque sync
create or replace function public.blotato_link_articles()
returns void language sql security definer set search_path = public as $$
  update blotato_schedules b set article_id = u.article_id
    from url_index u where b.article_id is null and b.link_key = u.url_key;
  update blotato_published b set article_id = u.article_id
    from url_index u where b.article_id is null and b.link_key = u.url_key;
$$;
revoke all on function public.blotato_link_articles() from anon, authenticated, public;
grant execute on function public.blotato_link_articles() to service_role;

-- Calendrier : passé (publiés, échecs) + futur (programmés), par site et par jour (fuseau Casablanca)
create or replace function public.blotato_calendar(p_past int default 14, p_next int default 14)
returns table (site text, day date, published bigint, failed bigint, scheduled bigint)
language sql stable set search_path = public as $$
  with days as (select d::date as day from generate_series(current_date - p_past, current_date + p_next, interval '1 day') d),
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

-- Rapprochement : planning du Sheet (pipeline_state.pins.cal) vs programmés chez Blotato, 14 prochains jours
create or replace function public.blotato_reconcile(p_next int default 14)
returns table (site text, day date, sheet bigint, blotato bigint)
language sql stable set search_path = public as $$
  with days as (select d::date as day from generate_series(current_date, current_date + p_next - 1, interval '1 day') d),
  sites as (
    select site from blotato_accounts where site is not null and platform = 'pinterest'
    union select jsonb_object_keys(coalesce((select data->'pins'->'cal' from pipeline_state where id = 1), '{}'::jsonb))
  )
  select s.site, d.day,
    coalesce(((select data->'pins'->'cal'->s.site->>(d.day::text) from pipeline_state where id = 1))::bigint, 0),
    (select count(*) from blotato_schedules x where x.site = s.site
       and (x.scheduled_at at time zone 'Africa/Casablanca')::date = d.day)
  from sites s cross join days d
  where s.site is not null and s.site <> '—'
  order by s.site, d.day;
$$;

-- Pins publiés les plus performants (stats Blotato / Pinterest)
create or replace function public.blotato_top_pins(p_site text, p_days int default 90, p_order text default 'impressions', p_limit int default 50)
returns table (id text, site text, created_at timestamptz, post_url text, title text, link text, article_id text,
  impressions int, saves int, pin_clicks int, clicks int, navigations int, metrics_at timestamptz)
language sql stable set search_path = public as $$
  select p.id, p.site, p.created_at, p.post_url, coalesce(p.title, left(p.content, 120)), p.link, p.article_id,
         p.impressions, p.saves, p.pin_clicks, p.clicks, p.navigations, p.metrics_at
    from blotato_published p
   where (p_site is null or p.site = p_site) and p.created_at >= now() - make_interval(days => p_days)
   order by case p_order when 'clicks' then coalesce(p.clicks,0) when 'saves' then coalesce(p.saves,0)
                         when 'pin_clicks' then coalesce(p.pin_clicks,0) else coalesce(p.impressions,0) end desc nulls last,
            p.created_at desc
   limit p_limit;
$$;

-- Totaux par site (période) pour les KPI Pinterest
create or replace function public.blotato_site_stats(p_days int default 30)
returns table (site text, account_id text, published bigint, failed bigint, scheduled_next7 bigint,
  impressions bigint, saves bigint, pin_clicks bigint, clicks bigint, ctr real, last_published timestamptz, next_scheduled timestamptz)
language sql stable set search_path = public as $$
  select a.site, a.id,
    (select count(*) from blotato_published p where p.account_id = a.id and p.created_at >= now() - make_interval(days => p_days)),
    (select count(*) from blotato_failed f where f.account_id = a.id and f.post_time >= now() - make_interval(days => p_days)),
    (select count(*) from blotato_schedules x where x.account_id = a.id and x.scheduled_at < now() + interval '7 days'),
    (select coalesce(sum(impressions),0) from blotato_published p where p.account_id = a.id and p.created_at >= now() - make_interval(days => p_days)),
    (select coalesce(sum(saves),0) from blotato_published p where p.account_id = a.id and p.created_at >= now() - make_interval(days => p_days)),
    (select coalesce(sum(pin_clicks),0) from blotato_published p where p.account_id = a.id and p.created_at >= now() - make_interval(days => p_days)),
    (select coalesce(sum(clicks),0) from blotato_published p where p.account_id = a.id and p.created_at >= now() - make_interval(days => p_days)),
    (select (sum(clicks)::real / nullif(sum(impressions),0))::real from blotato_published p where p.account_id = a.id and p.created_at >= now() - make_interval(days => p_days)),
    (select max(created_at) from blotato_published p where p.account_id = a.id),
    (select min(scheduled_at) from blotato_schedules x where x.account_id = a.id)
  from blotato_accounts a
  where a.platform = 'pinterest'
  order by a.site nulls last;
$$;

-- Par article : pins publiés + stats cumulées (attribution pin → article)
create or replace function public.blotato_article_stats(p_site text, p_limit int default 100)
returns table (article_id text, site text, keyword text, url text, pins bigint, impressions bigint, saves bigint,
  pin_clicks bigint, clicks bigint, last_pin timestamptz, indexed boolean)
language sql stable set search_path = public as $$
  select p.article_id, max(p.site), max(u.keyword), max(u.url), count(*), coalesce(sum(p.impressions),0),
         coalesce(sum(p.saves),0), coalesce(sum(p.pin_clicks),0), coalesce(sum(p.clicks),0), max(p.created_at),
         bool_or(index_bucket(u.verdict, u.coverage_state) = 'indexed')
    from blotato_published p left join url_index u on u.url_key = p.link_key
   where p.article_id is not null and (p_site is null or p.site = p_site)
   group by p.article_id
   order by coalesce(sum(p.clicks),0) desc, coalesce(sum(p.impressions),0) desc
   limit p_limit;
$$;

select cron.schedule('blotato-15min', '7,22,37,52 * * * *', $$select public.call_function('blotato', '{"action":"sync"}')$$);
select cron.schedule('index-10min', '*/10 * * * *', $$select public.call_function('index-sync', '{"action":"work"}')$$);
