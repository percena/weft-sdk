"""In-memory store: the 5 resources, SM enforcement, CI-graph traversal, events.

Dependency-free on purpose — robust (no DB locking/corruption for a demo),
trivial to reset/clean up, and the OpenAPI derives from the Pydantic schemas
(``app/schemas.py``), not from the persistence layer. Swappable for a real DB
later without touching the routers.

The store stamps ``actor`` on every event = the calling user's username (or
``"system"`` for seed/reset). The weft ``X-Weft-Actor: agent`` override is
NOT here — the agentic layer (built by the skill) adds it. This file is a
plain ITSM SaaS, no weft.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any, Callable

from .errors import bad_request, conflict, not_found
from .schemas import (
    CI, Change, Comment, Event, HistoryEntry, Incident, SLA, User,
)
from .seed import SEED_CIS, SEED_SLAS, SEED_USERS
from . import state_machine as sm


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _short_id() -> str:
    return secrets.token_hex(4)


class Store:
    """Holds the world. Mutations enforce the SM + emit events."""

    def __init__(self, now: Callable[[], datetime] = _utcnow) -> None:
        self._now = now
        self._listeners: list[Callable[[Event], None]] = []
        self.reset()

    # --- lifecycle ---
    def reset(self, actor: str = "system") -> None:
        self.users: dict[str, dict] = {u["id"]: dict(u) for u in SEED_USERS}
        self.cis: dict[str, dict] = {c["id"]: {**c, "created_at": self._now()} for c in SEED_CIS}
        self.slas: dict[str, dict] = {s["id"]: dict(s) for s in SEED_SLAS}
        self.incidents: dict[str, dict] = {}
        self.changes: dict[str, dict] = {}
        self._inc_seq = 0
        self._chg_seq = 0
        self._cmt_seq = 0
        self.emit(actor, "itsm.reset", {})

    def on_event(self, fn: Callable[[Event], None]) -> Callable[[], None]:
        self._listeners.append(fn)
        def unsub() -> None:
            if fn in self._listeners:
                self._listeners.remove(fn)
        return unsub

    def emit(self, actor: str, action: str, data: dict[str, Any]) -> Event:
        evt = Event(id=f"evt-{self._now().timestamp():.0f}-{_short_id()}", ts=self._now(), actor=actor, action=action, data=data)
        for fn in list(self._listeners):
            try:
                fn(evt)
            except Exception:
                pass  # a dead listener must not kill the broadcast
        return evt

    # --- users / cis / slas (read + minor update) ---
    def list_users(self) -> list[User]:
        return [User(**u) for u in self.users.values()]

    def get_user(self, uid: str) -> User:
        u = self.users.get(uid)
        if not u:
            raise not_found(f"user not found: {uid}")
        return User(**u)

    def find_user_by_username(self, username: str) -> User | None:
        for u in self.users.values():
            if u["username"] == username:
                return User(**u)
        return None

    def list_cis(self) -> list[CI]:
        return [self._ci_view(c) for c in self.cis.values()]

    def get_ci(self, cid: str) -> CI:
        c = self.cis.get(cid)
        if not c:
            raise not_found(f"CI not found: {cid}")
        return self._ci_view(c)

    def get_ci_dependents(self, cid: str) -> list[CI]:
        """Multi-hop traversal of depends_on + runs_on (the CMDB triage step)."""
        if cid not in self.cis:
            raise not_found(f"CI not found: {cid}")
        seen: set[str] = set()
        order: list[str] = []
        stack = [cid]
        while stack:
            cur = stack.pop()
            if cur in seen or cur not in self.cis:
                continue
            seen.add(cur)
            order.append(cur)
            c = self.cis[cur]
            stack.extend(c.get("depends_on", []) + c.get("runs_on", []))
        # exclude the root itself from "dependents"
        return [self._ci_view(self.cis[i]) for i in order if i != cid]

    def update_ci_status(self, cid: str, status: str, actor: str) -> CI:
        c = self.cis.get(cid)
        if not c:
            raise not_found(f"CI not found: {cid}")
        c["status"] = status
        self.emit(actor, "ci.updated", {"ci": self._ci_view(c).model_dump(mode="json")})
        return self._ci_view(c)

    def list_slas(self) -> list[SLA]:
        return [SLA(**s) for s in self.slas.values()]

    def get_sla(self, sid: str) -> SLA:
        s = self.slas.get(sid)
        if not s:
            raise not_found(f"SLA not found: {sid}")
        return SLA(**s)

    def _sla_for_priority(self, priority: str) -> str | None:
        for s in self.slas.values():
            if s["priority"] == priority:
                return s["id"]
        return None

    # --- incidents ---
    def create_incident(self, *, title: str, description: str, priority: str,
                        category: str, affected_ci: str | None, requester: str,
                        actor: str) -> Incident:
        if affected_ci and affected_ci not in self.cis:
            raise bad_request(f"unknown CI: {affected_ci}")
        self._inc_seq += 1
        iid = f"INC-{self._inc_seq}"
        now = self._now()
        rec: dict = {
            "id": iid, "title": title, "description": description, "priority": priority,
            "status": "new", "category": category, "assignee": None, "requester": requester,
            "affected_ci": affected_ci, "linked_cis": [], "linked_changes": [], "comments": [],
            "resolution_note": None, "sla_id": self._sla_for_priority(priority),
            "prior_status": None, "created_at": now, "updated_at": now, "history": [],
        }
        rec["history"].append({"action": "create", "from_status": None, "to_status": "new", "at": now, "actor": actor})
        self.incidents[iid] = rec
        self.emit(actor, "incident.created", {"incident": self._incident_view(rec).model_dump(mode="json")})
        return self._incident_view(rec)

    def list_incidents(self, *, status: str | None = None, assignee: str | None = None) -> list[Incident]:
        out = [self._incident_view(r) for r in self.incidents.values()]
        if status:
            out = [i for i in out if i.status == status]
        if assignee:
            out = [i for i in out if i.assignee == assignee]
        out.sort(key=lambda i: i.created_at, reverse=True)
        return out

    def get_incident(self, iid: str) -> Incident:
        rec = self.incidents.get(iid)
        if not rec:
            raise not_found(f"incident not found: {iid}")
        return self._incident_view(rec)

    def _incident_transition(self, iid: str, action: str, actor: str) -> Incident:
        rec = self.incidents.get(iid)
        if not rec:
            raise not_found(f"incident not found: {iid}")
        rule = sm.INCIDENT_TRANSITIONS.get(action)
        if not rule:
            raise bad_request(f"unknown action: {action}")
        if rec["status"] not in rule["from"]:
            raise conflict(
                f"cannot {action} incident {iid} in status {rec['status']}",
                sm.incident_allowed_actions(rec["status"]),
            )
        from_status = rec["status"]
        # record prior before resolving (for reopen $prior restore)
        if action == "resolve":
            rec["prior_status"] = from_status
        to = sm.resolve_target(rule, rec.get("prior_status"))
        # reopen consumes + clears the prior
        if action == "reopen":
            rec["prior_status"] = None
        rec["status"] = to
        rec["updated_at"] = self._now()
        rec["history"].append({"action": action, "from_status": from_status, "to_status": to, "at": rec["updated_at"], "actor": actor})
        self.emit(actor, "incident.transitioned",
                  {"incident": self._incident_view(rec).model_dump(mode="json"), "action": action, "from": from_status, "to": to})
        return self._incident_view(rec)

    def assign_incident(self, iid: str, assignee: str | None, actor: str) -> Incident:
        rec = self.incidents.get(iid)
        if not rec:
            raise not_found(f"incident not found: {iid}")
        # default: the affected_ci's owner (the on-call)
        if not assignee:
            if not rec.get("affected_ci"):
                raise bad_request("no assignee and no affected_ci to derive the on-call from")
            ci = self.cis.get(rec["affected_ci"])
            if not ci:
                raise bad_request(f"affected_ci missing: {rec['affected_ci']}")
            assignee = ci["owner"]
        if not self.find_user_by_username(assignee):
            raise bad_request(f"unknown user: {assignee}")
        # assign is the new→in_progress transition (enforced via the SM)
        inc = self._incident_transition(iid, "assign", actor)
        self.incidents[iid]["assignee"] = assignee
        self.incidents[iid]["updated_at"] = self._now()
        self.emit(actor, "incident.assigned",
                  {"incident": self._incident_view(self.incidents[iid]).model_dump(mode="json"), "assignee": assignee})
        return self._incident_view(self.incidents[iid])

    def request_info(self, iid, actor):  return self._incident_transition(iid, "request_info", actor)
    def provide_info(self, iid, actor):  return self._incident_transition(iid, "provide_info", actor)
    def escalate_incident(self, iid, actor): return self._incident_transition(iid, "escalate", actor)
    def resolve_incident(self, iid, resolution_note: str | None, actor: str) -> Incident:
        rec = self.incidents.get(iid)
        if not rec:
            raise not_found(f"incident not found: {iid}")
        if resolution_note:
            rec["resolution_note"] = resolution_note
        return self._incident_transition(iid, "resolve", actor)

    def close_incident(self, iid, actor):   return self._incident_transition(iid, "close", actor)
    def reopen_incident(self, iid, actor):  return self._incident_transition(iid, "reopen", actor)

    def add_incident_comment(self, iid: str, body: str, author: str, actor: str) -> Incident:
        rec = self.incidents.get(iid)
        if not rec:
            raise not_found(f"incident not found: {iid}")
        if rec["status"] == "closed":
            raise conflict("incident is closed; reopen before commenting",
                           sm.incident_allowed_actions(rec["status"]))
        self._cmt_seq += 1
        rec["comments"].append({"id": f"cmt-{self._cmt_seq}", "author": author, "body": body, "at": self._now()})
        rec["updated_at"] = self._now()
        self.emit(actor, "incident.commented",
                  {"incident": self._incident_view(rec).model_dump(mode="json"), "comment": rec["comments"][-1]})
        return self._incident_view(rec)

    def update_incident_priority(self, iid: str, priority: str, actor: str) -> Incident:
        rec = self.incidents.get(iid)
        if not rec:
            raise not_found(f"incident not found: {iid}")
        if rec["status"] == "closed":
            raise conflict("incident is closed", sm.incident_allowed_actions(rec["status"]))
        rec["priority"] = priority
        rec["sla_id"] = self._sla_for_priority(priority)
        rec["updated_at"] = self._now()
        self.emit(actor, "incident.priority_updated",
                  {"incident": self._incident_view(rec).model_dump(mode="json"), "priority": priority})
        return self._incident_view(rec)

    def _link(self, rec: dict, key: str, target_id: str, exists_in: dict) -> None:
        if target_id not in exists_in:
            raise bad_request(f"unknown id: {target_id}")
        if target_id not in rec[key]:
            rec[key].append(target_id)

    def link_incident_ci(self, iid: str, ci_id: str, actor: str) -> Incident:
        rec = self.incidents.get(iid)
        if not rec:
            raise not_found(f"incident not found: {iid}")
        if rec["status"] == "closed":
            raise conflict("incident is closed", sm.incident_allowed_actions(rec["status"]))
        self._link(rec, "linked_cis", ci_id, self.cis)
        rec["updated_at"] = self._now()
        self.emit(actor, "incident.linked", {"incident": self._incident_view(rec).model_dump(mode="json"), "kind": "ci", "id": ci_id})
        return self._incident_view(rec)

    def link_incident_change(self, iid: str, change_id: str, actor: str) -> Incident:
        rec = self.incidents.get(iid)
        if not rec:
            raise not_found(f"incident not found: {iid}")
        if rec["status"] == "closed":
            raise conflict("incident is closed", sm.incident_allowed_actions(rec["status"]))
        self._link(rec, "linked_changes", change_id, self.changes)
        rec["updated_at"] = self._now()
        self.emit(actor, "incident.linked", {"incident": self._incident_view(rec).model_dump(mode="json"), "kind": "change", "id": change_id})
        # back-link on the change too
        chg = self.changes.get(change_id)
        if chg and iid not in chg["linked_incidents"]:
            chg["linked_incidents"].append(iid)
        return self._incident_view(rec)

    # --- changes ---
    def create_change(self, *, title: str, description: str, type: str, risk: str,
                      affected_cis: list[str], rollback_plan: str | None,
                      requester: str, actor: str) -> Change:
        for cid in affected_cis:
            if cid not in self.cis:
                raise bad_request(f"unknown CI: {cid}")
        self._chg_seq += 1
        cid = f"CHG-{self._chg_seq}"
        now = self._now()
        rec: dict = {
            "id": cid, "title": title, "description": description, "type": type, "risk": risk,
            "status": "draft", "requester": requester, "implementer": None,
            "affected_cis": list(affected_cis), "linked_incidents": [], "change_window": None,
            "rollback_plan": rollback_plan, "prior_status": None,
            "created_at": now, "updated_at": now, "history": [],
        }
        rec["history"].append({"action": "create", "from_status": None, "to_status": "draft", "at": now, "actor": actor})
        self.changes[cid] = rec
        self.emit(actor, "change.created", {"change": self._change_view(rec).model_dump(mode="json")})
        return self._change_view(rec)

    def list_changes(self, *, status: str | None = None) -> list[Change]:
        out = [self._change_view(r) for r in self.changes.values()]
        if status:
            out = [c for c in out if c.status == status]
        out.sort(key=lambda c: c.created_at, reverse=True)
        return out

    def get_change(self, cid: str) -> Change:
        rec = self.changes.get(cid)
        if not rec:
            raise not_found(f"change not found: {cid}")
        return self._change_view(rec)

    def _change_transition(self, cid: str, action: str, actor: str) -> Change:
        rec = self.changes.get(cid)
        if not rec:
            raise not_found(f"change not found: {cid}")
        rule = sm.CHANGE_TRANSITIONS.get(action)
        if not rule:
            raise bad_request(f"unknown action: {action}")
        if rec["status"] not in rule["from"]:
            raise conflict(
                f"cannot {action} change {cid} in status {rec['status']}",
                sm.change_allowed_actions(rec["status"]),
            )
        from_status = rec["status"]
        to = rule["to"]  # rollback → rolled_back (fixed); no $prior restore
        if action == "rollback":
            rec["prior_status"] = from_status  # recorded for the post-mortem
        rec["status"] = to
        rec["updated_at"] = self._now()
        rec["history"].append({"action": action, "from_status": from_status, "to_status": to, "at": rec["updated_at"], "actor": actor})
        self.emit(actor, "change.transitioned",
                  {"change": self._change_view(rec).model_dump(mode="json"), "action": action, "from": from_status, "to": to})
        # rollback auto-creates + links the incident it caused
        if action == "rollback":
            inc = self.create_incident(
                title=f"Incident caused by rollback of {cid}",
                description=f"Auto-created on rollback of change {cid} (prior status: {from_status}).",
                priority="P2", category="software",
                affected_ci=rec["affected_cis"][0] if rec["affected_cis"] else None,
                requester=actor, actor=actor,
            )
            self._link(rec, "linked_incidents", inc.id, self.incidents)
            # back-link the change on the incident
            irec = self.incidents[inc.id]
            if cid not in irec["linked_changes"]:
                irec["linked_changes"].append(cid)
        return self._change_view(rec)

    def submit_change(self, cid, actor):    return self._change_transition(cid, "submit", actor)
    def approve_change(self, cid, actor):   return self._change_transition(cid, "approve", actor)
    def reject_change(self, cid, actor):    return self._change_transition(cid, "reject", actor)
    def schedule_change(self, cid, window, actor):
        rec = self.changes.get(cid)
        if not rec:
            raise not_found(f"change not found: {cid}")
        rec["change_window"] = window
        return self._change_transition(cid, "schedule", actor)
    def implement_change(self, cid, actor): return self._change_transition(cid, "implement", actor)
    def complete_change(self, cid, actor):  return self._change_transition(cid, "complete", actor)
    def rollback_change(self, cid, actor):  return self._change_transition(cid, "rollback", actor)
    def close_change(self, cid, actor):     return self._change_transition(cid, "close", actor)

    def link_change_ci(self, cid: str, ci_id: str, actor: str) -> Change:
        rec = self.changes.get(cid)
        if not rec:
            raise not_found(f"change not found: {cid}")
        if rec["status"] in ("closed", "rejected", "rolled_back"):
            raise conflict(f"change is {rec['status']}", sm.change_allowed_actions(rec["status"]))
        self._link(rec, "affected_cis", ci_id, self.cis)
        rec["updated_at"] = self._now()
        self.emit(actor, "change.linked", {"change": self._change_view(rec).model_dump(mode="json"), "kind": "ci", "id": ci_id})
        return self._change_view(rec)

    def link_change_incident(self, cid: str, incident_id: str, actor: str) -> Change:
        rec = self.changes.get(cid)
        if not rec:
            raise not_found(f"change not found: {cid}")
        if rec["status"] in ("closed", "rejected", "rolled_back"):
            raise conflict(f"change is {rec['status']}", sm.change_allowed_actions(rec["status"]))
        self._link(rec, "linked_incidents", incident_id, self.incidents)
        rec["updated_at"] = self._now()
        self.emit(actor, "change.linked", {"change": self._change_view(rec).model_dump(mode="json"), "kind": "incident", "id": incident_id})
        # back-link on the incident
        irec = self.incidents.get(incident_id)
        if irec and cid not in irec["linked_changes"]:
            irec["linked_changes"].append(cid)
        return self._change_view(rec)

    # --- snapshot (the /api/state view) ---
    def snapshot(self) -> dict:
        return {
            "users": len(self.users),
            "cis": len(self.cis),
            "slas": [SLA(**s).model_dump(mode="json") for s in self.slas.values()],
            "incidents": [i.model_dump(mode="json") for i in self.list_incidents()],
            "changes": [c.model_dump(mode="json") for c in self.list_changes()],
        }

    # --- views (raw dict → Pydantic, with allowed_actions, prior_status hidden) ---
    def _ci_view(self, c: dict) -> CI:
        return CI(**{k: v for k, v in c.items()})

    def _incident_view(self, r: dict) -> Incident:
        return Incident(
            id=r["id"], title=r["title"], description=r["description"], priority=r["priority"],
            status=r["status"], category=r["category"], assignee=r.get("assignee"),
            requester=r["requester"], affected_ci=r.get("affected_ci"),
            linked_cis=list(r.get("linked_cis", [])), linked_changes=list(r.get("linked_changes", [])),
            comments=[Comment(**c) for c in r.get("comments", [])],
            resolution_note=r.get("resolution_note"), sla_id=r.get("sla_id"),
            created_at=r["created_at"], updated_at=r["updated_at"],
            history=[HistoryEntry(**h) for h in r.get("history", [])],
            allowed_actions=sm.incident_allowed_actions(r["status"]),
        )

    def _change_view(self, r: dict) -> Change:
        return Change(
            id=r["id"], title=r["title"], description=r["description"], type=r["type"], risk=r["risk"],
            status=r["status"], requester=r["requester"], implementer=r.get("implementer"),
            affected_cis=list(r.get("affected_cis", [])), linked_incidents=list(r.get("linked_incidents", [])),
            change_window=r.get("change_window"), rollback_plan=r.get("rollback_plan"),
            created_at=r["created_at"], updated_at=r["updated_at"],
            history=[HistoryEntry(**h) for h in r.get("history", [])],
            allowed_actions=sm.change_allowed_actions(r["status"]),
        )


# Module-level singleton (the running app uses one; tests construct their own).
store = Store()
