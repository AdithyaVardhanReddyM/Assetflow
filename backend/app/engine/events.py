"""Translate GenBlaze `StreamEvent`s into the wire events the canvas consumes.

Three empirically-verified quirks drive this module (see docs/sdk-findings.md):

1. `StepCompletedEvent.step` is excluded from serialization. The attribute *is*
   populated in-process, so asset URLs are read off the live object here — they
   would otherwise never reach the browser.
2. `step.progress` carries `step_id` but **no** `step_index`, so node identity
   cannot be resolved from a progress event alone. We learn `step_id -> node_id`
   at `step.started` and apply it to every later event for that step.
3. `step.failed` carries `error`, not `message`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.graph.plan import ExecutionPlan


@dataclass(slots=True)
class WireEvent:
    type: str
    payload: dict[str, Any]
    node_id: str | None = None


@dataclass
class EventMapper:
    """Stateful because GenBlaze does not repeat `step_index` on every event."""

    plan: ExecutionPlan
    _node_by_step_id: dict[str, str] = field(default_factory=dict)

    def _node_for(self, event: Any) -> str | None:
        step_id = getattr(event, "step_id", None)
        if step_id and step_id in self._node_by_step_id:
            return self._node_by_step_id[step_id]

        # Prefer the live step object when present; fall back to the index map.
        step = getattr(event, "step", None)
        if step is not None:
            node_id = (getattr(step, "metadata", None) or {}).get("node_id")
            if node_id:
                if step_id:
                    self._node_by_step_id[step_id] = node_id
                return node_id

        index = getattr(event, "step_index", None)
        if index is not None:
            node_id = self.plan.index_to_node.get(index)
            if node_id and step_id:
                self._node_by_step_id[step_id] = node_id
            return node_id
        return None

    def map(self, event: Any) -> WireEvent | None:
        etype = getattr(event, "type", None)
        handler = _HANDLERS.get(etype or "")
        if handler is None:
            return None
        return handler(self, event)


def _assets_payload(step: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for asset in getattr(step, "assets", None) or []:
        metadata = getattr(asset, "metadata", None) or {}
        out.append(
            {
                "asset_id": getattr(asset, "asset_id", None),
                "url": asset.url,
                # An LLM step's words. In the payload itself because a text
                # asset's URL may be file:// or a private-bucket object — the
                # canvas shows the words, not the file.
                "text": metadata.get("text") if isinstance(metadata, dict) else None,
                "media_type": getattr(asset, "media_type", None),
                "sha256": getattr(asset, "sha256", None),
                "size_bytes": getattr(asset, "size_bytes", None),
                "width": getattr(asset, "width", None),
                "height": getattr(asset, "height", None),
                "duration": getattr(asset, "duration", None),
                # Until the run finishes and the sink rewrites URLs, an asset URL
                # points at the provider CDN and may expire in minutes. The canvas
                # may preview it but must not treat it as canonical.
                "ephemeral": True,
            }
        )
    return out


def _run_started(m: EventMapper, e: Any) -> WireEvent:
    return WireEvent(
        "run.started",
        {
            "genblaze_run_id": getattr(e, "run_id", None),
            "total_steps": getattr(e, "total_steps", None),
        },
    )


def _node_queued(m: EventMapper, e: Any) -> WireEvent:
    node_id = m._node_for(e)
    return WireEvent(
        "node.queued",
        {
            "node_id": node_id,
            "provider": getattr(e, "provider", None),
            "model": getattr(e, "model", None),
            "reason": getattr(e, "reason", None),
        },
        node_id,
    )


def _node_started(m: EventMapper, e: Any) -> WireEvent:
    node_id = m._node_for(e)
    return WireEvent(
        "node.started",
        {
            "node_id": node_id,
            "provider": getattr(e, "provider", None),
            "model": getattr(e, "model", None),
            "step_index": getattr(e, "step_index", None),
            "expected_duration_sec": getattr(e, "expected_duration_sec", None),
        },
        node_id,
    )


def _node_progress(m: EventMapper, e: Any) -> WireEvent:
    node_id = m._node_for(e)
    return WireEvent(
        "node.progress",
        {
            "node_id": node_id,
            "progress_pct": getattr(e, "progress_pct", None),
            "preview_url": getattr(e, "preview_url", None),
            "elapsed_sec": getattr(e, "elapsed_sec", None),
            "request_id": getattr(e, "request_id", None),
            # Heartbeats exist to keep the connection warm during long polls;
            # the UI should not treat them as fresh progress.
            "is_heartbeat": bool(getattr(e, "is_heartbeat", False)),
            "message": getattr(e, "message", None),
        },
        node_id,
    )


def _node_retried(m: EventMapper, e: Any) -> WireEvent:
    node_id = m._node_for(e)
    return WireEvent(
        "node.retried",
        {
            "node_id": node_id,
            "attempt": getattr(e, "attempt", None),
            "max_attempts": getattr(e, "max_attempts", None),
            "delay_sec": getattr(e, "delay_sec", None),
            "error_code": _enum_value(getattr(e, "error_code", None)),
        },
        node_id,
    )


def _node_completed(m: EventMapper, e: Any) -> WireEvent:
    node_id = m._node_for(e)
    step = getattr(e, "step", None)
    return WireEvent(
        "node.completed",
        {
            "node_id": node_id,
            "provider": getattr(e, "provider", None),
            "model": getattr(e, "model", None),
            "elapsed_sec": getattr(e, "elapsed_sec", None),
            "request_id": getattr(e, "request_id", None),
            "cost_usd": getattr(step, "cost_usd", None),
            "assets": _assets_payload(step) if step is not None else [],
        },
        node_id,
    )


def _node_failed(m: EventMapper, e: Any) -> WireEvent:
    node_id = m._node_for(e)
    step = getattr(e, "step", None)
    error_code = _enum_value(getattr(e, "error_code", None)) or _enum_value(
        getattr(step, "error_code", None)
    )
    metadata = (getattr(step, "metadata", None) or {}) if step is not None else {}

    # GenBlaze pre-fails a consumer whose producer failed, without invoking the
    # provider. Surfacing that as a hard error paints half the canvas red for one
    # real failure, so report it as skipped instead.
    if error_code == "invalid_input" and metadata.get("provider_invoked") is False:
        return WireEvent(
            "node.skipped",
            {"node_id": node_id, "reason": "upstream_failed"},
            node_id,
        )

    return WireEvent(
        "node.failed",
        {
            "node_id": node_id,
            "provider": getattr(e, "provider", None),
            "model": getattr(e, "model", None),
            # `error`, not `message` — the discriminated union dropped `message`
            # for failure events.
            "error": getattr(e, "error", None),
            "error_code": error_code,
            "elapsed_sec": getattr(e, "elapsed_sec", None),
            "request_id": getattr(e, "request_id", None),
        },
        node_id,
    )


def _run_completed(m: EventMapper, e: Any) -> WireEvent:
    return WireEvent(
        "run.completed",
        {
            "genblaze_run_id": getattr(e, "run_id", None),
            "run_status": _enum_value(getattr(e, "run_status", None)),
            "manifest_hash": getattr(e, "manifest_hash", None),
        },
    )


def _run_failed(m: EventMapper, e: Any) -> WireEvent:
    return WireEvent(
        "run.failed",
        {
            "genblaze_run_id": getattr(e, "run_id", None),
            "run_status": _enum_value(getattr(e, "run_status", None)),
            "manifest_hash": getattr(e, "manifest_hash", None),
            "message": getattr(e, "message", None),
        },
    )


def _enum_value(value: Any) -> str | None:
    if value is None:
        return None
    return getattr(value, "value", None) or str(value)


_HANDLERS = {
    "pipeline.started": _run_started,
    "step.queued": _node_queued,
    "step.started": _node_started,
    "step.progress": _node_progress,
    "step.retried": _node_retried,
    "step.completed": _node_completed,
    "step.failed": _node_failed,
    "pipeline.completed": _run_completed,
    "pipeline.failed": _run_failed,
}


def extract_result(event: Any) -> Any | None:
    """Both terminal events carry `.result` in-process.

    A best-effort run that ends FAILED emits `PipelineFailedEvent`, and its
    result still holds every succeeded step's assets — capturing only from the
    completed event silently discards partial output.
    """
    if getattr(event, "type", None) in ("pipeline.completed", "pipeline.failed"):
        return getattr(event, "result", None)
    return None
