"""Utility routes: GET /api/state (snapshot) + POST /api/reset.

Not agent tools — they back the demo UI + a hard reset for re-runs.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import current_user
from ..schemas import User
from ..store import store

router = APIRouter(tags=["utility"])


@router.get("/api/state")
def state(_: User = Depends(current_user)):
    return store.snapshot()


@router.post("/api/reset")
def reset(_: User = Depends(current_user)):
    store.reset(actor="system")
    return {"ok": True}
