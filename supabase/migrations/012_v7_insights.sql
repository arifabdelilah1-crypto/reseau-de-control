-- v7 : Volume vs portée Pinterest, liens cassés par article, historique d'indexation, alertes sitemap séparées.

-- Alertes sitemap : type dédié (avant : rangées avec « Indexation »)
update public.alerts set kind = 'sitemap_error' where fingerprint like 'sitemap:%' and kind <> 'sitemap_error';

-- Pinterest : par jour de publication (Casablanca) → pins, impressions / pin, clics. Les stats d'un pin
-- montent pendant plusieurs jours : « mature » = publié il y a ≥ 7 jours.
create or replace function public.blotato_volume_reach(p_days int default 90, p_site text default null)
returns table (day date, pins bigint, accounts bigint, impressions bigint, clicks bigint, saves bigint, impr_per_pin real, ctr real, mature boolean)
language sql stable set search_path = public as $$
  select (p.created_at at time zone 'Africa/Casablanca')::date d, count(*), count(distinct p.account_id),
         coalesce(sum(p.impressions),0), coalesce(sum(p.clicks),0), coalesce(sum(p.saves),0),
         (sum(p.impressions)::real / nullif(count(*),0))::real,
         (sum(p.clicks)::real / nullif(sum(p.impressions),0))::real,
         (p.created_at at time zone 'Africa/Casablanca')::date <= (now() at time zone 'Africa/Casablanca')::date - 7
    from blotato_published p
   where p.created_at >= now() - make_interval(days => p_days) and (p_site is null or p.site = p_site)
   group by 1, (p.created_at at time zone 'Africa/Casablanca')::date <= (now() at time zone 'Africa/Casablanca')::date - 7
   order by 1;
$$;

-- Par compte : rythme récent (7 j) vs avant, et portée des pins « mûrs » (publiés il y a 7 à 35 j) vs 35 à 90 j.
create or replace function public.blotato_account_reach()
returns table (site text, account_id text, pins_7d bigint, per_day_7d real, pins_prev bigint, per_day_prev real,
  impr_per_pin_recent real, impr_per_pin_before real, ctr_recent real, clicks_recent bigint, verdict text)
language sql stable set search_path = public as $$
  with b as (
    select a.site, a.id,
      count(*) filter (where p.created_at >= now() - interval '7 days') n7,
      count(*) filter (where p.created_at <  now() - interval '7 days' and p.created_at >= now() - interval '35 days') nprev,
      avg(p.impressions) filter (where p.created_at < now() - interval '7 days' and p.created_at >= now() - interval '35 days') ir,
      avg(p.impressions) filter (where p.created_at < now() - interval '35 days' and p.created_at >= now() - interval '90 days') ib,
      sum(p.clicks) filter (where p.created_at < now() - interval '7 days' and p.created_at >= now() - interval '35 days') cr,
      sum(p.impressions) filter (where p.created_at < now() - interval '7 days' and p.created_at >= now() - interval '35 days') imr
    from blotato_accounts a left join blotato_published p on p.account_id = a.id
    where a.platform = 'pinterest' group by a.site, a.id
  )
  select site, id, n7, (n7 / 7.0)::real, nprev, (nprev / 28.0)::real, ir::real, ib::real,
         (cr::real / nullif(imr,0))::real, coalesce(cr,0),
         case when n7 / 7.0 > 8 and coalesce(ir,0) < 5 then 'trop de pins, portée écrasée'
              when ib is not null and ir is not null and ir < ib * 0.4 then 'portée en chute'
              when n7 = 0 then 'aucun pin cette semaine'
              else 'ok' end
  from b order by site;
$$;

-- Liens des articles du Sheet : statut de l'URL (404, ?p=, redirection) — badges Pipeline / Pinterest.
create or replace function public.article_link_health()
returns table (article_id text, sheet_url text, sheet_key text, real_url text, http_status int, issue text)
language sql stable set search_path = public as $$
  select a.article_id, a.sheet_url, a.sheet_key, coalesce(u.url, a.canonical, a.final_url), a.http_status,
    case when a.checked_at is null then null
         when a.http_status = 404 then '404'
         when a.http_status >= 500 or a.http_status is null then 'erreur'
         when a.sheet_key ~ '[?&]p=\d+' then 'lien court'
         when a.target_key is distinct from a.sheet_key then 'redirection'
         else null end
  from url_alias a left join url_index u on u.url_key = a.target_key
  where a.checked_at is not null
    and (a.http_status is distinct from 200 or a.target_key is distinct from a.sheet_key);
$$;

-- Historique d'indexation (1 ligne / site / jour) pour la courbe « % indexé »
create table if not exists public.index_daily (
  day date not null, site_id uuid not null references public.sites(id) on delete cascade,
  total int not null, indexed int not null, unknown int not null, pending int not null,
  primary key (day, site_id)
);
alter table public.index_daily enable row level security;
drop policy if exists "index_daily read" on public.index_daily;
create policy "index_daily read" on public.index_daily for select to authenticated using (public.is_allowed());

create or replace function public.index_snapshot()
returns int language sql security definer set search_path = public as $$
  with s as (
    insert into index_daily (day, site_id, total, indexed, unknown, pending)
    select (now() at time zone 'Africa/Casablanca')::date, u.site_id, count(*),
           count(*) filter (where index_bucket(u.verdict, u.coverage_state) = 'indexed'),
           count(*) filter (where index_bucket(u.verdict, u.coverage_state) = 'unknown'),
           count(*) filter (where u.verdict is null)
      from url_index u join sites st on st.id = u.site_id and st.tracked group by u.site_id
    on conflict (day, site_id) do update set total = excluded.total, indexed = excluded.indexed, unknown = excluded.unknown, pending = excluded.pending
    returning 1
  ) select count(*)::int from s;
$$;
revoke all on function public.index_snapshot() from anon, authenticated, public;
grant execute on function public.index_snapshot() to service_role;
select public.index_snapshot();
select cron.schedule('index-snapshot-hourly', '43 * * * *', $$select public.index_snapshot()$$);

create or replace function public.index_trend(p_site uuid default null, p_days int default 90)
returns table (day date, total bigint, indexed bigint, unknown bigint, rate real)
language sql stable set search_path = public as $$
  select d.day, sum(d.total), sum(d.indexed), sum(d.unknown), (sum(d.indexed)::real / nullif(sum(d.total),0))::real
    from index_daily d join sites s on s.id = d.site_id and s.tracked
   where (p_site is null or d.site_id = p_site) and d.day >= current_date - p_days
   group by d.day order by d.day;
$$;
