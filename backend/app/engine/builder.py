"""Turn a compiled `ExecutionPlan` into a GenBlaze `Pipeline`.

Two choices worth stating outright:

- **`chain=False`, always.** Canvas edges are explicit. Implicit chaining would
  silently wire steps together in ways the user did not draw.
- **`metadata={"node_id": ...}` on every step.** Node identity then travels with
  the step instead of being re-derived from index arithmetic, which matters
  because `step.progress` events carry no `step_index`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from genblaze_core.providers.base import BaseProvider

from app.engine.manifests import sign_for_fetch
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
    # genblaze_core's Modality enum is closed; 3D masquerades as IMAGE at the
    # pipeline layer only. Our own PlannedStep.modality stays "3d" end to end.
    "3d": "IMAGE",
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
    #: node_id -> upstream prediction id. Steps listed here re-attach to a job
    #: the provider is already running (or has finished) instead of submitting
    #: a new one — the retry path for a step that timed out after its credits
    #: were already spent.
    resume_ids: dict[str, str] = field(default_factory=dict)


class ResumeProvider(BaseProvider):
    """A provider that re-attaches to an in-flight upstream job.

    GenBlaze's resume path takes the prediction id as an *argument* —
    `aresume(prediction_id, step, config)` — there is no RunnableConfig key
    for it, and `Pipeline` only ever executes a step through the provider's
    `invoke`/`ainvoke`. (`Pipeline.resume_step` resumes one step *outside* a
    run; it cannot keep the rest of the pipeline — sink, manifest, events,
    input chaining — around it.) Wrapping the adapter is therefore the seam:
    the one thing that changes is that this step polls/fetches the
    checkpointed job instead of calling `submit()` — which is what keeps a
    retried timeout from billing the provider twice.

    Subclasses `BaseProvider` because `Pipeline.step()` (core 0.3.8) rejects
    anything else. Inheriting brings concrete implementations that would
    shadow `__getattr__`, so every member the pipeline consults on a step's
    provider is delegated explicitly; `__getattr__` covers the rest,
    including instance state (`super().__init__()` is deliberately not
    called, so inherited code that reads provider state falls through to the
    adapter's own).
    """

    def __init__(self, inner: Any, prediction_id: str) -> None:
        self._inner = inner
        self._prediction_id = prediction_id

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    @property
    def name(self) -> str:  # type: ignore[override]
        return self._inner.name

    def get_capabilities(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.get_capabilities(*args, **kwargs)

    def validate_model(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.validate_model(*args, **kwargs)

    def normalize_params(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.normalize_params(*args, **kwargs)

    def estimate_cost(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.estimate_cost(*args, **kwargs)

    def prepare_payload(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.prepare_payload(*args, **kwargs)

    def submit(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.submit(*args, **kwargs)

    def poll(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.poll(*args, **kwargs)

    def fetch_output(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.fetch_output(*args, **kwargs)

    def resume(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.resume(*args, **kwargs)

    async def aresume(self, *args: Any, **kwargs: Any) -> Any:
        return await self._inner.aresume(*args, **kwargs)

    def invoke(self, step: Any, config: Any = None) -> Any:
        return self._inner.resume(self._prediction_id, step, config)

    async def ainvoke(self, step: Any, config: Any = None) -> Any:
        return await self._inner.aresume(self._prediction_id, step, config)


def _to_genblaze_asset(ref: AssetRef) -> Any:
    from genblaze_core import Asset

    return Asset(
        # Signed, because this URL is handed to a *remote* provider: Replicate,
        # Runway and GMI all fetch a reference image server-side, and the
        # durable URL on the asset row is a 401 to anyone without our keys.
        url=sign_for_fetch(ref.url),
        media_type=ref.media_type,
        sha256=ref.sha256,
        size_bytes=ref.size_bytes,
    )


def _sign_urls(value: Any) -> Any:
    """Copy `value`, presigning every private-bucket URL nested inside it.

    Two kinds of param carry an asset a fetcher outside this process has to
    open: a URL-typed param (an upload routed to a model that takes a URL
    rather than a chained input) and a composition clip, which travels as a
    URL inside the edit. Copied rather than mutated — the plan is persisted and
    goes on the manifest, and durable URLs are what belong there.
    """
    if isinstance(value, dict):
        return {key: _sign_urls(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_sign_urls(item) for item in value]
    if isinstance(value, str) and value.startswith("http"):
        return sign_for_fetch(value)
    return value


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
        resume_id = ctx.resume_ids.get(step.node_id)
        if resume_id:
            provider = ResumeProvider(provider, resume_id)
        modality = getattr(Modality, _MODALITY_BY_NAME[step.modality])
        step_type = getattr(StepType, _STEP_TYPE_BY_NAME.get(step.step_type, "GENERATE"))

        pipeline = pipeline.step(
            provider,
            model=step.model,
            prompt=step.prompt,
            modality=modality,
            step_type=step_type,
            params=_sign_urls(dict(step.params)),
            metadata={**step.metadata, "node_id": step.node_id, "run_id": ctx.run_id},
            # A fallback re-submits under another model — exactly the second
            # bill a resumed step exists to avoid.
            fallback_models=None if resume_id else (step.fallback_models or None),
            expected_duration_sec=step.expected_duration_sec,
            **_step_kwargs(step, ctx),
        )

    log.info(
        "pipeline.built",
        steps=len(plan.steps),
        max_concurrency=plan.max_concurrency,
        providers=sorted({s.provider_key for s in plan.steps}),
        resumed=sorted(n for n in ctx.resume_ids if plan.step_for_node(n)) or None,
    )
    return pipeline
