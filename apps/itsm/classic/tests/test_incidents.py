"""Incident workflows: major-incident response, links (back-link), priority→SLA."""
from __future__ import annotations


def test_workflow1_major_incident_response(client, login):
    login(client, "alice")  # agent
    inc = client.post("/api/incidents", json={
        "title": "P1: payment service down", "description": "customers can't pay",
        "priority": "P1", "category": "performance", "affected_ci": "ci1",
    }).json()
    assert inc["id"] == "INC-1"
    assert inc["sla_id"] == "sla1"  # P1 → sla1

    # link the dependent CIs (the CMDB triage)
    inc = client.post(f"/api/incidents/{inc['id']}/link/ci", json={"ci_id": "ci2"}).json()
    assert "ci2" in inc["linked_cis"]
    inc = client.post(f"/api/incidents/{inc['id']}/link/ci", json={"ci_id": "ci3"}).json()
    assert {"ci2", "ci3"} <= set(inc["linked_cis"])

    # assign (defaults to ci1's owner = alice)
    inc = client.post(f"/api/incidents/{inc['id']}/assign", json={}).json()
    assert inc["assignee"] == "alice"
    assert inc["status"] == "in_progress"

    # escalate (P1)
    inc = client.post(f"/api/incidents/{inc['id']}/escalate", json={}).json()
    assert inc["status"] == "escalated"

    # comment (the diagnosis)
    inc = client.post(f"/api/incidents/{inc['id']}/comments", json={"body": "db conn pool exhausted"}).json()
    assert len(inc["comments"]) == 1
    assert inc["comments"][0]["author"] == "alice"

    # resolve + close
    inc = client.post(f"/api/incidents/{inc['id']}/resolve", json={"resolution_note": "restarted pool"}).json()
    assert inc["status"] == "resolved"
    inc = client.post(f"/api/incidents/{inc['id']}/close").json()
    assert inc["status"] == "closed"


def test_link_change_backlinks_both_ways(client, login):
    login(client, "alice")
    inc = client.post("/api/incidents", json={"title": "i", "priority": "P3", "category": "software"}).json()
    chg = client.post("/api/changes", json={"title": "c", "type": "normal", "risk": "low", "affected_cis": ["ci2"]}).json()
    inc = client.post(f"/api/incidents/{inc['id']}/link/change", json={"change_id": chg["id"]}).json()
    assert chg["id"] in inc["linked_changes"]
    # back-link on the change
    chg = client.get(f"/api/changes/{chg['id']}").json()
    assert inc["id"] in chg["linked_incidents"]


def test_update_priority_updates_sla(client, login):
    login(client, "alice")
    inc = client.post("/api/incidents", json={"title": "i", "priority": "P3", "category": "software"}).json()
    assert inc["sla_id"] == "sla3"
    inc = client.post(f"/api/incidents/{inc['id']}/priority", json={"priority": "P1"}).json()
    assert inc["priority"] == "P1"
    assert inc["sla_id"] == "sla1"


def test_create_unknown_ci_rejected(client, login):
    login(client, "alice")
    r = client.post("/api/incidents", json={"title": "i", "priority": "P3", "category": "software", "affected_ci": "nope"})
    assert r.status_code == 400


def test_assign_unknown_user_rejected(client, login):
    login(client, "alice")
    inc = client.post("/api/incidents", json={"title": "i", "priority": "P3", "category": "software", "affected_ci": "ci1"}).json()
    assert client.post(f"/api/incidents/{inc['id']}/assign", json={"assignee": "nobody"}).status_code == 400


def test_assign_without_ci_or_assignee_rejected(client, login):
    login(client, "alice")
    inc = client.post("/api/incidents", json={"title": "i", "priority": "P3", "category": "software"}).json()  # no affected_ci
    assert client.post(f"/api/incidents/{inc['id']}/assign", json={}).status_code == 400
