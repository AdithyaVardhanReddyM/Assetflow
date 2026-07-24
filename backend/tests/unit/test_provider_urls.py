"""Private-bucket URLs are signed on their way *out* to a fetcher.

The bug these cover: a Sora 2 node with a reference image wired to it submitted
fine and then failed with `401 ... auth_failure`, because the URL we handed
Replicate was the durable one on the asset row — which our bucket answers with a
401 for everybody but us. The provider's downloader has none of our credentials,
and neither does ffmpeg, so anything leaving this process has to carry a
signature. What must *not* change is the plan and the manifest: those record the
durable URL, which is the one that still resolves next year.
"""

from __future__ import annotations

import pytest

from app.catalog.registry import get_catalog
from app.config import StorageMode
from app.engine import manifests
from app.engine.builder import BuildContext, _sign_urls, build_pipeline
from app.graph.compile import plan_graph
from app.graph.schema import AssetRef, Graph, audio_port_id

DURABLE = "https://s3.us-east-005.backblazeb2.com/assetflow-adithya/assetflow/x.jpg"
SIGNED = f"{DURABLE}?X-Amz-Signature=deadbeef"


class _FakeBackend:
    """Stands in for the S3 backend: recognizes our bucket, signs by suffix."""

    def __init__(self, *, fails: bool = False):
        self.fails = fails

    def key_from_url(self, url: str) -> str | None:
        prefix = "https://s3.us-east-005.backblazeb2.com/assetflow-adithya/"
        return url[len(prefix) :] if url.startswith(prefix) else None

    def presigned_get_url(self, key: str, *, expires_in: int) -> str:
        if self.fails:
            raise RuntimeError("signing exploded")
        return f"https://s3.us-east-005.backblazeb2.com/assetflow-adithya/{key}?X-Amz-Signature=deadbeef"


class _FakeSettings:
    storage_mode = StorageMode.B2
    b2_configured = True


@pytest.fixture
def signing(monkeypatch):
    """B2 mode with a signing backend that needs no credentials."""

    def _install(*, fails: bool = False, mode: StorageMode = StorageMode.B2):
        settings = _FakeSettings()
        settings.storage_mode = mode
        monkeypatch.setattr(manifests, "get_settings", lambda: settings)
        monkeypatch.setattr(manifests, "_signing_backend", lambda: _FakeBackend(fails=fails))

    return _install


@pytest.fixture
def catalog():
    return get_catalog()


# --------------------------------------------------------------------------- #
# sign_for_fetch
# --------------------------------------------------------------------------- #


def test_our_own_bucket_urls_are_signed(signing):
    signing()
    assert manifests.sign_for_fetch(DURABLE) == SIGNED


def test_a_provider_cdn_url_is_left_alone(signing):
    """Replicate's own delivery URLs are already fetchable; signing one would
    only produce a URL that is not ours to sign."""
    signing()
    url = "https://replicate.delivery/pbxt/abc/out.mp4"
    assert manifests.sign_for_fetch(url) == url


def test_local_files_are_left_alone(signing):
    signing()
    assert manifests.sign_for_fetch("file:///tmp/clip.mp4") == "file:///tmp/clip.mp4"


def test_local_storage_mode_signs_nothing(signing):
    """Local media is already served unauthenticated from /media."""
    signing(mode=StorageMode.LOCAL)
    assert manifests.sign_for_fetch(DURABLE) == DURABLE


def test_a_signing_failure_falls_back_to_the_durable_url(signing):
    """The fetcher's 401 names the URL it could not read; an exception here
    would fail the run with a message about our signing code instead."""
    signing(fails=True)
    assert manifests.sign_for_fetch(DURABLE) == DURABLE


# --------------------------------------------------------------------------- #
# params
# --------------------------------------------------------------------------- #


def test_urls_nested_in_params_are_signed(signing):
    """A composition edit carries its uploaded clips as URLs two levels down."""
    signing()
    params = {
        "duration": 5,
        "prompt": "not a url",
        "edit": {"tracks": [{"clips": [{"url": DURABLE, "start_sec": 0.0}]}]},
    }
    signed = _sign_urls(params)
    assert signed["edit"]["tracks"][0]["clips"][0]["url"] == SIGNED
    assert signed["duration"] == 5
    assert signed["prompt"] == "not a url"
    # The input is untouched: the plan it came from is persisted.
    assert params["edit"]["tracks"][0]["clips"][0]["url"] == DURABLE


