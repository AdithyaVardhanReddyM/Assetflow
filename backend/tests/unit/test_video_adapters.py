"""Tests for the first-party video adapters in `app.engine.genblaze_adapters`.

Same philosophy as test_image_adapters: pin the payload folding — the specs'
whole job is mapping the canvas's vocabulary onto each upstream API's wire
format, and a drift here fails silently until a real (billable) run.

The Runway/Luma pieces run against genblaze_core only; the GMI and Decart
cases construct real providers, which the test venv has installed. No test
touches the network.
"""

from __future__ import annotations

import json

import pytest
from genblaze_core import Modality
from genblaze_core.exceptions import ProviderError
from genblaze_core.models.asset import Asset
from genblaze_core.models.step import Step

from app.engine.genblaze_adapters import (
    LumaAgentsProvider,
    RunwayVideoProvider,
    sora_2_spec,
)


def _step(model, provider, modality, params=None, inputs=()):
    step = Step(model=model, provider=provider, prompt="p", modality=modality)
    step.params = dict(params or {})
    step.inputs = list(inputs)
    return step


def _img(url):
    return Asset(url=url, media_type="image/png")


def _vid(url):
    return Asset(url=url, media_type="video/mp4")


# --- Sora 2 (Replicate) -----------------------------------------------------


def test_sora_folds_ratio_words_and_routes_first_frame():
    spec = sora_2_spec()
    out = spec.param_transformer({"aspect_ratio": "9:16", "seconds": 8})
    assert out == {"aspect_ratio": "portrait", "seconds": 8}
    mapped = spec.input_mapping([_img("https://x.test/f.png")])
    assert mapped == {"input_reference": "https://x.test/f.png"}


# --- GMI video --------------------------------------------------------------


def test_seedance_aliases_ratio_and_routes_frames_then_references():
    from app.engine.genblaze_adapters import gmicloud_video_provider

    provider = gmicloud_video_provider()
    step = _step(
        "seedance-2-0-260128", "gmicloud-video", Modality.VIDEO,
        {"aspect_ratio": "9:16", "resolution": "1080p", "duration": 6},
        [_img("https://x.test/a.png"), _img("https://x.test/b.png"), _img("https://x.test/c.png")],
    )
    payload = provider.prepare_payload(step)
    assert payload["ratio"] == "9:16"
    assert "aspect_ratio" not in payload
    # Positional: first anchors, second ends, the rest are references.
    assert payload["first_frame"] == "https://x.test/a.png"
    assert payload["last_frame"] == "https://x.test/b.png"
    assert payload["reference_images"] == ["https://x.test/c.png"]


class _FakeResponse:
    """Just enough of `httpx.Response` for `GMICloudBase._submit_request`."""

    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = json.dumps(body)
        self.headers = {}

    def json(self):
        return self._body


