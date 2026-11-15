alter table public.operation_teams
alter column created_by drop not null;

alter table public.operation_incidents
alter column created_by drop not null;

alter table public.operation_timeline
alter column actor_id drop not null;

grant usage on schema private to anon;
grant select on public.operation_teams to anon;
grant select on public.operation_incidents to anon;
grant select on public.operation_timeline to anon;
grant select on public.operation_notifications to anon;

drop policy operation_teams_read on public.operation_teams;
drop policy operation_incidents_read on public.operation_incidents;
drop policy operation_timeline_read on public.operation_timeline;
drop policy operation_notifications_read on public.operation_notifications;

create policy operation_teams_read on public.operation_teams
for select to anon, authenticated
using (true);

create policy operation_incidents_read on public.operation_incidents
for select to anon, authenticated
using (true);

create policy operation_timeline_read on public.operation_timeline
for select to anon, authenticated
using (true);

create policy operation_notifications_read on public.operation_notifications
for select to anon, authenticated
using (true);

create or replace function private.create_operation_team(payload jsonb)
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
  if actor is not null
    and not private.has_active_officer(array['coordinator', 'admin']::public.officer_role[])
  then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  availability_value := coalesce(nullif(payload ->> 'availability', ''), 'available')::public.team_availability;
  if actor is null then
    actor_name := 'Public Operator';
  else
    select display_name into actor_name from public.profiles where id = actor for share;
  end if;

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

create or replace function private.create_operation_incident(payload jsonb)
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
  if actor is not null
    and not private.has_active_officer(array['field_officer', 'coordinator', 'admin']::public.officer_role[])
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

  if actor is null then
    actor_name := 'Public Operator';
  else
    select display_name into actor_name from public.profiles where id = actor for share;
  end if;

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

create or replace function private.mutate_operation_incident(
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
  if actor is not null
    and not private.has_active_officer(array['field_officer', 'coordinator', 'admin']::public.officer_role[])
  then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if target is null or expected_version is null or expected_version < 1
    or operation not in ('verification', 'priority', 'assignment', 'status')
    or length(normalized_reason) not between 10 and 2000
  then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  if actor is null then
    actor_name := 'Public Operator';
  else
    select display_name into actor_name from public.profiles where id = actor for share;
  end if;

  select * into incident from public.operation_incidents where id = target for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if incident.row_version <> expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = '40001';
  end if;

  if actor is not null
    and operation in ('verification', 'priority', 'assignment')
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

revoke all on function private.create_operation_team(jsonb) from public, anon, authenticated;
revoke all on function private.create_operation_incident(jsonb) from public, anon, authenticated;
revoke all on function private.mutate_operation_incident(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function private.create_operation_team(jsonb) to anon, authenticated;
grant execute on function private.create_operation_incident(jsonb) to anon, authenticated;
grant execute on function private.mutate_operation_incident(uuid, bigint, text, text, text) to anon, authenticated;

grant execute on function public.create_operation_team(jsonb) to anon, authenticated;
grant execute on function public.create_operation_incident(jsonb) to anon, authenticated;
grant execute on function public.mutate_operation_incident(uuid, bigint, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
