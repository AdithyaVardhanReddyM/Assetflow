"""TrackCompositor — the half of the Composition node that makes the edit real.

Most of these assert on the ffmpeg command rather than on a rendered file: the
filter graph *is* the behaviour, and building it wrong is the failure mode that
would otherwise only show up as a video that looks or sounds subtly incorrect.
Two end-to-end renders at the bottom prove the commands are actually valid
ffmpeg, which no amount of string assertion can.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from genblaze_core.exceptions import ProviderError
from genblaze_core.models.asset import Asset
from genblaze_core.models.step import Step

from app.engine import compositor as compositor_module
from app.engine.compositor import TrackCompositor


@pytest.fixture
def captured(monkeypatch):
    """Run the compositor without ffmpeg, keeping the command it built."""
    calls: list[list[str]] = []

    def fake_run(cmd, timeout=None):
        calls.append(cmd)

    monkeypatch.setattr(compositor_module, "run_ffmpeg", fake_run)
    monkeypatch.setattr(compositor_module, "resolve_ffmpeg", lambda path: "ffmpeg")
    monkeypatch.setattr(
        compositor_module, "resolve_input_path", lambda url, extra_roots=None: url
    )
    monkeypatch.setattr(
        compositor_module, "populate_file_asset_integrity", lambda asset, path: None
    )
    monkeypatch.setattr(TrackCompositor, "_frame_size", lambda self, path: (640, 360))
    # Every stub clip is a second long, so a shot's end is its start plus one.
    monkeypatch.setattr(TrackCompositor, "_duration", lambda self, path: 1.0)
    return calls


def step(*, inputs: list[Asset], edit: dict) -> Step:
    return Step(
        provider="track-compositor", model="mux", params={"edit": edit}, inputs=list(inputs)
    )


def clip(start=0.0, label=None, url=None):
    out: dict = {"start_sec": start, "label": label}
    if url:
        out["url"] = url
    return out


def vtrack(*clips, gain=1.0):
    return {"id": "video", "kind": "video", "gain": gain, "clips": list(clips)}


def atrack(*clips, gain=1.0, track_id="a1"):
    return {"id": track_id, "kind": "audio", "gain": gain, "clips": list(clips)}


def edit(*tracks, timeline_sec=30.0):
    return {"timeline_sec": timeline_sec, "tracks": list(tracks)}


def chained(media_type: str, url: str) -> Asset:
    return Asset(url=url, media_type=media_type)


def filter_graph(cmd: list[str]) -> str:
    return cmd[cmd.index("-filter_complex") + 1]


def with_audio(monkeypatch, present: bool) -> None:
    monkeypatch.setattr(
        TrackCompositor, "_has_audio_stream", lambda self, path: present
    )


VIDEO = chained("video/mp4", "file:///v.mp4")
AUDIO_1 = chained("audio/mpeg", "file:///a1.mp3")
AUDIO_2 = chained("audio/mpeg", "file:///a2.mp3")


# --------------------------------------------------------------------------- #
# audio: gain and placement
# --------------------------------------------------------------------------- #


def test_each_track_gets_its_own_gain(captured, monkeypatch):
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, AUDIO_1, AUDIO_2],
            edit=edit(
                vtrack(clip()),
                atrack(clip(label="Music"), gain=0.4),
                atrack(clip(label="VO"), gain=1.5, track_id="a2"),
            ),
        )
    )
    graph = filter_graph(captured[0])
    assert "[1:a]volume=0.4000[m1]" in graph
    assert "[2:a]volume=1.5000[m2]" in graph
    assert "amix=inputs=2" in graph


def test_a_clip_is_delayed_to_where_it_was_dragged(captured, monkeypatch):
    """`adelay` is the whole point of a timeline — without it every clip would
    play from zero no matter where the user put it."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, AUDIO_1],
            edit=edit(vtrack(clip()), atrack(clip(start=2.5, label="VO"))),
        )
    )
    assert "adelay=2500:all=1" in filter_graph(captured[0])


