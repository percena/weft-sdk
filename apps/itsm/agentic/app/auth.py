"""Cookie-session auth + role-based access (Depends-based).

In-memory sessions (token → username), HttpOnly + SameSite=Lax cookie.
``current_user`` resolves the session; ``require_role(*roles)`` gates by role.
The audit ``actor`` is the username. NB: no ``X-Weft-Actor`` handling here —
the agentic layer (built by the skill) adds the ``agent`` distinction. This
file is a plain SaaS.
"""
from __future__ import annotations

import secrets

from fastapi import Cookie, Depends

from .errors import HttpError, forbidden
from .schemas import User
from .store import store

SESSION_COOKIE = "itsm_session"
sessions: dict[str, str] = {}  # token -> username


def start_session(username: str) -> str:
    token = secrets.token_urlsafe(24)
    sessions[token] = username
    return token


def end_session(token: str | None) -> None:
    sessions.pop(token, None)


def current_user(itsm_session: str | None = Cookie(default=None)) -> User:
    if not itsm_session or itsm_session not in sessions:
        raise HttpError(401, "not logged in")
    user = store.find_user_by_username(sessions[itsm_session])
    if not user:
        raise HttpError(401, "not logged in")
    return user


def require_role(*roles: str):
    def _dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise forbidden(
                f"role {user.role!r} not allowed; requires one of: {', '.join(roles)}"
            )
        return user
    return _dep
