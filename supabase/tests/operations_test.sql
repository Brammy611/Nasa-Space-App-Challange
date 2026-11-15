begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-000000000001', 'pending@example.test', now(), '{"display_name":"Pending User","role":"admin"}'),
  ('00000000-0000-4000-8000-000000000002', 'field@example.test', now(), '{"display_name":"Field Officer"}'),
  ('00000000-0000-4000-8000-000000000003', 'coordinator@example.test', now(), '{"display_name":"Duty Coordinator"}');

update public.profiles
set role = 'field_officer', status = 'active'
where id = '00000000-0000-4000-8000-000000000002';
update public.profiles
set role = 'coordinator', status = 'active'
where id = '00000000-0000-4000-8000-000000000003';

select is(
  (select role::text from public.profiles where id = '00000000-0000-4000-8000-000000000001'),
  'pending',
  'user metadata cannot grant an officer role'
);

set local role anon;
select throws_ok('select * from public.profiles', '42501', null, 'anonymous users cannot read profiles');
select throws_ok(
  $$select public.create_operation_incident('{}'::jsonb)$$,
  '42501', null, 'anonymous users cannot call operation RPCs'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.profiles), 1, 'pending users can only see their profile');
select is((select count(*)::int from public.operation_incidents), 0, 'pending users cannot read incidents');
select throws_ok(
  $$select public.create_operation_incident('{"sourceType":"manual","title":"Blocked incident","description":"","lat":0,"lon":110,"reason":"Pending users cannot create this incident."}'::jsonb)$$,
  '42501', null, 'pending users cannot create incidents'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.create_operation_team('{"name":"Field Team","area":"Test area","leadName":"Field Lead"}'::jsonb)$$,
  '42501', null, 'field officers cannot create teams'
);
select lives_ok(
  $$select public.create_operation_incident('{"sourceType":"satellite","sourceId":"test-hotspot-1","sourceSnapshot":{"frp":12.5},"title":"Synthetic hotspot","description":"Test-only observation","lat":-1.2,"lon":110.4,"adminLabel":"Test district","reason":"Create a synthetic incident for local workflow testing."}'::jsonb)$$,
  'field officers can create an incident from an observation'
);
select is(
  (select count(*)::int from public.operation_incidents where source_id = 'test-hotspot-1'),
  1,
  'active officers can read the incident created by this test'
);
select throws_ok(
  $$insert into public.operation_incidents(reference,source_type,title,lat,lon,created_by,created_by_name) values ('BYPASS-1','manual','Bypass attempt',0,110,auth.uid(),'Field Officer')$$,
  '42501', null, 'direct table writes are denied'
);
select throws_ok(
  $$select public.mutate_operation_incident((select id from public.operation_incidents where source_id='test-hotspot-1'),1,'verification','confirmed','Field officer cannot make this manager decision.')$$,
  '42501', null, 'field officers cannot verify incidents'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
select lives_ok(
  $$select public.create_operation_team('{"name":"Manggala Test","area":"Synthetic district","leadName":"Test Commander","contact":"radio-01","availability":"available"}'::jsonb)$$,
  'coordinators can create field teams'
);
select lives_ok(
  $$select public.mutate_operation_incident((select id from public.operation_incidents where source_id='test-hotspot-1'),1,'verification','confirmed','Satellite indication was confirmed by the test coordinator.')$$,
  'coordinators can record human verification'
);
select is(
  (select verification::text from public.operation_incidents where source_id='test-hotspot-1'),
  'confirmed',
  'verification is persisted'
);
select is(
  (select row_version from public.operation_incidents where source_id='test-hotspot-1'),
  2::bigint,
  'mutations increment the row version'
);
select throws_ok(
  $$select public.mutate_operation_incident((select id from public.operation_incidents where source_id='test-hotspot-1'),1,'priority','high','This request deliberately uses a stale version.')$$,
  '40001', null, 'stale writes are rejected'
);
select lives_ok(
  $$select public.mutate_operation_incident((select id from public.operation_incidents where source_id='test-hotspot-1'),2,'assignment',(select id::text from public.operation_teams where name='Manggala Test'),'Assign the available test team for field follow-up.')$$,
  'coordinators can assign an available team'
);
select lives_ok(
  $$select public.mutate_operation_incident((select id from public.operation_incidents where source_id='test-hotspot-1'),3,'status','in_progress','The test team has started its synthetic field response.')$$,
  'assigned incidents can move into progress'
);
select is(
  (select count(*)::int from public.operation_timeline where incident_id = (select id from public.operation_incidents where source_id='test-hotspot-1')),
  4,
  'every workflow mutation appends an audit event'
);
select is(
  (select count(*)::int from public.operation_notifications where incident_id = (select id from public.operation_incidents where source_id='test-hotspot-1')),
  2,
  'assignment and status changes create notifications'
);
reset role;

select throws_ok(
  $$update public.operation_timeline set reason='Tampered audit reason'$$,
  '42501', null, 'the audit timeline cannot be updated'
);
select throws_ok(
  $$truncate public.operation_notifications$$,
  '42501', null, 'notifications cannot be truncated'
);

select * from finish();
rollback;
