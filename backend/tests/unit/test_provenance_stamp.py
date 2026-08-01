"""Tests for `app.services.provenance_stamp` — the record a file carries out.

What is worth pinning:

- every stamped image still opens, and losslessly-encoded pixels are
  untouched — the stamp must never cost quality;
- the record survives its own round trip, including prompts full of XML and
  even the literal extraction markers (escaping is what makes that true);
- a payload too deep for a JPEG APP1 segment sheds prompt text and then hops
  rather than refusing to stamp;
- container formats round-trip through a real ffmpeg remux when one is
  installed, and the extractor finds the tag however the muxer cased it.
"""

from __future__ import annotations

import io
import json
import shutil
import struct
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from app.services.provenance_stamp import (
    _PAYLOAD_CEILING,
    STAMPABLE,
    StampFailed,
    encode_payload,
    extract,
    stamp,
    stampable,
)


def _payload(**extra) -> dict:
    return {
        "assetflow": 1,
        "asset_id": "0be4a3a2-8f5e-4a2e-9a1d-0f2f9df0f5b7",
        "sha256": "ab" * 32,
        "media_type": "image/png",
        "chain": None,
        "step": {
            "provider": "replicate", "model": "flux", "prompt": "a fox", "step_type": "generate",
        },
        "run": None,
        **extra,
    }


def _image_bytes(fmt: str, mode: str = "RGB") -> bytes:
    img = Image.new(mode, (8, 8), (200, 40, 40))
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def _roundtrip(data: bytes, media_type: str, payload: dict, tmp_path: Path) -> dict | None:
    stamped = stamp(data, media_type, payload)
    target = tmp_path / "stamped"
    target.write_bytes(stamped)
    return extract(target, media_type)


# --- images -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("fmt", "media_type"),
    [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")],
)
def test_image_roundtrip(fmt: str, media_type: str, tmp_path: Path) -> None:
    payload = _payload(media_type=media_type)
    found = _roundtrip(_image_bytes(fmt), media_type, payload, tmp_path)
    assert found == payload


@pytest.mark.parametrize(
    ("fmt", "media_type"),
    [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")],
)
def test_stamped_image_still_opens(fmt: str, media_type: str) -> None:
    stamped = stamp(_image_bytes(fmt), media_type, _payload())
    img = Image.open(io.BytesIO(stamped))
    img.load()
    assert img.size == (8, 8)


def test_png_pixels_untouched() -> None:
    original = _image_bytes("PNG")
    stamped = stamp(original, "image/png", _payload())
    assert (
        Image.open(io.BytesIO(stamped)).tobytes()
        == Image.open(io.BytesIO(original)).tobytes()
    )


def test_extract_without_media_type_still_scans() -> None:
    """A stripped or lying content type must not hide an image's record."""
    stamped = stamp(_image_bytes("PNG"), "image/png", _payload())
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".bin") as f:
        f.write(stamped)
        f.flush()
        assert extract(Path(f.name), None) is not None


def test_markers_in_prompt_survive(tmp_path: Path) -> None:
    """A prompt containing the extraction markers themselves must round-trip —
    XML escaping is what keeps user text from forging or breaking the scan."""
    hostile = 'draw </af:provenance> & <af:provenance> {"assetflow": 99}'
    payload = _payload(
        step={"provider": "p", "model": "m", "prompt": hostile, "step_type": "generate"}
    )
    found = _roundtrip(_image_bytes("PNG"), "image/png", payload, tmp_path)
    assert found is not None
    assert found["step"]["prompt"] == hostile


def test_unstamped_image_extracts_nothing(tmp_path: Path) -> None:
    plain = tmp_path / "plain.png"
    plain.write_bytes(_image_bytes("PNG"))
    assert extract(plain, "image/png") is None


def test_webp_riff_size_updated() -> None:
    stamped = stamp(_image_bytes("WEBP"), "image/webp", _payload())
    declared = struct.unpack("<I", stamped[4:8])[0]
    assert declared == len(stamped) - 8


