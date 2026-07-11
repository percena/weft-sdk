"""CIs: list/get + multi-hop dependent traversal + status update (agent-only)."""
from __future__ import annotations


def test_list_and_get_ci(client, login):
    login(client, "alice")
    cis = client.get("/api/cis").json()
    assert {"ci1", "ci2", "ci3", "ci4", "ci5", "ci6"} <= {c["id"] for c in cis}
    ci1 = client.get("/api/cis/ci1").json()
    assert ci1["name"] == "payment-service"
    assert set(ci1["depends_on"]) == {"ci2", "ci3", "ci4"}
    assert ci1["runs_on"] == ["ci5"]


def test_dependents_traversal_multi_hop(client, login):
    login(client, "alice")
    # payment-service → depends_on {db,gateway,cache} + runs_on {server}
    deps = {d["id"] for d in client.get("/api/cis/ci1/dependents").json()}
    assert deps == {"ci2", "ci3", "ci4", "ci5"}
    # web-frontend depends_on api-gateway (ci3); ci3 runs_on ci5 → multi-hop
    web_deps = {d["id"] for d in client.get("/api/cis/ci6/dependents").json()}
    assert "ci3" in web_deps
    assert "ci5" in web_deps  # reached via ci3.runs_on


def test_dependents_unknown_ci(client, login):
    login(client, "alice")
    assert client.get("/api/cis/nope/dependents").status_code == 404


def test_update_ci_status_agent_only(client, login):
    login(client, "carol")  # requester → 403
    assert client.patch("/api/cis/ci2/status", json={"status": "maintenance"}).status_code == 403
    login(client, "alice")  # agent → ok
    r = client.patch("/api/cis/ci2/status", json={"status": "maintenance"})
    assert r.status_code == 200
    assert r.json()["status"] == "maintenance"
