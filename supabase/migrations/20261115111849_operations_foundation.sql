create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create type public.officer_role as enum (
  'pending',
  'viewer',
  'field_officer',
  'coordinator',
  'admin'
);
create type public.account_status as enum ('pending', 'active', 'suspended');
create type public.incident_source_type as enum ('satellite', 'citizen', 'manual');
create type public.incident_verification as enum (
  'unassessed',
  'confirmed',
  'not_confirmed',
  'needs_more_information'
);
create type public.incident_priority as enum ('unassessed', 'critical', 'high', 'medium', 'low');
create type public.incident_status as enum (
  'new',
  'triaging',
  'assigned',
  'in_progress',
  'monitoring',
  'resolved',
  'cancelled'
);
create type public.team_availability as enum ('available', 'busy', 'unavailable', 'unknown');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 80),
  role public.officer_role not null default 'pending',
  status public.account_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint active_profile_has_role check (status <> 'active' or role <> 'pending')
);

create table public.operation_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 3 and 150),
  area text not null check (length(btrim(area)) between 2 and 200),
  lead_name text not null check (length(btrim(lead_name)) between 2 and 100),
  contact text check (contact is null or length(btrim(contact)) between 1 and 200),
  availability public.team_availability not null default 'available',
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_by_name text not null check (length(btrim(created_by_name)) between 2 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index operation_teams_name_unique_idx on public.operation_teams (lower(name));

create table public.operation_incidents (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (length(reference) between 8 and 40),
  source_type public.incident_source_type not null,
  source_id text check (source_id is null or length(source_id) between 1 and 300),
  source_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(source_snapshot) = 'object'),
  title text not null check (length(btrim(title)) between 3 and 200),
  description text not null default '' check (length(description) <= 2000),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  admin_label text check (admin_label is null or length(admin_label) <= 300),
  verification public.incident_verification not null default 'unassessed',
  priority public.incident_priority not null default 'unassessed',
  status public.incident_status not null default 'new',
  assigned_team_id uuid references public.operation_teams(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_by_name text not null check (length(btrim(created_by_name)) between 2 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  unique (source_type, source_id)
);
create index operation_incidents_status_updated_idx on public.operation_incidents (status, updated_at desc);
create index operation_incidents_priority_updated_idx on public.operation_incidents (priority, updated_at desc);
create index operation_incidents_team_status_idx on public.operation_incidents (assigned_team_id, status);

create table public.operation_timeline (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.operation_incidents(id) on delete cascade,
  action text not null check (action in ('created', 'verification', 'priority', 'assignment', 'status')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  actor_name text not null check (length(btrim(actor_name)) between 2 and 80),
  reason text not null check (length(btrim(reason)) between 10 and 2000),
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);
create index operation_timeline_incident_created_idx on public.operation_timeline (incident_id, created_at desc, id);

create table public.operation_notifications (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references public.operation_incidents(id) on delete cascade,
  team_id uuid references public.operation_teams(id) on delete set null,
  message text not null check (length(btrim(message)) between 3 and 500),
  created_at timestamptz not null default now()
);
create index operation_notifications_created_idx on public.operation_notifications (created_at desc);
create index operation_notifications_incident_idx on public.operation_notifications (incident_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.operation_teams enable row level security;
alter table public.operation_incidents enable row level security;
alter table public.operation_timeline enable row level security;
alter table public.operation_notifications enable row level security;

revoke all on public.profiles from public, anon, authenticated;
revoke all on public.operation_teams from public, anon, authenticated;
revoke all on public.operation_incidents from public, anon, authenticated;
revoke all on public.operation_timeline from public, anon, authenticated;
revoke all on public.operation_notifications from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.operation_teams to authenticated;
grant select on public.operation_incidents to authenticated;
grant select on public.operation_timeline to authenticated;
grant select on public.operation_notifications to authenticated;

create function private.has_active_officer(allowed_roles public.officer_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = (select auth.uid())
      and p.status = 'active'
      and p.role = any(allowed_roles)
      and u.email_confirmed_at is not null
      and coalesce(u.is_anonymous, false) = false
  );
$$;
revoke all on function private.has_active_officer(public.officer_role[]) from public, anon, authenticated;
grant execute on function private.has_active_officer(public.officer_role[]) to authenticated;

create policy profiles_read_own on public.profiles
for select to authenticated
using (id = (select auth.uid()));

create policy operation_teams_read on public.operation_teams
for select to authenticated
using ((select private.has_active_officer(array['viewer', 'field_officer', 'coordinator', 'admin']::public.officer_role[])));

create policy operation_incidents_read on public.operation_incidents
for select to authenticated
using ((select private.has_active_officer(array['viewer', 'field_officer', 'coordinator', 'admin']::public.officer_role[])));

create policy operation_timeline_read on public.operation_timeline
for select to authenticated
using ((select private.has_active_officer(array['viewer', 'field_officer', 'coordinator', 'admin']::public.officer_role[])));

create policy operation_notifications_read on public.operation_notifications
for select to authenticated
using ((select private.has_active_officer(array['viewer', 'field_officer', 'coordinator', 'admin']::public.officer_role[])));

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    case
      when length(requested_name) between 2 and 80 then requested_name
      else left(coalesce(split_part(new.email, '@', 1), 'Petugas'), 80)
    end
  );
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.touch_updated_at() from public, anon, authenticated;
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function private.touch_updated_at();
create trigger operation_teams_touch_updated_at before update on public.operation_teams
for each row execute function private.touch_updated_at();

create function private.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'APPEND_ONLY' using errcode = '42501';
end;
$$;
revoke all on function private.reject_append_only_mutation() from public, anon, authenticated;
create trigger operation_timeline_immutable
before update or delete on public.operation_timeline
for each row execute function private.reject_append_only_mutation();
create trigger operation_timeline_no_truncate
before truncate on public.operation_timeline
for each statement execute function private.reject_append_only_mutation();
create trigger operation_notifications_immutable
before update or delete on public.operation_notifications
for each row execute function private.reject_append_only_mutation();
create trigger operation_notifications_no_truncate
before truncate on public.operation_notifications
for each statement execute function private.reject_append_only_mutation();

create function private.create_operation_team(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  result uuid;
  availability_value public.team_availability;
begin
  if actor is null
    or not private.has_active_officer(array['coordinator', 'admin']::public.officer_role[])
  then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  availability_value := coalesce(nullif(payload ->> 'availability', ''), 'available')::public.team_availability;
  select display_name into actor_name from public.profiles where id = actor for share;
  insert into public.operation_teams (
    name, area, lead_name, contact, availability, created_by, created_by_name
  ) values (
    btrim(payload ->> 'name'),
    btrim(payload ->> 'area'),
    btrim(payload ->> 'leadName'),
    nullif(btrim(payload ->> 'contact'), ''),
    availability_value,
    actor,
    actor_name
  ) returning id into result;
  return result;
end;
$$;
revoke all on function private.create_operation_team(jsonb) from public, anon, authenticated;
grant execute on function private.create_operation_team(jsonb) to authenticated;

create function public.create_operation_team(payload jsonb)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.create_operation_team(payload); $$;
revoke all on function public.create_operation_team(jsonb) from public, anon, authenticated;
grant execute on function public.create_operation_team(jsonb) to authenticated;

create function private.create_operation_incident(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  result uuid;
  existing uuid;
  source_type_value public.incident_source_type;
  source_id_value text := nullif(btrim(payload ->> 'sourceId'), '');
  snapshot_value jsonb := coalesce(payload -> 'sourceSnapshot', '{}'::jsonb);
  reason_value text := btrim(payload ->> 'reason');
begin
  if actor is null
    or not private.has_active_officer(array['field_officer', 'coordinator', 'admin']::public.officer_role[])
  then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object'
    or jsonb_typeof(snapshot_value) <> 'object'
    or length(snapshot_value::text) > 20000
    or length(reason_value) not between 10 and 2000
  then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  source_type_value := (payload ->> 'sourceType')::public.incident_source_type;
  if source_id_value is not null then
    select id into existing
    from public.operation_incidents
    where source_type = source_type_value and source_id = source_id_value;
    if existing is not null then return existing; end if;
  end if;

  select display_name into actor_name
  from public.profiles
  where id = actor
  for share;

  insert into public.operation_incidents (
    reference, source_type, source_id, source_snapshot, title, description,
    lat, lon, admin_label, created_by, created_by_name
  ) values (
    'AGNI-' || to_char(now() at time zone 'utc', 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6)),
    source_type_value,
    source_id_value,
    snapshot_value,
    btrim(payload ->> 'title'),
    left(coalesce(payload ->> 'description', ''), 2000),
    (payload ->> 'lat')::double precision,
    (payload ->> 'lon')::double precision,
    nullif(btrim(payload ->> 'adminLabel'), ''),
    actor,
    actor_name
  ) returning id into result;

  insert into public.operation_timeline (
    incident_id, action, actor_id, actor_name, reason, old_value, new_value
  ) values (result, 'created', actor, actor_name, reason_value, null, 'new');
  return result;
end;
$$;
revoke all on function private.create_operation_incident(jsonb) from public, anon, authenticated;
grant execute on function private.create_operation_incident(jsonb) to authenticated;

create function public.create_operation_incident(payload jsonb)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.create_operation_incident(payload); $$;
revoke all on function public.create_operation_incident(jsonb) from public, anon, authenticated;
grant execute on function public.create_operation_incident(jsonb) to authenticated;

create function private.mutate_operation_incident(
  target uuid,
  expected_version bigint,
  operation text,
  value text,
  reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  incident public.operation_incidents%rowtype;
  team public.operation_teams%rowtype;
  normalized_value text := btrim(value);
  normalized_reason text := btrim(reason);
  old_text text;
  new_text text;
  next_status public.incident_status;
begin
  if actor is null
    or not private.has_active_officer(array['field_officer', 'coordinator', 'admin']::public.officer_role[])
  then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if target is null or expected_version is null or expected_version < 1
    or operation not in ('verification', 'priority', 'assignment', 'status')
    or length(normalized_reason) not between 10 and 2000
  then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select display_name into actor_name from public.profiles where id = actor for share;
  select * into incident from public.operation_incidents where id = target for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if incident.row_version <> expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = '40001';
  end if;

  if operation in ('verification', 'priority', 'assignment')
    and not private.has_active_officer(array['coordinator', 'admin']::public.officer_role[])
  then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if operation = 'verification' then
    if normalized_value not in ('confirmed', 'not_confirmed', 'needs_more_information') then
      raise exception 'INVALID_VERIFICATION' using errcode = '22023';
    end if;
    old_text := incident.verification::text;
    new_text := normalized_value;
    update public.operation_incidents
    set verification = normalized_value::public.incident_verification,
        status = case when status = 'new' then 'triaging'::public.incident_status else status end,
        updated_at = now(),
        row_version = row_version + 1
    where id = target;
  elsif operation = 'priority' then
    if normalized_value not in ('critical', 'high', 'medium', 'low') then
      raise exception 'INVALID_PRIORITY' using errcode = '22023';
    end if;
    old_text := incident.priority::text;
    new_text := normalized_value;
    update public.operation_incidents
    set priority = normalized_value::public.incident_priority,
        updated_at = now(),
        row_version = row_version + 1
    where id = target;
  elsif operation = 'assignment' then
    select * into team
    from public.operation_teams
    where id = normalized_value::uuid
    for share;
    if not found then raise exception 'TEAM_NOT_FOUND' using errcode = 'P0002'; end if;
    if team.availability = 'unavailable' then
      raise exception 'TEAM_UNAVAILABLE' using errcode = '22023';
    end if;
    old_text := incident.assigned_team_id::text;
    new_text := team.id::text || '|' || team.name;
    update public.operation_incidents
    set assigned_team_id = team.id,
        status = case when status in ('new', 'triaging') then 'assigned'::public.incident_status else status end,
        updated_at = now(),
        row_version = row_version + 1
    where id = target;
  else
    next_status := normalized_value::public.incident_status;
    if next_status = incident.status
      or not (
        (incident.status = 'new' and next_status in ('triaging', 'cancelled'))
        or (incident.status = 'triaging' and next_status in ('assigned', 'in_progress', 'monitoring', 'resolved', 'cancelled'))
        or (incident.status = 'assigned' and next_status in ('in_progress', 'cancelled'))
        or (incident.status = 'in_progress' and next_status in ('monitoring', 'resolved', 'cancelled'))
        or (incident.status = 'monitoring' and next_status in ('in_progress', 'resolved', 'cancelled'))
        or (incident.status in ('resolved', 'cancelled') and next_status = 'triaging')
      )
      or (next_status = 'assigned' and incident.assigned_team_id is null)
    then
      raise exception 'INVALID_TRANSITION' using errcode = '22023';
    end if;
    old_text := incident.status::text;
    new_text := next_status::text;
    update public.operation_incidents
    set status = next_status,
        updated_at = now(),
        row_version = row_version + 1
    where id = target;
  end if;

  insert into public.operation_timeline (
    incident_id, action, actor_id, actor_name, reason, old_value, new_value
  ) values (target, operation, actor, actor_name, normalized_reason, old_text, new_text);

  if operation = 'assignment' then
    insert into public.operation_notifications (incident_id, team_id, message)
    values (target, team.id, incident.reference || ' ditugaskan ke ' || team.name);
  elsif operation = 'priority' and normalized_value in ('critical', 'high') then
    insert into public.operation_notifications (incident_id, team_id, message)
    values (target, incident.assigned_team_id, incident.reference || ' ditetapkan prioritas ' || normalized_value);
  elsif operation = 'status' then
    insert into public.operation_notifications (incident_id, team_id, message)
    values (target, incident.assigned_team_id, incident.reference || ' berubah status menjadi ' || normalized_value);
  end if;
  return target;
end;
$$;
revoke all on function private.mutate_operation_incident(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function private.mutate_operation_incident(uuid, bigint, text, text, text) to authenticated;

create function public.mutate_operation_incident(
  target uuid,
  expected_version bigint,
  operation text,
  value text,
  reason text
)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.mutate_operation_incident(target, expected_version, operation, value, reason); $$;
revoke all on function public.mutate_operation_incident(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.mutate_operation_incident(uuid, bigint, text, text, text) to authenticated;

notify pgrst, 'reload schema';
