"""Change routes — the agent's change-management tools (CAB + rollback).

``approve``/``reject`` are manager-only (CAB separation of duties); the rest
are agent. ``rollback`` auto-creates + links the incident the change caused
(in the store).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..auth import current_user, require_role
from ..schemas import (
    Change,
    CreateChangeRequest,
    LinkCiRequest,
    LinkIncidentRequest,
    ScheduleChangeRequest,
    User,
)
from ..store import store

router = APIRouter(prefix="/api/changes", tags=["changes"])


@router.post("", operation_id="createChange", response_model=Change)
def create_change(body: CreateChangeRequest, user: User = Depends(require_role("agent"))):
    return store.create_change(
        title=body.title,
        description=body.description,
        type=body.type,
        risk=body.risk,
        affected_cis=body.affected_cis,
        rollback_plan=body.rollback_plan,
        requester=user.username,
        actor=user.username,
    )


@router.get("", operation_id="listChanges", response_model=list[Change])
def list_changes(status: str | None = Query(default=None), _: User = Depends(current_user)):
    return store.list_changes(status=status)


@router.get("/{cid}", operation_id="getChange", response_model=Change)
def get_change(cid: str, _: User = Depends(current_user)):
    return store.get_change(cid)


@router.post("/{cid}/submit", operation_id="submitChange", response_model=Change)
def submit_change(cid: str, user: User = Depends(require_role("agent"))):
    return store.submit_change(cid, user.username)


@router.post("/{cid}/approve", operation_id="approveChange", response_model=Change)
def approve_change(cid: str, user: User = Depends(require_role("manager"))):
    return store.approve_change(cid, user.username)


@router.post("/{cid}/reject", operation_id="rejectChange", response_model=Change)
def reject_change(cid: str, user: User = Depends(require_role("manager"))):
    return store.reject_change(cid, user.username)


@router.post("/{cid}/schedule", operation_id="scheduleChange", response_model=Change)
def schedule_change(
    cid: str,
    body: ScheduleChangeRequest,
    user: User = Depends(require_role("agent")),
):
    return store.schedule_change(cid, body.change_window, user.username)


@router.post("/{cid}/implement", operation_id="implementChange", response_model=Change)
def implement_change(cid: str, user: User = Depends(require_role("agent"))):
    return store.implement_change(cid, user.username)


@router.post("/{cid}/complete", operation_id="completeChange", response_model=Change)
def complete_change(cid: str, user: User = Depends(require_role("agent"))):
    return store.complete_change(cid, user.username)


@router.post("/{cid}/rollback", operation_id="rollbackChange", response_model=Change)
def rollback_change(cid: str, user: User = Depends(require_role("agent"))):
    return store.rollback_change(cid, user.username)


@router.post("/{cid}/close", operation_id="closeChange", response_model=Change)
def close_change(cid: str, user: User = Depends(require_role("agent"))):
    return store.close_change(cid, user.username)


@router.post("/{cid}/link/ci", operation_id="linkChangeCi", response_model=Change)
def link_change_ci(cid: str, body: LinkCiRequest, user: User = Depends(require_role("agent"))):
    return store.link_change_ci(cid, body.ci_id, user.username)


@router.post("/{cid}/link/incident", operation_id="linkChangeIncident", response_model=Change)
def link_change_incident(cid: str, body: LinkIncidentRequest, user: User = Depends(require_role("agent"))):
    return store.link_change_incident(cid, body.incident_id, user.username)