def test_a_clip_at_zero_gets_no_delay_filter(captured, monkeypatch):
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(inputs=[VIDEO, AUDIO_1], edit=edit(vtrack(clip()), atrack(clip())))
    )
    assert "adelay" not in filter_graph(captured[0])


def test_mix_does_not_renormalize(captured, monkeypatch):
    """`normalize=0` is the whole reason a fader means anything: the default
    divides by input count, so adding a track would quieten every other one."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, AUDIO_1, AUDIO_2],
            edit=edit(vtrack(clip()), atrack(clip()), atrack(clip(), track_id="a2")),
        )
    )
    assert "normalize=0" in filter_graph(captured[0])


def test_silent_track_is_dropped_from_the_graph(captured, monkeypatch):
    """A muted track compiles to gain 0. Mixing it in at zero would still cost
    headroom, so it leaves the filter graph entirely."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, AUDIO_1, AUDIO_2],
            edit=edit(
                vtrack(clip()),
                atrack(clip(label="Muted"), gain=0.0),
                atrack(clip(label="VO"), track_id="a2"),
            ),
        )
    )
    graph = filter_graph(captured[0])
    assert "[1:a]" not in graph
    assert "amix" not in graph  # one surviving clip needs no mix at all


def test_video_audio_joins_the_mix_only_when_the_shot_has_any(captured, monkeypatch):
    """A generated video has no audio track, and referencing `[N:a]` for one
    that does not exist fails the entire render."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(inputs=[VIDEO, AUDIO_1], edit=edit(vtrack(clip()), atrack(clip())))
    )
    assert "[0:a]" not in filter_graph(captured[0])

    captured.clear()
    with_audio(monkeypatch, True)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, AUDIO_1],
            edit=edit(vtrack(clip(), gain=0.5), atrack(clip())),
        )
    )
    assert "[0:a]volume=0.5000[m0]" in filter_graph(captured[0])


def test_gain_is_clamped(captured, monkeypatch):
    """A gain past the fader's range would still be a legal filter string, so
    the clamp is the only thing between a bad document and a blown mix."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(inputs=[VIDEO, AUDIO_1], edit=edit(vtrack(clip()), atrack(clip(), gain=99.0)))
    )
    assert "[1:a]volume=2.0000[m1]" in filter_graph(captured[0])


# --------------------------------------------------------------------------- #
# video: one shot vs an edit
# --------------------------------------------------------------------------- #


def test_a_single_shot_at_zero_is_copied_not_re_encoded(captured, monkeypatch):
    """The ordinary case must stay cheap: nothing about the picture changed, so
    it is not worth an x264 pass."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(inputs=[VIDEO, AUDIO_1], edit=edit(vtrack(clip()), atrack(clip())))
    )
    cmd = captured[0]
    assert cmd[cmd.index("-c:v") + 1] == "copy"
    assert "overlay" not in filter_graph(cmd)
    assert cmd[cmd.index("-map") + 1] == "0:v"


def test_several_shots_are_laid_out_along_the_timeline(captured, monkeypatch):
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, chained("video/mp4", "file:///v2.mp4"), AUDIO_1],
            edit=edit(
                vtrack(clip(label="Shot 1"), clip(start=5.0, label="Shot 2")),
                atrack(clip()),
                timeline_sec=12.0,
            ),
        )
    )
    cmd = captured[0]
    graph = filter_graph(cmd)
    # A black canvas running to the end of the last shot, so the gap between
    # the two is black rather than a frozen frame.
    assert "color=c=black:s=640x360:r=30:d=6.000[bg]" in graph
    assert "setpts=PTS-STARTPTS+5.000/TB" in graph
    assert "enable='gte(t,5.000)'" in graph
    # Compositing means the picture is genuinely new, so it has to be encoded.
    assert cmd[cmd.index("-c:v") + 1] == "libx264"


def test_a_single_shot_that_starts_late_is_still_an_edit(captured, monkeypatch):
    """Dragging the only shot off zero means the composition opens on black —
    which a stream copy cannot express."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, AUDIO_1],
            edit=edit(vtrack(clip(start=3.0)), atrack(clip())),
        )
    )
    cmd = captured[0]
    assert cmd[cmd.index("-c:v") + 1] == "libx264"
    assert "overlay" in filter_graph(cmd)


