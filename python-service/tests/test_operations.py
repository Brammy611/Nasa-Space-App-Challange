import pytest
from fastapi.testclient import TestClient

import main
from fire_pipeline import operations

OFFICER = {"X-Officer-Key": "operations-test-key", "X-Officer-Name": "Rina Pratama"}


def _db(tmp_path, monkeypatch):
    path = tmp_path / "reports.sqlite"
    monkeypatch.setenv("FIRE_REPORTS_DB_PATH", str(path))
    monkeypatch.setenv("OFFICER_ACCESS_KEY", "operations-test-key")
    return str(path)


def _incident(path, source_id="marker-1"):
    return operations.create_incident(
        source_type="satellite",
        source_id=source_id,
        source_snapshot={"severity": "HIGH", "frp": 91.4},
        title="Indikasi satelit di Ogan Ilir",
        description="MODIS signal requiring field verification",
        lat=-3.2,
        lon=104.7,
        admin_label="Ogan Ilir, Sumatera Selatan",
        actor="Rina Pratama",
        reason="Dibuka untuk pemeriksaan lapangan oleh petugas piket.",
        sqlite_path=path,
    )


def _team(path, availability="available"):
    return operations.create_team(
        name=f"Regu Alpha {availability}",
        area="Ogan Ilir",
        lead_name="Dimas",
        contact="radio 12",
        availability=availability,
        actor="Rina Pratama",
        sqlite_path=path,
    )


def test_satellite_incident_starts_unassessed_and_has_creation_audit(tmp_path, monkeypatch):
    path = _db(tmp_path, monkeypatch)
    incident = _incident(path)

    assert incident["sourceSnapshot"]["severity"] == "HIGH"
    assert incident["verification"] == "unassessed"
    assert incident["priority"] == "unassessed"
    assert incident["status"] == "new"
    assert incident["rowVersion"] == 1
    assert incident["timeline"][0]["action"] == "created"
    assert incident["timeline"][0]["actor"] == "Rina Pratama"


def test_same_source_is_idempotent(tmp_path, monkeypatch):
    path = _db(tmp_path, monkeypatch)
    first = _incident(path)
    second = _incident(path)
    assert second["id"] == first["id"]
    assert len(operations.list_incidents(sqlite_path=path)) == 1


def test_human_decisions_assignment_and_status_are_versioned(tmp_path, monkeypatch):
    path = _db(tmp_path, monkeypatch)
    incident = _incident(path)
    team = _team(path)

    verified = operations.mutate_incident(
        incident["id"],
        expected_version=1,
        action="verification",
        value="confirmed",
        reason="Asap dan api terlihat oleh petugas di sisi timur lokasi.",
        actor="Rina Pratama",
        sqlite_path=path,
    )
    assert verified["verification"] == "confirmed"
    assert verified["status"] == "triaging"
    assert verified["rowVersion"] == 2

    prioritized = operations.mutate_incident(
        incident["id"],
        expected_version=2,
        action="priority",
        value="high",
        reason="Api mendekati permukiman dan akses pemadaman terbatas.",
        actor="Rina Pratama",
        sqlite_path=path,
    )
    assigned = operations.mutate_incident(
        incident["id"],
        expected_version=prioritized["rowVersion"],
        action="assignment",
        value=team["id"],
        reason="Regu Alpha paling dekat dan memiliki kendaraan yang tersedia.",
        actor="Koordinator Budi",
        sqlite_path=path,
    )
    assert assigned["assignedTeamName"] == team["name"]
    assert assigned["status"] == "assigned"

    active = operations.mutate_incident(
        incident["id"],
        expected_version=assigned["rowVersion"],
        action="status",
        value="in_progress",
        reason="Regu sudah tiba dan mulai membuat sekat bakar aman.",
        actor="Koordinator Budi",
        sqlite_path=path,
    )
    assert active["status"] == "in_progress"
    assert [item["action"] for item in active["timeline"][:4]] == [
        "status",
        "assignment",
        "priority",
        "verification",
    ]


