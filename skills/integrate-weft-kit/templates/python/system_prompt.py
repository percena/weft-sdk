"""Renders the agent's system prompt from YOUR state-machine module — the same
SM the backend enforces, so the prompt can't drift. Skill template (Python
branch) — port of ``lib/system-prompt.mjs``.

CUSTOMIZE:
- Point ``state_machine`` at YOUR SM module (it must export transition dicts).
- Render one transition block per resource SM (multi-resource apps call
  ``_transition_lines`` once per SM and concatenate).
- Replace the ``{{toolset}}`` prefix + the workflow rules with YOUR app's.
  The one error-prone manual step (runbook Step 6): after substituting,
  ``perl -i -pe 's/\\b{{toolset}}_/YOURTOOLSET_/g' system_prompt.py``.
"""
from __future__ import annotations

# CUSTOMIZE: import YOUR state-machine module.
from . import state_machine as sm


def _transition_lines(transitions: dict) -> list[str]:
    out = []
    for action, rule in transitions.items():
        frm = " / ".join(rule["from"])
        to = "back to prior status" if rule["to"] == "$prior" else rule["to"]
        out.append(f"- {action}: {frm} → {to}")
    return out


def build_system_prompt() -> str:
    # CUSTOMIZE: render YOUR SMs here (one block per resource SM).
    lines = _transition_lines(getattr(sm, "TRANSITIONS", {}))
    rules = "\n".join(lines)
    return f"""You are a {{appName}} operations assistant. You drive the REST API via the named {{toolset}}_* tools — each tool's name, arguments, and return schema are defined in its tool definition. Call them directly (they execute in the browser, same-origin).

## Planning multi-step sequences

For any task involving more than one API call, call plan_route with the target operation first — it returns the correct call order (precursors first) from the session's verified dependency graph. Respect missing_precursor / missing_precondition errors: they tell you which operation to run first; do not retry the same call blindly.

## State Machine (only the following transitions are valid; a 409 means the status doesn't allow the action)

{rules}

## Behavior Rules

1. A 409 means the current status doesn't allow that action. The response includes allowed_actions — relay them + don't retry the same action.
2. After a write, confirm in one sentence (e.g. "INC-1 created, P1, assigned to alice"). Don't dump raw JSON.
3. Don't invent arguments outside the tools' schemas.
4. Identity headers (X-Weft-*, Authorization, Cookie) are controlled by the runtime — don't set them yourself.
5. ALWAYS call the list/get tools when a user mentions a resource — never ask for details you can fetch yourself.
6. CUSTOMIZE: add YOUR app's workflow rules here (e.g. for a P1 incident: create → link dependent CIs → assign on-call → escalate → resolve → close).
"""
