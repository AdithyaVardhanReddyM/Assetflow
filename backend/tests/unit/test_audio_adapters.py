"""Tests for the first-party ElevenLabs audio adapters.

Same philosophy as the image/video siblings: pin the call-building — the
adapters' job is mapping the canvas's vocabulary onto the SDK's kwargs, and a
drift fails silently until a real (billable) run. The cover-mode test drives
generate() against a fake client; nothing touches the network.
"""

from __future__ import annotations

import pytest
from genblaze_core import Modality
from genblaze_core.exceptions import ProviderError
from genblaze_core.models.asset import Asset
from genblaze_core.models.step import Step

from app.engine.genblaze_adapters import (
    ElevenLabsLoopSFXProvider,
    ElevenLabsMusicProvider,
)


def _step(model, provider, params=None, prompt="p", inputs=()):
    step = Step(model=model, provider=provider, prompt=prompt, modality=Modality.AUDIO)
    step.params = dict(params or {})
    step.inputs = list(inputs)
    return step


# --- music: prompt mode ------------------------------------------------------


def test_music_folds_lyrics_into_the_prompt():
    provider = ElevenLabsMusicProvider(api_key="test")
    step = _step(
        "music_v2", "elevenlabs-music",
        {"lyrics": "la la la", "vocals": True},
        prompt="dreamy synthwave",
    )
    kwargs = provider.build_compose_kwargs(step)
    assert kwargs["model_id"] == "music_v2"
    assert kwargs["prompt"] == "dreamy synthwave\n\nLyrics:\nla la la"
    # Auto length: the model chooses unless the param is set.
    assert "music_length_ms" not in kwargs
    assert "force_instrumental" not in kwargs


def test_music_vocals_off_suppresses_lyrics():
    provider = ElevenLabsMusicProvider(api_key="test")
    step = _step(
        "music_v2", "elevenlabs-music",
        {"lyrics": "la la la", "vocals": False},
        prompt="dreamy synthwave",
    )
    kwargs = provider.build_compose_kwargs(step)
    assert kwargs["force_instrumental"] is True
    assert "Lyrics" not in kwargs["prompt"]


def test_music_duration_becomes_length_ms_and_is_bounded():
    provider = ElevenLabsMusicProvider(api_key="test")
    step = _step("music_v2", "elevenlabs-music", {"duration_seconds": 45})
    assert provider.build_compose_kwargs(step)["music_length_ms"] == 45_000

    step = _step("music_v2", "elevenlabs-music", {"duration_seconds": 2})
    with pytest.raises(ProviderError, match="duration_seconds"):
        provider.build_compose_kwargs(step)


# --- music: cover mode -------------------------------------------------------


class _FakePlan:
    def __init__(self):
        self.positive_global_styles = ["indie folk"]


class _FakeMusic:
    def __init__(self, plan):
        self._plan = plan
        self.upload_kwargs = None
        self.compose_kwargs = None

    def upload(self, **kwargs):
        self.upload_kwargs = kwargs

        class _Resp:
            composition_plan = self._plan

        return _Resp()

    def compose(self, **kwargs):
        self.compose_kwargs = kwargs
        return iter([b"ID3fake-mp3-bytes"])


class _FakeClient:
    def __init__(self, plan):
        self.music = _FakeMusic(plan)


def test_music_cover_mode_regenerates_from_the_extracted_plan(monkeypatch, tmp_path):
    import app.engine.genblaze_adapters as adapters

    monkeypatch.setattr(adapters, "_read_asset_bytes", lambda url: b"fake-audio")

    plan = _FakePlan()
    provider = ElevenLabsMusicProvider(api_key="test", output_dir=tmp_path)
    provider._client = _FakeClient(plan)

    step = _step(
        "music_v2", "elevenlabs-music",
        prompt="make it orchestral",
        inputs=[Asset(url="https://x.test/song.mp3", media_type="audio/mpeg")],
    )
    provider.generate(step)

    music = provider._client.music
    # The plan format follows the model tier.
    assert music.upload_kwargs["extract_composition_plan"] == "music_v2"
    # Plan replaces prompt (mutually exclusive upstream); the prompt survives
    # as one more global style.
    assert music.compose_kwargs["composition_plan"] is plan
    assert "prompt" not in music.compose_kwargs
    assert plan.positive_global_styles == ["indie folk", "make it orchestral"]
    # And the output landed as a temp-backed mp3 asset.
    assert step.assets and step.assets[0].url.startswith("file://")
    assert step.assets[0].metadata["audio_type"] == "music"


# --- sound effects -----------------------------------------------------------


def test_sfx_passes_loop_model_and_influence():
    provider = ElevenLabsLoopSFXProvider(api_key="test")
    step = _step(
        "eleven_text_to_sound_v2", "elevenlabs-sfx",
        {"loop": True, "prompt_influence": 0.3},
        prompt="rain on a tin roof",
    )
    kwargs = provider.build_convert_kwargs(step)
    assert kwargs == {
        "text": "rain on a tin roof",
        "model_id": "eleven_text_to_sound_v2",
        "loop": True,
        "prompt_influence": 0.3,
    }
    # No duration_seconds key at all: absent means the model picks (auto).
    assert "duration_seconds" not in kwargs


def test_sfx_duration_is_validated_in_process():
    provider = ElevenLabsLoopSFXProvider(api_key="test")
    step = _step(
        "eleven_text_to_sound_v2", "elevenlabs-sfx", {"duration_seconds": 45}
    )
    with pytest.raises(ProviderError, match="duration_seconds"):
        provider.build_convert_kwargs(step)


# --- catalog wiring ----------------------------------------------------------


def test_music_model_declares_the_source_audio_port():
    from app.catalog.registry import load_catalog

    model = load_catalog().model("elevenlabs", "music_v2")
    assert model is not None
    assert model.role == "music"
    handoff = model.accepts_port("source_audio")
    assert handoff is not None and handoff.modality.value == "audio"