class _FakeClient:
    """Replays a canned sequence of responses and counts the posts."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.posts = []

    def post(self, url, json=None):
        self.posts.append((url, json))
        return self._responses.pop(0)


_GMI_502 = {"error": "Backend error (401). Please try again."}


def test_gmi_submit_retries_a_flaky_5xx_and_succeeds(monkeypatch):
    """GMI answers a valid submit with `500 Backend error (401)` maybe half the
    time; the same payload goes through seconds later. GenBlaze never retries
    submit, so without this the canvas shows a dead node on a live workflow."""
    from app.engine import genblaze_adapters
    from app.engine.genblaze_adapters import gmicloud_video_provider

    monkeypatch.setattr(genblaze_adapters.time, "sleep", lambda _: None)
    provider = gmicloud_video_provider()
    client = _FakeClient(
        [
            _FakeResponse(500, _GMI_502),
            _FakeResponse(500, _GMI_502),
            _FakeResponse(200, {"request_id": "req-live"}),
        ]
    )
    provider._http_client = client

    result = provider._submit_request("seedance-2-0-fast-260128", {"prompt": "p"})

    assert result.prediction_id == "req-live"
    assert len(client.posts) == 3


def test_gmi_submit_gives_up_after_the_attempt_budget(monkeypatch):
    """And the ladder it climbs is minutes wide — seedance's route has stayed
    down for a quarter of an hour at a time, so a few seconds is not a retry."""
    from app.engine import genblaze_adapters
    from app.engine.genblaze_adapters import gmicloud_video_provider

    slept: list[float] = []
    monkeypatch.setattr(genblaze_adapters.time, "sleep", slept.append)
    provider = gmicloud_video_provider()
    attempts = genblaze_adapters._GMI_SUBMIT_ATTEMPTS
    client = _FakeClient([_FakeResponse(500, _GMI_502)] * attempts)
    provider._http_client = client

    # The exhausted error names GMI's upstream, not the node's inputs: someone
    # reading "server_error" under two wired images re-exports the images.
    with pytest.raises(ProviderError, match="upstream answered 401"):
        provider._submit_request("seedance-2-0-fast-260128", {"prompt": "p"})
    assert len(client.posts) == attempts
    assert slept == list(genblaze_adapters._GMI_SUBMIT_BACKOFF_SEC)
    assert sum(slept) >= 60


def test_gmi_fetch_output_surfaces_the_outcome_error(monkeypatch):
    """GMI parks the real failure at `outcome.error`; the stock connector reads
    top-level `error` (never set), so a ByteDance copyright block reached the
    canvas as `Video generation failed (code=unknown)` — dropping the one
    message telling the user to reword the prompt."""
    from app.engine.genblaze_adapters import gmicloud_video_provider

    provider = gmicloud_video_provider()
    detail = {
        "status": "failed",
        "outcome": {
            "error": "The request failed because the output video may be "
            "related to copyright restrictions.",
            "error_code": "OutputVideoSensitiveContentDetected.PolicyViolation",
        },
    }
    monkeypatch.setattr(provider, "_fetch_detail", lambda _id: detail)

    step = _step("seedance-2-0-260128", "gmicloud-video", Modality.VIDEO)
    with pytest.raises(ProviderError, match="copyright") as excinfo:
        provider.fetch_output("req-1", step)
    # content_policy, so nothing upstream retries a deterministic refusal.
    assert excinfo.value.error_code.value == "content_policy"


def test_gmi_submit_does_not_retry_a_rejected_payload(monkeypatch):
    """A 400 is our mistake, not GMI's weather — asking again just burns time."""
    from app.engine import genblaze_adapters
    from app.engine.genblaze_adapters import gmicloud_image_provider

    monkeypatch.setattr(genblaze_adapters.time, "sleep", lambda _: None)
    provider = gmicloud_image_provider()
    client = _FakeClient(
        [_FakeResponse(400, {"error": "invalid payload parameters: prompt"})]
    )
    provider._http_client = client

    with pytest.raises(ProviderError, match="invalid payload"):
        provider._submit_request("seedream-5.0-lite", {})
    assert len(client.posts) == 1


def test_kling_v3_stringifies_duration_and_requires_a_start_image():
    from app.engine.genblaze_adapters import gmicloud_video_provider

    provider = gmicloud_video_provider()
    wired = _step(
        "kling-v3-image-to-video", "gmicloud-video", Modality.VIDEO,
        {"duration": 5, "mode": "pro"},
        [_img("https://x.test/a.png"), _img("https://x.test/b.png")],
    )
    payload = provider.prepare_payload(wired)
    assert payload["duration"] == "5"
    assert payload["image"] == "https://x.test/a.png"
    assert payload["image_tail"] == "https://x.test/b.png"

    bare = _step("kling-v3-image-to-video", "gmicloud-video", Modality.VIDEO, {"duration": 5})
    with pytest.raises(ProviderError, match="image"):
        provider.prepare_payload(bare)


# --- Runway video -----------------------------------------------------------


def test_gen45_takes_the_wide_ratio_surface_with_an_image():
    provider = RunwayVideoProvider(api_secret="test")
    step = _step(
        "gen4.5", "runway-video", Modality.VIDEO,
        {"aspect_ratio": "1104:832", "duration": 5},
        [_img("https://x.test/a.png")],
    )
    payload = provider.prepare_payload(step)
    assert payload["ratio"] == "1104:832"
    assert payload["prompt_image"] == "https://x.test/a.png"


def test_gen45_text_to_video_refuses_image_only_ratios_in_process():
    # No image wired -> the text_to_video endpoint, which only speaks the two
    # HD ratios. Must fail before any client is constructed.
    provider = RunwayVideoProvider(api_secret="test")
    step = _step(
        "gen4.5", "runway-video", Modality.VIDEO,
        {"aspect_ratio": "1104:832", "duration": 5},
    )
    with pytest.raises(ProviderError, match="start image"):
        provider.submit(step)


