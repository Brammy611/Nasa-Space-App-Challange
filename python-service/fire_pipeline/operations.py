"""Operational incident workflow stored beside community reports.

FireWatch remains the source of satellite and citizen observations.  This
module adds the part FireOps did better: observations can become incidents,
then move through human verification, manual priority, assignment and field
status changes.  Every mutation is optimistic-lock protected and appended to
an immutable timeline.

The store intentionally reuses ``FIRE_REPORTS_DB_PATH``.  Render already
mounts that database on a persistent disk, so the integrated workflow is
durable without introducing a second undeployed database service.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from .reports import default_reports_db_path

SOURCE_TYPES = {"satellite", "citizen", "manual"}
VERIFICATION_DECISIONS = {
    "unassessed",
    "confirmed",
    "not_confirmed",
    "needs_more_information",
}
PRIORITIES = {"unassessed", "critical", "high", "medium", "low"}
STATUSES = {
    "new",
    "triaging",
    "assigned",
    "in_progress",
    "monitoring",
    "resolved",
    "cancelled",
}
TEAM_AVAILABILITY = {"available", "busy", "unavailable", "unknown"}
TRANSITIONS = {
    "new": {"triaging", "cancelled"},
    "triaging": {"assigned", "in_progress", "monitoring", "resolved", "cancelled"},
    "assigned": {"in_progress", "cancelled"},
    "in_progress": {"monitoring", "resolved", "cancelled"},
    "monitoring": {"in_progress", "resolved", "cancelled"},
    "resolved": {"triaging"},
    "cancelled": {"triaging"},
}


class OperationConflictError(RuntimeError):
    """The client edited a stale incident version."""


class OperationNotFoundError(LookupError):
    """An incident or team does not exist."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect(sqlite_path: str | None = None) -> sqlite3.Connection:
    connection = sqlite3.connect(sqlite_path or default_reports_db_path(), timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    _ensure_schema(connection)
    return connection


def _ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS operations_teams (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            area TEXT NOT NULL,
            lead_name TEXT NOT NULL,
            contact TEXT,
            availability TEXT NOT NULL DEFAULT 'unknown'
                CHECK (availability IN ('available', 'busy', 'unavailable', 'unknown')),
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS operations_incidents (
            id TEXT PRIMARY KEY,
            reference TEXT NOT NULL UNIQUE,
            source_type TEXT NOT NULL
                CHECK (source_type IN ('satellite', 'citizen', 'manual')),
            source_id TEXT,
            source_snapshot TEXT NOT NULL DEFAULT '{}',
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
            lon REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
            admin_label TEXT,
            verification TEXT NOT NULL DEFAULT 'unassessed'
                CHECK (verification IN ('unassessed', 'confirmed', 'not_confirmed', 'needs_more_information')),
            priority TEXT NOT NULL DEFAULT 'unassessed'
                CHECK (priority IN ('unassessed', 'critical', 'high', 'medium', 'low')),
            status TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'triaging', 'assigned', 'in_progress', 'monitoring', 'resolved', 'cancelled')),
            assigned_team_id TEXT REFERENCES operations_teams(id) ON DELETE SET NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
            UNIQUE (source_type, source_id)
        );

        CREATE TABLE IF NOT EXISTS operations_timeline (
            id TEXT PRIMARY KEY,
            incident_id TEXT NOT NULL REFERENCES operations_incidents(id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT NOT NULL,
            old_value TEXT,
            new_value TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS operations_notifications (
            id TEXT PRIMARY KEY,
            incident_id TEXT REFERENCES operations_incidents(id) ON DELETE CASCADE,
            team_id TEXT REFERENCES operations_teams(id) ON DELETE SET NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS operations_incidents_status_idx
            ON operations_incidents(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS operations_incidents_priority_idx
            ON operations_incidents(priority, updated_at DESC);
        CREATE INDEX IF NOT EXISTS operations_incidents_team_idx
            ON operations_incidents(assigned_team_id, status);
        CREATE INDEX IF NOT EXISTS operations_timeline_incident_idx
            ON operations_timeline(incident_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS operations_notifications_created_idx
            ON operations_notifications(created_at DESC);
        """
    )
    connection.commit()


def _required_text(value: Any, name: str, *, minimum: int = 1, maximum: int = 2000) -> str:
    text = str(value or "").strip()
    if len(text) < minimum or len(text) > maximum:
        raise ValueError(f"{name} must be {minimum}-{maximum} characters")
    return text


def _coordinate(value: Any, name: str, minimum: float, maximum: float) -> float:
    try:
        coordinate = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not minimum <= coordinate <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return coordinate


def _json(value: str | None) -> Any:
    try:
        return json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}


def _row_to_team(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "area": row["area"],
        "leadName": row["lead_name"],
        "contact": row["contact"],
        "availability": row["availability"],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _row_to_incident(row: sqlite3.Row) -> dict:
    keys = set(row.keys())
    return {
        "id": row["id"],
        "reference": row["reference"],
        "sourceType": row["source_type"],
        "sourceId": row["source_id"],
        "sourceSnapshot": _json(row["source_snapshot"]),
        "title": row["title"],
        "description": row["description"],
        "lat": row["lat"],
        "lon": row["lon"],
        "adminLabel": row["admin_label"],
        "verification": row["verification"],
        "priority": row["priority"],
        "status": row["status"],
        "assignedTeamId": row["assigned_team_id"],
        "assignedTeamName": row["assigned_team_name"] if "assigned_team_name" in keys else None,
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "rowVersion": row["row_version"],
    }


def _incident_select() -> str:
    return """
        SELECT i.*, t.name AS assigned_team_name
        FROM operations_incidents i
        LEFT JOIN operations_teams t ON t.id = i.assigned_team_id
    """


def _insert_timeline(
    connection: sqlite3.Connection,
    incident_id: str,
    action: str,
    actor: str,
    reason: str,
    old_value: str | None,
    new_value: str | None,
    created_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO operations_timeline
            (id, incident_id, action, actor, reason, old_value, new_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (str(uuid.uuid4()), incident_id, action, actor, reason, old_value, new_value, created_at),
    )


def _insert_notification(
    connection: sqlite3.Connection,
    incident_id: str,
    team_id: str | None,
    message: str,
    created_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO operations_notifications (id, incident_id, team_id, message, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (str(uuid.uuid4()), incident_id, team_id, message, created_at),
    )


def create_team(
    *,
    name: str,
    area: str,
    lead_name: str,
    contact: str | None,
    availability: str,
    actor: str,
    sqlite_path: str | None = None,
) -> dict:
    name_value = _required_text(name, "name", minimum=3, maximum=150)
    area_value = _required_text(area, "area", minimum=2, maximum=200)
    lead_value = _required_text(lead_name, "leadName", minimum=2, maximum=100)
    actor_value = _required_text(actor, "actor", maximum=80)
    contact_value = str(contact or "").strip()[:200] or None
    if availability not in TEAM_AVAILABILITY:
        raise ValueError("invalid team availability")
    now = _now()
    team_id = str(uuid.uuid4())
    connection = _connect(sqlite_path)
    try:
        connection.execute(
            """
            INSERT INTO operations_teams
                (id, name, area, lead_name, contact, availability, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (team_id, name_value, area_value, lead_value, contact_value, availability, actor_value, now, now),
        )
        connection.commit()
        row = connection.execute("SELECT * FROM operations_teams WHERE id = ?", (team_id,)).fetchone()
    except sqlite3.IntegrityError as exc:
        raise ValueError("a team with this name already exists") from exc
    finally:
        connection.close()
    return _row_to_team(row)


def list_teams(sqlite_path: str | None = None) -> list[dict]:
    connection = _connect(sqlite_path)
    try:
        rows = connection.execute(
            "SELECT * FROM operations_teams ORDER BY name COLLATE NOCASE"
        ).fetchall()
    finally:
        connection.close()
    return [_row_to_team(row) for row in rows]


def create_incident(
    *,
    source_type: str,
    source_id: str | None,
    source_snapshot: dict | None,
    title: str,
    description: str | None,
    lat: float,
    lon: float,
    admin_label: str | None,
    actor: str,
    reason: str,
    sqlite_path: str | None = None,
) -> dict:
    if source_type not in SOURCE_TYPES:
        raise ValueError("invalid sourceType")
    source_id_value = str(source_id or "").strip()[:300] or None
    title_value = _required_text(title, "title", minimum=3, maximum=200)
    description_value = str(description or "").strip()[:2000]
    lat_value = _coordinate(lat, "lat", -90, 90)
    lon_value = _coordinate(lon, "lon", -180, 180)
    admin_value = str(admin_label or "").strip()[:300] or None
    actor_value = _required_text(actor, "actor", maximum=80)
    reason_value = _required_text(reason, "reason", minimum=10, maximum=2000)
    snapshot_value = json.dumps(source_snapshot or {}, ensure_ascii=False, separators=(",", ":"))
    if len(snapshot_value) > 20_000:
        raise ValueError("sourceSnapshot is too large")

    now = _now()
    incident_id = str(uuid.uuid4())
    reference = f"AGNI-{datetime.now(timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:6].upper()}"
    connection = _connect(sqlite_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        if source_id_value:
            existing = connection.execute(
                _incident_select() + " WHERE i.source_type = ? AND i.source_id = ?",
                (source_type, source_id_value),
            ).fetchone()
            if existing is not None:
                connection.rollback()
                return _row_to_incident(existing)
        connection.execute(
            """
            INSERT INTO operations_incidents
                (id, reference, source_type, source_id, source_snapshot, title, description,
                 lat, lon, admin_label, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                incident_id,
                reference,
                source_type,
                source_id_value,
                snapshot_value,
                title_value,
                description_value,
                lat_value,
                lon_value,
                admin_value,
                actor_value,
                now,
                now,
            ),
        )
        _insert_timeline(connection, incident_id, "created", actor_value, reason_value, None, "new", now)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    incident = get_incident(incident_id, sqlite_path=sqlite_path)
    if incident is None:  # defensive; the committed row must be readable
        raise RuntimeError("created incident could not be loaded")
    return incident


def list_incidents(
    *,
    status: str | None = None,
    priority: str | None = None,
    sqlite_path: str | None = None,
) -> list[dict]:
    clauses: list[str] = []
    params: list[str] = []
    if status:
        if status not in STATUSES:
            raise ValueError("invalid status")
        clauses.append("i.status = ?")
        params.append(status)
    if priority:
        if priority not in PRIORITIES:
            raise ValueError("invalid priority")
        clauses.append("i.priority = ?")
        params.append(priority)
    query = _incident_select()
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, i.updated_at DESC"
    connection = _connect(sqlite_path)
    try:
        rows = connection.execute(query, params).fetchall()
    finally:
        connection.close()
    return [_row_to_incident(row) for row in rows]


def get_incident(incident_id: str, sqlite_path: str | None = None) -> dict | None:
    connection = _connect(sqlite_path)
    try:
        row = connection.execute(
            _incident_select() + " WHERE i.id = ?", (incident_id,)
        ).fetchone()
        if row is None:
            return None
        timeline_rows = connection.execute(
            """
            SELECT id, action, actor, reason, old_value, new_value, created_at
            FROM operations_timeline
            WHERE incident_id = ?
            ORDER BY created_at DESC, rowid DESC
            """,
            (incident_id,),
        ).fetchall()
    finally:
        connection.close()
    incident = _row_to_incident(row)
    incident["timeline"] = [
        {
            "id": item["id"],
            "action": item["action"],
            "actor": item["actor"],
            "reason": item["reason"],
            "oldValue": item["old_value"],
            "newValue": item["new_value"],
            "createdAt": item["created_at"],
        }
        for item in timeline_rows
    ]
    return incident


def mutate_incident(
    incident_id: str,
    *,
    expected_version: int,
    action: str,
    actor: str,
    reason: str,
    value: str,
    sqlite_path: str | None = None,
) -> dict:
    if action not in {"verification", "priority", "assignment", "status"}:
        raise ValueError("invalid action")
    actor_value = _required_text(actor, "actor", maximum=80)
    reason_value = _required_text(reason, "reason", minimum=10, maximum=2000)
    value = str(value or "").strip()
    if not isinstance(expected_version, int) or expected_version < 1:
        raise ValueError("expectedVersion must be a positive integer")

    connection = _connect(sqlite_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute(
            "SELECT * FROM operations_incidents WHERE id = ?", (incident_id,)
        ).fetchone()
        if current is None:
            raise OperationNotFoundError("incident not found")
        if current["row_version"] != expected_version:
            raise OperationConflictError("incident changed; reload before saving")

        now = _now()
        column: str
        old_value: str | None
        new_value: str
        team_id: str | None = current["assigned_team_id"]
        next_status = current["status"]

        if action == "verification":
            if value not in VERIFICATION_DECISIONS - {"unassessed"}:
                raise ValueError("invalid verification decision")
            column = "verification"
            old_value = current[column]
            new_value = value
            if current["status"] == "new":
                next_status = "triaging"
        elif action == "priority":
            if value not in PRIORITIES - {"unassessed"}:
                raise ValueError("invalid priority")
            column = "priority"
            old_value = current[column]
            new_value = value
        elif action == "assignment":
            team = connection.execute(
                "SELECT id, name, availability FROM operations_teams WHERE id = ?", (value,)
            ).fetchone()
            if team is None:
                raise OperationNotFoundError("team not found")
            if team["availability"] == "unavailable":
                raise ValueError("unavailable team cannot be assigned")
            column = "assigned_team_id"
            old_value = current[column]
            new_value = team["id"]
            team_id = team["id"]
            if current["status"] in {"new", "triaging"}:
                next_status = "assigned"
        else:
            if value not in STATUSES:
                raise ValueError("invalid status")
            if value == current["status"]:
                raise ValueError("status is unchanged")
            if value not in TRANSITIONS[current["status"]]:
                raise ValueError(f"status cannot move from {current['status']} to {value}")
            if value == "assigned" and not current["assigned_team_id"]:
                raise ValueError("assign a team before setting assigned status")
            column = "status"
            old_value = current[column]
            new_value = value
            next_status = value

        assignments = [f"{column} = ?", "status = ?", "updated_at = ?", "row_version = row_version + 1"]
        params: list[Any] = [new_value, next_status, now]
        result = connection.execute(
            f"UPDATE operations_incidents SET {', '.join(assignments)} WHERE id = ? AND row_version = ?",
            (*params, incident_id, expected_version),
        )
        if result.rowcount != 1:
            raise OperationConflictError("incident changed; reload before saving")

        timeline_new_value = new_value
        if action == "assignment":
            team_name = connection.execute(
                "SELECT name FROM operations_teams WHERE id = ?", (new_value,)
            ).fetchone()["name"]
            timeline_new_value = f"{new_value}|{team_name}"
        _insert_timeline(
            connection,
            incident_id,
            action,
            actor_value,
            reason_value,
            old_value,
            timeline_new_value,
            now,
        )

        reference = current["reference"]
        if action == "assignment":
            _insert_notification(
                connection,
                incident_id,
                team_id,
                f"{reference} ditugaskan ke {team_name}",
                now,
            )
        elif action == "priority" and new_value in {"critical", "high"}:
            _insert_notification(
                connection,
                incident_id,
                team_id,
                f"{reference} ditetapkan sebagai prioritas {new_value}",
                now,
            )
        elif action == "status":
            _insert_notification(
                connection,
                incident_id,
                team_id,
                f"{reference} berubah status menjadi {new_value}",
                now,
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    incident = get_incident(incident_id, sqlite_path=sqlite_path)
    if incident is None:
        raise RuntimeError("updated incident could not be loaded")
    return incident


def incident_summary(sqlite_path: str | None = None) -> dict:
    connection = _connect(sqlite_path)
    try:
        rows = connection.execute(
            "SELECT status, priority, COUNT(*) AS count FROM operations_incidents GROUP BY status, priority"
        ).fetchall()
    finally:
        connection.close()
    total = sum(row["count"] for row in rows)
    return {
        "total": total,
        "open": sum(row["count"] for row in rows if row["status"] not in {"resolved", "cancelled"}),
        "criticalHigh": sum(row["count"] for row in rows if row["priority"] in {"critical", "high"}),
        "unassigned": sum(
            incident["assignedTeamId"] is None
            for incident in list_incidents(sqlite_path=sqlite_path)
            if incident["status"] not in {"resolved", "cancelled"}
        ),
    }


def list_notifications(limit: int = 30, sqlite_path: str | None = None) -> list[dict]:
    safe_limit = max(1, min(int(limit), 100))
    connection = _connect(sqlite_path)
    try:
        rows = connection.execute(
            """
            SELECT n.id, n.incident_id, n.team_id, n.message, n.created_at,
                   i.reference, t.name AS team_name
            FROM operations_notifications n
            LEFT JOIN operations_incidents i ON i.id = n.incident_id
            LEFT JOIN operations_teams t ON t.id = n.team_id
            ORDER BY n.created_at DESC
            LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()
    finally:
        connection.close()
    return [
        {
            "id": row["id"],
            "incidentId": row["incident_id"],
            "reference": row["reference"],
            "teamId": row["team_id"],
            "teamName": row["team_name"],
            "message": row["message"],
            "createdAt": row["created_at"],
        }
        for row in rows
    ]
