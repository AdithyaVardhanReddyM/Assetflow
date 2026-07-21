"""Workflow CRUD and graph validation.

`POST /v1/workflows/validate` is the endpoint the canvas calls as the user edits:
it compiles without persisting and returns diagnostics anchored to node and edge
ids, so errors can be drawn inline rather than surfaced only when a run fails.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app.db.models import Workflow
from app.deps import CatalogDep, CurrentUser, Session
from app.errors import NotFound
from app.graph.compile import plan_graph
from app.graph.schema import Graph
from app.services.workflows import load_asset_refs

router = APIRouter(prefix="/v1/workflows", tags=["workflows"])


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    graph: Graph = Field(default_factory=Graph)


class WorkflowUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    graph: Graph | None = None


class GraphPayload(BaseModel):
    graph: Graph


def _serialize(workflow: Workflow) -> dict[str, Any]:
    return {
        "id": str(workflow.id),
        "name": workflow.name,
        "description": workflow.description,
        "graph": workflow.graph,
        "created_at": workflow.created_at.isoformat() if workflow.created_at else None,
        "updated_at": workflow.updated_at.isoformat() if workflow.updated_at else None,
    }


async def _get_owned(session: Session, workflow_id: uuid.UUID, user: CurrentUser) -> Workflow:
    """Tenant scoping in one place. Missing and not-yours both return 404 —
    a 403 would confirm the id exists to someone who should not know that."""
    result = await session.execute(
        select(Workflow).where(
            Workflow.id == workflow_id,
            Workflow.tenant_id == user.tenant_id,
            Workflow.deleted_at.is_(None),
        )
    )
    workflow = result.scalar_one_or_none()
    if workflow is None:
        raise NotFound(f"Workflow {workflow_id} was not found.")
    return workflow


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_workflow(
    body: WorkflowCreate, session: Session, user: CurrentUser
) -> dict[str, Any]:
    workflow = Workflow(
        tenant_id=user.tenant_id,
        owner_user_id=user.user_id,
        name=body.name,
        description=body.description,
        graph=body.graph.model_dump(mode="json"),
    )
    session.add(workflow)
    await session.commit()
    await session.refresh(workflow)
    return _serialize(workflow)


@router.get("")
async def list_workflows(
    session: Session,
    user: CurrentUser,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    result = await session.execute(
        select(Workflow)
        .where(Workflow.tenant_id == user.tenant_id, Workflow.deleted_at.is_(None))
        .order_by(Workflow.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )
    items = [_serialize(w) for w in result.scalars()]
    return {"items": items, "limit": limit, "offset": offset}


@router.get("/{workflow_id}")
async def get_workflow(
    workflow_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    return _serialize(await _get_owned(session, workflow_id, user))


@router.patch("/{workflow_id}")
async def update_workflow(
    workflow_id: uuid.UUID, body: WorkflowUpdate, session: Session, user: CurrentUser
) -> dict[str, Any]:
    workflow = await _get_owned(session, workflow_id, user)
    if body.name is not None:
        workflow.name = body.name
    if body.description is not None:
        workflow.description = body.description
    if body.graph is not None:
        workflow.graph = body.graph.model_dump(mode="json")
    await session.commit()
    await session.refresh(workflow)
    return _serialize(workflow)


@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(
    workflow_id: uuid.UUID, session: Session, user: CurrentUser
) -> Response:
    workflow = await _get_owned(session, workflow_id, user)
    # Soft delete: runs reference workflows, and a hard delete would orphan the
    # provenance trail for media the user still has in their library.
    await session.execute(
        update(Workflow).where(Workflow.id == workflow.id).values(deleted_at=datetime.now(UTC))
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/validate")
async def validate_graph(
    body: GraphPayload, session: Session, user: CurrentUser, catalog: CatalogDep
) -> dict[str, Any]:
    """Compile without persisting. Always 200 — the payload says whether the
    graph is valid, because a 4xx per keystroke is not a useful editing UX."""
    assets = await load_asset_refs(session, tenant_id=user.tenant_id, graph=body.graph)
    result = plan_graph(body.graph, catalog=catalog, assets=assets)
    return {
        "valid": result.valid,
        "errors": [d.as_dict() for d in result.errors],
        "warnings": [d.as_dict() for d in result.warnings],
        "plan": result.plan.model_dump(mode="json") if result.plan else None,
    }
