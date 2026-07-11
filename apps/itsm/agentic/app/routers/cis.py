"""CI (CMDB) routes — list/get + multi-hop dependent traversal + status update."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import current_user, require_role
from ..schemas import CI, UpdateCiStatusRequest, User
from ..store import store

router = APIRouter(prefix="/api/cis", tags=["cis"])


@router.get("", operation_id="listCis", response_model=list[CI])
def list_cis(_: User = Depends(current_user)):
    return store.list_cis()


@router.get("/{cid}", operation_id="getCi", response_model=CI)
def get_ci(cid: str, _: User = Depends(current_user)):
    return store.get_ci(cid)


@router.get("/{cid}/dependents", operation_id="getCiDependents", response_model=list[CI])
def get_ci_dependents(cid: str, _: User = Depends(current_user)):
    return store.get_ci_dependents(cid)


@router.patch("/{cid}/status", operation_id="updateCiStatus", response_model=CI)
def update_ci_status(
    cid: str,
    body: UpdateCiStatusRequest,
    user: User = Depends(require_role("agent")),
):
    return store.update_ci_status(cid, body.status, user.username)
