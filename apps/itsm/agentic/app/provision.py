"""weftd provisioning chain — Python port of the skill's ``provision.mjs``.

Lazily provisions the weftd app + toolset + skill + automation + graph on the
pre-existing tenant (``WEFT_TENANT_ID``) the first time ``ensure_app()`` runs.
The 5 weftd slugs + the model + the spec path + the display name are passed in
by the caller (``app/main.py`` resolves them — kept parameterized so this
module is the skill's generic Python template, not ITSM-hardcoded).

``weftd_api`` is sync (httpx.Client) — fine for the provisioning chain + the
session-creation call (both are short request/response, not the streaming
``/v1`` proxy — that's in ``session_routes.py`` with ``httpx.AsyncClient``).
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import httpx

_HERE = Path(__file__).resolve().parent
_APP_ROOT = _HERE.parent  # apps/itsm/agentic/

_HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}


def derive_tool_names(spec: dict, toolset: str) -> list[str]:
    """Fail-closed allowlist: ``<toolset>_<operationId>``.lower() per operationId.

    the runtime's tool visibility is fail-closed on an empty allowlist — these
    ``<toolset>_*`` names must be listed for the named-toolset tools to be
    visible to the LLM. ``plan_route`` is runtime-internal, never listed.
    """
    names: list[str] = []
    for methods in (spec.get("paths") or {}).values():
        for m, op in (methods or {}).items():
            if m not in _HTTP_METHODS:
                continue
            if isinstance(op, dict) and op.get("operationId"):
                names.append(f"{toolset}_{op['operationId']}".lower())
    return names


class Provisioning:
    def __init__(self, *, weftd_base: str, api_key: str, tenant_id: str,
                 system_prompt: str, toolset: str, app_slug: str, app_name: str,
                 skill_slug: str, graph_slug: str, model: str, spec_path: str):
        self.weftd_base = weftd_base.rstrip("/")
        self.api_key = api_key
        self.tenant_id = tenant_id
        self.system_prompt = system_prompt
        self.toolset = toolset
        self.app_slug = app_slug
        self.app_name = app_name
        self.skill_slug = skill_slug
        self.graph_slug = graph_slug
        self.model = model
        spec = Path(spec_path)
        self.spec_path = spec if spec.is_absolute() else _APP_ROOT / spec
        self._ctx: dict | None = None
        self._lock = threading.Lock()
        self._client = httpx.Client(timeout=60.0, headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        })

    def weftd_api(self, method: str, path: str, body=None) -> dict:
        """One provisioning call. Retries ONCE on a transient pre-handshake
        TLS/connect error (a reverse-proxy TLS-handshake drop — ``httpx.ConnectError`` /
        ``ConnectTimeout``), mirroring the ``/v1`` proxy's retry in
        ``session_routes.py``. HTTP 4xx/5xx are NOT retried — the provisioning
        chain is idempotent (find-or-create + draft/validate/publish/bind), so
        a re-run after a mid-chain failure is safe, but a single HTTP error is
        a real problem, not a transient one."""
        def _do() -> dict:
            resp = self._client.request(method, f"{self.weftd_base}{path}", json=body)
            if resp.status_code >= 400:
                try:
                    msg = resp.json().get("error", f"HTTP {resp.status_code}")
                except Exception:
                    msg = f"HTTP {resp.status_code}"
                raise RuntimeError(f"{msg} ({method} {path})")
            return resp.json() if resp.content else {}
        try:
            return _do()
        except (httpx.ConnectError, httpx.ConnectTimeout):
            return _do()  # one retry on a reverse-proxy TLS-handshake drop

    def _provision_app(self) -> dict:
        # tenant is pre-provisioned via the Weft console (WEFT_TENANT_ID).
        tenant_id = self.tenant_id
        if not tenant_id:
            t = self.weftd_api("POST", "/v1/tenants", {"name": self.app_name})
            tenant_id = t["tenant_id"]

        apps = self.weftd_api("GET", f"/v1/tenants/{tenant_id}/apps")
        existing = next(
            (a for a in (apps if isinstance(apps, list) else []) if a.get("slug") == self.app_slug),
            None,
        )
        # Register the control-plane app with the same origin allowlist the local
        # server enforces (ITSM_CORS_ORIGINS). Fall back to "*" only when unset —
        # the dev default — so a production integrator who sets ITSM_CORS_ORIGINS
        # gets weftd-side origin enforcement instead of an open wildcard.
        allowed_origins = [o.strip() for o in os.environ.get("ITSM_CORS_ORIGINS", "").split(",") if o.strip()]
        app = existing or self.weftd_api("POST", f"/v1/tenants/{tenant_id}/apps", {
            "slug": self.app_slug, "display_name": self.app_name,
            "allowed_origins": allowed_origins or ["*"],
        })
        app_id = app["app_id"]
        app_base = f"/v1/tenants/{tenant_id}/apps/{app_id}"

        spec = json.loads(self.spec_path.read_text())
        tool_names = derive_tool_names(spec, self.toolset)
        skill_payload = {
            "tool_names": tool_names,
            "system_prompt": self.system_prompt,
            "model": os.environ.get("OPENAI_MODEL") or self.model,
        }
        auto_payload = {"config_snapshot": json.dumps({
            "trigger": {"event": "session.created"},
            "action": {"type": "agent_message", "message":
                f"Hello! I'm the {self.app_name} assistant. I can help you manage "
                f"incidents, changes, and CIs. Try: 'P1: payment service down — "
                f"find the on-call, link the dependent CIs, assign + escalate'!"},
        })}

        # Toolset is tenant-scoped (sequential); skill/automation/graph are
        # app-scoped (independent — but kept sequential here for clarity).
        self._provision_toolset(tenant_id, spec)
        self._provision_skill(app_base, skill_payload)
        self._provision_automation(app_base, auto_payload)
        self._provision_graph(app_base)
        return {"tenant_id": tenant_id, "app_id": app_id}

    def _provision_toolset(self, tenant_id: str, spec: dict) -> None:
        # execution:"client" — same-origin + cookie + local → the browser
        # executes the tool calls (the cookie authenticates; X-Weft-Actor is
        # stamped by the runtime). base_url:"" → relative paths.
        self.weftd_api("PUT", f"/v1/tenants/{tenant_id}/toolsets/{self.toolset}", {
            "base_url": "", "execution": "client", "auth_type": "none",
            "spec": spec, "enabled": True,
        })

    def _provision_graph(self, app_base: str) -> None:
        graph_file = _APP_ROOT / f"{self.app_slug}-graph.json"
        if not graph_file.exists():
            print(f"[{self.app_slug}] {self.app_slug}-graph.json not found — "
                  f"skipping graph provisioning (generate + re-provision to bind)")
            return
        graph_text = graph_file.read_text()
        created = False
        try:
            self.weftd_api("POST", f"{app_base}/graphs", {
                "slug": self.graph_slug, "display_name": f"{self.app_name} Dependency Graph",
                "description": "Data-flow DAG for the API",
            })
            created = True
        except Exception:
            pass
        gv = self.weftd_api("PUT", f"{app_base}/graphs/{self.graph_slug}/draft", {"config_snapshot": graph_text})
        try:
            self.weftd_api("POST", f"{app_base}/graphs/{self.graph_slug}/validate")
            self.weftd_api("POST", f"{app_base}/graphs/{self.graph_slug}/publish")
        except Exception as e:
            # the analyzer's shared-field heuristic can produce data-flow
            # cycles (esp. when path params don't NAME-match the response id field —
            # e.g. {iid} vs `id` — so only spurious shared-field edges are inferred,
            # which cycle). Fail-open: skip the graph bind — the agent relies on the
            # system prompt + the reactive 409 backstop, NOT the graph.
            print(f"[{self.app_slug}] graph validate failed ({e}) — skipping bind "
                  f"(fail-open: the agent uses the system prompt + 409, not the graph)")
            return
        if not created:
            try:
                self.weftd_api("DELETE", f"{app_base}/graphs/{self.graph_slug}/unbind")
            except Exception:
                pass
        self.weftd_api("POST", f"{app_base}/graphs/{self.graph_slug}/bind", {"version_id": gv["version_id"]})

    def _provision_skill(self, app_base: str, payload: dict) -> None:
        created = False
        try:
            self.weftd_api("POST", f"{app_base}/skills", {
                "slug": self.skill_slug, "display_name": self.app_name, "description": "Assistant skill",
            })
            created = True
        except Exception:
            pass
        sv = self.weftd_api("PUT", f"{app_base}/skills/{self.skill_slug}/draft", payload)
        self.weftd_api("POST", f"{app_base}/skills/{self.skill_slug}/validate")
        self.weftd_api("POST", f"{app_base}/skills/{self.skill_slug}/publish")
        if not created:
            try:
                self.weftd_api("DELETE", f"{app_base}/skills/{self.skill_slug}/unbind")
            except Exception:
                pass
        self.weftd_api("POST", f"{app_base}/skills/{self.skill_slug}/bind", {"version_id": sv["version_id"]})

    def _provision_automation(self, app_base: str, payload: dict) -> None:
        created = False
        try:
            self.weftd_api("POST", f"{app_base}/automations", {
                "slug": "welcome", "display_name": "Welcome Greeting", "description": "Greeting",
            })
            created = True
        except Exception:
            pass
        av = self.weftd_api("PUT", f"{app_base}/automations/welcome/draft", payload)
        self.weftd_api("POST", f"{app_base}/automations/welcome/validate")
        self.weftd_api("POST", f"{app_base}/automations/welcome/publish")
        if not created:
            try:
                self.weftd_api("DELETE", f"{app_base}/automations/welcome/unbind")
            except Exception:
                pass
        self.weftd_api("POST", f"{app_base}/automations/welcome/bind", {"version_id": av["version_id"]})

    def ensure_app(self) -> dict:
        """Lazy + thread-safe. First call provisions; later calls return the ctx."""
        if self._ctx and self._ctx.get("app_id"):
            return self._ctx
        with self._lock:
            if self._ctx and self._ctx.get("app_id"):
                return self._ctx
            self._ctx = self._provision_app()  # raises on failure → _ctx stays None → next call retries
            return self._ctx


def create_provisioning(*, weftd_base, api_key, tenant_id, system_prompt,
                        toolset, app_slug, app_name, skill_slug, graph_slug, model, spec_path):
    return Provisioning(
        weftd_base=weftd_base, api_key=api_key, tenant_id=tenant_id,
        system_prompt=system_prompt, toolset=toolset, app_slug=app_slug,
        app_name=app_name, skill_slug=skill_slug, graph_slug=graph_slug,
        model=model, spec_path=spec_path,
    )
