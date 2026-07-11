"""Incident + change state machines: legal paths, the 409 backstop, $prior."""
from __future__ import annotations


def _inc(client, **over):
    body = {"title": "t", "description": "d", "priority": "P2", "category": "software", "affected_ci": "ci1"}
    body.update(over)
    return client.post("/api/incidents", json=body).json()


def test_incident_happy_path(client, login):
    login(client, "alice")
    inc = _inc(client)
    assert inc["status"] == "new"
    assert "assign" in inc["allowed_actions"]
    inc = client.post(f"/api/incidents/{inc['id']}/assign", json={}).json()
    assert inc["status"] == "in_progress"
    assert inc["assignee"] == "alice"  # ci1 owner = the on-call
    inc = client.post(f"/api/incidents/{inc['id']}/resolve", json={"resolution_note": "fixed"}).json()
    assert inc["status"] == "resolved"
    assert inc["resolution_note"] == "fixed"
    inc = client.post(f"/api/incidents/{inc['id']}/close").json()
    assert inc["status"] == "closed"
    assert inc["allowed_actions"] == []  # terminal


def test_illegal_transition_409_with_allowed_actions(client, login):
    login(client, "alice")
    inc = _inc(client)  # new
    r = client.post(f"/api/incidents/{inc['id']}/resolve", json={})  # resolve from new → illegal
    assert r.status_code == 409
    body = r.json()
    assert "allowed_actions" in body
    assert "assign" in body["allowed_actions"]
    assert "resolve" not in body["allowed_actions"]


def test_reopen_restores_prior(client, login):
    login(client, "alice")
    inc = _inc(client)
    client.post(f"/api/incidents/{inc['id']}/assign", json={}).json()  # → in_progress
    client.post(f"/api/incidents/{inc['id']}/resolve", json={}).json()  # → resolved (prior=in_progress)
    inc = client.post(f"/api/incidents/{inc['id']}/reopen", json={}).json()
    assert inc["status"] == "in_progress"  # $prior restored


def test_escalate_then_resolve(client, login):
    login(client, "alice")
    inc = _inc(client)
    inc = client.post(f"/api/incidents/{inc['id']}/assign", json={}).json()
    inc = client.post(f"/api/incidents/{inc['id']}/escalate", json={}).json()
    assert inc["status"] == "escalated"
    inc = client.post(f"/api/incidents/{inc['id']}/resolve", json={}).json()
    assert inc["status"] == "resolved"


def test_request_info_cycle(client, login):
    login(client, "alice")
    inc = _inc(client)
    client.post(f"/api/incidents/{inc['id']}/assign", json={}).json()
    inc = client.post(f"/api/incidents/{inc['id']}/request-info", json={}).json()
    assert inc["status"] == "pending_user"
    inc = client.post(f"/api/incidents/{inc['id']}/provide-info", json={}).json()
    assert inc["status"] == "in_progress"


def test_closed_blocks_open_mutations(client, login):
    login(client, "alice")
    inc = _inc(client)
    client.post(f"/api/incidents/{inc['id']}/assign", json={}).json()
    client.post(f"/api/incidents/{inc['id']}/resolve", json={}).json()
    client.post(f"/api/incidents/{inc['id']}/close").json()
    assert client.post(f"/api/incidents/{inc['id']}/comments", json={"body": "x"}).status_code == 409
    assert client.post(f"/api/incidents/{inc['id']}/link/ci", json={"ci_id": "ci2"}).status_code == 409
