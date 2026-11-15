import "server-only";

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IncidentPriority,
  IncidentStatus,
  IncidentSummary,
  OperationIncident,
  OperationNotification,
  OperationTeam,
} from "@/types";
import { requireOfficerState } from "@/lib/officerSession";

const incidentCreateSchema = z.object({
  sourceType: z.enum(["satellite", "citizen", "manual"]),
  sourceId: z.string().trim().min(1).max(300).nullable().optional(),
  sourceSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(2000).nullable().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  adminLabel: z.string().max(300).nullable().optional(),
  reason: z.string().trim().min(10).max(2000),
});

const teamCreateSchema = z.object({
  name: z.string().trim().min(3).max(150),
  area: z.string().trim().min(2).max(200),
  leadName: z.string().trim().min(2).max(100),
  contact: z.string().trim().max(200).nullable().optional(),
  availability: z.enum(["available", "busy", "unavailable", "unknown"]).default("available"),
});

const incidentMutationSchema = z.object({
  expectedVersion: z.number().int().positive(),
  action: z.enum(["verification", "priority", "assignment", "status"]),
  value: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(10).max(2000),
});

const STATUS_VALUES = new Set<IncidentStatus>([
  "new", "triaging", "assigned", "in_progress", "monitoring", "resolved", "cancelled",
]);
const PRIORITY_VALUES = new Set<IncidentPriority>(["unassessed", "critical", "high", "medium", "low"]);
const PRIORITY_ORDER: Record<IncidentPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unassessed: 4,
};

interface IncidentRow {
  id: string;
  reference: string;
  source_type: OperationIncident["sourceType"];
  source_id: string | null;
  source_snapshot: Record<string, unknown>;
  title: string;
  description: string;
  lat: number;
  lon: number;
  admin_label: string | null;
  verification: OperationIncident["verification"];
  priority: OperationIncident["priority"];
  status: OperationIncident["status"];
  assigned_team_id: string | null;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  row_version: number;
}

