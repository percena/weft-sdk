"""Incident routes — the agent's incident-management tools.

operationIds are camelCase → the skill derives ``itsm_<operationId>`` tool names
(e.g. ``createIncident`` → ``itsm_createincident``). Role gates:
requester/agent create + comment; agent works (assign/escalate/
resolve/close/reopen/link/priority).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..auth import current_user, require_role
from ..schemas import (
    AddCommentRequest,
    AssignRequest,
    CreateIncidentRequest,
    Incident,
    LinkChangeRequest,
    LinkCiRequest,
    ResolveIncidentRequest,
    UpdatePriorityRequest,
    User,
)
from ..store import store

router = APIRouter(prefix="/api/incidents", tags=["incidents"])


@router.post("", operation_id="createIncident", response_model=Incident)
def create_incident(
    body: CreateIncidentRequest,
    user: User = Depends(require_role("requester", "agent")),
):
    return store.create_incident(
        title=body.title,
        description=body.description,
        priority=body.priority,
        category=body.category,
        affected_ci=body.affected_ci,
        requester=user.username,
        actor=user.username,
    )


@router.get("", operation_id="listIncidents", response_model=list[Incident])
def list_incidents(
    status: str | None = Query(default=None),
    assignee: str | None = Query(default=None),
    _: User = Depends(current_user),
):
    return store.list_incidents(status=status, assignee=assignee)


@router.get("/{iid}", operation_id="getIncident", response_model=Incident)
def get_incident(iid: str, _: User = Depends(current_user)):
    return store.get_incident(iid)


@router.post("/{iid}/assign", operation_id="assignIncident", response_model=Incident)
def assign_incident(iid: str, body: AssignRequest, user: User = Depends(require_role("agent"))):
    return store.assign_incident(iid, body.assignee, user.username)


@router.post("/{iid}/request-info", operation_id="requestInfo", response_model=Incident)
def request_info(iid: str, user: User = Depends(require_role("agent"))):
    return store.request_info(iid, user.username)


@router.post("/{iid}/provide-info", operation_id="provideInfo", response_model=Incident)
def provide_info(iid: str, user: User = Depends(require_role("agent", "requester"))):
    return store.provide_info(iid, user.username)


@router.post("/{iid}/escalate", operation_id="escalateIncident", response_model=Incident)
def escalate_incident(iid: str, user: User = Depends(require_role("agent"))):
    return store.escalate_incident(iid, user.username)


@router.post("/{iid}/resolve", operation_id="resolveIncident", response_model=Incident)
def resolve_incident(
    iid: str,
    body: ResolveIncidentRequest,
    user: User = Depends(require_role("agent")),
):
    return store.resolve_incident(iid, body.resolution_note, user.username)


@router.post("/{iid}/close", operation_id="closeIncident", response_model=Incident)
def close_incident(iid: str, user: User = Depends(require_role("agent"))):
    return store.close_incident(iid, user.username)


@router.post("/{iid}/reopen", operation_id="reopenIncident", response_model=Incident)
def reopen_incident(iid: str, user: User = Depends(require_role("agent"))):
    return store.reopen_incident(iid, user.username)


@router.post("/{iid}/comments", operation_id="addIncidentComment", response_model=Incident)
def add_comment(
    iid: str,
    body: AddCommentRequest,
    user: User = Depends(require_role("requester", "agent")),
):
    return store.add_incident_comment(iid, body.body, user.username, user.username)


@router.post("/{iid}/priority", operation_id="updateIncidentPriority", response_model=Incident)
def update_priority(
    iid: str,
    body: UpdatePriorityRequest,
    user: User = Depends(require_role("agent")),
):
    return store.update_incident_priority(iid, body.priority, user.username)


@router.post("/{iid}/link/ci", operation_id="linkIncidentCi", response_model=Incident)
def link_ci(iid: str, body: LinkCiRequest, user: User = Depends(require_role("agent"))):
    return store.link_incident_ci(iid, body.ci_id, user.username)


@router.post("/{iid}/link/change", operation_id="linkIncidentChange", response_model=Incident)
def link_change(iid: str, body: LinkChangeRequest, user: User = Depends(require_role("agent"))):
    return store.link_incident_change(iid, body.change_id, user.username)
