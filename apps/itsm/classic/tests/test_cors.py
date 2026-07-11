"""CORS hardening guard: the default must NOT pair `*` with credentials.

Locks the regression where ``cors_origins=["*"]`` + ``allow_credentials=True``
made Starlette reflect ANY origin WITH credentials (the textbook credentialed
CORS misconfig). The dev-default (``ITSM_CORS_ORIGINS`` unset) must send
``Access-Control-Allow-Origin: *`` and NO ``Access-Control-Allow-Credentials``.
The credentialed-allowlist branch (set) is exercised via an env-driven import
in a separate process, not here.
"""
from __future__ import annotations


def test_default_preflight_pairs_star_with_no_credentials(client):
    r = client.options(
        "/api/auth/me",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "*"
    # the regression we are guarding against: credentials must NOT ship with `*`
    assert r.headers.get("access-control-allow-credentials") is None
