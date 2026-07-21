"""Catalog tests.

The load-bearing guarantee here is that serving the catalog never imports a
provider package. If it did, a missing extra or a key-hungry adapter constructor
would take down the palette — and with it the canvas — instead of degrading to a
greyed-out entry.
"""

from __future__ import annotations

import sys

import pytest

from app.catalog.models import ProviderStatus
from app.catalog.registry import load_catalog, resolve_status


@pytest.fixture
def catalog():
    return load_catalog()


def test_mock_provider_is_always_ready(catalog):
    mock = catalog.provider("mock")
    assert mock is not None
    assert mock.status is ProviderStatus.READY
    assert {m.modality.value for m in mock.models} == {"video", "image", "audio"}


def test_every_model_has_a_wellformed_adapter_reference(catalog):
    for model in catalog.models:
        module, sep, attr = model.adapter.partition(":")
        assert sep and module and attr, f"{model.id} has a malformed adapter: {model.adapter!r}"
        # Real providers come from genblaze_*; the mock slot is our own
        # sample-backed shim (see app/engine/mock_providers.py).
        assert module.startswith(("genblaze", "app.engine.mock_providers")), (
            f"{model.id} adapter is not a recognized module: {module}"
        )


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


def test_uninstalled_provider_reports_actionable_reason(catalog):
    google = catalog.provider("google")
    assert google.status is not ProviderStatus.READY
    reason = google.unavailable_reason()
    # Must tell the user what to actually do about it.
    assert "genblaze[google]" in reason or "GEMINI_API_KEY" in reason


def test_missing_key_is_distinct_from_not_installed(monkeypatch, catalog):
    google = catalog.provider("google")
    assert resolve_status(google) is ProviderStatus.NOT_INSTALLED

    # Pretend the package is installed but the key is absent.
    import importlib.util

    monkeypatch.setattr(
        importlib.util, "find_spec", lambda name: object() if "genblaze" in name else None
    )
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert resolve_status(google) is ProviderStatus.MISSING_KEY

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    assert resolve_status(google) is ProviderStatus.READY


def test_node_types_declare_ports(catalog):
    kinds = {n.kind for n in catalog.node_types}
    assert kinds == {
        "input.text", "input.upload", "generate", "transform.composite", "output"
    }

    composite = catalog.node_type("transform.composite")
    assert {p.id for p in composite.inputs} == {"video", "audio"}
    assert all(p.required for p in composite.inputs)

    generate = catalog.node_type("generate")
    init_image = next(p for p in generate.inputs if p.id == "init_image")
    # Only exposed when the selected model declares it in `accepts`.
    assert init_image.model_gated


def test_image_to_video_models_accept_an_init_image(catalog):
    model = catalog.model("gmicloud", "Kling-Image2Video-V2.1-Master")
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
