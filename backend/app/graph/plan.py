"""The compiled execution plan — the handoff from `graph/` to the engine.

A plan is JSON-serializable on purpose: it is snapshotted onto the run row, so a
run can be replayed, and so the worker can map GenBlaze step indices back to
canvas node ids without recompiling.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.graph.errors import Diagnostic


class PlannedStep(BaseModel):
    node_id: str
    index: int
    provider_key: str
    model: str
    modality: str
    step_type: str = "generate"
    prompt: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    #: Indices of prior steps whose assets feed this one (GenBlaze `input_from`).
    input_from: list[int] = Field(default_factory=list)
    #: Ingested upload asset ids feeding this step (GenBlaze `external_inputs`).
    external_input_asset_ids: list[str] = Field(default_factory=list)
    fallback_models: list[str] = Field(default_factory=list)
    expected_duration_sec: float | None = None
    est_cost_usd: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class PlanEstimates(BaseModel):
    cost_usd: float | None = None
    duration_sec: float | None = None


class ExecutionPlan(BaseModel):
    name: str = "workflow"
    steps: list[PlannedStep] = Field(default_factory=list)
    max_concurrency: int = 1
    estimates: PlanEstimates = Field(default_factory=PlanEstimates)
    #: Canvas node ids marked as outputs, for the run summary.
    output_node_ids: list[str] = Field(default_factory=list)

    @property
    def index_to_node(self) -> dict[int, str]:
        return {s.index: s.node_id for s in self.steps}

    def step_for_node(self, node_id: str) -> PlannedStep | None:
        return next((s for s in self.steps if s.node_id == node_id), None)


class PlanResult(BaseModel):
    plan: ExecutionPlan | None = None
    errors: list[Diagnostic] = Field(default_factory=list)
    warnings: list[Diagnostic] = Field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors and self.plan is not None
