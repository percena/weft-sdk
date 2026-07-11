"""Weft actor extraction — the ``X-Weft-Actor`` → event-actor override.

The classic ITSM emits ``actor = <username>`` (the audit trail). The agentic
layer adds: when the Weft browser runtime stamps ``X-Weft-Actor: agent`` on a
client-side tool call, the event's ``actor`` becomes ``"agent"`` so the
action-bridge replays it as an automated live cursor. A real site won't have this logic —
the skill must add it. Here it's a contextvar set by a middleware + read by
``store.emit`` (a one-line override there).
"""
from __future__ import annotations

from contextvars import ContextVar

# "agent" when X-Weft-Actor=agent; else None (the store falls back to the
# passed username).
actor_var: ContextVar[str | None] = ContextVar("weft_actor", default=None)


def get_actor() -> str | None:
    return actor_var.get()


async def actor_middleware(request, call_next):
    if request.headers.get("x-weft-actor") == "agent":
        token = actor_var.set("agent")
        try:
            return await call_next(request)
        finally:
            actor_var.reset(token)
    return await call_next(request)
