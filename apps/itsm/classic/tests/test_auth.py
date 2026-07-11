"""Auth: login / me / logout + the cookie + role gates."""
from __future__ import annotations


def test_login_me_logout(client, login):
    login(client, "alice")
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["username"] == "alice"
    assert r.json()["role"] == "agent"
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401


def test_unknown_user_rejected(client):
    r = client.post("/api/auth/login", json={"username": "nobody"})
    assert r.status_code == 401


def test_missing_username(client):
    r = client.post("/api/auth/login", json={"username": "  "})
    assert r.status_code == 400


def test_unauth_blocked_from_state(client):
    assert client.get("/api/state").status_code == 401


def test_role_gate_requester_cannot_assign(client, login):
    login(client, "carol")  # requester
    inc = client.post("/api/incidents", json={
        "title": "x", "priority": "P3", "category": "software", "affected_ci": "ci1",
    }).json()
    assert inc["status"] == "new"
    # assign is agent-only
    assert client.post(f"/api/incidents/{inc['id']}/assign", json={}).status_code == 403
