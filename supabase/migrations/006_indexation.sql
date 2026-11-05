-- Indexation Google des articles publiés (GSC URL Inspection API)
create table public.url_index (
  url text primary key,                 -- URL telle que publiée (WP URL du Sheet)
  url_key text not null,                -- forme normalisée pour les jointures (sans schéma, www, slash final)
  site_id uuid references public.sites(id) on delete cascade,
  article_id text,
  keyword text,
  first_seen_at timestamptz not null default now(),
  last_inspected_at timestamptz,
  next_check_at timestamptz not null default now(),
  verdict text,                         -- PASS | NEUTRAL | FAIL | PARTIAL | IMPRESSIONS
  coverage_state text,                  -- texte Google, ex. « Crawled - currently not indexed »
  indexing_state text,
  page_fetch_state text,
  robots_state text,
  last_crawl_at timestamptz,
  google_canonical text,
  user_canonical text,
  inspection_link text,
  indexed_at timestamptz,               -- première fois vue indexée
  error text,
  attempts int not null default 0
);
create index url_index_site on public.url_index (site_id);
create index url_index_due on public.url_index (next_check_at);
create index url_index_key on public.url_index (url_key);
alter table public.url_index enable row level security;
create policy "url_index read" on public.url_index for select to authenticated using (public.is_allowed());

create or replace function public.url_key(u text)
returns text language sql immutable as $$
  select rtrim(regexp_replace(regexp_replace(lower(coalesce(u,'')), '^[a-z]+://', ''), '^www\.', ''), '/');
$$;

create or replace function public.index_bucket(verdict text, coverage text)
returns text language sql immutable as $$
  -- Google renvoie coverageState dans la langue demandée (de-DE ici) : motifs anglais + allemands
  select case
    when verdict in ('PASS','IMPRESSIONS') then 'indexed'
    when verdict is null then 'pending'
    when coverage ilike '%404%' or coverage ilike '%not found%' or coverage ilike '%nicht gefunden%' then 'not_found'
    when coverage ilike '%crawled%not indexed%' or coverage ilike '%gecrawlt%' then 'crawled_not_indexed'
    when coverage ilike '%discovered%not indexed%' or coverage ilike '%gefunden%nicht indexiert%' then 'discovered_not_indexed'
    when coverage ilike '%unknown to google%' or coverage ilike '%nicht bekannt%' then 'unknown'
    when coverage ilike '%duplicate%' or coverage ilike '%canonical%' or coverage ilike '%duplikat%' or coverage ilike '%kanonisch%' then 'duplicate'
    when coverage ilike '%redirect%' or coverage ilike '%weiterleitung%' then 'redirect'
    when coverage ilike '%noindex%' or coverage ilike '%excluded%' or coverage ilike '%ausgeschlossen%' or coverage ilike '%blockiert%' then 'excluded'
    else 'other' end;
$$;

-- Ajoute les articles publiés du Sheet + marque « indexé » ceux qui ont déjà des impressions GSC (économise le quota)
create or replace function public.index_seed()
returns jsonb language plpgsql security definer set search_path = public as $$
declare added int := 0; shortcut int := 0;
begin
  with arts as (
    select a->>'url' url, a->>'id' aid, a->>'kw' kw
      from pipeline_state p, jsonb_array_elements(coalesce(p.data->'articleList','[]'::jsonb)) a
     where p.id = 1 and a->>'st' = 'published' and coalesce(a->>'url','') ~ '^https?://'
  ), mapped as (
    select distinct on (url_key(arts.url)) arts.url, url_key(arts.url) k, arts.aid, arts.kw, s.id site_id
      from arts left join sites s on s.domain = split_part(url_key(arts.url), '/', 1)
  ), ins as (
    insert into url_index (url, url_key, site_id, article_id, keyword)
    select m.url, m.k, m.site_id, m.aid, m.kw from mapped m
    where not exists (select 1 from url_index u where u.url_key = m.k)
    on conflict (url) do nothing
    returning 1
  ) select count(*) into added from ins;

  update url_index u set site_id = s.id
    from sites s where u.site_id is null and s.domain = split_part(u.url_key, '/', 1);

  with seen as (
    select url_key(page) k, min(date) d from gsc_page_daily where impressions > 0 group by 1
    union all
    select url_key(page), min(month) from gsc_page_monthly where impressions > 0 group by 1
  ), firsts as (select k, min(d) d from seen group by k),
  upd as (
    update url_index u set verdict = 'IMPRESSIONS', coverage_state = 'Vue dans les résultats Google (impressions Search Console)',
           indexed_at = coalesce(u.indexed_at, f.d::timestamptz), next_check_at = now() + interval '30 days', error = null
      from firsts f
     where f.k = u.url_key and (u.verdict is null or u.verdict not in ('PASS','IMPRESSIONS'))
    returning 1
  ) select count(*) into shortcut from upd;

  return jsonb_build_object('added', added, 'impressions_shortcut', shortcut);
