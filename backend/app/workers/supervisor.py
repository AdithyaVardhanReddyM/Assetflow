"""Worker supervisor: an asyncio pool that claims and executes runs.

Runs in-process during development and as a standalone process in production
(`python -m app.workers`) — same code either way, so the dev loop is one command
and scaling out is a process-count change.

Cancellation works only because execution goes through `astream()`/`arun()`:
the synchronous `stream()` would leave a worker thread polling a provider after
the task was cancelled.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import uuid

from app.config import get_settings
from app.db.models import RunStatus
from app.db.session import get_sessionmaker
from app.logging import get_logger
from app.workers import queue
from app.workers.runner import execute_run

log = get_logger(__name__)

# How long a freshly queued run can sit before an idle worker notices it. The
# claim is one SKIP LOCKED update — cheap enough to check every second, and a
# second of queue latency is visible on a Run button in a way 2s clearly was.
_IDLE_POLL_SECONDS = 1.0
_HEARTBEAT_SECONDS = 30.0
_SWEEP_SECONDS = 60.0


class Supervisor:
    def __init__(self, worker_id: str | None = None) -> None:
        settings = get_settings()
        self.worker_id = worker_id or f"{os.uname().nodename}:{os.getpid()}:{uuid.uuid4().hex[:6]}"
        self.concurrency = settings.worker_concurrency
        self._tasks: list[asyncio.Task[None]] = []
        self._active: dict[uuid.UUID, asyncio.Task[None]] = {}
        self._stopping = asyncio.Event()

    # --- lifecycle --------------------------------------------------------

    async def start(self) -> None:
        # Recover anything a previous process abandoned before claiming new work.
        async with get_sessionmaker()() as session:
            await queue.sweep_expired(session)

        self._tasks = [
            asyncio.create_task(self._worker_loop(i), name=f"worker-{i}")
            for i in range(self.concurrency)
        ]
        self._tasks.append(asyncio.create_task(self._sweeper(), name="sweeper"))
        log.info("supervisor.started", worker_id=self.worker_id, concurrency=self.concurrency)

    async def stop(self, *, drain_seconds: float = 30.0) -> None:
        self._stopping.set()
        for task in self._tasks:
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.gather(*self._tasks, return_exceptions=True)

        if self._active:
            log.info("supervisor.draining", in_flight=len(self._active))
            _done, pending = await asyncio.wait(
                list(self._active.values()), timeout=drain_seconds
            )
            for task in pending:
                task.cancel()
        log.info("supervisor.stopped", worker_id=self.worker_id)

    # --- loops ------------------------------------------------------------

    async def _worker_loop(self, index: int) -> None:
        sessionmaker = get_sessionmaker()
        while not self._stopping.is_set():
            try:
                async with sessionmaker() as session:
                    run_id = await queue.claim_run(session, self.worker_id)
                if run_id is None:
                    await asyncio.sleep(_IDLE_POLL_SECONDS)
                    continue

                log.info("worker.claimed", worker=index, run_id=str(run_id))
                task = asyncio.create_task(self._run_with_heartbeat(run_id))
                self._active[run_id] = task
                try:
                    await task
                finally:
                    self._active.pop(run_id, None)

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("worker.loop_error", worker=index, exc_type=type(exc).__name__)
                await asyncio.sleep(_IDLE_POLL_SECONDS)

    async def _run_with_heartbeat(self, run_id: uuid.UUID) -> None:
        beat = asyncio.create_task(self._heartbeat(run_id))
        sessionmaker = get_sessionmaker()
        try:
            async with sessionmaker() as session:
                await execute_run(session, run_id, self.worker_id)
        except asyncio.CancelledError:
            async with sessionmaker() as session:
                await queue.finalize(
                    session, run_id, status=RunStatus.CANCELED,
                    error="Canceled.", error_code="canceled",
                )
            raise
        finally:
            beat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await beat

    async def _heartbeat(self, run_id: uuid.UUID) -> None:
        """Extend the lease, and notice a cancel request from the API process."""
        sessionmaker = get_sessionmaker()
        while True:
            await asyncio.sleep(_HEARTBEAT_SECONDS)
            try:
                async with sessionmaker() as session:
                    canceled = await queue.heartbeat(session, run_id, self.worker_id)
                if canceled:
                    log.info("worker.cancel_requested", run_id=str(run_id))
                    task = self._active.get(run_id)
                    if task is not None:
                        task.cancel()
                    return
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - a missed beat is recoverable
                log.warning("worker.heartbeat_failed", run_id=str(run_id), error=str(exc))

    async def _sweeper(self) -> None:
        sessionmaker = get_sessionmaker()
        while not self._stopping.is_set():
            await asyncio.sleep(_SWEEP_SECONDS)
            try:
                async with sessionmaker() as session:
                    await queue.sweep_expired(session)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - sweeping is best-effort
                log.warning("worker.sweep_failed", error=str(exc))
