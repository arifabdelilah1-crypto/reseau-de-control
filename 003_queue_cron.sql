-- Queue insert that skips duplicates of jobs already queued/running
create or replace function public.enqueue_sync_jobs(p_jobs jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.sync_jobs (site_id, kind, start_date, end_date, priority)
  select (j->>'site_id')::uuid, j->>'kind', (j->>'start_date')::date, (j->>'end_date')::date,
         coalesce((j->>'priority')::int, 5)
    from jsonb_array_elements(p_jobs) j
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.enqueue_sync_jobs(jsonb) from anon, authenticated, public;

-- Helper used by cron: call an edge function with the cron secret
create or replace function public.call_function(p_name text, p_body jsonb)
returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := (select value from public.app_secrets where name = 'functions_url') || '/' || p_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.app_secrets where name = 'cron_secret')),
    body := p_body,
    timeout_milliseconds := 150000
  );
$$;
revoke all on function public.call_function(text, jsonb) from anon, authenticated, public;

select cron.schedule('ops-sync-5min',   '*/5 * * * *', $$select public.call_function('ops-sync', '{"action":"run"}')$$);
select cron.schedule('seo-worker-2min', '*/2 * * * *', $$select public.call_function('seo-sync', '{"action":"work"}')$$);
select cron.schedule('seo-daily',       '17 5 * * *',  $$select public.call_function('seo-sync', '{"action":"daily"}')$$);

grant execute on function public.claim_sync_jobs(int), public.enqueue_sync_jobs(jsonb), public.purge_old_data() to service_role;
