"""Magic Text service — the pure parsing pieces.

The Replicate call and storage paths are exercised end to end in dev; what
must never regress silently are the classifiers that decide which output URL
is the poster, which is the JSON, and how big the coordinate spaces are.
"""

import struct

from app.services.magic_text import (
    parse_resolution,
    pick_outputs,
    png_dimensions,
    single_output_url,
)


def _png(width: int, height: int) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + b"IHDR"
        + struct.pack(">II", width, height)
    )


class TestPngDimensions:
    def test_reads_ihdr(self):
        assert png_dimensions(_png(960, 1088)) == (960, 1088)

    def test_rejects_non_png(self):
        assert png_dimensions(b'{"detail": "requested file not found"}') is None

    def test_rejects_truncated(self):
        assert png_dimensions(b"\x89PNG\r\n\x1a\n") is None

    def test_rejects_zero_size(self):
        assert png_dimensions(_png(0, 100)) is None


class TestPickOutputs:
    def test_observed_order(self):
        json_url, image_url = pick_outputs(
            ["https://x/tmp.json", "https://x/tmp.png"]
        )
        assert json_url == "https://x/tmp.json"
        assert image_url == "https://x/tmp.png"

    def test_swapped_order_still_classified(self):
        json_url, image_url = pick_outputs(
            ["https://x/base.webp", "https://x/layers.json"]
        )
        assert json_url == "https://x/layers.json"
        assert image_url == "https://x/base.webp"

    def test_query_strings_ignored(self):
        json_url, image_url = pick_outputs(
            ["https://x/a.json?sig=1", "https://x/b.png?exp=2"]
        )
        assert json_url == "https://x/a.json?sig=1"
        assert image_url == "https://x/b.png?exp=2"

    def test_missing_half_is_none(self):
        assert pick_outputs(["https://x/only.png"]) == (None, "https://x/only.png")
        assert pick_outputs([]) == (None, None)


class TestSingleOutputUrl:
    def test_bare_string(self):
        assert single_output_url("https://x/cut.png") == "https://x/cut.png"

    def test_list(self):
        assert single_output_url(["https://x/cut.png"]) == "https://x/cut.png"

    def test_garbage(self):
        assert single_output_url(None) is None
        assert single_output_url({"weird": True}) is None
        assert single_output_url(["not-a-url"]) is None


class TestParseResolution:
    def test_standard(self):
        assert parse_resolution("1024x1024") == (1024, 1024)

    def test_garbage(self):
        assert parse_resolution(None) is None
        assert parse_resolution("wide") is None
        assert parse_resolution("0x100") is None
