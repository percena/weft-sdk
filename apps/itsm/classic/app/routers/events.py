"""SSE event feed (GET /api/events).

Wire format: ``event: itsm.event\\ndata: <Event json>\\n\\n`` + a
``:keepalive\\n\\n`` comment every 15s. The agentic action-bridge listens on
the ``itsm.event`` channel and replays ``actor == 'agent'`` events as an automated live
cursor. This classic emits ``actor`` = the logged-in username (the audit
trail); the skill's added ``X-Weft-Actor`` override is what marks agent calls.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..auth import current_user
from ..schemas import Event, User
from ..store import store

router = APIRouter(tags=["events"])


def _frame(event: Event) -> str:
    return f"event: itsm.event\ndata: {json.dumps(event.model_dump(mode='json'))}\n\n"


@router.get("/api/events")
async def events(_: User = Depends(current_user)):
    async def gen():
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def push(event: Event) -> None:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, event)
            except RuntimeError:
                pass  # loop closed mid-flight

        unsub = store.on_event(push)
        try:
            yield f"event: itsm.hello\ndata: {json.dumps({'ok': True})}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield _frame(event)
                except asyncio.TimeoutError:
                    yield ":keepalive\n\n"
        finally:
            unsub()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
