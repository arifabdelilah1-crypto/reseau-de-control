-- Résolution des URLs du Sheet : verrou (deux passages en même temps ne prennent pas les mêmes URLs) + cron 2 min.
create or replace function public.alias_claim(p_n int)
returns table (sheet_url text) language sql security definer set search_path = public as $$
  update url_alias a set next_check_at = now() + interval '15 minutes'
   where a.sheet_url in (
     select x.sheet_url from url_alias x where x.next_check_at <= now()
      order by x.checked_at nulls first, x.created_at limit p_n for update skip locked)
  returning a.sheet_url;
$$;
revoke all on function public.alias_claim(int) from anon, authenticated, public;
grant execute on function public.alias_claim(int) to service_role;
select cron.schedule('index-aliases-2min', '1-59/2 * * * *', $$select public.call_function('index-sync', '{"action":"aliases"}')$$);
