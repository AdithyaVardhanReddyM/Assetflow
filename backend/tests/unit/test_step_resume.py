"""Retrying a timed-out step re-attaches to the provider's job — no resubmit.

The scenario: a long video generation blows past the poll timeout. The provider
accepted the job — and billed for it — and its job id was checkpointed on
`run_steps.upstream_id` off the first progress event that carried a
`request_id`. When the run is retried, that step must go straight to GenBlaze's
resume path (poll → fetch on the stored id, `submit()` never called), because a
fresh submit pays for the same generation twice. Any *other* failure means the
upstream job is dead, and resubmitting is the only way to get output.
"""

from __future__ import annotations

import pytest

from app.db.models import RunStep, StepStatus
from app.engine.builder import BuildContext, ResumeProvider, build_pipeline
from app.graph.plan import ExecutionPlan, PlannedStep
from app.workers.runner import _resume_targets


def _plan(**overrides):
    steps = overrides.pop(
        "steps",
        [
            PlannedStep(
                node_id="vid",
                index=0,
                provider_key="mock",
                model="mock-video-v1",
                modality="video",
            )
        ],
    )
    return ExecutionPlan(name="p", steps=steps, **overrides)


def _row(**overrides):
    defaults = dict(
        node_id="vid",
        step_index=0,
        provider="mock",
        model="mock-video-v1",
        modality="video",
        status=StepStatus.FAILED,
        error_code="timeout",
        upstream_id="pred-123",
    )
    return RunStep(**{**defaults, **overrides})


# --------------------------------------------------------------------------- #
# which steps qualify
# --------------------------------------------------------------------------- #


def test_a_timed_out_step_with_a_job_id_is_resumed():
    assert _resume_targets(_plan(), [_row()]) == {"vid": "pred-123"}


def test_a_succeeded_step_is_not_resumed():
    assert _resume_targets(_plan(), [_row(status=StepStatus.SUCCEEDED)]) == {}


@pytest.mark.parametrize("code", ["server_error", "content_policy", None])
def test_only_a_timeout_qualifies(code):
    """Any other failure means the upstream job itself died — resubmitting is
    the correct way to get output, not re-polling a corpse."""
    assert _resume_targets(_plan(), [_row(error_code=code)]) == {}


def test_a_timeout_with_no_checkpointed_id_cannot_resume():
    assert _resume_targets(_plan(), [_row(upstream_id=None)]) == {}


def test_a_step_no_longer_in_the_plan_is_ignored():
    assert _resume_targets(_plan(), [_row(node_id="gone")]) == {}


def test_a_step_whose_model_changed_is_not_fed_the_old_job_id():
    """Retry snapshots the same plan today, but a stale job id handed to a
    different model would fetch the wrong output — guard on provider+model."""
    assert _resume_targets(_plan(), [_row(model="mock-video-v2")]) == {}
    assert _resume_targets(_plan(), [_row(provider="replicate")]) == {}


# --------------------------------------------------------------------------- #
# the wrapper: invoke/ainvoke route to resume, everything else delegates
# --------------------------------------------------------------------------- #


class _RecordingProvider:
    name = "stub"

    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def resume(self, prediction_id, step, config=None):
        self.calls.append(("resume", prediction_id))
        return step

    async def aresume(self, prediction_id, step, config=None):
        self.calls.append(("aresume", prediction_id))
        return step

    def validate_model(self, slug, **kwargs):
        return f"validated:{slug}"


def test_invoke_routes_to_resume_with_the_stored_id():
    inner = _RecordingProvider()
    wrapped = ResumeProvider(inner, "pred-123")
    step = object()
    assert wrapped.invoke(step, {"timeout": 5}) is step
    assert inner.calls == [("resume", "pred-123")]


async def test_ainvoke_routes_to_aresume_with_the_stored_id():
    inner = _RecordingProvider()
    wrapped = ResumeProvider(inner, "pred-123")
    step = object()
    assert await wrapped.ainvoke(step) is step
    assert inner.calls == [("aresume", "pred-123")]


def test_everything_else_is_the_adapters():
    """The pipeline consults name/validate_model/normalize_params on the
    step's provider — those must answer as the real adapter."""
    wrapped = ResumeProvider(_RecordingProvider(), "pred-123")
    assert wrapped.name == "stub"
    assert wrapped.validate_model("m") == "validated:m"


# --------------------------------------------------------------------------- #
# plan → pipeline: only the listed node is wrapped
# --------------------------------------------------------------------------- #


def _two_step_plan():
    return _plan(
        steps=[
            PlannedStep(
                node_id="vid",
                index=0,
                provider_key="mock",
                model="mock-video-v1",
                modality="video",
                fallback_models=["mock-video-v2"],
            ),
            PlannedStep(
                node_id="img",
                index=1,
                provider_key="mock",
                model="mock-image-v1",
                modality="image",
                fallback_models=["mock-image-v2"],
            ),
        ]
    )


def _ctx(resume_ids):
    return BuildContext(
        tenant_id="t",
        workflow_id=None,
        run_id="r",
        assets={},
        preflight=False,
        resume_ids=resume_ids,
    )


def test_build_pipeline_wraps_only_the_resumed_node():
    pipeline = build_pipeline(_two_step_plan(), _ctx({"vid": "pred-123"}))

    resumed, fresh = pipeline._steps
    assert isinstance(resumed.provider, ResumeProvider)
    assert resumed.provider._prediction_id == "pred-123"
    # A fallback re-submits under another model — the second bill this path
    # exists to avoid.
    assert resumed.fallback_models == []

    assert not isinstance(fresh.provider, ResumeProvider)
    assert fresh.fallback_models == ["mock-image-v2"]


def test_build_pipeline_without_resume_ids_is_unchanged():
    pipeline = build_pipeline(_two_step_plan(), _ctx({}))
    assert not any(isinstance(s.provider, ResumeProvider) for s in pipeline._steps)


# --------------------------------------------------------------------------- #
# the real resume path: submit() is never called
# --------------------------------------------------------------------------- #


def test_resume_polls_and_fetches_without_submitting():
    from genblaze_core import Asset
    from genblaze_core.models.enums import StepStatus as GBStepStatus
    from genblaze_core.models.step import Step
    from genblaze_core.providers.base import UPSTREAM_ID_KEY, BaseProvider

    class _Fake(BaseProvider):
        name = "fake"

        def __init__(self):
            super().__init__()
            self.submits = 0

        def submit(self, step, config=None):
            self.submits += 1
            return "fresh-id"

        def poll(self, prediction_id, config=None):
            return True

        def fetch_output(self, prediction_id, step):
            step.assets = [
                Asset(url=f"https://cdn.test/{prediction_id}.mp4", media_type="video/mp4")
            ]
            return step

    inner = _Fake()
    wrapped = ResumeProvider(inner, "pred-123")
    result = wrapped.invoke(Step(provider="fake", model="m"))

    assert inner.submits == 0
    assert result.status is GBStepStatus.SUCCEEDED
    # Output fetched from the checkpointed job, and the id re-recorded on the
    # step so the retried run's own row checkpoints it again.
    assert result.assets[0].url == "https://cdn.test/pred-123.mp4"
    assert result.metadata[UPSTREAM_ID_KEY] == "pred-123"
