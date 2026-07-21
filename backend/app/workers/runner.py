"""Execute one run: compile → stream → persist.

Every GenBlaze event is translated and appended to `run_events` with a monotonic
`seq` in the same transaction as the step-state update. That table is the SSE
source, the audit trail, and the replay buffer — which is what gives reconnect,
exactly-once-per-seq delivery, and a demoable event history for free.
"""

from __future__ import annotations

import contextlib
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import Asset, AssetKind, Run, RunEvent, RunStatus, RunStep, StepStatus
from app.engine.builder import BuildContext, build_pipeline
from app.engine.events import EventMapper, extract_result
from app.engine.sinks import build_sink, collect_assets
from app.graph.plan import ExecutionPlan
from app.graph.schema import AssetRef
from app.logging import get_logger, run_id_var
from app.workers import queue

log = get_logger(__name__)

_STEP_STATUS_BY_EVENT = {
    "node.queued": StepStatus.PENDING,
    "node.started": StepStatus.RUNNING,
    "node.progress": StepStatus.RUNNING,
    "node.completed": StepStatus.SUCCEEDED,
    "node.failed": StepStatus.FAILED,
    "node.skipped": StepStatus.SKIPPED,
}


class _EventWriter:
    """Owns the per-run sequence counter.

    Safe as a local counter because the lease guarantees a single writer per run;
    it resumes from `max(seq)` so a retried attempt appends rather than collides.
    """

    def __init__(self, session: AsyncSession, run_id: uuid.UUID, start_seq: int) -> None:
        self._session = session
        self._run_id = run_id
        self._seq = start_seq

    async def append(self, type_: str, payload: dict[str, Any], node_id: str | None = None) -> int:
        self._seq += 1
        self._session.add(
            RunEvent(
                run_id=self._run_id,
                seq=self._seq,
                type=type_,
                node_id=node_id,
                payload=payload,
            )
        )
        await self._session.commit()
        return self._seq


async def _next_seq(session: AsyncSession, run_id: uuid.UUID) -> int:
    result = await session.execute(
        select(func.coalesce(func.max(RunEvent.seq), 0)).where(RunEvent.run_id == run_id)
    )
    return int(result.scalar_one())


async def _seed_steps(session: AsyncSession, run: Run, plan: ExecutionPlan) -> None:
    """Insert a row per planned step so the canvas can render the full graph as
    pending before anything starts."""
    existing = await session.execute(select(RunStep.node_id).where(RunStep.run_id == run.id))
    known = {r[0] for r in existing.fetchall()}
    for step in plan.steps:
        if step.node_id in known:
            continue
        session.add(
            RunStep(
                run_id=run.id,
                node_id=step.node_id,
                step_index=step.index,
                provider=step.provider_key,
                model=step.model,
                modality=step.modality,
                step_type=step.step_type,
                status=StepStatus.PENDING,
                prompt=step.prompt,
                params=step.params,
            )
        )
    await session.commit()


async def _apply_step_update(
    session: AsyncSession, run_id: uuid.UUID, event_type: str, payload: dict[str, Any]
) -> None:
    node_id = payload.get("node_id")
    if not node_id:
        return

    values: dict[str, Any] = {}
    status = _STEP_STATUS_BY_EVENT.get(event_type)
    if status is not None:
        values["status"] = status

    match event_type:
        case "node.started":
            values["started_at"] = datetime.now(UTC)
        case "node.progress":
            for key in ("progress_pct", "elapsed_sec"):
                if payload.get(key) is not None:
                    values[key] = payload[key]
            if payload.get("preview_url"):
                values["preview_url"] = payload["preview_url"]
            # The upstream provider job id. GenBlaze has no on_submit hook, so
            # this is the earliest point we can checkpoint it.
            if payload.get("request_id"):
                values["upstream_id"] = payload["request_id"]
        case "node.completed":
            values |= {"finished_at": datetime.now(UTC), "progress_pct": 1.0}
            for key in ("elapsed_sec", "cost_usd"):
                if payload.get(key) is not None:
                    values[key] = payload[key]
            if payload.get("request_id"):
                values["upstream_id"] = payload["request_id"]
        case "node.failed":
            values |= {
                "finished_at": datetime.now(UTC),
                "error": payload.get("error"),
                "error_code": payload.get("error_code"),
            }
        case "node.retried":
            values["retries"] = payload.get("attempt") or 0

    if not values:
        return
    await session.execute(
        update(RunStep)
        .where(RunStep.run_id == run_id, RunStep.node_id == node_id)
        .values(**values)
    )
    await session.commit()