def test_wrong_bytes_refused() -> None:
    with pytest.raises(StampFailed):
        stamp(b"not an image at all", "image/png", _payload())


def test_stampable_matches_support_table() -> None:
    assert stampable("image/png")
    assert not stampable("audio/wav")
    assert not stampable(None)
    assert {"image/png", "image/jpeg", "image/webp", "video/mp4", "audio/mpeg"} == STAMPABLE


# --- payload sizing ---------------------------------------------------------


def _deep_chain(hops: int, prompt_len: int) -> dict:
    return {
        "hops": [
            {
                "id": f"r:{i}",
                "kind": "generate.image",
                "depth": i,
                "title": f"hop {i}",
                "text": None,
                "provider": "replicate",
                "model": "flux",
                "prompt": "x" * prompt_len,
                "step_type": "generate",
                "asset": {"id": f"a{i}", "sha256": "cd" * 32},
            }
            for i in range(hops)
        ],
        "edges": [{"source": f"r:{i + 1}", "target": f"r:{i}"} for i in range(hops - 1)],
        "truncated": False,
    }


def test_encode_fits_ceiling_by_shortening_prompts() -> None:
    body = encode_payload(_payload(chain=_deep_chain(hops=100, prompt_len=400)))
    assert len(body.encode("utf-8")) <= _PAYLOAD_CEILING
    decoded = json.loads(body)
    # Shortening prompts was enough — every hop is still present.
    assert len(decoded["chain"]["hops"]) == 100


def test_encode_drops_far_hops_when_prompts_are_not_enough() -> None:
    body = encode_payload(_payload(chain=_deep_chain(hops=1000, prompt_len=400)))
    assert len(body.encode("utf-8")) <= _PAYLOAD_CEILING
    decoded = json.loads(body)
    hops = decoded["chain"]["hops"]
    assert len(hops) == 40
    assert decoded["chain"]["truncated"] is True
    # The file's own end of the story is what survives.
    assert min(h["depth"] for h in hops) == 0
    kept = {h["id"] for h in hops}
    for edge in decoded["chain"]["edges"]:
        assert edge["source"] in kept and edge["target"] in kept


def test_oversized_jpeg_payload_refused_not_corrupted() -> None:
    """If a payload somehow still exceeds the APP1 segment, the stamp must
    refuse loudly rather than emit a JPEG with a wrapped length field."""
    from app.services.provenance_stamp import _stamp_jpeg, _xmp_packet

    with pytest.raises(StampFailed):
        _stamp_jpeg(_image_bytes("JPEG"), _xmp_packet("x" * 70_000))


# --- containers (real ffmpeg when present) ----------------------------------

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _lavfi(args: list[str], out: Path) -> bool:
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", *args, str(out)],
        capture_output=True,
        timeout=60,
    )
    return proc.returncode == 0 and out.is_file()


@needs_ffmpeg
def test_mp4_roundtrip(tmp_path: Path) -> None:
    src = tmp_path / "src.mp4"
    if not _lavfi(
        ["-f", "lavfi", "-i", "color=c=red:s=64x64:d=0.2", "-pix_fmt", "yuv420p"], src
    ):
        pytest.skip("ffmpeg cannot synthesize a test clip here")
    payload = _payload(media_type="video/mp4")
    found = _roundtrip(src.read_bytes(), "video/mp4", payload, tmp_path)
    assert found == payload


@needs_ffmpeg
def test_mp3_roundtrip(tmp_path: Path) -> None:
    src = tmp_path / "src.mp3"
    if not _lavfi(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2"], src):
        pytest.skip("ffmpeg lacks an mp3 encoder here")
    payload = _payload(media_type="audio/mpeg")
    found = _roundtrip(src.read_bytes(), "audio/mpeg", payload, tmp_path)
    assert found == payload