end $$;
revoke all on function public.index_seed() from anon, authenticated, public;
grant execute on function public.index_seed() to service_role;

-- Prochain lot à inspecter, réparti entre les sites, dans la limite du quota journalier par propriété
create or replace function public.index_claim(p_n int, p_daily int)
returns table (url text, site_id uuid, site_url text, account_id uuid)
language sql security definer set search_path = public as $$
  with used as (
    select site_id, count(*) n from url_index
     where last_inspected_at >= date_trunc('day', now()) group by site_id
  ), due as (
    select u.url, u.site_id, g.site_url, g.account_id,
           row_number() over (partition by u.site_id order by (u.verdict is null) desc, u.first_seen_at desc) rn
      from url_index u
      join sites s on s.id = u.site_id and s.tracked
      join gsc_sites g on g.id = s.gsc_site_id
      left join used on used.site_id = u.site_id
     where u.next_check_at <= now() and coalesce(used.n, 0) < p_daily
  )
  select url, site_id, site_url, account_id from due
   order by rn, random() limit p_n;
$$;
revoke all on function public.index_claim(int, int) from anon, authenticated, public;
grant execute on function public.index_claim(int, int) to service_role;

create or replace function public.index_summary()
returns table (site_id uuid, domain text, total bigint, indexed bigint, pending bigint,
  crawled_not_indexed bigint, discovered_not_indexed bigint, unknown bigint, excluded bigint, other bigint,
  stale_not_indexed bigint, median_days_to_index real, inspected_today bigint, last_inspected_at timestamptz)
language sql stable set search_path = public as $$
  select s.id, s.domain,
    count(u.*),
    count(*) filter (where index_bucket(u.verdict, u.coverage_state) = 'indexed'),
    count(*) filter (where index_bucket(u.verdict, u.coverage_state) = 'pending'),
    count(*) filter (where index_bucket(u.verdict, u.coverage_state) = 'crawled_not_indexed'),
    count(*) filter (where index_bucket(u.verdict, u.coverage_state) = 'discovered_not_indexed'),
    count(*) filter (where index_bucket(u.verdict, u.coverage_state) = 'unknown'),
    count(*) filter (where index_bucket(u.verdict, u.coverage_state) in ('excluded','duplicate','redirect','not_found')),
    count(*) filter (where index_bucket(u.verdict, u.coverage_state) = 'other'),
    count(*) filter (where index_bucket(u.verdict, u.coverage_state) not in ('indexed','pending') and u.first_seen_at < now() - interval '14 days'),
    (percentile_cont(0.5) within group (order by extract(epoch from (u.indexed_at - u.first_seen_at)) / 86400)
       filter (where u.indexed_at is not null and u.indexed_at > u.first_seen_at))::real,
    count(*) filter (where u.last_inspected_at >= date_trunc('day', now())),
    max(u.last_inspected_at)
  from sites s join url_index u on u.site_id = s.id
  where s.tracked
  group by s.id, s.domain
  order by s.domain;
$$;

create or replace function public.index_list(p_site uuid, p_bucket text, p_limit int default 200)
returns table (url text, article_id text, keyword text, bucket text, verdict text, coverage_state text,
  first_seen_at timestamptz, last_inspected_at timestamptz, last_crawl_at timestamptz, indexed_at timestamptz,
  google_canonical text, inspection_link text, error text, domain text)
language sql stable set search_path = public as $$
  select u.url, u.article_id, u.keyword, index_bucket(u.verdict, u.coverage_state), u.verdict, u.coverage_state,
         u.first_seen_at, u.last_inspected_at, u.last_crawl_at, u.indexed_at, u.google_canonical, u.inspection_link, u.error, s.domain
    from url_index u join sites s on s.id = u.site_id
   where s.tracked and (p_site is null or u.site_id = p_site)
     and (p_bucket is null or p_bucket = 'all'
          or (p_bucket = 'not_indexed' and index_bucket(u.verdict, u.coverage_state) not in ('indexed','pending'))
          or index_bucket(u.verdict, u.coverage_state) = p_bucket)
   order by u.first_seen_at desc
   limit p_limit;
$$;

create or replace function public.index_timeline(p_site uuid, p_days int default 60)
returns table (date date, seen bigint, indexed bigint)
language sql stable set search_path = public as $$
  select d::date,
    (select count(*) from url_index u join sites s on s.id = u.site_id and s.tracked
      where (p_site is null or u.site_id = p_site) and u.first_seen_at::date = d::date),
    (select count(*) from url_index u join sites s on s.id = u.site_id and s.tracked
      where (p_site is null or u.site_id = p_site) and u.indexed_at::date = d::date)
  from generate_series(current_date - p_days + 1, current_date, interval '1 day') d
  order by 1;
$$;

insert into public.settings(key, value) values
  ('index_daily_per_site', '300'),
  ('index_alert_min', '25')
on conflict (key) do nothing;
