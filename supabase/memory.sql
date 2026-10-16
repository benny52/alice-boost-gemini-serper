-- Run once in the Supabase SQL Editor. Compatible with the earlier history-only table.
begin;

create table if not exists public.alice_memory (
  conversation_id text primary key,
  history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.alice_memory
  add column if not exists search jsonb not null default '{}'::jsonb,
  add column if not exists revision bigint not null default 0;

alter table public.alice_memory enable row level security;
revoke all on table public.alice_memory from public, anon, authenticated;
grant select, insert, update on table public.alice_memory to service_role;

commit;
