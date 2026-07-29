"""B2 archival must never run on the worker's event loop.

The incident: GenBlaze's `_finalize` calls `sink.write_run()` synchronously
inside the pipeline, and with lazy transfer that is minutes of download/upload
I/O — executed on the loop that also serves the API, heartbeats, and event
persistence. The loop froze, the lease expired mid-upload, the tail of the
event stream was lost, and a second worker re-ran (and re-paid for) the whole
pipeline while the canvas sat on "generating" forever.

The runner therefore streams with no sink and flushes the transfer afterwards
in a worker thread, treating an archival failure as a downgrade (provider
URLs), never as a run failure.
"""

from __future__ import annotations

import threading
import uuid

from app.config import get_settings
from app.graph.plan import ExecutionPlan, PlannedStep
from app.workers.runner import _flush_sink, _stream_pipeline


class _Result:
    def __init__(self) -> None:
        self.run = object()
        self.manifest = object()


class _TerminalEvent:
    type = "pipeline.completed"

    def __init__(self, result: _Result) -> None:
        self.result = result


class _FakePipeline:
    def __init__(self, result: _Result) -> None:
        self._result = result
        self.astream_kwargs: dict | None = None

    async def astream(self, **kwargs):
        self.astream_kwargs = kwargs
        yield _TerminalEvent(self._result)


class _FakeSink:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.wrote: tuple | None = None
        self.write_thread: threading.Thread | None = None
        self.closed = False

    def write_run(self, run, manifest) -> None:
        self.write_thread = threading.current_thread()
        if self.fail:
            raise RuntimeError("transfer exploded")
        self.wrote = (run, manifest)

    def close(self) -> None:
        self.closed = True


def _plan() -> ExecutionPlan:
    return ExecutionPlan(
        name="p",
        steps=[
            PlannedStep(
                node_id="n1",
                index=0,
                provider_key="mock",
                model="mock-video-v1",
                modality="video",
            )
        ],
    )


async def _run(pipeline: _FakePipeline, sink: _FakeSink):
    # session/writer are never touched: the terminal event is filtered out of
    # the persistence path, so the buffer only ever sees the shutdown sentinel.
    return await _stream_pipeline(
        None, uuid.uuid4(), pipeline, sink, _plan(), None, get_settings()
    )


async def test_sink_stays_out_of_the_pipeline_and_flushes_in_a_thread():
    result = _Result()
    pipeline = _FakePipeline(result)
    sink = _FakeSink()

    captured = await _run(pipeline, sink)

    assert captured is result
    assert "sink" not in pipeline.astream_kwargs
    assert sink.wrote == (result.run, result.manifest)
    assert sink.write_thread is not threading.main_thread()
    assert sink.closed


async def test_transfer_failure_downgrades_instead_of_failing_the_run():
    result = _Result()
    sink = _FakeSink(fail=True)

    captured = await _run(_FakePipeline(result), sink)

    # The captured result survives — the caller still persists step statuses
    # and assets (on provider URLs) — and the sink is still closed.
    assert captured is result
    assert sink.closed


async def test_flush_is_a_noop_without_sink_or_result():
    await _flush_sink(None, _Result(), uuid.uuid4())
    sink = _FakeSink()
    await _flush_sink(sink, None, uuid.uuid4())
    assert sink.wrote is None
