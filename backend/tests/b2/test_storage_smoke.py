"""Real-B2 smoke tests.

Skipped unless credentials are present, so the default suite stays offline:

    uv run pytest -m b2 -v

These assert the properties the app actually depends on — durable URLs are
stable and private, presigned URLs fetch, and a full pipeline run lands assets
*and* a verifiable provenance manifest in the bucket.
"""

from __future__ import annotations

import contextlib
import uuid

import httpx
import pytest

from app.config import get_settings

pytestmark = pytest.mark.b2

settings = get_settings()

requires_b2 = pytest.mark.skipif(
    not settings.b2_configured,
    reason="B2 credentials not configured (B2_KEY_ID / B2_APP_KEY / B2_BUCKET)",
)


@pytest.fixture(scope="module")
def backend():
    from genblaze_s3 import S3StorageBackend

    return S3StorageBackend.for_backblaze(
        settings.b2_bucket,
        region=settings.b2_region,
        key_id=settings.b2_key_id,
        app_key=settings.b2_app_key,
    )


@pytest.fixture
def probe_key(backend):
    key = f"{settings.b2_prefix}/_test/{uuid.uuid4().hex}.bin"
    yield key
    with contextlib.suppress(Exception):  # cleanup is best-effort
        backend.delete(key)


@requires_b2
def test_put_get_roundtrip(backend, probe_key):
    payload = b"asset-flow smoke" * 64
    backend.put(probe_key, payload, content_type="application/octet-stream")
    assert backend.get(probe_key) == payload
    assert backend.exists(probe_key)


@requires_b2
def test_content_type_is_preserved(backend, probe_key):
    """B2 serves whatever was recorded at upload; a wrong value breaks inline
    <video> playback in the browser."""
    backend.put(probe_key, b"\x00\x01", content_type="video/mp4")
    assert backend.head(probe_key).content_type == "video/mp4"


@requires_b2
def test_durable_url_is_stable_and_unsigned(backend, probe_key):
    backend.put(probe_key, b"x", content_type="text/plain")
    url = backend.get_durable_url(probe_key)
    # A signature in a persisted URL would rot and would break canonical-hash
    # stability, so durable URLs must carry none.
    assert "X-Amz-Signature" not in url
    assert "X-Amz-Credential" not in url
    assert backend.get_durable_url(probe_key) == url


@requires_b2
def test_durable_url_is_not_publicly_readable(backend, probe_key):
    """The bucket is private by design; a 200 here means it is not."""
    backend.put(probe_key, b"secret", content_type="text/plain")
    response = httpx.get(backend.get_durable_url(probe_key), timeout=30.0)
    assert response.status_code != 200, (
        "The bucket is PUBLIC — generated media is world-readable at a permanent URL."
    )


@requires_b2
def test_presigned_url_fetches(backend, probe_key):
    payload = b"presigned body"
    backend.put(probe_key, payload, content_type="text/plain")
    response = httpx.get(
        backend.presigned_get_url(probe_key, expires_in=300), timeout=30.0
    )
    assert response.status_code == 200
    assert response.content == payload


@requires_b2
def test_key_from_url_roundtrips(backend, probe_key):
    """GET /v1/assets/{id}/content only has the stored durable URL, so it must
    be able to recover the key in order to presign."""
    backend.put(probe_key, b"x", content_type="text/plain")
    assert backend.key_from_url(backend.get_durable_url(probe_key)) == probe_key


@requires_b2
def test_pipeline_writes_assets_and_manifest_to_b2():
    """The end-to-end property that matters for provenance: after a run, both
    the asset and its canonical manifest are in the bucket, the asset carries a
    SHA-256, and the manifest verifies."""
    from genblaze_core import Modality, Pipeline

    # Our sample-backed mock, not genblaze_core.mocks — the stock one returns
    # unfetchable https://mock.test URLs that the sink cannot transfer.
    from app.engine.mock_providers import video_provider
    from app.engine.sinks import build_sink

    run_id = uuid.uuid4().hex
    sink = build_sink(run_id=run_id)
    assert sink is not None, "build_sink returned None — is STORAGE_MODE=b2?"

    result = (
        Pipeline(f"smoke-{run_id}", tenant_id="test_tenant", preflight=False)
        .step(
            video_provider(),
            model="mock-video-v1",
            prompt="smoke test",
            modality=Modality.VIDEO,
            metadata={"node_id": "n1"},
        )
        .run(sink=sink, timeout=120, raise_on_failure=False)
    )

    run, manifest = result
    asset = run.steps[0].assets[0]

    assert settings.b2_bucket in asset.url, f"asset URL does not point at B2: {asset.url}"
    assert asset.sha256, "asset has no SHA-256 — the sink did not hash-bind the bytes"
    # verify() only passes once the sink has transferred bytes into durable
    # storage; this is the property that makes provenance meaningful.
    assert manifest.verify(), "manifest failed verification"
    assert manifest.manifest_uri, "manifest was not persisted"
