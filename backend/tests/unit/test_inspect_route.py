"""Tests for the public /v1/inspect route — multipart in, resolution out.

The stamp service has its own round-trip suite; what is worth pinning here is
the route's plumbing: an upload spools and hashes correctly, a stamped file
whose library row is gone still answers from its embedded snapshot, a plain
file resolves to an honest "none", and none of it asks for authentication.
"""

from __future__ import annotations

import hashlib
import io

import httpx
import pytest
from PIL import Image

from app.deps import db_session
from app.main import create_app
from app.services.provenance_stamp import stamp


class _NoRows:
    def scalar_one_or_none(self):
        return None

    def scalars(self):
        return self

    def first(self):
        return None


class EmptySession:
    """A database with nothing in it — every lookup misses."""

    async def execute(self, _stmt):
        return _NoRows()

    async def get(self, _model, _pk):
        return None


@pytest.fixture
async def client():
    app = create_app()

    async def _empty_db():
        yield EmptySession()

    app.dependency_overrides[db_session] = _empty_db
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (10, 120, 40)).save(buf, format="PNG")
    return buf.getvalue()


def _payload() -> dict:
    return {
        "assetflow": 1,
        "asset_id": "0be4a3a2-8f5e-4a2e-9a1d-0f2f9df0f5b7",
        "sha256": "ab" * 32,
        "media_type": "image/png",
        "chain": None,
        "step": {"provider": "p", "model": "m", "prompt": "a fox", "step_type": "generate"},
        "run": None,
    }


async def test_plain_file_resolves_to_none(client: httpx.AsyncClient) -> None:
    data = _png()
    res = await client.post(
        "/v1/inspect", files={"file": ("plain.png", data, "image/png")}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["found"] is False
    assert body["source"] == "none"
    assert body["sha256"] == hashlib.sha256(data).hexdigest()
    assert body["size_bytes"] == len(data)


async def test_stamped_file_with_forgotten_asset_answers_from_snapshot(
    client: httpx.AsyncClient,
) -> None:
    stamped = stamp(_png(), "image/png", _payload())
    res = await client.post(
        "/v1/inspect", files={"file": ("stamped.png", stamped, "image/png")}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["found"] is True
    assert body["source"] == "snapshot"
    assert body["asset"] is None
    # The embedded record is the whole answer — the library has forgotten it.
    assert body["embedded"]["step"]["prompt"] == "a fox"


async def test_inspect_requires_no_auth_header(client: httpx.AsyncClient) -> None:
    """The route's whole audience is people without accounts; a regression
    that adds the auth dependency would break every recipient at once."""
    res = await client.post(
        "/v1/inspect", files={"file": ("x.png", _png(), "image/png")}
    )
    assert res.status_code != 401