def test_render_length_follows_the_picture_not_the_ruler(captured, monkeypatch):
    """The node's timeline is a ruler the user scrolls. Exporting all of it
    would append however much black they happened to have scrolled to, and a
    ruler shorter than the edit would cut the last shot off."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, chained("video/mp4", "file:///v2.mp4"), AUDIO_1],
            edit=edit(
                vtrack(clip(), clip(start=40.0)), atrack(clip()), timeline_sec=5.0
            ),
        )
    )
    cmd = captured[0]
    assert "d=41.000" in filter_graph(cmd)
    assert cmd[cmd.index("-t") + 1] == "41.000"
    assert "-shortest" not in cmd


def test_the_copy_path_trims_audio_that_outruns_the_shot(captured, monkeypatch):
    """With one shot the picture keeps its own length, so a music bed longer
    than it has to be cut rather than extend the video."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(inputs=[VIDEO, AUDIO_1], edit=edit(vtrack(clip()), atrack(clip())))
    )
    cmd = captured[0]
    assert "-shortest" in cmd
    assert "-t" not in cmd


# --------------------------------------------------------------------------- #
# clip resolution
# --------------------------------------------------------------------------- #


def test_uploaded_clip_is_taken_from_its_url(captured, monkeypatch):
    with_audio(monkeypatch, False)
    result = TrackCompositor().generate(
        step(
            inputs=[VIDEO],
            edit=edit(vtrack(clip()), atrack(clip(label="Upload", url="https://b2/x.mp3"))),
        )
    )
    assert "https://b2/x.mp3" in captured[0]
    # Recorded as an input, or the manifest would lose the uploaded clip.
    assert any(a.url == "https://b2/x.mp3" for a in result.inputs)


def test_chained_clips_are_matched_in_order(captured, monkeypatch):
    """Positional matching is the contract with the compiler — the first audio
    clip takes the first chained audio asset."""
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, chained("audio/mpeg", "file:///first.mp3"),
                    chained("audio/mpeg", "file:///second.mp3")],
            edit=edit(
                vtrack(clip()),
                atrack(clip(), gain=0.2),
                atrack(clip(), gain=0.8, track_id="a2"),
            ),
        )
    )
    cmd = captured[0]
    assert cmd.index("file:///first.mp3") < cmd.index("file:///second.mp3")
    graph = filter_graph(cmd)
    assert "[1:a]volume=0.2000[m1]" in graph and "[2:a]volume=0.8000[m2]" in graph


def test_uploads_and_chained_clips_interleave(captured, monkeypatch):
    with_audio(monkeypatch, False)
    TrackCompositor().generate(
        step(
            inputs=[VIDEO, chained("audio/mpeg", "file:///gen.mp3")],
            edit=edit(
                vtrack(clip()),
                atrack(clip(url="https://b2/up.mp3"), clip()),
            ),
        )
    )
    cmd = captured[0]
    assert cmd[cmd.index("https://b2/up.mp3") - 1] == "-i"
    assert cmd.index("https://b2/up.mp3") < cmd.index("file:///gen.mp3")


def test_missing_chained_audio_is_a_typed_error(captured, monkeypatch):
    with_audio(monkeypatch, False)
    with pytest.raises(ProviderError, match="no audio input"):
        TrackCompositor().generate(
            step(inputs=[VIDEO], edit=edit(vtrack(clip()), atrack(clip())))
        )


