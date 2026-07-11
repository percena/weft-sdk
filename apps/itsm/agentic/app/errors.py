"""HTTP error type + helpers — the 409 + allowed_actions reactive backstop.

Illegal state-machine transitions raise ``conflict(...)`` so the API returns
``409 { error, allowed_actions }`` — the contract the agent's system prompt
and the weft action-bridge both rely on.
"""
from __future__ import annotations


class HttpError(Exception):
    def __init__(self, status: int, message: str, extra: dict | None = None):
        self.status = status
        self.message = message
        self.extra = extra or {}
        super().__init__(message)


def not_found(msg: str) -> HttpError:
    return HttpError(404, msg)


def bad_request(msg: str) -> HttpError:
    return HttpError(400, msg)


def conflict(msg: str, allowed_actions: list[str]) -> HttpError:
    return HttpError(409, msg, {"allowed_actions": allowed_actions})


def forbidden(msg: str) -> HttpError:
    return HttpError(403, msg)
