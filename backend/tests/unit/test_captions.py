"""Caption ASS generation — the subtitle file *is* the behaviour.

Most of these assert on the generated ASS text: a wrong color channel order,
a broken karaoke window, or a mis-anchored `\\pos` would otherwise only show
up as a video that looks subtly wrong. One end-to-end burn at the bottom
proves the file drives a real ffmpeg/libass render.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.services.captions import (
    CAPTION_STYLES,
    _ass_color,
    _fonts_dir,
    _timestamp,
    build_ass,
    burn_command,
)

PLACE = {"x": 0.5, "y": 0.82, "w": 0.8}


def word(text: str, start: float, end: float) -> dict:
    return {"text": text, "start": start, "end": end}


def cue(start: float, end: float, *lines: list[dict]) -> dict:
    return {"start": start, "end": end, "lines": list(lines)}


ONE_LINE = cue(0.0, 2.0, [word("hello", 0.0, 0.8), word("world", 0.9, 1.6)])


# --- primitives -------------------------------------------------------------


def test_ass_colors_are_bgr():
    # #FACC15 (the canvas accent) → blue 15, green CC, red FA.
    assert _ass_color("FACC15") == "&H0015CCFA&"
    assert _ass_color("000000", 0x50) == "&H50000000&"


def test_timestamps_are_centiseconds():
    assert _timestamp(0.0) == "0:00:00.00"
    assert _timestamp(83.456) == "0:01:23.46"
    assert _timestamp(3600.0) == "1:00:00.00"


def test_every_style_declares_a_shipped_font():
    shipped = {"Archivo Black", "Poppins SemiBold", "Instrument Serif"}
    assert {s.fontname for s in CAPTION_STYLES.values()} <= shipped


# --- script structure -------------------------------------------------------


def test_playres_matches_the_video_and_pos_is_fractional():
    ass = build_ass([ONE_LINE], "classic", PLACE, 1280, 720)
    assert "PlayResX: 1280" in ass and "PlayResY: 720" in ass
    # Center anchor (alignment 5) at x*W, y*H — same math for any format.
    assert "\\pos(640,590)" in ass


def test_vertical_video_scales_by_its_own_height():
    ass = build_ass([ONE_LINE], "classic", PLACE, 720, 1280)
    assert "\\pos(360,1050)" in ass
    # Fontsize follows height, so portrait text is bigger in absolute pixels.
    landscape = build_ass([ONE_LINE], "classic", PLACE, 1280, 720)
    size_of = lambda s: int(s.split("Style: Caption,Poppins SemiBold,")[1].split(",")[0])
    assert size_of(ass) > size_of(landscape)


def test_the_corner_scale_grows_text_and_its_dressing():
    size_of = lambda s: int(s.split("Style: Caption,Archivo Black,")[1].split(",")[0])
    plain = build_ass([ONE_LINE], "outline", PLACE, 1280, 720)
    doubled = build_ass([ONE_LINE], "outline", {**PLACE, "scale": 2.0}, 1280, 720)
    # Within a pixel of double — each side rounds independently.
    assert abs(size_of(doubled) - 2 * size_of(plain)) <= 1
    # The stroke scales with the text, so a grown caption doesn't thin out.
    outline_of = lambda s: float(
        next(l for l in s.splitlines() if l.startswith("Style: Caption")).split(",")[16]
    )
    assert abs(outline_of(doubled) - 2 * outline_of(plain)) <= 0.2
    # Absent scale (an old client) means 1 — the style's native size.
    assert build_ass([ONE_LINE], "outline", PLACE, 1280, 720) == plain


def test_editor_line_breaks_are_pinned():
    two_lines = cue(0.0, 2.0, [word("first", 0.0, 0.5)], [word("second", 0.6, 1.0)])
    ass = build_ass([two_lines], "classic", PLACE, 1280, 720)
    assert "first\\Nsecond" in ass
    assert "\\q2" in ass  # libass must not re-wrap what the editor measured


def test_uppercase_styles_shout_and_quiet_ones_do_not():
    loud = build_ass([ONE_LINE], "outline", PLACE, 1280, 720)
    quiet = build_ass([ONE_LINE], "classic", PLACE, 1280, 720)
    assert "HELLO WORLD" in loud
    assert "hello world" in quiet


def test_markup_in_words_cannot_reach_libass():
    hostile = cue(0.0, 1.0, [word("{\\b1}pwn\\", 0.0, 0.5)])
    ass = build_ass([hostile], "classic", PLACE, 1280, 720)
    assert "{\\b1}pwn" not in ass
    assert "(\\" not in ass and "(b1)pwn" in ass


# --- highlight modes --------------------------------------------------------


def test_plain_styles_emit_one_event_per_cue():
    ass = build_ass([ONE_LINE], "classic", PLACE, 1280, 720)
    assert ass.count("Dialogue:") == 1


def test_karaoke_emits_one_window_per_word():
    ass = build_ass([ONE_LINE], "karaoke", PLACE, 1280, 720)
    events = [l for l in ass.splitlines() if l.startswith("Dialogue:")]
    assert len(events) == 2
    # First window runs to the *next word's start* so text never flickers out.
    assert events[0].startswith("Dialogue: 0,0:00:00.00,0:00:00.90,")
    # The active word is tinted with the accent; the other word stays plain.
    assert "{\\1c&H0015CCFA&}HELLO{\\r} WORLD" in events[0]
    assert "HELLO {\\1c&H0015CCFA&}WORLD{\\r}" in events[1]


def test_block_highlight_wraps_the_active_word_in_an_accent_border():
    ass = build_ass([ONE_LINE], "bold-social", PLACE, 1280, 720)
    events = [l for l in ass.splitlines() if l.startswith("Dialogue:")]
    assert len(events) == 2
    assert "\\3c&H0015CCFA&" in events[0]  # accent border
    assert "\\1c&H001C211F&" in events[0]  # ink text on it
    assert "\\bord" in events[0]


def test_lower_third_is_a_boxed_style():
    ass = build_ass([ONE_LINE], "lower-third", PLACE, 1280, 720)
    style_line = next(l for l in ass.splitlines() if l.startswith("Style: Caption"))
    fields = style_line.split(",")
    assert fields[15] == "3"  # BorderStyle 3 — opaque box per line


def test_unknown_style_is_refused():
    from app.services.captions import CaptionBurnFailed

    with pytest.raises(CaptionBurnFailed):
        build_ass([ONE_LINE], "comic-sans", PLACE, 1280, 720)


def test_zero_length_windows_are_dropped():
    stutter = cue(0.0, 1.0, [word("a", 0.5, 0.5), word("b", 0.5, 1.0)])
    ass = build_ass([stutter], "karaoke", PLACE, 1280, 720)
    events = [l for l in ass.splitlines() if l.startswith("Dialogue:")]
    assert len(events) == 1  # "a"'s window is 0-wide; only "b" renders


# --- the burn command -------------------------------------------------------


def test_burn_command_burns_with_our_fonts_and_keeps_audio(monkeypatch):
    import app.services.captions as mod

    monkeypatch.setattr(mod, "_ffmpeg_bin", lambda: "ffmpeg")
    cmd = burn_command("source.mp4", "subs.ass", "/fonts", "out.mp4")
    assert cmd[:4] == ["ffmpeg", "-y", "-i", "source.mp4"]
    assert "ass=subs.ass:fontsdir=/fonts" in cmd
    assert "copy" in cmd  # audio passes through untouched


# --- transcript sidecars ----------------------------------------------------


def local_settings(tmp_path: Path):
    from types import SimpleNamespace

    from app.config import StorageMode

    return SimpleNamespace(
        storage_mode=StorageMode.LOCAL,
        local_media_dir=tmp_path,
        local_media_base_url="http://media.local",
    )


def test_a_stored_transcript_short_circuits_scribe(tmp_path: Path, monkeypatch):
    """The second transcription of the same asset must not bill again."""
    import asyncio
    import json
    from types import SimpleNamespace

    import app.services.captions as mod

    settings = local_settings(tmp_path)
    asset = SimpleNamespace(tenant_id="user_t", id="abc-123")
    sidecar = tmp_path / "user_t/captions/transcripts/abc-123.json"
    sidecar.parent.mkdir(parents=True)
    stored = {
        "has_speech": True,
        "language": "en",
        "duration_sec": 1.5,
        "words": [{"text": "hi", "start": 0.0, "end": 0.4}],
    }
    sidecar.write_text(json.dumps(stored))

    def no_billing():
        raise AssertionError("Scribe was called despite a stored transcript")

    monkeypatch.setattr(mod, "_scribe_client", no_billing)
    result = asyncio.run(mod.transcribe_asset(asset, settings))
    assert result == stored


def test_a_fresh_transcript_is_written_back(tmp_path: Path, monkeypatch):
    import asyncio
    import json
    from types import SimpleNamespace

    import app.services.captions as mod

    settings = local_settings(tmp_path)
    asset = SimpleNamespace(
        tenant_id="user_t", id="new-1", filename="a.mp4", media_type="video/mp4"
    )

    class FakeScribe:
        class speech_to_text:  # noqa: N801 - mirrors the SDK's attribute
            @staticmethod
            def convert(**kwargs):
                return SimpleNamespace(
                    words=[
                        SimpleNamespace(text="hey", start=0.1, end=0.5, type="word")
                    ],
                    language_code="en",
                    audio_duration_secs=2.0,
                )

    async def fake_bytes(a, s):
        return b"fake-video"

    monkeypatch.setattr(mod, "_asset_bytes", fake_bytes)
    monkeypatch.setattr(mod, "_scribe_client", lambda: FakeScribe())

    result = asyncio.run(mod.transcribe_asset(asset, settings))
    assert result["has_speech"] and result["words"][0]["text"] == "hey"
    sidecar = tmp_path / "user_t/captions/transcripts/new-1.json"
    assert json.loads(sidecar.read_text()) == result


def test_generations_carry_the_captioned_flag():
    from types import SimpleNamespace

    from app.services.results import serialize_generation

    def asset(meta):
        return SimpleNamespace(
            id="a1", url="http://x/a.mp4", media_type="video/mp4",
            modality="video", asset_metadata=meta, width=1, height=1,
            created_at=None,
        )

    burned = serialize_generation(asset({"source": "captions.burn"}), node_id="n")
    plain = serialize_generation(asset(None), node_id="n")
    assert burned["captioned"] is True
    assert plain["captioned"] is False


# --- one real render --------------------------------------------------------


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_a_real_burn_renders_frames(tmp_path: Path):
    """The generated ASS drives an actual libass render without erroring."""
    src = tmp_path / "src.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src),
        ],
        check=True, capture_output=True,
    )
    subs = tmp_path / "subs.ass"
    subs.write_text(build_ass([ONE_LINE], "bold-social", PLACE, 320, 180))

    out = tmp_path / "out.mp4"
    proc = subprocess.run(
        burn_command("src.mp4", "subs.ass", str(_fonts_dir()), "out.mp4"),
        cwd=tmp_path, capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr[-400:]
    assert out.stat().st_size > 0
