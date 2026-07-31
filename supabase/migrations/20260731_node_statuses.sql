-- Drive Audit Map scalable status storage
-- Stores one row per node path to avoid oversized JSON payload updates.

create table if not exists public.node_statuses (
  node_path text primary key,
  status text not null,
  updated_at timestamptz not null default now(),
  constraint node_statuses_status_check check (status in ('green', 'yellow', 'red', 'none'))
);

create or replace function public.node_statuses_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists node_statuses_set_updated_at on public.node_statuses;
create trigger node_statuses_set_updated_at
before update on public.node_statuses
for each row
execute function public.node_statuses_set_updated_at();

alter table public.node_statuses enable row level security;

drop policy if exists "node_statuses_select_all" on public.node_statuses;
drop policy if exists "node_statuses_insert_all" on public.node_statuses;
drop policy if exists "node_statuses_update_all" on public.node_statuses;

create policy "node_statuses_select_all"
on public.node_statuses
for select
to anon, authenticated
using (true);

create policy "node_statuses_insert_all"
on public.node_statuses
for insert
to anon, authenticated
with check (true);

create policy "node_statuses_update_all"
on public.node_statuses
for update
to anon, authenticated
using (true)
with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update on table public.node_statuses to anon, authenticated;
