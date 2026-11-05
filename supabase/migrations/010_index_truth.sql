-- Indexation v2 : la vérité = les sitemaps WordPress (articles réellement publiés), pas les URLs du Sheet.
-- Constat du 30/10 : sur 1 371 URLs du Sheet, seules 478 sont les vraies URLs. Les autres sont des liens
-- courts (?p=123) ou d'anciens slugs qui redirigent (slug changé, articles fusionnés) ; Google ne connaît que
-- l'URL finale. url_index ne contient plus que les URLs des sitemaps ; les URLs du Sheet vont dans url_alias,
-- résolues (redirection + canonique) puis reliées à leur vraie URL.

alter table public.url_index add column if not exists source text not null default 'sheet';
alter table public.url_index add column if not exists lastmod timestamptz;
alter table public.url_index add column if not exists sitemap_seen_at timestamptz;

create table if not exists public.url_alias (
  sheet_url text primary key,
  sheet_key text not null,
  site_id uuid references public.sites(id) on delete cascade,
  article_id text,
  keyword text,
  final_url text,            -- URL atteinte après redirections
  canonical text,            -- <link rel="canonical"> de la page
  target_key text,           -- url_key de la vraie URL (canonique, sinon finale)
  http_status int,
  checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists url_alias_due on public.url_alias (next_check_at);
create index if not exists url_alias_target on public.url_alias (target_key);
create index if not exists url_alias_sheet_key on public.url_alias (sheet_key);
alter table public.url_alias enable row level security;
drop policy if exists "url_alias read" on public.url_alias;
create policy "url_alias read" on public.url_alias for select to authenticated using (public.is_allowed());

-- Sitemap d'un site → url_index (ajout, mise à jour de lastmod, suppression des articles disparus).
-- p_urls = [{"loc":"https://…","lastmod":"2026-10-20T…"}]
create or replace function public.index_upsert_sitemap(p_site uuid, p_urls jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare added int; removed int; total int;
begin
  drop table if exists _sm;
  create temp table _sm on commit drop as
    select distinct on (url_key(x->>'loc')) x->>'loc' loc, url_key(x->>'loc') k, nullif(x->>'lastmod','')::timestamptz lm
      from jsonb_array_elements(p_urls) x where coalesce(x->>'loc','') ~ '^https?://';
  select count(*) into total from _sm;
  if total = 0 then return jsonb_build_object('total', 0, 'skipped', true); end if;

  -- URL déjà suivie sous une autre forme (http/www/slash) : on garde la ligne et ses inspections
  update url_index u set source = 'sitemap', lastmod = s.lm, sitemap_seen_at = now(), site_id = p_site
    from _sm s where u.url_key = s.k;
  with ins as (
    insert into url_index (url, url_key, site_id, source, lastmod, sitemap_seen_at, first_seen_at)
    select s.loc, s.k, p_site, 'sitemap', s.lm, now(), least(now(), coalesce(s.lm, now()))
      from _sm s where not exists (select 1 from url_index u where u.url_key = s.k)
    on conflict (url) do nothing returning 1
  ) select count(*) into added from ins;
  -- Plus dans le sitemap (dépublié, supprimé, ou URL du Sheet) → retiré du suivi
  with del as (
    delete from url_index u where u.site_id = p_site and not exists (select 1 from _sm s where s.k = u.url_key) returning 1
  ) select count(*) into removed from del;
  perform index_link_aliases();
  return jsonb_build_object('total', total, 'added', added, 'removed', removed);
end $$;
revoke all on function public.index_upsert_sitemap(uuid, jsonb) from anon, authenticated, public;
grant execute on function public.index_upsert_sitemap(uuid, jsonb) to service_role;

-- Sheet → url_alias (au lieu de url_index). Remplace index_seed (même nom : appelé par index-sync).
create or replace function public.index_seed()
returns jsonb language plpgsql security definer set search_path = public as $$
declare added int := 0;
begin
  with arts as (
    select a->>'url' url, a->>'id' aid, a->>'kw' kw
      from pipeline_state p, jsonb_array_elements(coalesce(p.data->'articleList','[]'::jsonb)) a
     where p.id = 1 and a->>'st' = 'published' and coalesce(a->>'url','') ~ '^https?://'
  ), ins as (
    insert into url_alias (sheet_url, sheet_key, site_id, article_id, keyword)
    select distinct on (arts.url) arts.url, url_key(arts.url),
           (select s.id from sites s where s.domain = split_part(regexp_replace(url_key(arts.url), '\?.*$', ''), '/', 1)),
           arts.aid, arts.kw
      from arts
    on conflict (sheet_url) do update set article_id = excluded.article_id, keyword = excluded.keyword
    returning (xmax = 0) as inserted
  ) select count(*) filter (where inserted) into added from ins;
  return jsonb_build_object('aliases_added', added);
end $$;
revoke all on function public.index_seed() from anon, authenticated, public;
grant execute on function public.index_seed() to service_role;

-- Relie chaque vraie URL à son article du Sheet (et marque « indexé » via les impressions GSC, sans quota).
create or replace function public.index_link_aliases()
returns jsonb language plpgsql security definer set search_path = public as $$
declare linked int; shortcut int;
begin
  with best as (
    select distinct on (coalesce(a.target_key, a.sheet_key)) coalesce(a.target_key, a.sheet_key) k, a.article_id, a.keyword
      from url_alias a where a.article_id is not null
     order by coalesce(a.target_key, a.sheet_key), (a.target_key is not null) desc, a.created_at
  ), upd as (
    update url_index u set article_id = b.article_id, keyword = b.keyword
      from best b where u.url_key = b.k and (u.article_id is distinct from b.article_id)
    returning 1
  ) select count(*) into linked from upd;

  with seen as (
    select url_key(page) k, min(date) d from gsc_page_daily where impressions > 0 group by 1
    union all select url_key(page), min(month) from gsc_page_monthly where impressions > 0 group by 1
  ), firsts as (select k, min(d) d from seen group by k),
  upd2 as (
    update url_index u set verdict = 'IMPRESSIONS', coverage_state = 'Vue dans les résultats Google (impressions Search Console)',
           indexed_at = coalesce(u.indexed_at, f.d::timestamptz), next_check_at = greatest(u.next_check_at, now() + interval '30 days'), error = null
      from firsts f where f.k = u.url_key and (u.verdict is null or u.verdict not in ('PASS','IMPRESSIONS'))
    returning 1
  ) select count(*) into shortcut from upd2;
  return jsonb_build_object('linked', linked, 'impressions_shortcut', shortcut);
end $$;
revoke all on function public.index_link_aliases() from anon, authenticated, public;
grant execute on function public.index_link_aliases() to service_role;

-- Lot d'alias à résoudre (nouveaux, puis revérifiés tous les 7 jours).
create or replace function public.alias_claim(p_n int)
returns table (sheet_url text) language sql security definer set search_path = public as $$
  select sheet_url from url_alias where next_check_at <= now() order by checked_at nulls first, created_at limit p_n;
$$;
revoke all on function public.alias_claim(int) from anon, authenticated, public;
grant execute on function public.alias_claim(int) to service_role;

-- Pins → articles : via la vraie URL ou via l'URL du Sheet (les pins pointent souvent vers l'ancien slug).
create or replace function public.blotato_link_articles()
returns void language sql security definer set search_path = public as $$
  update blotato_schedules b set article_id = coalesce(u.article_id, a.article_id)
    from url_alias a left join url_index u on u.url_key = a.target_key
   where b.article_id is null and (b.link_key = a.sheet_key or b.link_key = a.target_key);
  update blotato_schedules b set article_id = u.article_id
    from url_index u where b.article_id is null and b.link_key = u.url_key and u.article_id is not null;
  update blotato_published b set article_id = coalesce(u.article_id, a.article_id)
    from url_alias a left join url_index u on u.url_key = a.target_key
   where b.article_id is null and (b.link_key = a.sheet_key or b.link_key = a.target_key);
  update blotato_published b set article_id = u.article_id
    from url_index u where b.article_id is null and b.link_key = u.url_key and u.article_id is not null;
$$;

create or replace function public.blotato_article_stats(p_site text, p_limit int default 100)
returns table (article_id text, site text, keyword text, url text, pins bigint, impressions bigint, saves bigint,
  pin_clicks bigint, clicks bigint, last_pin timestamptz, indexed boolean)
language sql stable set search_path = public as $$
  with art as (
    select a.article_id, max(a.keyword) keyword, max(coalesce(u.url, a.final_url, a.sheet_url)) url,
           bool_or(index_bucket(u.verdict, u.coverage_state) = 'indexed') indexed
      from url_alias a left join url_index u on u.url_key = a.target_key
     group by a.article_id
  )
  select p.article_id, max(p.site), max(art.keyword), max(art.url), count(*), coalesce(sum(p.impressions),0),
         coalesce(sum(p.saves),0), coalesce(sum(p.pin_clicks),0), coalesce(sum(p.clicks),0), max(p.created_at), bool_or(art.indexed)
    from blotato_published p left join art on art.article_id = p.article_id
   where p.article_id is not null and (p_site is null or p.site = p_site)
   group by p.article_id
   order by coalesce(sum(p.clicks),0) desc, coalesce(sum(p.impressions),0) desc
   limit p_limit;
$$;

-- Rapport « à corriger dans le Sheet » : URL du Sheet ≠ vraie URL.
create or replace function public.sheet_url_fixes(p_site uuid default null)
returns table (article_id text, keyword text, domain text, sheet_url text, real_url text, http_status int, issue text, shared_with bigint)
language sql stable set search_path = public as $$
  select a.article_id, a.keyword, s.domain, a.sheet_url, coalesce(u.url, a.canonical, a.final_url), a.http_status,
    case
      when a.checked_at is null then 'pas encore vérifiée'
      when a.http_status = 404 then 'page introuvable (404)'
      when a.http_status >= 500 or a.http_status is null then 'erreur serveur'
      when a.sheet_key ~ '[?&]p=\d+' then 'lien court ?p= au lieu de la vraie URL'
      when u.url_key is null then 'URL finale absente du sitemap'
      else 'redirige vers une autre URL (slug changé)' end,
    (select count(*) from url_alias b where b.target_key = a.target_key and b.article_id is distinct from a.article_id)
  from url_alias a join sites s on s.id = a.site_id
  left join url_index u on u.url_key = a.target_key
  where (p_site is null or a.site_id = p_site)
    and (a.checked_at is null or a.http_status is distinct from 200 or a.target_key is distinct from a.sheet_key)
  order by s.domain, a.article_id;
$$;

insert into public.settings(key, value) values ('index_sitemap_hours', '6') on conflict (key) do nothing;
