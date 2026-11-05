-- Agent du dashboard : suivi de consommation DeepSeek + réglages
create table public.agent_usage (
  day date primary key,
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  calls int not null default 0
);
alter table public.agent_usage enable row level security;
create policy "agent_usage read" on public.agent_usage for select to authenticated using (public.is_allowed());

create or replace function public.agent_track(p_day date, p_prompt bigint, p_completion bigint)
returns void language sql security definer set search_path = public as $$
  insert into agent_usage(day, prompt_tokens, completion_tokens, calls) values (p_day, p_prompt, p_completion, 1)
  on conflict (day) do update set prompt_tokens = agent_usage.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = agent_usage.completion_tokens + excluded.completion_tokens, calls = agent_usage.calls + 1;
$$;
revoke all on function public.agent_track(date, bigint, bigint) from anon, authenticated, public;
grant execute on function public.agent_track(date, bigint, bigint) to service_role;

insert into public.settings(key, value) values
  ('agent_daily_tokens', '400000'),
  ('agent_model', '"deepseek-chat"')
on conflict (key) do nothing;

-- (optionnel) nettoyage de la copie de la spec Blotato utilisée pendant le développement :
-- drop schema if exists scratch cascade;
