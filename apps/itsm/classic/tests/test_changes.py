"""Change workflows: CAB (manager) + implement/complete + rollback auto-incident."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_workflow2_change_management_with_rollback(client, login):
    alice = client  # agent
    login(alice, "alice")

    # prerequisite incident (the change is prompted by it)
    inc = alice.post("/api/incidents", json={
        "title": "db slow", "priority": "P2", "category": "performance", "affected_ci": "ci2",
    }).json()

    # 1. create + 2. link ci + incident
    chg = alice.post("/api/changes", json={
        "title": "DB migration", "type": "normal", "risk": "medium",
        "affected_cis": ["ci2"], "rollback_plan": "restore snapshot",
    }).json()
    assert chg["status"] == "draft"
    chg = alice.post(f"/api/changes/{chg['id']}/link/ci", json={"ci_id": "ci2"}).json()
    chg = alice.post(f"/api/changes/{chg['id']}/link/incident", json={"incident_id": inc["id"]}).json()
    assert inc["id"] in chg["linked_incidents"]

    # 3. submit
    chg = alice.post(f"/api/changes/{chg['id']}/submit").json()
    assert chg["status"] == "submitted"

    # 4. CAB approve — agent first fails (role), manager approves
    assert alice.post(f"/api/changes/{chg['id']}/approve").status_code == 403
    bob = TestClient(app)
    login(bob, "bob")  # manager
    chg = bob.post(f"/api/changes/{chg['id']}/approve").json()
    assert chg["status"] == "cab_approved"

    # 5. schedule + 6. implement + 7. complete
    chg = alice.post(f"/api/changes/{chg['id']}/schedule", json={"change_window": "2026-07-02T02:00Z"}).json()
    assert chg["status"] == "scheduled"
    assert chg["change_window"] == "2026-07-02T02:00Z"
    chg = alice.post(f"/api/changes/{chg['id']}/implement").json()
    assert chg["status"] == "implementing"
    chg = alice.post(f"/api/changes/{chg['id']}/complete").json()
    assert chg["status"] == "implemented"

    # 8. rollback → auto-creates + links an incident
    chg = alice.post(f"/api/changes/{chg['id']}/rollback").json()
    assert chg["status"] == "rolled_back"
    auto_ids = [i for i in chg["linked_incidents"] if i != inc["id"]]
    assert len(auto_ids) == 1
    auto = alice.get(f"/api/incidents/{auto_ids[0]}").json()
    assert auto["title"].startswith("Incident caused by rollback")
    assert chg["id"] in auto["linked_changes"]  # back-linked


def test_reject_change_manager(client, login):
    login(client, "alice")
    chg = client.post("/api/changes", json={"title": "x", "type": "normal", "risk": "low"}).json()
    client.post(f"/api/changes/{chg['id']}/submit")
    bob = TestClient(app)
    login(bob, "bob")
    chg = bob.post(f"/api/changes/{chg['id']}/reject").json()
    assert chg["status"] == "rejected"


def test_change_illegal_transition_409(client, login):
    login(client, "alice")
    chg = client.post("/api/changes", json={"title": "x", "type": "normal", "risk": "low"}).json()
    # approve from draft → manager must, but it's illegal (must submit first)
    bob = TestClient(app)
    login(bob, "bob")
    r = bob.post(f"/api/changes/{chg['id']}/approve")
    assert r.status_code == 409
    assert "submit" in r.json()["allowed_actions"]


def test_rollback_only_after_implement(client, login):
    login(client, "alice")
    chg = client.post("/api/changes", json={"title": "x", "type": "normal", "risk": "low"}).json()
    # rollback from draft → illegal
    r = client.post(f"/api/changes/{chg['id']}/rollback")
    assert r.status_code == 409