# --------------------------------------------------------------------------- #
# the whole path, plan → pipeline
# --------------------------------------------------------------------------- #


def _graph(nodes, edges=()):
    return Graph.model_validate({"version": 1, "nodes": nodes, "edges": list(edges)})


def _upload(node_id, **data):
    return {
        "id": node_id,
        "kind": "input.upload",
        "position": {"x": 0.0, "y": 0.0},
        "data": {"asset_id": "asset-1", **data},
    }


def _gen(node_id, *, model="mock-video-v1", modality="video", y=100.0, **data):
    return {
        "id": node_id,
        "kind": "generate",
        "position": {"x": 0.0, "y": y},
        "data": {
            "provider": "mock",
            "model": model,
            "modality": modality,
            "prompt": "a cat",
            **data,
        },
    }


def _assets(media_type="image/png", modality="image"):
    return {
        "asset-1": AssetRef(
            asset_id="asset-1",
            url=DURABLE,
            media_type=media_type,
            modality=modality,
            sha256="ab" * 32,
        )
    }


def _ctx(assets):
    return BuildContext(tenant_id="t", workflow_id=None, run_id="r", assets=assets, preflight=False)


def test_an_uploaded_reference_reaches_the_provider_signed(signing, catalog):
    """The Sora 2 case, on the mock adapter: an upload wired to a video node's
    reference port rides `external_inputs`, and the provider fetches it."""
    signing()
    graph = _graph(
        [_upload("up"), _gen("vid")],
        [
            {
                "id": "e1",
                "source": "up",
                "target": "vid",
                "target_handle": "init_image",
                "source_handle": "out",
            }
        ],
    )
    assets = _assets()
    result = plan_graph(graph, catalog=catalog, assets=assets)
    assert result.valid, result.errors

    pipeline = build_pipeline(result.plan, _ctx(assets))
    (inbound,) = pipeline._steps[0].external_inputs
    assert inbound.url == SIGNED
    # Signing is for the wire only — provenance keeps the durable URL, and the
    # sha256 that travels with it keeps the manifest hash stable regardless.
    assert assets["asset-1"].url == DURABLE
    assert inbound.sha256 == "ab" * 32


def test_an_uploaded_composition_clip_reaches_ffmpeg_signed(signing, catalog):
    """The clip URL is read by ffmpeg in a subprocess, which has no keys."""
    signing()
    graph = _graph(
        [
            _gen("vid", y=0.0),
            _upload("music"),
            {
                "id": "mux",
                "kind": "transform.composite",
                "position": {"x": 0.0, "y": 200.0},
                "data": {
                    "op": "mux",
                    "timeline_sec": 30.0,
                    "video": {"id": "video", "clips": [{"source": "vid", "start_sec": 0.0}]},
                    "tracks": [{"id": "a1", "clips": [{"source": "music", "start_sec": 0.0}]}],
                },
            },
        ],
        [
            {
                "id": "e1",
                "source": "vid",
                "target": "mux",
                "target_handle": "video",
                "source_handle": "out",
            },
            {
                "id": "e2",
                "source": "music",
                "target": "mux",
                "target_handle": audio_port_id("a1"),
                "source_handle": "out",
            },
        ],
    )
    assets = _assets(media_type="audio/mpeg", modality="audio")
    result = plan_graph(graph, catalog=catalog, assets=assets)
    assert result.valid, result.errors

    pipeline = build_pipeline(result.plan, _ctx(assets))
    edit = pipeline._steps[1].params["edit"]
    clip = edit["tracks"][1]["clips"][0]
    assert clip["url"] == SIGNED
    # The plan the run persists still carries the durable one.
    plan_edit = result.plan.step_for_node("mux").params["edit"]
    assert plan_edit["tracks"][1]["clips"][0]["url"] == DURABLE
