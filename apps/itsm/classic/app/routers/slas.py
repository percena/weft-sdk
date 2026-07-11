"""SLA routes — list/get the priority → response/resolution target matrix."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import current_user
from ..schemas import SLA, User
from ..store import store

router = APIRouter(prefix="/api/slas", tags=["slas"])


@router.get("", operation_id="listSlas", response_model=list[SLA])
def list_slas(_: User = Depends(current_user)):
    return store.list_slas()


@router.get("/{sid}", operation_id="getSla", response_model=SLA)
def get_sla(sid: str, _: User = Depends(current_user)):
    return store.get_sla(sid)