def test_stale_version_and_invalid_transition_are_rejected(tmp_path, monkeypatch):
    path = _db(tmp_path, monkeypatch)
    incident = _incident(path)

    with pytest.raises(operations.OperationConflictError):
        operations.mutate_incident(
            incident["id"],
            expected_version=99,
            action="priority",
            value="low",
            reason="Bukti lapangan menunjukkan dampak saat ini masih terbatas.",
            actor="Rina Pratama",
            sqlite_path=path,
        )

    with pytest.raises(ValueError, match="status cannot move"):
        operations.mutate_incident(
            incident["id"],
            expected_version=1,
            action="status",
            value="resolved",
            reason="Mencoba melewati tahapan operasional yang diwajibkan.",
            actor="Rina Pratama",
            sqlite_path=path,
        )


def test_unavailable_team_cannot_be_assigned(tmp_path, monkeypatch):
    path = _db(tmp_path, monkeypatch)
    incident = _incident(path)
    team = _team(path, availability="unavailable")
    with pytest.raises(ValueError, match="unavailable"):
        operations.mutate_incident(
            incident["id"],
            expected_version=1,
            action="assignment",
            value=team["id"],
            reason="Penugasan ini harus ditolak karena tim tidak tersedia.",
            actor="Rina Pratama",
            sqlite_path=path,
        )


def test_summary_and_notifications_follow_mutations(tmp_path, monkeypatch):
    path = _db(tmp_path, monkeypatch)
    incident = _incident(path)
    team = _team(path)
    high = operations.mutate_incident(
        incident["id"],
        expected_version=1,
        action="priority",
        value="critical",
        reason="Api besar sangat dekat dengan fasilitas pelayanan publik.",
        actor="Rina Pratama",
        sqlite_path=path,
    )
    operations.mutate_incident(
        incident["id"],
        expected_version=high["rowVersion"],
        action="assignment",
        value=team["id"],
        reason="Tim tersedia dengan waktu tempuh paling singkat ke lokasi.",
        actor="Rina Pratama",
        sqlite_path=path,
    )

    summary = operations.incident_summary(sqlite_path=path)
    assert summary == {"total": 1, "open": 1, "criticalHigh": 1, "unassigned": 0}
    messages = [item["message"] for item in operations.list_notifications(sqlite_path=path)]
    assert any("ditugaskan" in message for message in messages)
    assert any("critical" in message for message in messages)


def test_operations_api_requires_officer_and_records_signed_name(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    client = TestClient(main.app)
    payload = {
        "sourceType": "citizen",
        "sourceId": "report-7",
        "sourceSnapshot": {"reportStatus": "under_review"},
        "title": "Laporan asap dari warga",
        "description": "Asap semakin tebal dari arah lahan gambut",
        "lat": -2.9,
        "lon": 104.8,
        "adminLabel": "Banyuasin",
        "reason": "Dibuka untuk mengoordinasikan pemeriksaan laporan warga.",
    }

    assert client.post("/api/operations/incidents", json=payload).status_code == 401
    created = client.post("/api/operations/incidents", json=payload, headers=OFFICER)
    assert created.status_code == 201
    assert created.json()["createdBy"] == "Rina Pratama"
    assert created.json()["timeline"][0]["actor"] == "Rina Pratama"

    listing = client.get("/api/operations/incidents", headers=OFFICER)
    assert listing.status_code == 200
    assert listing.json()["summary"]["total"] == 1


def test_operations_api_returns_conflict_for_stale_write(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    client = TestClient(main.app)
    created = client.post(
        "/api/operations/incidents",
        json={
            "sourceType": "manual",
            "title": "Pemeriksaan manual lokasi",
            "lat": -2.1,
            "lon": 113.9,
            "reason": "Koordinator membuka pemeriksaan manual untuk tim lapangan.",
        },
        headers=OFFICER,
    ).json()
    response = client.patch(
        f"/api/operations/incidents/{created['id']}",
        json={
            "expectedVersion": 22,
            "action": "priority",
            "value": "low",
            "reason": "Data terbaru menunjukkan jangkauan dampak masih rendah.",
        },
        headers=OFFICER,
    )
    assert response.status_code == 409