interface TeamRow {
  id: string;
  name: string;
  area: string;
  lead_name: string;
  contact: string | null;
  availability: OperationTeam["availability"];
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

interface TimelineRow {
  id: string;
  action: "created" | "verification" | "priority" | "assignment" | "status";
  actor_name: string;
  reason: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

interface NotificationRow {
  id: string;
  incident_id: string | null;
  team_id: string | null;
  message: string;
  created_at: string;
}

function privateResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function validationResponse(error: z.ZodError): Response {
  return privateResponse(
    { error: "Invalid operation request.", code: "INVALID_BODY", details: error.flatten().fieldErrors },
    422
  );
}

function databaseErrorResponse(error: unknown): Response {
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "OPERATIONS_DATABASE_ERROR";
  const message = typeof value?.message === "string" ? value.message : "Operation database request failed.";
  if (code === "40001" || code === "23505") {
    return privateResponse({ error: code === "40001" ? "Incident changed; reload before saving." : "This record already exists.", code }, 409);
  }
  if (code === "P0002" || message.includes("NOT_FOUND")) {
    return privateResponse({ error: "Operation record not found.", code: "NOT_FOUND" }, 404);
  }
  if (code === "42501" || message.includes("FORBIDDEN")) {
    return privateResponse({ error: "Your officer role cannot perform this action.", code: "OFFICER_ACCESS_DENIED" }, 403);
  }
  if (["22023", "22P02", "23514", "23502"].includes(code)) {
    return privateResponse({ error: "The requested operation is not valid for the current state.", code }, 422);
  }
  console.error("Supabase operations request failed", error);
  return privateResponse({ error: "Operations database is temporarily unavailable.", code }, 502);
}

async function readPayload(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return privateResponse({ error: "Request body must be valid JSON.", code: "INVALID_BODY" }, 400);
  }
}

function mapTeam(row: TeamRow): OperationTeam {
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    leadName: row.lead_name,
    contact: row.contact,
    availability: row.availability,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIncident(row: IncidentRow, teamNames: Map<string, string>): OperationIncident {
  return {
    id: row.id,
    reference: row.reference,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceSnapshot: row.source_snapshot ?? {},
    title: row.title,
    description: row.description,
    lat: row.lat,
    lon: row.lon,
    adminLabel: row.admin_label,
    verification: row.verification,
    priority: row.priority,
    status: row.status,
    assignedTeamId: row.assigned_team_id,
    assignedTeamName: row.assigned_team_id ? teamNames.get(row.assigned_team_id) ?? null : null,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: Number(row.row_version),
  };
}

async function loadTeams(client: SupabaseClient): Promise<{ rows: TeamRow[]; error: unknown }> {
  const result = await client.from("operation_teams").select("*").order("name");
  return { rows: (result.data ?? []) as TeamRow[], error: result.error };
}

async function loadIncidentRows(client: SupabaseClient): Promise<{ rows: IncidentRow[]; error: unknown }> {
  const result = await client.from("operation_incidents").select("*").limit(1000);
  return { rows: (result.data ?? []) as IncidentRow[], error: result.error };
}

async function getIncident(
  client: SupabaseClient,
  id: string,
  includeTimeline: boolean
): Promise<{ incident: OperationIncident | null; error: unknown }> {
  const [incidentResult, teamResult] = await Promise.all([
    client.from("operation_incidents").select("*").eq("id", id).maybeSingle(),
    loadTeams(client),
  ]);
  if (incidentResult.error || teamResult.error) {
    return { incident: null, error: incidentResult.error ?? teamResult.error };
  }
  if (!incidentResult.data) return { incident: null, error: null };
  const teams = new Map(teamResult.rows.map((team) => [team.id, team.name]));
  const incident = mapIncident(incidentResult.data as IncidentRow, teams);
  if (!includeTimeline) return { incident, error: null };

  const timelineResult = await client
    .from("operation_timeline")
    .select("id, action, actor_name, reason, old_value, new_value, created_at")
    .eq("incident_id", id)
    .order("created_at", { ascending: false });
  if (timelineResult.error) return { incident: null, error: timelineResult.error };
  incident.timeline = ((timelineResult.data ?? []) as TimelineRow[]).map((item) => ({
    id: item.id,
    action: item.action,
    actor: item.actor_name,
    reason: item.reason,
    oldValue: item.old_value,
    newValue: item.new_value,
    createdAt: item.created_at,
  }));
  return { incident, error: null };
}

export async function listOperationIncidents(request: Request): Promise<Response> {
  const access = await requireOfficerState();
  if ("response" in access) return access.response;
  const incoming = new URL(request.url);
  const status = incoming.searchParams.get("status");
  const priority = incoming.searchParams.get("priority");
  if (status && !STATUS_VALUES.has(status as IncidentStatus)) {
    return privateResponse({ error: "Invalid status filter.", code: "INVALID_FILTER" }, 422);
  }
  if (priority && !PRIORITY_VALUES.has(priority as IncidentPriority)) {
    return privateResponse({ error: "Invalid priority filter.", code: "INVALID_FILTER" }, 422);
  }

  const [incidentResult, teamResult] = await Promise.all([
    loadIncidentRows(access.supabase),
    loadTeams(access.supabase),
  ]);
  if (incidentResult.error || teamResult.error) return databaseErrorResponse(incidentResult.error ?? teamResult.error);
  const teamNames = new Map(teamResult.rows.map((team) => [team.id, team.name]));
  const all = incidentResult.rows.map((row) => mapIncident(row, teamNames));
  const summary: IncidentSummary = {
    total: all.length,
    open: all.filter((item) => !["resolved", "cancelled"].includes(item.status)).length,
    criticalHigh: all.filter((item) => ["critical", "high"].includes(item.priority) && !["resolved", "cancelled"].includes(item.status)).length,
    unassigned: all.filter((item) => !item.assignedTeamId && !["resolved", "cancelled"].includes(item.status)).length,
  };
  const incidents = all
    .filter((item) => !status || item.status === status)
    .filter((item) => !priority || item.priority === priority)
    .sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] || right.updatedAt.localeCompare(left.updatedAt));
  return privateResponse({ incidents, summary });
}

