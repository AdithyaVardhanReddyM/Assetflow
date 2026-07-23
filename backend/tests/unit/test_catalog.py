"""Catalog tests.

The load-bearing guarantee here is that serving the catalog never imports a
provider package. If it did, a missing extra or a key-hungry adapter constructor
would take down the palette — and with it the canvas — instead of degrading to a
greyed-out entry.
"""

from __future__ import annotations

import sys

import pytest

from app.catalog.models import ModelDescriptor, ProviderStatus
from app.catalog.registry import load_catalog, resolve_status


@pytest.fixture
def catalog():
    return load_catalog()


def test_mock_provider_is_always_ready(catalog):
    mock = catalog.provider("mock")
    assert mock is not None
    assert mock.status is ProviderStatus.READY
    assert {m.modality.value for m in mock.models} == {"video", "image", "audio", "text"}


def test_every_model_has_a_wellformed_adapter_reference(catalog):
    for model in catalog.models:
        module, sep, attr = model.adapter.partition(":")
        assert sep and module and attr, f"{model.id} has a malformed adapter: {model.adapter!r}"
        # Real providers come from genblaze_* or from our own adapter shims:
        # mock_providers (the sample-backed mock), genblaze_adapters (the
        # first-party providers/factories for models the stock connectors
        # cannot express — see that module's docstring), and
        # openrouter_provider (the in-app LLM adapter).
        assert module.startswith(
            (
                "genblaze",
                "app.engine.mock_providers",
                "app.engine.genblaze_adapters",
                "app.engine.openrouter_provider",
            )
        ), f"{model.id} adapter is not a recognized module: {module}"


def test_mock_adapters_resolve_and_emit_transferable_assets():
    """The mocks must return assets a sink can actually fetch, or every B2 run
    dies with `SinkError: asset transfers failed`."""
    import tempfile

    from app.engine.mock_providers import _asset, audio_provider, image_provider, video_provider

    for factory in (video_provider, image_provider, audio_provider):
        assert factory() is not None

    for modality, media_type in (
        ("video", "video/mp4"), ("image", "image/png"), ("audio", "audio/mpeg"),
    ):
        asset = _asset(modality)
        assert asset.media_type == media_type
        # file:// is a source form ObjectStorageSink understands; the stock
        # GenBlaze mocks return https://mock.test URLs, which are unfetchable
        # and make every B2 run die with SinkError.
        assert asset.url.startswith("file://"), asset.url
        # And it must sit under temp — the sink rejects local sources outside
        # temp or a provider's output_dir.
        assert tempfile.gettempdir() in asset.url, asset.url
        assert asset.size_bytes and asset.size_bytes > 0


def test_model_ids_are_unique_within_a_provider(catalog):
    for provider in catalog.providers:
        ids = [m.id for m in provider.models]
        assert len(ids) == len(set(ids)), f"{provider.key} has duplicate model ids"


def test_denormalized_provider_fields_are_populated(catalog):
    for model in catalog.models:
        assert model.provider_key
        assert model.provider_label
        assert model.status is catalog.provider(model.provider_key).status


def test_serving_the_catalog_imports_no_provider_package():
    """The whole reason availability uses find_spec instead of import."""
    before = {m for m in sys.modules if m.startswith("genblaze_") and m != "genblaze_core"}
    catalog = load_catalog()
    [
        (m.id, m.status, p.unavailable_reason())
        for p in catalog.providers
        for m in p.models
    ]
    after = {m for m in sys.modules if m.startswith("genblaze_") and m != "genblaze_core"}
    assert after == before, f"catalog load imported provider packages: {after - before}"


def test_uninstalled_provider_reports_actionable_reason(monkeypatch, catalog):
    # Luma is the specimen (google was, until that provider was dropped); the
    # state is forced rather than read from the venv so a dev's shell env
    # cannot decide the suite's fate.
    luma = catalog.provider("luma")
    import importlib.util

    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    luma.status = resolve_status(luma)
    # Must tell the user what to actually do about it.
    assert "genblaze[luma]" in luma.unavailable_reason()

    monkeypatch.setattr(
        importlib.util, "find_spec", lambda name: object() if "genblaze" in name else None
    )
    monkeypatch.delenv("LUMAAI_API_KEY", raising=False)
    luma.status = resolve_status(luma)
    assert "LUMAAI_API_KEY" in luma.unavailable_reason()


def test_missing_key_is_distinct_from_not_installed(monkeypatch, catalog):
    luma = catalog.provider("luma")
    import importlib.util

    # Pretend the package is absent — whether the optional provider extras
    # happen to be installed in this venv must not decide the suite's fate.
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    assert resolve_status(luma) is ProviderStatus.NOT_INSTALLED

    # Pretend the package is installed but the key is absent.
    monkeypatch.setattr(
        importlib.util, "find_spec", lambda name: object() if "genblaze" in name else None
    )
    monkeypatch.delenv("LUMAAI_API_KEY", raising=False)
    assert resolve_status(luma) is ProviderStatus.MISSING_KEY

    monkeypatch.setenv("LUMAAI_API_KEY", "test-key")
    assert resolve_status(luma) is ProviderStatus.READY


