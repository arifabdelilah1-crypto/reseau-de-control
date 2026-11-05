-- Pipeline (Google Sheet via Apps Script) : dernier état connu + historique léger
create table public.pipeline_state (
  id int primary key default 1 check (id = 1),
  data jsonb,
  ok boolean not null default false,
  error text,
  ms int,
  taken_at timestamptz not null default now()
);
alter table public.pipeline_state enable row level security;
create policy "pipeline read" on public.pipeline_state for select to authenticated using (public.is_allowed());

create table public.pipeline_history (
  taken_at timestamptz primary key default now(),
  metrics jsonb not null
);
alter table public.pipeline_history enable row level security;
create policy "pipeline hist read" on public.pipeline_history for select to authenticated using (public.is_allowed());

insert into public.settings(key, value) values
  ('pipeline_failed_alert', '10'),
  ('pipeline_pin_gap_hours', '48')
on conflict (key) do nothing;

select cron.schedule('pipeline-15min', '*/15 * * * *', $$select public.call_function('pipeline', '{"action":"refresh"}')$$);