async def _persist_assets(
    session: AsyncSession, run: Run, result: Any
) -> list[Any]:
    records = collect_assets(result, run_id=str(run.id))
    for record in records:
        session.add(
            Asset(
                tenant_id=run.tenant_id,
                kind=AssetKind.GENERATED,
                genblaze_asset_id=record.genblaze_asset_id,
                run_id=run.id,
                node_id=record.node_id,
                b2_key=record.b2_key,
                url=record.url,
                media_type=record.media_type,
                modality=record.modality,
                sha256=record.sha256,
                size_bytes=record.size_bytes,
                width=record.width,
                height=record.height,
                duration_sec=record.duration_sec,
            )
        )
    await session.commit()
    return records


def _summarize(result: Any) -> dict[str, Any]:
    run = getattr(result, "run", None)
    manifest = getattr(result, "manifest", None)
    settings = get_settings()

    steps = list(getattr(run, "steps", []) or [])
    costs = [s.cost_usd for s in steps if getattr(s, "cost_usd", None) is not None]

    verified: str | None = None
    if manifest is not None and settings.storage_mode.value == "b2":
        # Only meaningful once a sink has hash-bound the bytes into durable
        # storage. In local mode verify() can pass on a provider-declared hash,
        # which would be a misleading "verified" badge — report null instead.
        try:
            verified = "true" if manifest.verify() else "false"
        except Exception:  # noqa: BLE001 - verification must not fail the run
            verified = None

    return {
        "genblaze_run_id": str(getattr(run, "run_id", "") or "") or None,
        "manifest_hash": getattr(manifest, "canonical_hash", None),
        "manifest_uri": getattr(manifest, "manifest_uri", None),
        "manifest_verified": verified,
        "total_cost_usd": round(sum(costs), 6) if costs else None,
    }


async def execute_run(session: AsyncSession, run_id: uuid.UUID, worker_id: str) -> None:
    """Run one claimed job to completion. Never raises — every exit path
    finalizes the run so it cannot be left `running` forever."""
    run_id_var.set(str(run_id))
    settings = get_settings()

    run = await session.get(Run, run_id)
    if run is None:
        log.warning("runner.run_missing", run_id=str(run_id))
        return

    plan = ExecutionPlan.model_validate(run.plan_snapshot)
    writer = _EventWriter(session, run_id, await _next_seq(session, run_id))
    await _seed_steps(session, run, plan)
    await writer.append("run.queued", {"total_steps": len(plan.steps)})

    mapper = EventMapper(plan=plan)
    captured: Any = None
    sink = None

    try:
        assets = await _load_asset_refs(session, run, plan)
        pipeline = build_pipeline(
            plan,
            BuildContext(
                tenant_id=run.tenant_id,
                workflow_id=str(run.workflow_id) if run.workflow_id else None,
                run_id=str(run.id),
                assets=assets,
                # Preflight validates model slugs before any paid call. Worth the
                # latency: a typo'd model should cost nothing.
                preflight=True,
            ),
        )
        sink = build_sink(run_id=str(run.id))

        stream = pipeline.astream(
            sink=sink,
            timeout=settings.step_timeout_seconds,
            fail_fast=False,
            raise_on_failure=False,
            pipeline_timeout=_pipeline_timeout(plan),
        )

        async for event in stream:
            captured = extract_result(event) or captured
            wire = mapper.map(event)
            if wire is None:
                continue
            # Heartbeats keep proxies warm but are not real progress; persisting
            # them would bloat the event log for no UI benefit.
            if wire.type == "node.progress" and wire.payload.get("is_heartbeat"):
                continue
            # GenBlaze's terminal event arrives before we have persisted assets
            # or computed the final status. `_finish` emits the authoritative
            # one; emitting both would put two terminal events in the log, and
            # since consumers close the stream on the first one they would
            # disconnect before ever seeing the assets.
            if wire.type in ("run.completed", "run.failed"):
                continue
            await writer.append(wire.type, wire.payload, wire.node_id)
            await _apply_step_update(session, run_id, wire.type, wire.payload)

        await _finish(session, run, writer, captured)

    except Exception as exc:
        log.exception("runner.failed", run_id=str(run_id), exc_type=type(exc).__name__)
        # If the failure was itself a database error, the transaction is aborted
        # and every later statement is rejected — including the ones recording
        # the failure. Roll back first, or the error handler strands the run in
        # `running` and only the lease sweep eventually rescues it.
        with contextlib.suppress(Exception):
            await session.rollback()
        with contextlib.suppress(Exception):
            await writer.append("run.failed", {"message": f"{type(exc).__name__}: {exc}"})
        with contextlib.suppress(Exception):
            await queue.finalize(
                session,
                run_id,
                status=RunStatus.FAILED,
                error=str(exc)[:2000],
                error_code=type(exc).__name__,
            )
    finally:
        if sink is not None:
            # The pipeline normally closes the sink itself; this covers the paths
            # where we never reached run(). Best-effort by design.
            with contextlib.suppress(Exception):
                sink.close()


