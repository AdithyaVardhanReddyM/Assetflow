"""Tests for the first-party image adapters in `app.engine.genblaze_adapters`.

Everything here runs against genblaze_core only — the optional provider SDKs
(replicate, runwayml, decart, genblaze_gmicloud) are imported lazily by the
factories, and these tests deliberately never call anything that would need
them. What is worth pinning:

- the Seedream size table maps every advertised (ratio, resolution) pair to a
  "WxH" inside GMI's documented pixel budget;
- reference images route to each model's *array* parameter, since silently
  dropping a wired reference is the failure mode the module exists to prevent;
- the Runway image family validates ratios in-process and refuses a turbo
  submit with no references before any network is touched.
"""

from __future__ import annotations

import pytest
from genblaze_core import Modality
from genblaze_core.exceptions import ProviderError
from genblaze_core.models.asset import Asset
from genblaze_core.models.step import Step

from app.engine.genblaze_adapters import (
    _SEEDREAM_SIZES,
    RUNWAY_IMAGE_RATIOS,
    DecartLucyImageProvider,
    RunwayImageProvider,
    replicate_image_specs,
    seedream5_specs,
    seedream_size_transform,
)


def _image_step(model: str, provider: str, params: dict | None = None) -> Step:
    step = Step(model=model, provider=provider, prompt="a test prompt", modality=Modality.IMAGE)
    step.params = dict(params or {})
    return step


def _img(url: str) -> Asset:
    return Asset(url=url, media_type="image/png")


# --- Seedream size folding --------------------------------------------------


def test_seedream_size_table_stays_inside_gmi_pixel_budget():
    # GMI's documented constraints for explicit "WxH": total pixels within
    # [3,686,400, 10,404,496] and W/H within [1/16, 16].
    for (ratio, resolution), size in _SEEDREAM_SIZES.items():
        w, h = (int(v) for v in size.split("x"))
        assert 3_686_400 <= w * h <= 10_404_496, f"{ratio}@{resolution} -> {size}"
        assert 1 / 16 <= w / h <= 16

        # The pair must actually mean what it says: the pixel shape may deviate
        # from the nominal ratio only by rounding.
        rw, rh = (int(v) for v in ratio.split(":"))
        assert abs(w / h - rw / rh) < 0.02, f"{ratio}@{resolution} -> {size}"


def test_seedream_transform_folds_pair_into_size():
    out = seedream_size_transform(
        {"aspect_ratio": "16:9", "resolution": "3K", "output_format": "png"}
    )
    assert out == {"size": "3840x2160", "output_format": "png"}


def test_seedream_transform_lets_an_explicit_size_win():
    out = seedream_size_transform({"aspect_ratio": "16:9", "size": "2560x1440"})
    assert out == {"size": "2560x1440"}


def test_seedream_transform_rejects_unknown_pair():
    with pytest.raises(ProviderError):
        seedream_size_transform({"aspect_ratio": "16:9", "resolution": "4K"})


def test_seedream_spec_routes_all_references_as_array():
    spec = next(s for s in seedream5_specs() if s.model_id == "seedream-5.0-pro")
    mapped = spec.input_mapping([_img("https://x.test/a.png"), _img("https://x.test/b.png")])
    assert mapped == {"image": ["https://x.test/a.png", "https://x.test/b.png"]}


# --- Replicate array routing ------------------------------------------------


@pytest.mark.parametrize(
    ("slug", "slot"),
    [
        ("google/nano-banana-pro", "image_input"),
        ("google/nano-banana-2", "image_input"),
        ("openai/gpt-image-1.5", "input_images"),
        ("openai/gpt-image-2", "input_images"),
    ],
)
def test_replicate_specs_use_each_models_array_slot(slug, slot):
    spec = next(s for s in replicate_image_specs() if s.model_id == slug)
    mapped = spec.input_mapping([_img("https://x.test/a.png"), _img("https://x.test/b.png")])
    assert mapped == {slot: ["https://x.test/a.png", "https://x.test/b.png"]}