export async function createOperationIncident(request: Request): Promise<Response> {
  const access = await requireOfficerState();
  if ("response" in access) return access.response;
  const payload = await readPayload(request);
  if (payload instanceof Response) return payload;
  const parsed = incidentCreateSchema.safeParse(payload);
  if (!parsed.success) return validationResponse(parsed.error);
  const result = await access.supabase.rpc("create_operation_incident", { payload: parsed.data });
  if (result.error) return databaseErrorResponse(result.error);
  const loaded = await getIncident(access.supabase, String(result.data), true);
  if (loaded.error) return databaseErrorResponse(loaded.error);
  return loaded.incident ? privateResponse(loaded.incident, 201) : privateResponse({ error: "Created incident was not found." }, 502);
}

export async function readOperationIncident(id: string): Promise<Response> {
  const access = await requireOfficerState();
  if ("response" in access) return access.response;
  const loaded = await getIncident(access.supabase, id, true);
  if (loaded.error) return databaseErrorResponse(loaded.error);
  return loaded.incident ? privateResponse(loaded.incident) : privateResponse({ error: "Incident not found.", code: "NOT_FOUND" }, 404);
}

export async function mutateOperationIncident(request: Request, id: string): Promise<Response> {
  const access = await requireOfficerState();
  if ("response" in access) return access.response;
  const payload = await readPayload(request);
  if (payload instanceof Response) return payload;
  const parsed = incidentMutationSchema.safeParse(payload);
  if (!parsed.success) return validationResponse(parsed.error);
  const result = await access.supabase.rpc("mutate_operation_incident", {
    target: id,
    expected_version: parsed.data.expectedVersion,
    operation: parsed.data.action,
    value: parsed.data.value,
    reason: parsed.data.reason,
  });
  if (result.error) return databaseErrorResponse(result.error);
  const loaded = await getIncident(access.supabase, String(result.data), true);
  if (loaded.error) return databaseErrorResponse(loaded.error);
  return loaded.incident ? privateResponse(loaded.incident) : privateResponse({ error: "Updated incident was not found." }, 502);
}

export async function listOperationTeams(): Promise<Response> {
  const access = await requireOfficerState();
  if ("response" in access) return access.response;
  const result = await loadTeams(access.supabase);
  if (result.error) return databaseErrorResponse(result.error);
  return privateResponse({ teams: result.rows.map(mapTeam) });
}

export async function createOperationTeam(request: Request): Promise<Response> {
  const access = await requireOfficerState();
  if ("response" in access) return access.response;
  const payload = await readPayload(request);
  if (payload instanceof Response) return payload;
  const parsed = teamCreateSchema.safeParse(payload);
  if (!parsed.success) return validationResponse(parsed.error);
  const result = await access.supabase.rpc("create_operation_team", { payload: parsed.data });
  if (result.error) return databaseErrorResponse(result.error);
  const teamResult = await access.supabase.from("operation_teams").select("*").eq("id", String(result.data)).maybeSingle();
  if (teamResult.error) return databaseErrorResponse(teamResult.error);
  return teamResult.data ? privateResponse(mapTeam(teamResult.data as TeamRow), 201) : privateResponse({ error: "Created team was not found." }, 502);
}

export async function listOperationNotifications(): Promise<Response> {
  const access = await requireOfficerState();
  if ("response" in access) return access.response;
  const [notificationResult, incidentResult, teamResult] = await Promise.all([
    access.supabase.from("operation_notifications").select("*").order("created_at", { ascending: false }).limit(30),
    loadIncidentRows(access.supabase),
    loadTeams(access.supabase),
  ]);
  if (notificationResult.error || incidentResult.error || teamResult.error) {
    return databaseErrorResponse(notificationResult.error ?? incidentResult.error ?? teamResult.error);
  }
  const references = new Map(incidentResult.rows.map((incident) => [incident.id, incident.reference]));
  const teamNames = new Map(teamResult.rows.map((team) => [team.id, team.name]));
  const notifications: OperationNotification[] = ((notificationResult.data ?? []) as NotificationRow[]).map((item) => ({
    id: item.id,
    incidentId: item.incident_id,
    reference: item.incident_id ? references.get(item.incident_id) ?? null : null,
    teamId: item.team_id,
    teamName: item.team_id ? teamNames.get(item.team_id) ?? null : null,
    message: item.message,
    createdAt: item.created_at,
  }));
  return privateResponse({ notifications });
}
