"""User routes — list/get (the on-call lookup the agent uses to assign)."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import require_role
from ..schemas import User
from ..store import store

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", operation_id="listUsers", response_model=list[User])
def list_users(_: User = Depends(require_role("agent", "manager"))):
    return store.list_users()


@router.get("/{uid}", operation_id="getUser", response_model=User)
def get_user(uid: str, _: User = Depends(require_role("agent", "manager"))):
    return store.get_user(uid)
