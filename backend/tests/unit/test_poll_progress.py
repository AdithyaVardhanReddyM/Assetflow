"""poll_progress overrides — the signals a node's progress bar is built from.

Providers that report real progress (Runway's 0-1 ``task.progress``) surface
``progress_pct``; queue-based providers with no numeric progress (GMI, Luma
Agents, Decart) surface a "Waiting in queue" message while parked and nothing
once generating. Either way the base poll loop merges the dict into the next
``node.progress`` event — these tests pin the dict, not the loop.
"""

from unittest.mock import MagicMock

import pytest

from app.engine.genblaze_adapters import (
    DecartLucyVideoProvider,
    LumaAgentsProvider,
    RunwayImageProvider,
    RunwayVideoProvider,
)


# --- GMI (queue status message) ----------------------------------------------

pytest.importorskip("genblaze_gmicloud", reason="gmicloud extra not installed")

from app.engine.genblaze_adapters import _gmi_retrying_classes  # noqa: E402


@pytest.fixture(params=[0, 1], ids=["image", "video"])
def gmi_provider(request):
    return _gmi_retrying_classes()[request.param]()


def test_gmi_queued_reports_waiting(gmi_provider):
    gmi_provider._fetch_detail = MagicMock(return_value={"status": "queued"})
    assert gmi_provider.poll("req-1") is False
    assert gmi_provider.poll_progress("req-1") == {"message": "Waiting in queue"}


def test_gmi_processing_reports_nothing(gmi_provider):
    gmi_provider._fetch_detail = MagicMock(return_value={"status": "processing"})
    assert gmi_provider.poll("req-1") is False
    assert gmi_provider.poll_progress("req-1") is None


def test_gmi_terminal_caches_detail_and_clears_status(gmi_provider):
    detail = {"status": "success", "outcome": {"data": {}}}
    gmi_provider._fetch_detail = MagicMock(return_value={"status": "queued"})
    gmi_provider.poll("req-1")
    gmi_provider._fetch_detail = MagicMock(return_value=detail)
    assert gmi_provider.poll("req-1") is True
    # fetch_output reads the cached detail — the override must keep feeding it.
    assert gmi_provider._get_cached_poll_result("req-1") == detail
    assert gmi_provider.poll_progress("req-1") is None


# --- Runway (numeric progress + draft thumbnail) -------------------------------


@pytest.fixture(params=[RunwayImageProvider, RunwayVideoProvider])
def runway(request):
    provider = request.param(api_secret="test")
    provider._client = MagicMock()
    return provider


def _runway_task(**attrs):
    task = MagicMock(spec=["status", "progress", "thumbnail_url", "preview_url"])
    task.progress = None
    task.thumbnail_url = None
    task.preview_url = None
    for key, value in attrs.items():
        setattr(task, key, value)
    return task


def test_runway_progress_pct_flows_from_poll(runway):
    runway._client.tasks.retrieve.return_value = _runway_task(
        status="RUNNING", progress=0.42
    )
    assert runway.poll("t1") is False
    assert runway.poll_progress("t1") == {"progress_pct": 0.42}


def test_runway_thumbnail_rides_as_preview(runway):
    runway._client.tasks.retrieve.return_value = _runway_task(
        status="RUNNING", progress=0.5, thumbnail_url="https://cdn.runway.example/f.jpg"
    )
    runway.poll("t1")
    assert runway.poll_progress("t1") == {
        "progress_pct": 0.5,
        "preview_url": "https://cdn.runway.example/f.jpg",
    }


def test_runway_no_signals_before_first_poll(runway):
    assert runway.poll_progress("never-polled") is None


def test_runway_terminal_poll_clears_stash(runway):
    runway._client.tasks.retrieve.return_value = _runway_task(
        status="RUNNING", progress=0.9
    )
    runway.poll("t1")
    runway._client.tasks.retrieve.return_value = _runway_task(status="SUCCEEDED")
    assert runway.poll("t1") is True
    assert runway.poll_progress("t1") is None


def test_runway_out_of_range_progress_dropped(runway):
    runway._client.tasks.retrieve.return_value = _runway_task(
        status="RUNNING", progress=1.7
    )
    runway.poll("t1")
    assert runway.poll_progress("t1") is None


# --- Luma Agents / Decart (queue status message) --------------------------------


def _luma_with_state(state: str) -> LumaAgentsProvider:
    provider = LumaAgentsProvider(api_key="test")
    resp = MagicMock(status_code=200)
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"state": state}
    provider._http = MagicMock()
    provider._http.get.return_value = resp
    return provider


def test_luma_queued_reports_waiting():
    provider = _luma_with_state("queued")
    assert provider.poll("g1") is False
    assert provider.poll_progress("g1") == {"message": "Waiting in queue"}


def test_luma_dreaming_reports_nothing():
    provider = _luma_with_state("dreaming")
    assert provider.poll("g1") is False
    assert provider.poll_progress("g1") is None


def test_decart_queued_reports_waiting(monkeypatch):
    provider = DecartLucyVideoProvider(api_key="test")
    provider._client = MagicMock()
    status = MagicMock()
    status.status = "queued"

    monkeypatch.setattr(
        "genblaze_core._utils._run_async", lambda coro: status, raising=True
    )
    assert provider.poll("j1") is False
    assert provider.poll_progress("j1") == {"message": "Waiting in queue"}
