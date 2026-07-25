"""Execute one run: compile → stream → persist.

Every GenBlaze event is translated and appended to `run_events` with a monotonic
`seq` in the same transaction as the step-state update. That table is the SSE
source, the audit trail, and the replay buffer — which is what gives reconnect,
exactly-once-per-seq delivery, and a demoable event history for free.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import Asset, AssetKind, Run, RunEvent, RunStatus, RunStep, StepStatus
from app.engine.builder import BuildContext, build_pipeline
from app.engine.events import EventMapper, extract_result
from app.engine.manifests import preview_url
from app.engine.sinks import build_sink, collect_assets
from app.graph.plan import ExecutionPlan, PlanEstimates, PlannedStep
from app.graph.presets import CHARACTER_SHEET, character_sheet_prompt
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

    async def append(
        self,
        type_: str,
        payload: dict[str, Any],
        node_id: str | None = None,
        *,
        commit: bool = True,
    ) -> int:
        """Queue one event; `commit=False` lets the caller fold the event and
        its step-row update into a single commit. The database is a ~300ms
        round trip away, so every commit saved is user-visible latency."""
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
        if commit:
            await self._session.commit()
        return self._seq


async def _next_seq(session: AsyncSession, run_id: uuid.UUID) -> int:
    result = await session.execute(
        select(func.coalesce(func.max(RunEvent.seq), 0)).where(RunEvent.run_id == run_id)
    )
    return int(result.scalar_one())


async def _seed_steps(session: AsyncSession, run: Run, plan: ExecutionPlan) -> None:
    """Insert a row per planned step so the canvas can render the full graph as
    pending before anything starts. Does not commit — the caller folds the
    seeds and the `run.queued` event into one commit."""
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


def _resume_targets(plan: ExecutionPlan, prior_steps: list[RunStep]) -> dict[str, str]:
    """node_id -> upstream prediction id for steps a retry should re-attach to.

    A step that hit the poll timeout was *charged* — the provider accepted the
    job and kept running it after we stopped waiting. Its job id was
    checkpointed on `upstream_id` (see `_apply_step_update`), so a retry can
    poll/fetch that job instead of submitting — and paying for — a new one.
    Only a timeout qualifies: any other failure means the upstream job itself
    is dead and resubmitting is the correct (and only) way to get output.

    Guarded on provider+model still matching the plan, so a retry of a run
    whose graph was since edited never feeds one model's job id to another.
    """
    targets: dict[str, str] = {}
    for row in prior_steps:
        if (
            row.status is not StepStatus.FAILED
            or row.error_code != "timeout"
            or not row.upstream_id
        ):
            continue
        step = plan.step_for_node(row.node_id)
        if step is None or step.provider_key != row.provider or step.model != row.model:
            continue
        targets[row.node_id] = row.upstream_id
    return targets


async def _parent_resume_ids(
    session: AsyncSession, run: Run, plan: ExecutionPlan
) -> dict[str, str]:
    """Resumable upstream job ids from the run this one retries, if any."""
    if run.parent_run_id is None:
        return {}
    rows = await session.execute(select(RunStep).where(RunStep.run_id == run.parent_run_id))
    return _resume_targets(plan, list(rows.scalars()))


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
    # No commit here — the caller commits once for the event and this update
    # together. Two commits per event doubled every round trip to the database.
    await session.execute(
        update(RunStep)
        .where(RunStep.run_id == run_id, RunStep.node_id == node_id)
        .values(**values)
    )


async def _persist_assets(
    session: AsyncSession, run: Run, results: list[Any]
) -> list[Asset]:
    """Stage asset rows on the session and return them with ids populated
    (flushed, not committed — `_finish` folds the rows and the terminal event
    into one commit). The ids ride the terminal event so the canvas can name
    an asset for download and lineage without re-fetching the run."""
    rows: list[Asset] = []
    for result in results:
        for record in collect_assets(result, run_id=str(run.id)):
            rows.append(
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
                    asset_metadata={"text": record.text} if record.text else {},
                )
            )
    session.add_all(rows)
    await session.flush()
    return rows


def _summarize(results: list[Any]) -> dict[str, Any]:
    """Cost across every stage; identity and manifest from the last stage that
    has one — for a staged run that is the media pipeline, whose manifest
    covers the assets the user actually asked for."""
    settings = get_settings()

    costs: list[float] = []
    for result in results:
        run = getattr(result, "run", None)
        for s in getattr(run, "steps", []) or []:
            if getattr(s, "cost_usd", None) is not None:
                costs.append(s.cost_usd)

    final = next(
        (r for r in reversed(results) if getattr(r, "manifest", None) is not None),
        results[-1],
    )
    run = getattr(final, "run", None)
    manifest = getattr(final, "manifest", None)

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
        "b2_prefix": settings.b2_prefix if settings.storage_mode.value == "b2" else None,
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

    try:
        assets = await _load_asset_refs(session, run, plan)
        resume_ids = await _parent_resume_ids(session, run, plan)
        if resume_ids:
            log.info(
                "runner.resuming_steps",
                run_id=str(run_id),
                parent_run_id=str(run.parent_run_id),
                nodes=sorted(resume_ids),
            )
        ctx = BuildContext(
            tenant_id=run.tenant_id,
            workflow_id=str(run.workflow_id) if run.workflow_id else None,
            run_id=str(run.id),
            assets=assets,
            # Preflight validates model slugs before any paid call. Worth the
            # latency: a typo'd model should cost nothing.
            preflight=True,
            resume_ids=resume_ids,
        )

        if any(s.prompt_from is not None for s in plan.steps):
            # A GenBlaze pipeline fixes every prompt at construction, so steps
            # whose prompt an upstream LLM writes cannot share a pipeline with
            # that LLM — the run is split into a text stage and a media stage.
            results = await _execute_staged(session, run, plan, ctx, writer, settings)
        else:
            captured = await _stream_pipeline(
                session,
                run.id,
                build_pipeline(plan, ctx),
                build_sink(run_id=str(run.id)),
                plan,
                writer,
                settings,
            )
            results = [captured] if captured is not None else []

        await _finish(session, run, writer, results)

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


def _step_timeout(plan: ExecutionPlan, settings: Any) -> float:
    """Per-step poll ceiling for this plan.

    GenBlaze takes one timeout for every step in a pipeline, so a plan
    containing any video step gets the video ceiling — video jobs routinely
    run past 600s while an image would have failed long before either limit.
    """
    if any(s.modality == "video" for s in plan.steps):
        return float(settings.video_step_timeout_seconds)
    return float(settings.step_timeout_seconds)


def _pipeline_timeout(plan: ExecutionPlan, settings: Any) -> float:
    """Wall-clock ceiling on the whole pipeline, not a per-step guard.

    Floored at the per-step timeout plus margin: a provider's *queue* time
    counts against this clock, so a ceiling tighter than what one step is
    allowed kills runs that were merely waiting their turn (seen live with
    GMI: a 15s-estimated image spent >120s queued and the old 120s floor
    killed it)."""
    estimated = plan.estimates.duration_sec or 120.0
    floor = _step_timeout(plan, settings) + 60.0
    return max(floor, min(estimated * 2.5, 1800.0))


async def _stream_pipeline(
    session: AsyncSession,
    run_id: uuid.UUID,
    pipeline: Any,
    sink: Any | None,
    plan: ExecutionPlan,
    writer: _EventWriter,
    settings: Any,
    *,
    suppress_run_started: bool = False,
) -> Any:
    """Stream one pipeline, appending events and step updates. Returns the
    captured terminal result (or None).

    The mapper is built on the plan *this pipeline* was built from — its step
    indices, not the full run's — because GenBlaze events that carry only a
    `step_index` are resolved against it.
    """
    mapper = EventMapper(plan=plan)
    captured: Any = None
    # Per-node timestamp of the last *persisted* progress event. Providers can
    # emit progress every poll tick, and at ~1s of commit latency per event a
    # chatty step would spend longer writing its progress than generating.
    last_progress: dict[str, float] = {}

    # Persistence is decoupled from consumption on purpose: the stream applies
    # backpressure, so writing each event inline (~1s of database round trips
    # apiece) throttles the *pipeline itself* — measured as 3-4s of added
    # latency per event on a remote Postgres. The loop below drains events at
    # full speed; this task drains the buffer, folding everything that has
    # accumulated into a single commit.
    buffer: asyncio.Queue[Any | None] = asyncio.Queue()

    async def persist() -> None:
        while True:
            wire = await buffer.get()
            if wire is None:
                return
            batch = [wire]
            while not buffer.empty():
                nxt = buffer.get_nowait()
                if nxt is None:
                    batch.append(None)
                    break
                batch.append(nxt)
            done = batch[-1] is None
            for item in batch:
                if item is None:
                    break
                await writer.append(item.type, item.payload, item.node_id, commit=False)
                await _apply_step_update(session, run_id, item.type, item.payload)
            await session.commit()
            if done:
                return

    persist_task = asyncio.create_task(persist())
    try:
        stream = pipeline.astream(
            sink=sink,
            timeout=_step_timeout(plan, settings),
            fail_fast=False,
            raise_on_failure=False,
            pipeline_timeout=_pipeline_timeout(plan, settings),
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
            # A staged run is several pipelines; only the first may announce.
            if suppress_run_started and wire.type == "run.started":
                continue
            if wire.type == "node.progress" and not _worth_persisting(
                wire.payload, last_progress
            ):
                continue
            if wire.type == "node.completed":
                _sign_event_assets(wire.payload)
            buffer.put_nowait(wire)
    finally:
        buffer.put_nowait(None)
        # Every buffered event lands before the caller emits terminal state —
        # and a writer crash surfaces here rather than being swallowed.
        await persist_task
        if sink is not None:
            # The pipeline normally closes the sink itself; this covers the
            # paths where we never reached run(). Best-effort by design.
            with contextlib.suppress(Exception):
                sink.close()
    return captured


_PROGRESS_PERSIST_INTERVAL = 2.5


def _worth_persisting(payload: dict[str, Any], last_progress: dict[str, float]) -> bool:
    """Throttle progress events to one per node per interval.

    Always keep the ones that carry something irreplaceable — a preview frame,
    or the first sighting of the provider's job id (the checkpoint a retry
    resumes from). The rest are a percentage the UI repaints anyway.
    """
    node_id = str(payload.get("node_id") or "")
    request_key = f"req:{node_id}"
    irreplaceable = bool(payload.get("preview_url")) or (
        payload.get("request_id") is not None and request_key not in last_progress
    )
    if payload.get("request_id") is not None:
        last_progress[request_key] = 1.0
    now = time.monotonic()
    if irreplaceable or now - last_progress.get(node_id, 0.0) >= _PROGRESS_PERSIST_INTERVAL:
        last_progress[node_id] = now
        return True
    return False


def _sign_event_assets(payload: dict[str, Any]) -> None:
    """Swap any durable private-bucket URL in a completion event for a
    presigned one, so the canvas can render the asset the moment the step
    finishes. Signing is local crypto — no network call. URLs that are not
    ours (a provider CDN) pass through untouched, and failures leave the
    payload as it was."""
    for asset in payload.get("assets") or []:
        url = asset.get("url")
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        signed = preview_url(url)
        if signed and signed != url:
            asset["url"] = signed


def _text_output(result: Any) -> str | None:
    """The words an LLM stage produced, read off its result's assets."""
    run = getattr(result, "run", None)
    for step in getattr(run, "steps", []) or []:
        for asset in getattr(step, "assets", None) or []:
            metadata = getattr(asset, "metadata", None) or {}
            text = metadata.get("text") if isinstance(metadata, dict) else None
            if text:
                return str(text)
    return None


