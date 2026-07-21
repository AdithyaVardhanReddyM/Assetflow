"""Progress streaming.

SSE rather than WebSockets: the feed is unidirectional (cancel is a plain POST),
SSE has reconnect semantics built in, and it survives the serverless frontend
constraints that break long-lived sockets.

Events are read from the `run_events` table rather than an in-memory bus, because
the worker may be a different process — and because Supabase's transaction pooler
does not support LISTEN/NOTIFY, so we poll by sequence instead. That also makes
replay and reconnect fall out for free.

The client must NOT use `EventSource`: it cannot set an Authorization header, and
Clerk session tokens are short-lived, so the canvas uses a fetch + ReadableStream
reader instead. Never put the token in a query string.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Header, Query, Request
from sqlalchemy import select
from sse_starlette.sse import EventSourceResponse

from app.db.models import Run, RunEvent
from app.db.session import get_sessionmaker
from app.deps import CurrentUser, Session
from app.errors import NotFound
from app.logging import get_logger

log = get_logger(__name__)
router = APIRouter(prefix="/v1/runs", tags=["events"])

_POLL_SECONDS = 0.5
_KEEPALIVE_SECONDS = 15.0
_MAX_STREAM_SECONDS = 20 * 60

_TERMINAL_EVENTS = {"run.completed", "run.failed", "run.canceled"}


async def _fetch_events(session, run_id: uuid.UUID, after_seq: int, limit: int = 200):
    result = await session.execute(
        select(RunEvent)
        .where(RunEvent.run_id == run_id, RunEvent.seq > after_seq)
        .order_by(RunEvent.seq)
        .limit(limit)
    )
    return list(result.scalars())


@router.get("/{run_id}/events/history")
async def event_history(
    run_id: uuid.UUID,
    session: Session,
    user: CurrentUser,
    after_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=2000),
) -> dict[str, Any]:
    """Polling fallback and replay source.

    Same query as the stream, so it costs nothing extra to offer — and it means a
    hostile proxy or a client that cannot hold a connection still works.
    """
    run = await _require_run(session, run_id, user)
    events = await _fetch_events(session, run_id, after_seq, limit)
    return {
        "events": [
            {
                "seq": e.seq,
                "type": e.type,
                "node_id": e.node_id,
                "payload": e.payload,
                "ts": e.created_at.isoformat() if e.created_at else None,
            }
            for e in events
        ],
        "last_seq": events[-1].seq if events else after_seq,
        "status": run.status.value,
        "terminal": run.status.is_terminal,
    }


async def _require_run(session, run_id: uuid.UUID, user: CurrentUser) -> Run:
    result = await session.execute(
        select(Run).where(Run.id == run_id, Run.tenant_id == user.tenant_id)
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise NotFound(f"Run {run_id} was not found.")
    return run


@router.get("/{run_id}/events")
async def stream_events(
    run_id: uuid.UUID,
    request: Request,
    session: Session,
    user: CurrentUser,
    after_seq: int = Query(default=0, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> EventSourceResponse:
    # Authorize once, up front, on the caller's own session.
    await _require_run(session, run_id, user)

    # A reconnecting client resumes from the last id it actually saw, which is
    # more trustworthy than the query param it was originally given.
    start = after_seq
    if last_event_id and last_event_id.isdigit():
        start = max(start, int(last_event_id))

    async def generator() -> AsyncIterator[dict[str, Any]]:
        cursor = start
        elapsed = 0.0
        since_keepalive = 0.0
        sessionmaker = get_sessionmaker()

        try:
            while elapsed < _MAX_STREAM_SECONDS:
                if await request.is_disconnected():
                    return

                async with sessionmaker() as stream_session:
                    events = await _fetch_events(stream_session, run_id, cursor)
                    terminal_seen = False
                    for event in events:
                        cursor = event.seq
                        yield {
                            "id": str(event.seq),
                            "event": event.type,
                            "data": json.dumps(
                                {
                                    "seq": event.seq,
                                    "run_id": str(run_id),
                                    "type": event.type,
                                    "node_id": event.node_id,
                                    "ts": event.created_at.isoformat()
                                    if event.created_at
                                    else None,
                                    **(event.payload or {}),
                                }
                            ),
                        }
                        if event.type in _TERMINAL_EVENTS:
                            terminal_seen = True

                    if terminal_seen:
                        return

                    if not events:
                        # Guard against a run that finished before we attached,
                        # or one whose terminal event we somehow missed.
                        run = await stream_session.get(Run, run_id)
                        if run is not None and run.status.is_terminal:
                            return

                if events:
                    since_keepalive = 0.0
                    continue

                await asyncio.sleep(_POLL_SECONDS)
                elapsed += _POLL_SECONDS
                since_keepalive += _POLL_SECONDS
                if since_keepalive >= _KEEPALIVE_SECONDS:
                    since_keepalive = 0.0
                    yield {"event": "keepalive", "data": "{}"}

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("sse.stream_error", run_id=str(run_id))
            yield {
                "event": "stream.error",
                "data": json.dumps({"message": f"{type(exc).__name__}: {exc}"}),
            }

    return EventSourceResponse(
        generator(),
        headers={
            "Cache-Control": "no-cache, no-transform",
            # nginx and friends will otherwise buffer the stream into uselessness.
            "X-Accel-Buffering": "no",
        },
    )
