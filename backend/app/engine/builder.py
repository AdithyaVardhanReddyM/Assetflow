"""Turn a compiled `ExecutionPlan` into a GenBlaze `Pipeline`.

Two choices worth stating outright:

- **`chain=False`, always.** Canvas edges are explicit. Implicit chaining would
  silently wire steps together in ways the user did not draw.
- **`metadata={"node_id": ...}` on every step.** Node identity then travels with
  the step instead of being re-derived from index arithmetic, which matters
  because `step.progress` events carry no `step_index`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.engine.providers import build_provider
from app.graph.plan import ExecutionPlan, PlannedStep
from app.graph.schema import AssetRef
from app.logging import get_logger

log = get_logger(__name__)

_MODALITY_BY_NAME = {
    "image": "IMAGE",
    "video": "VIDEO",
    "audio": "AUDIO",
    "text": "TEXT",
}

_STEP_TYPE_BY_NAME = {
    "generate": "GENERATE",
    "mix": "MIX",
    "ingest": "INGEST",
    "edit": "EDIT",
}


@dataclass(slots=True)
class BuildContext:
    tenant_id: str
    workflow_id: str | None
    run_id: str
    assets: dict[str, AssetRef]
    preflight: bool = True


def _to_genblaze_asset(ref: AssetRef) -> Any:
    from genblaze_core import Asset

    return Asset(
        url=ref.url,
        media_type=ref.media_type,
        sha256=ref.sha256,
        size_bytes=ref.size_bytes,
    )


def _step_kwargs(step: PlannedStep, ctx: BuildContext) -> dict[str, Any]:
    """`external_inputs` and `input_from` are mutually exclusive in GenBlaze; the
    compiler already rejected graphs that need both, so at most one is set."""
    kwargs: dict[str, Any] = {}
    if step.input_from:
        kwargs["input_from"] = list(step.input_from)
    elif step.external_input_asset_ids:
        kwargs["external_inputs"] = [
            _to_genblaze_asset(ctx.assets[a]) for a in step.external_input_asset_ids
        ]
    return kwargs


def build_pipeline(plan: ExecutionPlan, ctx: BuildContext) -> Any:
    from genblaze_core import Modality, Pipeline
    from genblaze_core.models.enums import StepType

    # A Pipeline fixes every prompt at construction, so a prompt that an LLM
    # step has not written yet cannot be expressed here. The runs router
    # already refuses these; this is the backstop that keeps a plan reaching
    # a provider with the wrong prompt from being possible at all.
    if plan.prompt_chained_node_ids:
        raise ValueError(
            "Cannot build a pipeline whose prompt comes from an LLM step: "
            f"{', '.join(plan.prompt_chained_node_ids)}. Prompt chaining needs "
            "the run split into a text stage and a media stage."
        )

    pipeline = Pipeline(
        plan.name,
        tenant_id=ctx.tenant_id,
        project_id=ctx.workflow_id,
        chain=False,
        max_concurrency=plan.max_concurrency,
        preflight=ctx.preflight,
    )

    for step in plan.steps:
        provider = build_provider(step.provider_key, step.model)
        modality = getattr(Modality, _MODALITY_BY_NAME[step.modality])
        step_type = getattr(StepType, _STEP_TYPE_BY_NAME.get(step.step_type, "GENERATE"))

        pipeline = pipeline.step(
            provider,
            model=step.model,
            prompt=step.prompt,
            modality=modality,
            step_type=step_type,
            params=dict(step.params),
            metadata={**step.metadata, "node_id": step.node_id, "run_id": ctx.run_id},
            fallback_models=step.fallback_models or None,
            expected_duration_sec=step.expected_duration_sec,
            **_step_kwargs(step, ctx),
        )

    log.info(
        "pipeline.built",
        steps=len(plan.steps),
        max_concurrency=plan.max_concurrency,
        providers=sorted({s.provider_key for s in plan.steps}),
    )
    return pipeline
