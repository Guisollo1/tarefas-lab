-- =====================================================================
-- LFR PLANEJAMENTO ONLINE V3 — SUPABASE
-- Execute todo este arquivo no SQL Editor do seu projeto Supabase.
-- Atualizado para o comportamento do Supabase em agosto de 2026:
-- inclui GRANT explícito, RLS e Realtime.
-- =====================================================================

begin;

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table if not exists public.workspaces (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  color text not null default '#0b5cab',
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,workspace_id)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 140),
  description text,
  due_date date not null,
  priority text not null default 'media' check (priority in ('alta','media','baixa')),
  status text not null default 'afazer' check (status in ('planejado','afazer','andamento','concluido')),
  category text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,workspace_id)
);

create table if not exists public.task_assignees (
  workspace_id uuid not null,
  task_id uuid not null,
  person_id uuid not null,
  done boolean not null default false,
  done_at timestamptz,
  done_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (task_id,person_id),
  foreign key (task_id,workspace_id) references public.tasks(id,workspace_id) on delete cascade,
  foreign key (person_id,workspace_id) references public.people(id,workspace_id) on delete restrict
);

insert into public.workspaces (id,name)
values ('11111111-1111-4111-8111-111111111111','Planejamento LFR')
on conflict (id) do update set name=excluded.name;

create index if not exists workspace_members_user_idx on public.workspace_members(user_id,workspace_id);
create index if not exists people_workspace_active_name_idx on public.people(workspace_id,active,name);
create unique index if not exists people_workspace_name_unique on public.people(workspace_id,lower(name)) where active;
create index if not exists tasks_workspace_due_status_idx on public.tasks(workspace_id,due_date,status);
create index if not exists tasks_workspace_updated_idx on public.tasks(workspace_id,updated_at desc);
create index if not exists task_assignees_workspace_task_idx on public.task_assignees(workspace_id,task_id);
create index if not exists task_assignees_workspace_person_idx on public.task_assignees(workspace_id,person_id);

create or replace function private.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id=target_workspace
      and wm.user_id=(select auth.uid())
  );
$$;

create or replace function private.is_workspace_owner(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id=target_workspace
      and wm.user_id=(select auth.uid())
      and wm.role='owner'
  );
$$;

revoke all on function private.is_workspace_member(uuid) from public,anon;
revoke all on function private.is_workspace_owner(uuid) from public,anon;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.is_workspace_owner(uuid) to authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public,anon;
grant execute on function private.set_updated_at() to authenticated;

drop trigger if exists people_set_updated_at on public.people;
create trigger people_set_updated_at before update on public.people for each row execute function private.set_updated_at();
drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks for each row execute function private.set_updated_at();

-- Função administrativa para liberar um usuário já criado no Supabase Auth.
-- Ela não é executável pelo navegador; use somente no SQL Editor.
create or replace function private.add_user_to_lfr_workspace(
  user_email text,
  member_role text default 'member'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_workspace constant uuid := '11111111-1111-4111-8111-111111111111';
  target_user uuid;
begin
  if member_role not in ('owner','member') then
    raise exception 'Função inválida. Use owner ou member.';
  end if;
  select id into target_user from auth.users where lower(email)=lower(trim(user_email)) limit 1;
  if target_user is null then
    raise exception 'Usuário % não encontrado em Authentication > Users.',user_email;
  end if;
  insert into public.workspace_members(workspace_id,user_id,role)
  values(target_workspace,target_user,member_role)
  on conflict(workspace_id,user_id) do update set role=excluded.role;
  return target_user;
end;
$$;

revoke all on function private.add_user_to_lfr_workspace(text,text) from public,anon,authenticated;

-- Usuários que já existiam quando este schema foi instalado são incluídos.
insert into public.workspace_members(workspace_id,user_id,role)
select '11111111-1111-4111-8111-111111111111',u.id,
  case when u.id=(select id from auth.users order by created_at,id limit 1) then 'owner' else 'member' end
from auth.users u
on conflict(workspace_id,user_id) do nothing;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.people enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;

-- Recria políticas de modo idempotente.
drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member on public.workspaces for select to authenticated
using (private.is_workspace_member(id));

drop policy if exists workspaces_update_owner on public.workspaces;
create policy workspaces_update_owner on public.workspaces for update to authenticated
using (private.is_workspace_owner(id)) with check (private.is_workspace_owner(id));

drop policy if exists workspace_members_select_member on public.workspace_members;
create policy workspace_members_select_member on public.workspace_members for select to authenticated
using (private.is_workspace_member(workspace_id));

drop policy if exists people_select_member on public.people;
create policy people_select_member on public.people for select to authenticated using (private.is_workspace_member(workspace_id));
drop policy if exists people_insert_member on public.people;
create policy people_insert_member on public.people for insert to authenticated with check (private.is_workspace_member(workspace_id));
drop policy if exists people_update_member on public.people;
create policy people_update_member on public.people for update to authenticated using (private.is_workspace_member(workspace_id)) with check (private.is_workspace_member(workspace_id));
drop policy if exists people_delete_member on public.people;
create policy people_delete_member on public.people for delete to authenticated using (private.is_workspace_member(workspace_id));

drop policy if exists tasks_select_member on public.tasks;
create policy tasks_select_member on public.tasks for select to authenticated using (private.is_workspace_member(workspace_id));
drop policy if exists tasks_insert_member on public.tasks;
create policy tasks_insert_member on public.tasks for insert to authenticated with check (private.is_workspace_member(workspace_id));
drop policy if exists tasks_update_member on public.tasks;
create policy tasks_update_member on public.tasks for update to authenticated using (private.is_workspace_member(workspace_id)) with check (private.is_workspace_member(workspace_id));
drop policy if exists tasks_delete_member on public.tasks;
create policy tasks_delete_member on public.tasks for delete to authenticated using (private.is_workspace_member(workspace_id));

drop policy if exists task_assignees_select_member on public.task_assignees;
create policy task_assignees_select_member on public.task_assignees for select to authenticated using (private.is_workspace_member(workspace_id));
drop policy if exists task_assignees_insert_member on public.task_assignees;
create policy task_assignees_insert_member on public.task_assignees for insert to authenticated with check (private.is_workspace_member(workspace_id));
drop policy if exists task_assignees_update_member on public.task_assignees;
create policy task_assignees_update_member on public.task_assignees for update to authenticated using (private.is_workspace_member(workspace_id)) with check (private.is_workspace_member(workspace_id));
drop policy if exists task_assignees_delete_member on public.task_assignees;
create policy task_assignees_delete_member on public.task_assignees for delete to authenticated using (private.is_workspace_member(workspace_id));

-- GRANT explícito: necessário nos projetos Supabase atuais para a Data API.
revoke all on table public.workspaces,public.workspace_members,public.people,public.tasks,public.task_assignees from anon;
grant select,update on table public.workspaces to authenticated;
grant select on table public.workspace_members to authenticated;
grant select,insert,update,delete on table public.people,public.tasks,public.task_assignees to authenticated;

-- Realtime: adiciona as tabelas à publicação somente se ainda não estiverem presentes.
do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='people') then
    alter publication supabase_realtime add table public.people;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='task_assignees') then
    alter publication supabase_realtime add table public.task_assignees;
  end if;
end $$;

commit;

-- Verificação rápida: deve retornar as cinco tabelas com RLS ativo.
select schemaname,tablename,rowsecurity
from pg_tables
where schemaname='public' and tablename in ('workspaces','workspace_members','people','tasks','task_assignees')
order by tablename;