async def _skip_step(
    session: AsyncSession, run_id: uuid.UUID, writer: _EventWriter, step: PlannedStep
) -> None:
    payload = {"node_id": step.node_id, "reason": "upstream_failed"}
    await writer.append("node.skipped", payload, step.node_id, commit=False)
    await _apply_step_update(session, run_id, "node.skipped", payload)
    await session.commit()


async def _execute_staged(
    session: AsyncSession,
    run: Run,
    plan: ExecutionPlan,
    ctx: BuildContext,
    writer: _EventWriter,
    settings: Any,
) -> list[Any]:
    """Execute a prompt-chained plan: text steps first, then everything else.

    Text steps run one pipeline each, in plan order, so an LLM chained off
    another LLM sees its predecessor's words. The remaining steps then run as a
    single pipeline with every `prompt_from` resolved to literal words and the
    plan reindexed — `input_from` refers to *pipeline* positions, which shift
    when the text steps drop out.
    """
    await writer.append("run.started", {"total_steps": len(plan.steps)})

    results: list[Any] = []
    words: dict[int, str] = {}
    failed: set[int] = set()

    def resolved_prompt(step: PlannedStep) -> str | None:
        if step.prompt_from is None:
            return step.prompt
        prompt = words[step.prompt_from]
        # A character sheet's literal prompt was wrapped at compile time; an
        # LLM-written one could not be — the words only exist now.
        if step.metadata.get("prompt_preset") == CHARACTER_SHEET:
            return character_sheet_prompt(prompt)
        return prompt

    for step in (s for s in plan.steps if s.modality == "text"):
        if step.prompt_from is not None and step.prompt_from not in words:
            failed.add(step.index)
            await _skip_step(session, run.id, writer, step)
            continue

        stage_plan = ExecutionPlan(
            name=f"{plan.name}:{step.node_id[:8]}",
            steps=[
                step.model_copy(
                    update={"index": 0, "prompt": resolved_prompt(step), "prompt_from": None}
                )
            ],
            max_concurrency=1,
            estimates=PlanEstimates(duration_sec=step.expected_duration_sec),
        )
        captured = await _stream_pipeline(
            session,
            run.id,
            build_pipeline(stage_plan, ctx),
            build_sink(run_id=str(run.id)),
            stage_plan,
            writer,
            settings,
            suppress_run_started=True,
        )
        if captured is not None:
            results.append(captured)

        text = _text_output(captured)
        if text:
            words[step.index] = text
        else:
            # The step's own failure event has already been recorded by the
            # stream; what remains is keeping its dependents from running.
            failed.add(step.index)

    media_steps = [s for s in plan.steps if s.modality != "text"]
    runnable: list[PlannedStep] = []
    for step in media_steps:
        depends_on = [*step.input_from] + (
            [step.prompt_from] if step.prompt_from is not None else []
        )
        if any(d in failed for d in depends_on):
            failed.add(step.index)
            await _skip_step(session, run.id, writer, step)
            continue
        runnable.append(step)

    if runnable:
        # The step rows were seeded with the un-rewritten prompts; record what
        # will actually run, so the database shows the words the LLM wrote.
        for step in runnable:
            if step.prompt_from is not None:
                await session.execute(
                    update(RunStep)
                    .where(RunStep.run_id == run.id, RunStep.node_id == step.node_id)
                    .values(prompt=resolved_prompt(step))
                )
        await session.commit()

        index_map = {s.index: position for position, s in enumerate(runnable)}
        media_plan = ExecutionPlan(
            name=plan.name,
            steps=[
                s.model_copy(
                    update={
                        "index": index_map[s.index],
                        "prompt": resolved_prompt(s),
                        "prompt_from": None,
                        "input_from": sorted(index_map[i] for i in s.input_from),
                    }
                )
                for s in runnable
            ],
            max_concurrency=plan.max_concurrency,
            estimates=plan.estimates,
            output_node_ids=plan.output_node_ids,
        )
        captured = await _stream_pipeline(
            session,
            run.id,
            build_pipeline(media_plan, ctx),
            build_sink(run_id=str(run.id)),
            media_plan,
            writer,
            settings,
            suppress_run_started=True,
        )
        if captured is not None:
            results.append(captured)

    return results


