"""The two state machines (incident + change). Pure data + functions.

Consumed by the store (``app/store.py``) so the backend's enforcement is the
single source of truth. ``$prior`` back-edges (incident ``reopen``, change
``rollback``) restore a recorded prior status. Non-status mutations
(``add_comment`` / ``link_*`` / ``update_priority``) are valid on any *open*
record and excluded from the allowed_actions of terminal states.
"""
from __future__ import annotations

# --- Incident SM (6 states; reopen is a $prior back-edge to in_progress) ---
INCIDENT_STATES = ["new", "in_progress", "pending_user", "resolved", "closed", "escalated"]

INCIDENT_TRANSITIONS: dict[str, dict] = {
    "assign":       {"from": ["new"], "to": "in_progress"},
    "request_info": {"from": ["in_progress"], "to": "pending_user"},
    "provide_info": {"from": ["pending_user"], "to": "in_progress"},
    "escalate":     {"from": ["new", "in_progress", "pending_user"], "to": "escalated"},
    "resolve":      {"from": ["in_progress", "escalated"], "to": "resolved"},
    "close":        {"from": ["resolved"], "to": "closed"},
    "reopen":       {"from": ["resolved"], "to": "$prior"},
}

# Mutations that don't change status — valid while the incident is open.
INCIDENT_OPEN_MUTATIONS = {"add_comment", "link_ci", "link_change", "update_priority"}

# --- Change SM (9 states; rollback is a $prior back-edge + auto-incident) ---
CHANGE_STATES = [
    "draft", "submitted", "cab_approved", "scheduled",
    "implementing", "implemented", "closed", "rejected", "rolled_back",
]

CHANGE_TRANSITIONS: dict[str, dict] = {
    "submit":    {"from": ["draft"], "to": "submitted"},
    "approve":   {"from": ["submitted"], "to": "cab_approved"},
    "reject":    {"from": ["submitted"], "to": "rejected"},
    "schedule":  {"from": ["cab_approved"], "to": "scheduled"},
    "implement": {"from": ["scheduled"], "to": "implementing"},
    "complete":  {"from": ["implementing"], "to": "implemented"},
    "rollback":  {"from": ["implementing", "implemented"], "to": "rolled_back"},
    "close":     {"from": ["implemented"], "to": "closed"},
}

CHANGE_OPEN_MUTATIONS = {"link_ci", "link_incident"}


def _sm_actions(transitions: dict[str, dict], status: str) -> list[str]:
    return [a for a, rule in transitions.items() if status in rule["from"]]


def incident_allowed_actions(status: str) -> list[str]:
    acts = _sm_actions(INCIDENT_TRANSITIONS, status)
    if status != "closed":
        acts += sorted(INCIDENT_OPEN_MUTATIONS)
    return acts


def change_allowed_actions(status: str) -> list[str]:
    acts = _sm_actions(CHANGE_TRANSITIONS, status)
    if status not in ("closed", "rejected", "rolled_back"):
        acts += sorted(CHANGE_OPEN_MUTATIONS)
    return acts


def resolve_target(rule: dict, prior: str | None) -> str:
    """``$prior`` rules restore the recorded prior status."""
    if rule["to"] == "$prior":
        if not prior:
            raise ValueError("no prior status recorded to return to")
        return prior
    return rule["to"]
