"""SQLAlchemy mirror of db/schema.ts.

Drizzle owns the schema; this module only *reads and writes* it. Nothing here
creates or migrates tables — `create_type=False` on every enum and no
`metadata.create_all()` anywhere. `app.db.verify` reflects the live database at
startup and fails loudly if this mirror has drifted from Drizzle.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Computed,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import ENUM, JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELED = "canceled"
    INTERRUPTED = "interrupted"

    @property
    def is_terminal(self) -> bool:
        return self in _TERMINAL_RUN_STATUSES


_TERMINAL_RUN_STATUSES = frozenset(
    {
        RunStatus.SUCCEEDED,
        RunStatus.PARTIAL,
        RunStatus.FAILED,
        RunStatus.CANCELED,
        RunStatus.INTERRUPTED,
    }
)


class StepStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    CANCELED = "canceled"


class AssetKind(StrEnum):
    UPLOAD = "upload"
    GENERATED = "generated"


class EnrichmentStatus(StrEnum):
    PENDING = "pending"
    DONE = "done"
    FAILED = "failed"


# `create_type=False`: Drizzle creates these types via `pnpm db:push`.
_values = lambda enum_cls: [m.value for m in enum_cls]  # noqa: E731

_run_status = ENUM(RunStatus, name="run_status", create_type=False, values_callable=_values)
_step_status = ENUM(StepStatus, name="step_status", create_type=False, values_callable=_values)
_asset_kind = ENUM(AssetKind, name="asset_kind", create_type=False, values_callable=_values)
_enrichment_status = ENUM(
    EnrichmentStatus, name="enrichment_status", create_type=False, values_callable=_values
)


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )


class Workflow(Base):
    __tablename__ = "workflows"

    id: Mapped[uuid.UUID] = _pk()
    tenant_id: Mapped[str] = mapped_column(Text, nullable=False)
    owner_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    graph: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    thumbnail_asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[uuid.UUID] = _pk()
    tenant_id: Mapped[str] = mapped_column(Text, nullable=False)
    owner_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflows.id", ondelete="SET NULL")
    )
    idempotency_key: Mapped[str | None] = mapped_column(Text)

    graph_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    plan_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    genblaze_run_id: Mapped[str | None] = mapped_column(Text)
    parent_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    status: Mapped[RunStatus] = mapped_column(_run_status, nullable=False, default=RunStatus.QUEUED)
    error: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(Text)

    manifest_uri: Mapped[str | None] = mapped_column(Text)
    manifest_hash: Mapped[str | None] = mapped_column(Text)
    manifest_verified: Mapped[str | None] = mapped_column(Text)
    b2_prefix: Mapped[str | None] = mapped_column(Text)

    total_cost_usd: Mapped[float | None] = mapped_column(Float)
    duration_sec: Mapped[float | None] = mapped_column(Float)

    claimed_by: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    cancel_requested: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    steps: Mapped[list[RunStep]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="RunStep.step_index"
    )


class RunStep(Base):
    __tablename__ = "run_steps"

    id: Mapped[uuid.UUID] = _pk()
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
    )
    node_id: Mapped[str] = mapped_column(Text, nullable=False)
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    genblaze_step_id: Mapped[str | None] = mapped_column(Text)

    provider: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    modality: Mapped[str] = mapped_column(Text, nullable=False)
    step_type: Mapped[str] = mapped_column(Text, nullable=False, default="generate")
    status: Mapped[StepStatus] = mapped_column(
        _step_status, nullable=False, default=StepStatus.PENDING
    )

    prompt: Mapped[str | None] = mapped_column(Text)
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    upstream_id: Mapped[str | None] = mapped_column(Text)

    progress_pct: Mapped[float | None] = mapped_column(Float)
    preview_url: Mapped[str | None] = mapped_column(Text)
    elapsed_sec: Mapped[float | None] = mapped_column(Float)
    cost_usd: Mapped[float | None] = mapped_column(Float)

    error: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(Text)
    retries: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    run: Mapped[Run] = relationship(back_populates="steps")


class RunEvent(Base):
    __tablename__ = "run_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    node_id: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[uuid.UUID] = _pk()
    tenant_id: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[AssetKind] = mapped_column(_asset_kind, nullable=False)

    genblaze_asset_id: Mapped[str | None] = mapped_column(Text)
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="SET NULL")
    )
    node_id: Mapped[str | None] = mapped_column(Text)

    b2_key: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    media_type: Mapped[str] = mapped_column(Text, nullable=False)
    modality: Mapped[str] = mapped_column(Text, nullable=False)
    sha256: Mapped[str | None] = mapped_column(String(64))
    size_bytes: Mapped[int | None] = mapped_column(Integer)

    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    duration_sec: Mapped[float | None] = mapped_column(Float)

    manifest_uri: Mapped[str | None] = mapped_column(Text)
    filename: Mapped[str | None] = mapped_column(Text)
    asset_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AssetEnrichment(Base):
    """Derived, searchable metadata — the mirror of `assetEnrichment` in
    db/schema.ts; see the rationale there.

    `search_text` is database-generated and never written from here;
    `Computed` keeps it out of every INSERT this mirror emits.
    """

    __tablename__ = "asset_enrichment"

    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[EnrichmentStatus] = mapped_column(
        _enrichment_status, nullable=False, default=EnrichmentStatus.PENDING
    )

    caption: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    ocr_text: Mapped[str | None] = mapped_column(Text)
    palette: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    prompt: Mapped[str | None] = mapped_column(Text)

    search_doc: Mapped[str | None] = mapped_column(Text)
    search_text: Mapped[str | None] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', coalesce(search_doc, ''))")
    )
    embedding: Mapped[Any | None] = mapped_column(Vector(1024))

    model: Mapped[str | None] = mapped_column(Text)
    sidecar_key: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


__all__ = [
    "Asset",
    "AssetEnrichment",
    "AssetKind",
    "Base",
    "EnrichmentStatus",
    "Run",
    "RunEvent",
    "RunStatus",
    "RunStep",
    "StepStatus",
    "Workflow",
]

# Referenced by app.db.verify to detect drift from Drizzle.
EXPECTED_TABLES: dict[str, type[Base]] = {
    "workflows": Workflow,
    "runs": Run,
    "run_steps": RunStep,
    "run_events": RunEvent,
    "assets": Asset,
    "asset_enrichment": AssetEnrichment,
}