def test_fully_muted_composition_is_refused(captured, monkeypatch):
    with_audio(monkeypatch, False)
    with pytest.raises(ProviderError, match="muted or silent"):
        TrackCompositor().generate(
            step(
                inputs=[VIDEO, AUDIO_1],
                edit=edit(vtrack(clip()), atrack(clip(), gain=0.0)),
            )
        )


# --------------------------------------------------------------------------- #
# end to end
# --------------------------------------------------------------------------- #


def make_video(path: Path, seconds: int, pattern: str = "testsrc") -> Path:
    subprocess.run(
        ["ffmpeg", "-f", "lavfi", "-i",
         f"{pattern}=duration={seconds}:size=64x64:rate=10",
         "-pix_fmt", "yuv420p", "-y", str(path)],
        check=True, capture_output=True,
    )
    return path


def make_tone(path: Path, freq: int, seconds: int = 1) -> Path:
    subprocess.run(
        ["ffmpeg", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}",
         "-y", str(path)],
        check=True, capture_output=True,
    )
    return path


def probe_duration(path: Path) -> float:
    return float(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    )


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_renders_a_real_two_track_composition(tmp_path: Path):
    """Proves the single-shot fast path is something ffmpeg actually accepts."""
    video = make_video(tmp_path / "v.mp4", 1)
    tones = [make_tone(tmp_path / f"a{i}.wav", f) for i, f in enumerate((440, 880))]

    result = TrackCompositor(output_dir=tmp_path).generate(
        Step(
            provider="track-compositor",
            model="mux",
            params={
                "edit": {
                    "timeline_sec": 1.0,
                    "tracks": [
                        vtrack(clip(label="Shot")),
                        atrack(clip(label="Music"), gain=0.3),
                        atrack(clip(label="VO"), track_id="a2"),
                    ],
                }
            },
            inputs=[
                Asset(url=video.as_uri(), media_type="video/mp4"),
                *(Asset(url=t.as_uri(), media_type="audio/wav") for t in tones),
            ],
        )
    )

    assert len(result.assets) == 1
    out = result.assets[0]
    assert out.media_type == "video/mp4"
    assert out.sha256 and out.size_bytes
    # Every clip that survived the render is named on the asset, which is what
    # carries the composition into the provenance manifest.
    assert [t.label for t in out.tracks] == ["Shot", "Music", "VO"]

    written = Path(out.url.removeprefix("file://"))
    streams = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
         "-of", "csv=p=0", str(written)],
        check=True, capture_output=True, text=True,
    ).stdout
    assert "video" in streams and "audio" in streams


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_renders_two_shots_cut_one_after_the_other(tmp_path: Path):
    """The edit path: two shots on the picture track and a delayed voice clip,
    which together must produce a file as long as the timeline."""
    first = make_video(tmp_path / "v1.mp4", 1)
    second = make_video(tmp_path / "v2.mp4", 1, pattern="smptebars")
    tone = make_tone(tmp_path / "a.wav", 440)

    result = TrackCompositor(output_dir=tmp_path).generate(
        Step(
            provider="track-compositor",
            model="mux",
            params={
                "edit": {
                    "timeline_sec": 3.0,
                    "tracks": [
                        vtrack(clip(label="Shot 1"), clip(start=1.5, label="Shot 2")),
                        atrack(clip(start=1.0, label="VO")),
                    ],
                }
            },
            inputs=[
                Asset(url=first.as_uri(), media_type="video/mp4"),
                Asset(url=second.as_uri(), media_type="video/mp4"),
                Asset(url=tone.as_uri(), media_type="audio/wav"),
            ],
        )
    )

    written = Path(result.assets[0].url.removeprefix("file://"))
    # The second shot starts at 1.5s and runs a second, so the composition has
    # to be about 2.5s — proof the offset survived into the render rather than
    # every clip collapsing onto zero.
    assert 2.3 <= probe_duration(written) <= 3.2
