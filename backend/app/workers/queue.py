"""Postgres-backed job queue.

The `runs` table *is* the queue — a run is the job, which halves the state
machine and removes a whole class of "job says done, run says running" bugs.

`FOR UPDATE SKIP LOCKED` is the boring, correct Postgres queue primitive and
works fine through Supabase's transaction pooler. Leases plus a recovery sweep
are what make a killed worker recoverable rather than a lost run.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import RunStatus
from app.logging import get_logger

log = get_logger(__name__)

# One statement: find an eligible run, lock it, and mark it claimed. Doing this
# as select-then-update would race between workers.
_CLAIM_SQL = text(
    """
    UPDATE runs SET
        status = 'running',
        claimed_by = :worker_id,
        attempt = attempt + 1,
        lease_expires_at = now() + make_interval(secs => :lease_seconds),
        started_at = COALESCE(started_at, now()),
        updated_at = now()
    WHERE id = (
        SELECT r.id FROM runs r
        WHERE r.status = 'queued'
          AND r.cancel_requested IS NULL
          AND (
            SELECT count(*) FROM runs busy
            WHERE busy.tenant_id = r.tenant_id AND busy.status = 'running'
          ) < :per_tenant_limit
        ORDER BY r.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id;
    """
)

_HEARTBEAT_SQL = text(
    """
    UPDATE runs
       SET lease_expires_at = now() + make_interval(secs => :lease_seconds),
           updated_at = now()
     WHERE id = :run_id AND claimed_by = :worker_id
    RETURNING cancel_requested IS NOT NULL AS canceled;
    """
)

# Runs whose worker died mid-flight: the lease lapsed and nobody finished them.
#
# The `::run_status` cast is required, not cosmetic: a CASE expression yields
# `text`, and Postgres will not implicitly coerce that into an enum column.
_SWEEP_SQL = text(
    """
    UPDATE runs
       SET status = (CASE WHEN attempt < max_attempts THEN 'queued'
                          ELSE 'interrupted' END)::run_status,
           claimed_by = NULL,
           lease_expires_at = NULL,
           error = CASE WHEN attempt < max_attempts THEN error
                        ELSE 'Worker stopped before the run finished.' END,
           error_code = CASE WHEN attempt < max_attempts THEN error_code ELSE 'interrupted' END,
           finished_at = CASE WHEN attempt < max_attempts THEN NULL ELSE now() END,
           updated_at = now()
     WHERE status = 'running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < now()
    RETURNING id, status;
    """
)

_CANCEL_PENDING_SQL = text(
    """
    SELECT id FROM runs
     WHERE cancel_requested IS NOT NULL
       AND status IN ('queued', 'running')
       AND claimed_by = :worker_id;
    """
)


async def claim_run(session: AsyncSession, worker_id: str) -> uuid.UUID | None:
    settings = get_settings()
    result = await session.execute(
        _CLAIM_SQL,
        {
            "worker_id": worker_id,
            "lease_seconds": settings.worker_lease_seconds,
            "per_tenant_limit": settings.per_tenant_run_limit,
        },
    )
    row = result.first()
    await session.commit()
    return row[0] if row else None


async def heartbeat(session: AsyncSession, run_id: uuid.UUID, worker_id: str) -> bool:
    """Extend the lease. Returns True if a cancel has been requested."""
    settings = get_settings()
    result = await session.execute(
        _HEARTBEAT_SQL,
        {
            "run_id": str(run_id),
            "worker_id": worker_id,
            "lease_seconds": settings.worker_lease_seconds,
        },
    )
    row = result.first()
    await session.commit()
    return bool(row and row[0])


async def sweep_expired(session: AsyncSession) -> list[tuple[uuid.UUID, str]]:
    """Requeue (or bury) runs abandoned by a dead worker.

    Called on startup and periodically. This is what makes crash recovery a
    demonstrable behaviour: kill the worker mid-run, restart, watch it resume.
    """
    result = await session.execute(_SWEEP_SQL)
    rows = [(r[0], r[1]) for r in result.fetchall()]
    # Buried runs never reach finalize(), so their steps are closed out here.
    # Requeued runs keep their rows as-is — the retry re-drives them.
    for run_id, status in rows:
        if status == "interrupted":
            await _close_out_steps(session, run_id, run_status=RunStatus.INTERRUPTED)
    await session.commit()
    if rows:
        log.info(
            "queue.swept",
            requeued=[str(i) for i, s in rows if s == "queued"],
            interrupted=[str(i) for i, s in rows if s == "interrupted"],
        )
    return rows


async def cancels_for_worker(session: AsyncSession, worker_id: str) -> list[uuid.UUID]:
    result = await session.execute(_CANCEL_PENDING_SQL, {"worker_id": worker_id})
    return [r[0] for r in result.fetchall()]


async def finalize(
    session: AsyncSession,
    run_id: uuid.UUID,
    *,
    status: RunStatus,
    error: str | None = None,
    error_code: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    fields = {
        "status": status.value,
        "error": error,
        "error_code": error_code,
        "claimed_by": None,
        "lease_expires_at": None,
        "finished_at": datetime.now(UTC),
        **(extra or {}),
    }
    # Bound parameters arrive as text and enum columns need an explicit cast.
    # Must be CAST(:x AS t), never :x::t — `::` collides with text()'s own
    # `:param` syntax and yields a syntax error at execution time.
    assignments = ", ".join(
        f"{k} = CAST(:{k} AS run_status)" if k == "status" else f"{k} = :{k}"
        for k in fields
    )
    await session.execute(
        text(f"UPDATE runs SET {assignments}, updated_at = now() WHERE id = :run_id"),
        {**fields, "run_id": str(run_id)},
    )
    # A terminal run may not keep steps mid-flight: a row left pending/running
    # renders as "generating" on the canvas forever. The runner reconciles its
    # own steps with proper events; this catches the paths that never get
    # there — cancellation, a crashed worker, a buried retry.
    await _close_out_steps(session, run_id, run_status=status)
    await session.commit()


_CLOSE_STEPS_SQL = text(
    """
    UPDATE run_steps
       SET status = CAST(:step_status AS step_status),
           error = COALESCE(error, :step_error),
           finished_at = COALESCE(finished_at, now())
     WHERE run_id = :run_id AND status IN ('pending', 'running')
    """
)


async def _close_out_steps(
    session: AsyncSession, run_id: uuid.UUID, *, run_status: RunStatus
) -> None:
    """Force any still-open step of a terminal run into a terminal state.
    Does not commit — runs inside the caller's transaction."""
    interrupted = run_status in (RunStatus.CANCELED, RunStatus.INTERRUPTED)
    await session.execute(
        _CLOSE_STEPS_SQL,
        {
            "run_id": str(run_id),
            "step_status": "canceled" if interrupted else "failed",
            "step_error": None if interrupted
            else "The run ended before this step reported a result.",
        },
    )


def lease_deadline(seconds: int | None = None) -> datetime:
    settings = get_settings()
    return datetime.now(UTC) + timedelta(seconds=seconds or settings.worker_lease_seconds)
