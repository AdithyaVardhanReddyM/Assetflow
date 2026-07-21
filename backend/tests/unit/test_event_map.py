"""Event-mapper tests.

These encode the GenBlaze quirks documented in docs/sdk-findings.md. They use
lightweight stand-ins rather than real SDK events on purpose: the point is to pin
*our* translation contract, including the cases that are easy to regress —
`step.progress` carrying no `step_index`, `step.failed` using `error` rather than
`message`, and assets living only on the in-process object.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.engine.events import EventMapper, extract_result
from app.graph.plan import ExecutionPlan, PlannedStep


def plan() -> ExecutionPlan:
    return ExecutionPlan(
        name="t",
        steps=[
            PlannedStep(
                node_id="gen_video", index=0, provider_key="mock",
                model="mock-video-v1", modality="video",
            ),
            PlannedStep(
                node_id="gen_audio", index=1, provider_key="mock",
                model="mock-audio-v1", modality="audio",
            ),
        ],
    )


@pytest.fixture
def mapper() -> EventMapper:
    return EventMapper(plan=plan())


def ev(type_: str, **kw):
    return SimpleNamespace(type=type_, **kw)


def test_pipeline_started_maps_to_run_started(mapper):
    out = mapper.map(ev("pipeline.started", run_id="gb-1", total_steps=2))
    assert out.type == "run.started"
    assert out.payload["total_steps"] == 2


def test_step_started_resolves_node_from_index(mapper):
    out = mapper.map(
        ev("step.started", step_id="s1", step_index=1, provider="mock", model="m")
    )
    assert out.type == "node.started"
    assert out.node_id == "gen_audio"


def test_progress_resolves_node_via_learned_step_id(mapper):
    """The crux: `step.progress` carries no `step_index`, so node identity has to
    come from the map learned at `step.started`."""
    mapper.map(ev("step.started", step_id="s1", step_index=0, provider="mock", model="m"))

    out = mapper.map(
        ev("step.progress", step_id="s1", provider="mock", model="m",
           progress_pct=0.5, preview_url="https://cdn/p.jpg", request_id="pred_9")
    )
    assert out.type == "node.progress"
    assert out.node_id == "gen_video"  # would be None without the learned map
    assert out.payload["progress_pct"] == 0.5
    assert out.payload["request_id"] == "pred_9"


def test_progress_without_prior_started_does_not_crash(mapper):
    out = mapper.map(ev("step.progress", step_id="unknown", provider="p", model="m"))
    assert out.type == "node.progress"
    assert out.node_id is None


def test_completed_reads_assets_off_the_in_process_step(mapper):
    """Assets are excluded from serialization, so they must be read from the live
    object or they never reach the browser."""
    asset = SimpleNamespace(
        asset_id="a1", url="https://cdn/v.mp4", media_type="video/mp4",
        sha256="ab" * 32, size_bytes=123, width=1920, height=1080, duration=6.0,
    )
    step = SimpleNamespace(
        assets=[asset], cost_usd=0.04, metadata={"node_id": "gen_video"},
        error_code=None,
    )
    out = mapper.map(
        ev("step.completed", step_id="s1", step_index=0, provider="mock",
           model="m", elapsed_sec=6.0, step=step)
    )
    assert out.type == "node.completed"
    assert out.node_id == "gen_video"
    assert out.payload["cost_usd"] == 0.04
    assert len(out.payload["assets"]) == 1
    assert out.payload["assets"][0]["url"] == "https://cdn/v.mp4"
    # Mid-run URLs point at the provider CDN and can expire.
    assert out.payload["assets"][0]["ephemeral"] is True


def test_completed_without_step_object_yields_no_assets(mapper):
    out = mapper.map(
        ev("step.completed", step_id="s1", step_index=0, provider="p", model="m", step=None)
    )
    assert out.payload["assets"] == []


def test_failed_uses_error_not_message(mapper):
    out = mapper.map(
        ev("step.failed", step_id="s1", step_index=0, provider="p", model="m",
           error="provider exploded", step=None)
    )
    assert out.type == "node.failed"
    assert out.payload["error"] == "provider exploded"


def test_upstream_failure_becomes_skipped_not_failed(mapper):
    """One real failure should not paint every downstream node red."""
    step = SimpleNamespace(
        error_code=SimpleNamespace(value="invalid_input"),
        metadata={"node_id": "gen_audio", "provider_invoked": False},
        assets=[],
    )
    out = mapper.map(
        ev("step.failed", step_id="s2", step_index=1, provider="p", model="m",
           error="input resolution failed", step=step)
    )
    assert out.type == "node.skipped"
    assert out.payload["reason"] == "upstream_failed"


def test_genuine_invalid_input_still_fails(mapper):
    """`provider_invoked=True` means the provider really rejected it."""
    step = SimpleNamespace(
        error_code=SimpleNamespace(value="invalid_input"),
        metadata={"node_id": "gen_audio", "provider_invoked": True},
        assets=[],
    )
    out = mapper.map(
        ev("step.failed", step_id="s2", step_index=1, provider="p", model="m",
           error="bad prompt", step=step)
    )
    assert out.type == "node.failed"


def test_heartbeat_is_flagged(mapper):
    out = mapper.map(
        ev("step.progress", step_id="s1", provider="p", model="m", is_heartbeat=True)
    )
    assert out.payload["is_heartbeat"] is True


def test_unknown_event_is_ignored(mapper):
    assert mapper.map(ev("something.else")) is None


def test_extract_result_from_both_terminal_events():
    """A best-effort run that ends FAILED still carries succeeded steps' assets;
    capturing only from `pipeline.completed` would discard partial output."""
    payload = SimpleNamespace(run=None, manifest=None)
    assert extract_result(ev("pipeline.completed", result=payload)) is payload
    assert extract_result(ev("pipeline.failed", result=payload)) is payload
    assert extract_result(ev("step.completed", result=payload)) is None