async def _finish(
    session: AsyncSession, run: Run, writer: _EventWriter, results: list[Any]
) -> None:
    if not results:
        await writer.append("run.failed", {"message": "The run produced no result."})
        await queue.finalize(
            session, run.id, status=RunStatus.FAILED,
            error="The run produced no result.", error_code="no_result",
        )
        return

    rows = await _persist_assets(session, run, results)
    summary = _summarize(results)

    # Each asset keeps its own pointer to the run manifest: the run row is
    # deletable (assets.run_id goes null on delete), and the trail must
    # survive the index forgetting the run.
    if summary.get("manifest_uri"):
        for row in rows:
            row.manifest_uri = summary["manifest_uri"]

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
                    "asset_id": str(r.id),
                    "node_id": r.node_id,
                    "url": r.url,
                    # Signed here so the canvas can render final results off
                    # this one event instead of a per-asset fetch round trip.
                    # From the URL, not b2_key: in local mode the key is a bare
                    # relative path while the URL is already fetchable as-is.
                    "preview_url": preview_url(r.url),
                    "media_type": r.media_type,
                    "modality": r.modality,
                    "sha256": r.sha256,
                    "size_bytes": r.size_bytes,
                    "width": r.width,
                    "height": r.height,
                    "text": (r.asset_metadata or {}).get("text"),
                    # Post-run URLs are durable, unlike the mid-run previews.
                    "ephemeral": False,
                }
                for r in rows
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
        steps=len(steps), assets=len(rows),
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