def test_gen4_turbo_refuses_text_to_video_with_a_wiring_hint():
    provider = RunwayVideoProvider(api_secret="test")
    step = _step("gen4_turbo", "runway-video", Modality.VIDEO, {"aspect_ratio": "1280:720"})
    with pytest.raises(ProviderError, match="start frame"):
        provider.build_request(step)


def test_gemini_omni_flash_video_input_flips_to_editing_mode():
    provider = RunwayVideoProvider(api_secret="test")
    step = _step(
        "gemini_omni_flash", "runway-video", Modality.VIDEO,
        {"aspect_ratio": "1280:720", "duration": 5},
        [_vid("https://x.test/clip.mp4"), _img("https://x.test/style.png")],
    )
    endpoint, request = provider.build_request(step)
    assert endpoint == "video_to_video"
    assert request["video_uri"] == "https://x.test/clip.mp4"
    assert request["references"] == [{"uri": "https://x.test/style.png"}]
    # Ratio/duration do not exist on the editing endpoint.
    assert "ratio" not in request and "duration" not in request


def test_gemini_omni_flash_rejects_gen45_only_ratios():
    provider = RunwayVideoProvider(api_secret="test")
    step = _step(
        "gemini_omni_flash", "runway-video", Modality.VIDEO,
        {"aspect_ratio": "1584:672"},
        [_img("https://x.test/a.png")],
    )
    with pytest.raises(ProviderError):
        provider.submit(step)


# --- Luma Agents ------------------------------------------------------------


def test_ray_body_nests_video_options_and_frame_anchors():
    provider = LumaAgentsProvider(api_key="test")
    step = _step(
        "ray-3.2", "luma-agents", Modality.VIDEO,
        {"aspect_ratio": "16:9", "resolution": "1080p", "duration": "10s", "loop": False},
        [_img("https://x.test/s.png"), _img("https://x.test/e.png")],
    )
    body = provider.build_request_body(step)
    assert body["type"] == "video"
    assert body["video"] == {
        "resolution": "1080p",
        "duration": "10s",
        "loop": False,
        "start_frame": {"url": "https://x.test/s.png"},
        "end_frame": {"url": "https://x.test/e.png"},
    }


def test_uni_body_wraps_references_as_image_ref_objects():
    provider = LumaAgentsProvider(api_key="test")
    step = _step(
        "uni-1", "luma-agents", Modality.IMAGE,
        {"aspect_ratio": "3:2", "output_format": "png"},
        [_img("https://x.test/r1.png"), _img("https://x.test/r2.png")],
    )
    body = provider.build_request_body(step)
    assert body["type"] == "image"
    assert body["image_ref"] == [
        {"url": "https://x.test/r1.png"},
        {"url": "https://x.test/r2.png"},
    ]
    assert "video" not in body


def test_luma_fetch_output_reads_the_output_list_shape(monkeypatch):
    """Agents API 2026-04-01 returns `output: [{"type","url"}]`, not the
    ray-era `assets: {key: url}`. Reading only `assets` lost a completed,
    billed uni-1 image to "no asset URL found" — both shapes must parse."""
    provider = LumaAgentsProvider(api_key="test")
    data = {
        "state": "completed",
        "output": [
            {"type": "image", "url": "https://cdn.luma.test/gen/J8Fk4DI4.jpg", "layer": None}
        ],
    }
    monkeypatch.setattr(provider, "_get_cached_poll_result", lambda _id: data)

    step = _step("uni-1", "luma-agents", Modality.IMAGE)
    out = provider.fetch_output("gen-1", step)
    assert [a.url for a in out.assets] == ["https://cdn.luma.test/gen/J8Fk4DI4.jpg"]
    assert out.assets[0].media_type == "image/jpeg"


def test_luma_fetch_output_still_reads_the_assets_dict_shape(monkeypatch):
    provider = LumaAgentsProvider(api_key="test")
    data = {"state": "completed", "assets": {"video": "https://cdn.luma.test/clip.mp4"}}
    monkeypatch.setattr(provider, "_get_cached_poll_result", lambda _id: data)

    step = _step("ray-3.2", "luma-agents", Modality.VIDEO)
    out = provider.fetch_output("gen-2", step)
    assert [a.url for a in out.assets] == ["https://cdn.luma.test/clip.mp4"]
    assert out.assets[0].media_type == "video/mp4"


# --- lip sync ---------------------------------------------------------------