def _pipeline_timeout(plan: ExecutionPlan) -> float:
    """Wall-clock ceiling. `pipeline_timeout` is checked between steps, so this
    is a bound on the whole run, not a per-step guard."""
    estimated = plan.estimates.duration_sec or 120.0
    return max(120.0, min(estimated * 2.5, 1800.0))


async def _finish(
    session: AsyncSession, run: Run, writer: _EventWriter, captured: Any
) -> None:
    if captured is None:
        await writer.append("run.failed", {"message": "The run produced no result."})
        await queue.finalize(
            session, run.id, status=RunStatus.FAILED,
            error="The run produced no result.", error_code="no_result",
        )
        return

    records = await _persist_assets(session, run, captured)
    summary = _summarize(captured)

    step_rows = await session.execute(select(RunStep).where(RunStep.run_id == run.id))
    steps = list(step_rows.scalars())
    failed = [s for s in steps if s.status is StepStatus.FAILED]
    succeeded = [s for s in steps if s.status is StepStatus.SUCCEEDED]

    if failed and succeeded:
        status = RunStatus.PARTIAL
    elif failed:
        status = RunStatus.FAILED
    else:
        status = RunStatus.SUCCEEDED

    duration = None
    if run.started_at:
        duration = (datetime.now(UTC) - run.started_at).total_seconds()

    await writer.append(
        "run.completed" if status is not RunStatus.FAILED else "run.failed",
        {
            "status": status.value,
            **summary,
            "assets": [
                {
                    "node_id": r.node_id,
                    "url": r.url,
                    "media_type": r.media_type,
                    "modality": r.modality,
                    "sha256": r.sha256,
                    "size_bytes": r.size_bytes,
                    # Post-run URLs are durable, unlike the mid-run previews.
                    "ephemeral": False,
                }
                for r in records
            ],
        },
    )

    await queue.finalize(
        session, run.id, status=status,
        error=failed[0].error if failed else None,
        error_code=failed[0].error_code if failed else None,
        extra={**summary, "duration_sec": duration},
    )
    log.info(
        "runner.finished", run_id=str(run.id), status=status.value,
        steps=len(steps), assets=len(records),
    )


async def _load_asset_refs(
    session: AsyncSession, run: Run, plan: ExecutionPlan
) -> dict[str, AssetRef]:
    wanted = {a for step in plan.steps for a in step.external_input_asset_ids}
    if not wanted:
        return {}
    rows = await session.execute(
        select(Asset).where(
            Asset.tenant_id == run.tenant_id,
            Asset.id.in_([uuid.UUID(a) for a in wanted]),
        )
    )
    return {
        str(a.id): AssetRef(
            asset_id=str(a.id),
            url=a.url,
            media_type=a.media_type,
            modality=a.modality,
            sha256=a.sha256,
            size_bytes=a.size_bytes,
        )
        for a in rows.scalars()
    }