def test_gpt_image_2_folds_resolution_into_pixel_sizes():
    from app.engine.genblaze_adapters import gpt_image_2_size_transform

    out = gpt_image_2_size_transform(
        {"aspect_ratio": "16:9", "resolution": "4K", "quality": "high"}
    )
    assert out == {"aspect_ratio": "3840x2160", "quality": "high"}

    # A pair with no pixel size of its own keeps the plain ratio word...
    out = gpt_image_2_size_transform({"aspect_ratio": "16:9", "resolution": "1K"})
    assert out == {"aspect_ratio": "16:9"}

    # ...but `resolution` never leaks upstream — Replicate 422s unknown keys.
    out = gpt_image_2_size_transform({"resolution": "2K"})
    assert "resolution" not in out


def test_gpt_image_2_size_table_values_are_upstream_enum_members():
    """Every folded size must be a value GPT Image 2's schema actually admits."""
    from app.engine.genblaze_adapters import _GPT_IMAGE_2_SIZES

    upstream = {
        "1024x1024", "1536x1024", "1024x1536", "1536x1152", "1152x1536",
        "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840",
    }
    assert set(_GPT_IMAGE_2_SIZES.values()) <= upstream


# --- Runway image -----------------------------------------------------------


def test_runway_payload_aliases_ratio_and_routes_references():
    provider = RunwayImageProvider()
    step = _image_step("gen4_image", "runway-image", {"aspect_ratio": "1080:1920"})
    step.inputs = [_img("https://x.test/a.png"), _img("https://x.test/b.png")]
    payload = provider.prepare_payload(step)
    assert payload["ratio"] == "1080:1920"
    assert payload["reference_images"] == [
        {"uri": "https://x.test/a.png"},
        {"uri": "https://x.test/b.png"},
    ]


def test_runway_caps_references_at_three():
    provider = RunwayImageProvider()
    step = _image_step("gen4_image_turbo", "runway-image", {"aspect_ratio": "1024:1024"})
    step.inputs = [_img(f"https://x.test/{i}.png") for i in range(5)]
    payload = provider.prepare_payload(step)
    assert len(payload["reference_images"]) == 3


def test_runway_rejects_a_word_ratio_in_process():
    provider = RunwayImageProvider()
    step = _image_step("gen4_image", "runway-image", {"aspect_ratio": "16:9"})
    with pytest.raises(ProviderError):
        provider.prepare_payload(step)


def test_runway_turbo_submit_refuses_missing_references():
    # submit() must fail with a wiring hint before touching the SDK — the
    # provider has no client and no key here, so reaching the network at all
    # would blow up differently.
    provider = RunwayImageProvider(api_secret="test-secret")
    step = _image_step("gen4_image_turbo", "runway-image", {"aspect_ratio": "1920:1080"})
    with pytest.raises(ProviderError, match="reference"):
        provider.submit(step)


def test_runway_ratio_enum_matches_catalog_options():
    """Every ratio the catalog offers must be one the adapter accepts."""
    from app.catalog.registry import load_catalog

    catalog = load_catalog()
    for model_id in ("gen4_image", "gen4_image_turbo"):
        model = catalog.model("runway", model_id)
        assert model is not None, f"{model_id} missing from providers.yaml"
        spec = model.param("aspect_ratio")
        assert spec is not None
        values = {o.value for o in spec.options}
        assert values == RUNWAY_IMAGE_RATIOS


# --- Decart Lucy ------------------------------------------------------------


def test_lucy_registry_validates_resolution():
    provider = DecartLucyImageProvider()
    ok = _image_step("lucy-image-2", "decart-lucy-image", {"resolution": "720p"})
    assert provider.prepare_payload(ok)["resolution"] == "720p"

    bad = _image_step("lucy-image-2", "decart-lucy-image", {"resolution": "1080p"})
    with pytest.raises(ProviderError):
        provider.prepare_payload(bad)


# --- catalog wiring ---------------------------------------------------------


def test_new_image_models_point_at_existing_adapter_attrs():
    """Each app.engine.genblaze_adapters reference must resolve to a real
    attribute — a typo here would only surface when a run is submitted."""
    import app.engine.genblaze_adapters as adapters
    from app.catalog.registry import load_catalog

    for model in load_catalog().models:
        module, _, attr = model.adapter.partition(":")
        if module == "app.engine.genblaze_adapters":
            assert hasattr(adapters, attr), f"{model.id}: no such adapter attr {attr!r}"
