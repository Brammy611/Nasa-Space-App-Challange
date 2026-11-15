create index operation_teams_created_by_idx
on public.operation_teams (created_by);

create index operation_incidents_created_by_idx
on public.operation_incidents (created_by);

create index operation_timeline_actor_id_idx
on public.operation_timeline (actor_id);

create index operation_notifications_team_id_idx
on public.operation_notifications (team_id);
