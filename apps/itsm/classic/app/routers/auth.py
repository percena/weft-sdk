"""Auth routes: login / logout / me. (Not agent tools — utility.)"""
from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, Response

from ..auth import SESSION_COOKIE, current_user, end_session, start_session
from ..errors import HttpError, bad_request
from ..schemas import LoginRequest, User
from ..store import store

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginRequest, response: Response):
    username = body.username.strip()
    if not username:
        raise bad_request("username is required")
    user = store.find_user_by_username(username)
    if not user:
        raise HttpError(401, f"unknown user: {username}")
    # demo: any password accepted (the seeded users have none).
    token = start_session(username)
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", path="/")
    return {"id": user.id, "username": user.username, "role": user.role}


@router.post("/logout")
def logout(
    response: Response,
    itsm_session: str | None = Cookie(default=None),
    _: User = Depends(current_user),
):
    end_session(itsm_session)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return {"id": user.id, "username": user.username, "role": user.role, "on_call_for": user.on_call_for}