def test_node_types_declare_ports(catalog):
    kinds = {n.kind for n in catalog.node_types}
    assert kinds == {
        "input.text", "input.upload", "generate", "transform.composite", "output"
    }

    composite = catalog.node_type("transform.composite")
    assert {p.id for p in composite.inputs} == {"video", "audio"}
    video = next(p for p in composite.inputs if p.id == "video")
    audio = next(p for p in composite.inputs if p.id == "audio")
    assert video.required
    # `audio` is a template the node expands into one handle per lane, so it is
    # never a handle itself and no single lane is individually required — the
    # compiler insists on one being *connected* instead.
    assert audio.per_track
    assert not audio.required

    generate = catalog.node_type("generate")
    init_image = next(p for p in generate.inputs if p.id == "init_image")
    # Only exposed when the selected model declares it in `accepts`.
    assert init_image.model_gated


def test_image_to_video_models_accept_an_init_image(catalog):
    model = catalog.model("gmicloud", "kling-v3-image-to-video")
    assert model is not None
    handoff = model.accepts_port("init_image")
    assert handoff is not None
    assert handoff.modality.value == "image"


def test_params_have_ui_metadata(catalog):
    """The canvas renders panels generically, so every param needs enough
    metadata to draw a field without model-specific code."""
    for model in catalog.models:
        for param in model.params:
            assert param.display_label()
            if param.type == "enum":
                assert param.options, f"{model.id}.{param.name} is an enum with no options"
                values = [o.value for o in param.options]
                if param.default is not None:
                    assert param.default in values, (
                        f"{model.id}.{param.name} default is not among its options"
                    )


def test_lipsync_model_is_port_driven(catalog):
    """Lipsync is steered by its inputs, not by text or an aspect ratio."""
    model = catalog.model("mock", "mock-lipsync-v1")
    assert model is not None
    assert {a.port for a in model.accepts} == {"avatar", "speech"}
    assert model.accepts_port("avatar").modality.value == "image"
    assert model.accepts_port("speech").modality.value == "audio"
    # No ratio to steer, so the canvas falls back to what the model emits.
    assert model.param("aspect_ratio") is None
    assert model.output_aspect_ratio == "1:1"
    # Nothing to describe — the compiler must not demand a prompt.
    assert model.requires_prompt is False


def test_speech_port_accepts_a_voice_or_music(catalog):
    """The `speech` input is narrower than its modality: sound effects are
    audio too and drive no mouth, but a voice or a song both do."""
    speech = next(p for p in catalog.node_type("generate").inputs if p.id == "speech")
    assert speech.roles == ["speech", "music"]
    # Same shape for the track a music model covers: narration or a sound
    # effect is not source music.
    source_audio = next(
        p for p in catalog.node_type("generate").inputs if p.id == "source_audio"
    )
    assert source_audio.roles == ["music"]
    # Every other port takes anything of its modality, or the gate would be
    # silently blocking wires nobody meant to block.
    others = [
        p
        for p in catalog.node_type("generate").inputs
        if p.id not in ("speech", "source_audio")
    ]
    assert all(not p.roles for p in others)


def test_every_mock_model_is_hidden(catalog):
    """The mocks are the compiler suite's substrate, not product surface —
    none of them may reach a picker."""
    mock = catalog.provider("mock")
    assert mock.models and all(m.hidden for m in mock.models)


def test_a_keyless_source_exists_for_every_role_gated_port(catalog):
    """A port that only a `speech` node can fill is unreachable on a canvas with
    no credentials unless the always-available provider offers one."""
    gated = {r for p in catalog.node_type("generate").inputs for r in p.roles}
    keyless = {
        m.role
        for p in catalog.providers
        if p.always_available
        for m in p.models
    }
    assert gated <= keyless, f"no keyless model for {sorted(gated - keyless)}"


def test_llm_model_is_text_to_text(catalog):
    """The prompt writer takes words and returns words — no media ports, and
    nothing to chain into it but a prompt."""
    model = catalog.model("mock", "mock-llm-v1")
    assert model is not None
    assert model.modality.value == "text"
    assert model.role == "llm"
    assert model.accepts == []
    # It rewrites what you give it, so it does need a prompt.
    assert model.requires_prompt is True
    assert model.output_media_type == "text/plain"


def test_model_payload_carries_every_descriptor_field(catalog):
    """`_model_payload` is hand-written, so a field added to ModelDescriptor
    silently stops reaching the canvas unless it is added there too. Lipsync
    shipped broken exactly this way once."""
    from app.routers.catalog import _model_payload

    internal = {
        "provider_key",  # sent as "provider"
        "provider_label",  # sent verbatim under its own key
        "adapter",  # deliberately server-side: an import path is not the canvas's business
        "hidden",  # server-side by definition: a hidden model is never serialized at all
    }
    payload = _model_payload(catalog.model("mock", "mock-lipsync-v1"))
    missing = set(ModelDescriptor.model_fields) - internal - set(payload)
    assert not missing, f"_model_payload drops {sorted(missing)}"
