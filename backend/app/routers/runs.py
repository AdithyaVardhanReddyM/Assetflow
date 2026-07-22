"""Run lifecycle: enqueue, inspect, cancel, retry."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Header, Query, Response, status
from pydantic import BaseModel, model_validator
from sqlalchemy import select, update

from app.db.models import Asset, Run, RunStatus, RunStep, Workflow
from app.deps import CatalogDep, CurrentUser, Session
from app.errors import Conflict, NotFound, UnprocessableGraph
from app.graph.compile import plan_graph
from app.graph.errors import ErrorCode, error
from app.graph.schema import Graph
from app.services.workflows import load_asset_refs

router = APIRouter(prefix="/v1/runs", tags=["runs"])


class RunCreate(BaseModel):
    workflow_id: uuid.UUID | None = None
    graph: Graph | None = None

    @model_validator(mode="after")
    def _one_of(self) -> RunCreate:
        if (self.workflow_id is None) == (self.graph is None):
            raise ValueError("Provide exactly one of workflow_id or graph.")
        return self


def _serialize_step(step: RunStep) -> dict[str, Any]:
    return {
        "node_id": step.node_id,
        "step_index": step.step_index,
        "provider": step.provider,
        "model": step.model,
        "modality": step.modality,
        "status": step.status.value,
        "progress_pct": step.progress_pct,
        "preview_url": step.preview_url,
        "elapsed_sec": step.elapsed_sec,
        "cost_usd": step.cost_usd,
        "upstream_id": step.upstream_id,
        "error": step.error,
        "error_code": step.error_code,
    }


def _serialize_asset(asset: Asset) -> dict[str, Any]:
    return {
        "id": str(asset.id),
        "node_id": asset.node_id,
        "url": asset.url,
        "media_type": asset.media_type,
        "modality": asset.modality,
        "sha256": asset.sha256,
        "size_bytes": asset.size_bytes,
    }


def _serialize_run(run: Run, *, steps=None, assets=None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": str(run.id),
        "workflow_id": str(run.workflow_id) if run.workflow_id else None,
        "status": run.status.value,
        "attempt": run.attempt,
        "error": run.error,
        "error_code": run.error_code,
        "manifest": {
            "uri": run.manifest_uri,
            "hash": run.manifest_hash,
            # Tri-state on purpose: null means "not applicable" (local storage),
            # which is different from "verification failed".
            "verified": {"true": True, "false": False}.get(run.manifest_verified or ""),
        },
        "total_cost_usd": run.total_cost_usd,
        "duration_sec": run.duration_sec,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "events_url": f"/v1/runs/{run.id}/events",
    }
    if steps is not None:
        body["steps"] = [_serialize_step(s) for s in steps]
    if assets is not None:
        body["assets"] = [_serialize_asset(a) for a in assets]
    return body


async def _get_owned(session: Session, run_id: uuid.UUID, user: CurrentUser) -> Run:
    result = await session.execute(
        select(Run).where(Run.id == run_id, Run.tenant_id == user.tenant_id)
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise NotFound(f"Run {run_id} was not found.")
    return run


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def create_run(
    body: RunCreate,
    session: Session,
    user: CurrentUser,
    catalog: CatalogDep,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    # Replay protection before anything else: a double-clicked Run button must
    # not spend twice on a paid provider.
    if idempotency_key:
        existing = await session.execute(
            select(Run).where(
                Run.tenant_id == user.tenant_id, Run.idempotency_key == idempotency_key
            )
        )
        prior = existing.scalar_one_or_none()
        if prior is not None:
            return _serialize_run(prior)

    workflow: Workflow | None = None
    if body.workflow_id is not None:
        result = await session.execute(
            select(Workflow).where(
                Workflow.id == body.workflow_id,
                Workflow.tenant_id == user.tenant_id,
                Workflow.deleted_at.is_(None),
            )
        )
        workflow = result.scalar_one_or_none()
        if workflow is None:
            raise NotFound(f"Workflow {body.workflow_id} was not found.")
        graph = Graph.model_validate(workflow.graph)
    else:
        graph = body.graph  # type: ignore[assignment]

    assets = await load_asset_refs(session, tenant_id=user.tenant_id, graph=graph)
    plan_result = plan_graph(
        graph, catalog=catalog, assets=assets, name=workflow.name if workflow else "workflow"
    )
    if not plan_result.valid:
        raise UnprocessableGraph(
            "This workflow cannot run yet.",
            errors=[d.as_dict() for d in plan_result.errors],
        )

    # A prompt written by an upstream LLM step is not knowable when the GenBlaze
    # pipeline is built, and a run that quietly used the un-rewritten prompt
    # would spend real money producing the wrong thing. Refuse instead — the
    # canvas already carries the same message as a warning.
    chained = plan_result.plan.prompt_chained_node_ids
    if chained:
        raise UnprocessableGraph(
            "Running a workflow whose prompt comes from an LLM node isn't "
            "supported yet.",
            errors=[
                error(
                    ErrorCode.PROMPT_CHAIN_UNSUPPORTED,
                    "This node's prompt is written by an LLM node.",
                    node_id=node_id,
                    hint="Disconnect the LLM node and type the prompt, or run the "
                    "LLM node on its own first.",
                ).as_dict()
                for node_id in chained
            ],
        )

    run = Run(
        tenant_id=user.tenant_id,
        owner_user_id=user.user_id,
        workflow_id=workflow.id if workflow else None,
        idempotency_key=idempotency_key,
        graph_snapshot=graph.model_dump(mode="json"),
        plan_snapshot=plan_result.plan.model_dump(mode="json"),
        status=RunStatus.QUEUED,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)

    return {
        **_serialize_run(run),
        "steps": [
            {
                "node_id": s.node_id,
                "step_index": s.index,
                "provider": s.provider_key,
                "model": s.model,
                "modality": s.modality,
                "status": "pending",
            }
            for s in plan_result.plan.steps
        ],
        "warnings": [d.as_dict() for d in plan_result.warnings],
        "estimates": plan_result.plan.estimates.model_dump(),
    }


@router.get("")
async def list_runs(
    session: Session,
    user: CurrentUser,
    workflow_id: uuid.UUID | None = Query(default=None),
    run_status: RunStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    stmt = select(Run).where(Run.tenant_id == user.tenant_id)
    if workflow_id is not None:
        stmt = stmt.where(Run.workflow_id == workflow_id)
    if run_status is not None:
        stmt = stmt.where(Run.status == run_status)
    stmt = stmt.order_by(Run.created_at.desc()).limit(limit).offset(offset)

    result = await session.execute(stmt)
    return {
        "items": [_serialize_run(r) for r in result.scalars()],
        "limit": limit,
        "offset": offset,
    }


@router.get("/{run_id}")
async def get_run(run_id: uuid.UUID, session: Session, user: CurrentUser) -> dict[str, Any]:
    run = await _get_owned(session, run_id, user)
    steps = (
        await session.execute(
            select(RunStep).where(RunStep.run_id == run.id).order_by(RunStep.step_index)
        )
    ).scalars()
    assets = (
        await session.execute(select(Asset).where(Asset.run_id == run.id))
    ).scalars()
    return _serialize_run(run, steps=list(steps), assets=list(assets))


@router.post("/{run_id}/cancel", status_code=status.HTTP_202_ACCEPTED)
async def cancel_run(
    run_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    run = await _get_owned(session, run_id, user)
    if run.status.is_terminal:
        raise Conflict(f"Run is already {run.status.value}.")

    # The API only records intent; the worker owning the lease notices on its
    # next heartbeat and cancels the asyncio task. Cross-process cancellation
    # through the database avoids needing a message bus.
    await session.execute(
        update(Run).where(Run.id == run.id).values(cancel_requested=datetime.now(UTC))
    )
    await session.commit()
    return {"id": str(run.id), "status": "canceling"}


@router.post("/{run_id}/retry", status_code=status.HTTP_202_ACCEPTED)
async def retry_run(
    run_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    """Re-run the exact graph that was executed, linked to the original."""
    original = await _get_owned(session, run_id, user)
    if not original.status.is_terminal:
        raise Conflict("This run is still in progress.")

    retry = Run(
        tenant_id=original.tenant_id,
        owner_user_id=user.user_id,
        workflow_id=original.workflow_id,
        graph_snapshot=original.graph_snapshot,
        plan_snapshot=original.plan_snapshot,
        parent_run_id=original.id,
        status=RunStatus.QUEUED,
    )
    session.add(retry)
    await session.commit()
    await session.refresh(retry)
    return _serialize_run(retry)


@router.get("/{run_id}/manifest")
async def get_manifest(
    run_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    """Re-read the canonical manifest from B2 and re-verify it.

    Reading it back from storage rather than echoing the database is the point:
    it proves the provenance record is really in the bucket and still intact.
    """
    run = await _get_owned(session, run_id, user)
    if not run.manifest_uri:
        raise NotFound("This run has no manifest — it may not have reached storage.")

    from app.engine.manifests import read_manifest

    return await read_manifest(run)


@router.delete("/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_run(run_id: uuid.UUID, session: Session, user: CurrentUser) -> Response:
    run = await _get_owned(session, run_id, user)
    if not run.status.is_terminal:
        raise Conflict("Cancel the run before deleting it.")
    await session.delete(run)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