def test_pixverse_lipsync_routes_video_and_audio():
    from app.engine.genblaze_adapters import replicate_provider

    provider = replicate_provider()
    step = _step(
        "pixverse/lipsync", "replicate", Modality.VIDEO,
        inputs=[_vid("https://x.test/talk.mp4"),
                Asset(url="https://x.test/voice.mp3", media_type="audio/mpeg")],
    )
    payload = provider.prepare_payload(step)
    assert payload["video"] == "https://x.test/talk.mp4"
    assert payload["audio"] == "https://x.test/voice.mp3"


def test_pixverse_lipsync_refuses_missing_wiring_in_process():
    from app.engine.genblaze_adapters import replicate_provider

    provider = replicate_provider()
    half = _step(
        "pixverse/lipsync", "replicate", Modality.VIDEO,
        inputs=[_vid("https://x.test/talk.mp4")],
    )
    with pytest.raises(ProviderError, match="audio"):
        provider.prepare_payload(half)
    other = _step(
        "pixverse/lipsync", "replicate", Modality.VIDEO,
        inputs=[Asset(url="https://x.test/voice.mp3", media_type="audio/mpeg")],
    )
    with pytest.raises(ProviderError, match="video"):
        provider.prepare_payload(other)


def test_kling_lipsync_refuses_missing_wiring_in_process():
    from app.engine.genblaze_adapters import gmi_kling_lipsync_provider

    provider = gmi_kling_lipsync_provider()
    step = _step("kling-lip-sync", "gmicloud-video", Modality.VIDEO)
    step.inputs = [_vid("https://x.test/talk.mp4")]
    with pytest.raises(ProviderError, match="speech"):
        provider.submit(step)
    step.inputs = [Asset(url="https://x.test/voice.mp3", media_type="audio/mpeg")]
    with pytest.raises(ProviderError, match="source video"):
        provider.submit(step)


# --- Decart Lucy edit -------------------------------------------------------


def test_lucy_edit_provider_requires_a_source_video():
    from app.engine.genblaze_adapters import DecartLucyVideoProvider

    provider = DecartLucyVideoProvider()
    step = _step(
        "lucy-2.5", "decart", Modality.VIDEO,
        {"enhance_prompt": True},
        [_img("https://x.test/style.png")],  # image but no video
    )
    with pytest.raises(ProviderError, match="source video"):
        provider.submit(step)


def test_lucy_edit_takes_each_slot_from_inputs_or_params(monkeypatch):
    """A chained video rides step.inputs while an uploaded reference arrives
    as a presigned-URL param (the catalog's `via: param` handoff) — the mix
    GenBlaze cannot express through external_inputs alone."""
    from types import SimpleNamespace

    from app.engine import genblaze_adapters
    from app.engine.genblaze_adapters import DecartLucyVideoProvider

    provider = DecartLucyVideoProvider(api_key="test")
    captured = {}

    class _FakeQueue:
        def submit(self, params):
            captured.update(params)
            return SimpleNamespace(job_id="job-1")

    monkeypatch.setattr(provider, "_get_client", lambda: SimpleNamespace(queue=_FakeQueue()))
    monkeypatch.setattr(genblaze_adapters, "_decart_call", lambda value: value)

    step = _step(
        "lucy-2.5", "decart", Modality.VIDEO,
        {"reference_image": "https://b2.test/cap.png?sig=abc"},
        [_vid("https://b2.test/clip.mp4")],
    )
    assert provider.submit(step) == "job-1"
    assert captured["data"] == "https://b2.test/clip.mp4"
    assert captured["reference_image"] == "https://b2.test/cap.png?sig=abc"


def test_decart_calls_share_one_living_event_loop():
    """The decart SDK caches an aiohttp session welded to the loop it was born
    on. `_run_async` (one asyncio.run per call) killed that loop between
    submit and poll — seen live as `poll failed: Event loop is closed`. Every
    call must land on the same, still-running loop."""
    import asyncio

    from app.engine.genblaze_adapters import _decart_call

    loops = []

    async def probe():
        loops.append(asyncio.get_running_loop())
        return "ok"

    assert _decart_call(probe()) == "ok"
    assert _decart_call(probe()) == "ok"
    assert loops[0] is loops[1]
    assert not loops[0].is_closed()


# --- catalog wiring ---------------------------------------------------------


def test_video_models_point_at_existing_adapter_attrs():
    import app.engine.genblaze_adapters as adapters
    from app.catalog.registry import load_catalog

    for model in load_catalog().models:
        module, _, attr = model.adapter.partition(":")
        if module == "app.engine.genblaze_adapters":
            assert hasattr(adapters, attr), f"{model.id}: no such adapter attr {attr!r}"
