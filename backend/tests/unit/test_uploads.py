"""Upload ingest — the parts that need neither B2 nor a database.

The storage round trip is covered by `tests/b2/` behind the `b2` marker; what
matters here is that the gatekeeping happens *before* any bytes are stored.
"""

from __future__ import annotations

import io

import pytest

from app.services.uploads import (
    MAX_UPLOAD_BYTES,
    UnsupportedMedia,
    UploadTooLarge,
    _extension,
    digest_and_size,
    ingest_upload,
    modality_of,
)

# sha256 of b"hello"
HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"


def test_digest_matches_and_rewinds():
    stream = io.BytesIO(b"hello")
    sha, size = digest_and_size(stream)
    assert sha == HELLO_SHA
    assert size == 5
    # The caller uploads straight from this stream, so it has to be back at 0.
    assert stream.tell() == 0


def test_digest_survives_chunk_boundaries():
    """The reader loops in 1 MiB chunks; a payload spanning several must hash
    the same as one shot."""
    import hashlib

    payload = b"x" * (1 << 20) * 2 + b"tail"
    sha, size = digest_and_size(io.BytesIO(payload))
    assert sha == hashlib.sha256(payload).hexdigest()
    assert size == len(payload)


def test_oversized_upload_is_refused_before_storing():
    stream = io.BytesIO(b"0" * (MAX_UPLOAD_BYTES + 1))
    with pytest.raises(UploadTooLarge):
        digest_and_size(stream)


async def test_non_media_upload_is_refused():
    # No session/settings are touched: the type check must reject first, so a
    # bogus session here would only be reached on a regression.
    with pytest.raises(UnsupportedMedia):
        await ingest_upload(
            None,
            tenant_id="user_test",
            stream=io.BytesIO(b"MZ..."),
            filename="payload.exe",
            media_type="application/x-msdownload",
        )


@pytest.mark.parametrize(
    ("media_type", "expected"),
    [("image/png", "image"), ("video/mp4", "video"), ("audio/mpeg", "audio")],
)
def test_modality_from_media_type(media_type, expected):
    assert modality_of(media_type) == expected


def test_extension_prefers_media_type_over_filename():
    assert _extension("image/png", "photo.jpeg") == ".png"


def test_extension_falls_back_to_filename_suffix():
    assert _extension("image/heic", "shot.heic") == ".heic"


def test_extension_rejects_absurd_suffix():
    assert _extension("application/unknown", "file.thisisnotanextension") == ".bin"
