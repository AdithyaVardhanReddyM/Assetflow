"""The compositor behind a Composition node.

GenBlaze ships `FFmpegCompositor`, which takes exactly one video and one audio,
stream-copies them into an MP4 and ignores `step.params` — so it can express
neither several clips on a timeline nor a gain on any of them. The canvas offers
both, so the render belongs to us.

The contract with the compiler is `params["edit"]`, built by `_build_mix_step`
in `graph/compile.py`:

    {"timeline_sec": 30.0,
     "tracks": [
       {"id": "video", "kind": "video", "gain": 1.0,
        "clips": [{"start_sec": 0.0, "label": "Shot 1", "url": null}, ...]},
       {"id": "a1", "kind": "audio", "gain": 0.4,
        "clips": [{"start_sec": 2.0, "label": "Music", "url": "https://…"}]}]}

A clip naming a `url` is an upload, which reaches us as a URL rather than a
chained asset (GenBlaze rejects `external_inputs` alongside `input_from`). Every
other clip is matched to `step.inputs` **by position**, within its media class:
the compiler walks tracks in order and clips along each one in time order, and
emits `input_from` the same way. That holds because each upstream step yields
one asset.

Uploads resolved here are appended to `step.inputs` so a clip that arrived as a
URL still shows up as an input on the run manifest — otherwise the provenance
chain would silently lose every uploaded clip.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

from genblaze_core.exceptions import ProviderError
from genblaze_core.models.asset import Asset, AudioMetadata, Track, VideoMetadata
from genblaze_core.models.enums import Modality, ProviderErrorCode, StepType
from genblaze_core.models.step import Step
from genblaze_core.providers._ffmpeg_utils import (
    FFMPEG_TIMEOUT,
    get_output_path,
    populate_file_asset_integrity,
    resolve_ffmpeg,
    resolve_input_path,
    run_ffmpeg,
)
from genblaze_core.providers.base import ProviderCapabilities, SyncProvider
from genblaze_core.runnable.config import RunnableConfig

from app.logging import get_logger

log = get_logger(__name__)

#: Gains are linear multipliers straight into ffmpeg's `volume` filter, and the
#: canvas fader spans the same range. Mirrors `CompositeTrack.gain` in schema.py.
MAX_GAIN = 2.0
#: Below this a clip is inaudible, so it is dropped from the filter graph
#: entirely rather than mixed in at zero — `amix` divides headroom across its
#: inputs, so a silent one would quietly attenuate the audible clips.
SILENCE_EPSILON = 1e-4

#: Only used when an uploaded clip arrives without its media type — ffmpeg
#: sniffs the container anyway, so this exists to keep the manifest's Asset
#: well-formed rather than to steer decoding.
_FALLBACK_MEDIA_TYPE = {"video": "video/mp4", "audio": "audio/mpeg"}

#: What the picture falls back to when the timeline is not fully covered, and
#: what a multi-clip edit is composited onto.
_FALLBACK_SIZE = (1280, 720)
_FALLBACK_FPS = 30


def _gain(track: dict[str, Any]) -> float:
    raw = track.get("gain", 1.0)
    try:
        gain = float(raw)
    except (TypeError, ValueError):
        return 1.0
    if gain != gain:  # NaN, which would poison the filter string
        return 1.0
    return max(0.0, min(MAX_GAIN, gain))


def _start(clip: dict[str, Any]) -> float:
    try:
        return max(0.0, float(clip.get("start_sec", 0.0)))
    except (TypeError, ValueError):
        return 0.0


@dataclass(slots=True)
class _Input:
    """One decoded ffmpeg input: a clip, plus where it sits and how loud."""

    index: int
    path: str
    kind: str
    start: float
    gain: float
    label: str


class TrackCompositor(SyncProvider):
    """Renders a composition node's timeline into one MP4.

    Args:
        output_dir: Directory for output files (default system temp).
        ffmpeg_path: Path to the ffmpeg binary (default "ffmpeg" — uses PATH).
        timeout: Subprocess timeout in seconds.
    """

    name = "track-compositor"

    def __init__(
        self,
        output_dir: str | Path | None = None,
        ffmpeg_path: str = "ffmpeg",
        timeout: float = FFMPEG_TIMEOUT,
    ) -> None:
        super().__init__()
        self._output_dir = Path(output_dir) if output_dir else None
        self._ffmpeg_path = ffmpeg_path
        self._timeout = timeout

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.VIDEO],
            supported_inputs=["video", "audio"],
            accepts_chain_input=True,
            output_formats=["video/mp4"],
        )

    # -- probing ------------------------------------------------------------

    def _ffprobe(self, args: list[str]) -> str:
        probe = resolve_ffmpeg(self._ffmpeg_path).replace("ffmpeg", "ffprobe")
        try:
            result = subprocess.run(
                [probe, "-v", "error", *args],
                capture_output=True,
                timeout=min(self._timeout, 30),
            )
        except (OSError, subprocess.TimeoutExpired):
            log.warning("compositor.probe_failed", args=args[:2])
            return ""
        return result.stdout.decode(errors="replace").strip() if result.returncode == 0 else ""

    def _has_audio_stream(self, path: str) -> bool:
        """Whether an input carries audio at all.

        A generated video usually has no audio track, and referencing `[N:a]`
        for one that does not exist fails the entire render — so a picture clip
        joins the mix only when it has something to contribute.
        """
        return bool(
            self._ffprobe(
                ["-select_streams", "a", "-show_entries", "stream=index",
                 "-of", "csv=p=0", path]
            )
        )

    def _duration(self, path: str) -> float:
        raw = self._ffprobe(
            ["-show_entries", "format=duration", "-of", "csv=p=0", path]
        )
        try:
            return max(0.0, float(raw))
        except (TypeError, ValueError):
            return 0.0

    def _frame_size(self, path: str) -> tuple[int, int]:
        """The canvas a multi-clip edit is composited onto — taken from the
        first shot, so a 9:16 composition does not get letterboxed into 16:9."""
        raw = self._ffprobe(
            ["-select_streams", "v:0", "-show_entries", "stream=width,height",
             "-of", "csv=p=0", path]
        )
        try:
            width, height = (int(v) for v in raw.split(",")[:2])
        except (TypeError, ValueError):
            return _FALLBACK_SIZE
        return (width, height) if width > 0 and height > 0 else _FALLBACK_SIZE

    # -- input resolution ---------------------------------------------------

    def _roots(self) -> list[Path] | None:
        return [self._output_dir] if self._output_dir else None

    def _resolve(self, edit: dict[str, Any], step: Step) -> list[_Input]:
        """Every clip in the edit, in the compiler's order, as an ffmpeg input.

        Chained clips consume `step.inputs` of their media class in order; the
        pools are mutated as we walk, which is what makes position the match.
        """
        pools = {
            "video": [a for a in step.inputs if a.media_type.startswith("video/")],
            "audio": [a for a in step.inputs if a.media_type.startswith("audio/")],
        }
        resolved: list[_Input] = []

        for track in edit.get("tracks") or []:
            kind = "video" if track.get("kind") == "video" else "audio"
            gain = _gain(track)
            for clip in track.get("clips") or []:
                url = clip.get("url")
                if url:
                    step.inputs.append(
                        Asset(
                            url=str(url),
                            media_type=str(
                                clip.get("media_type") or _FALLBACK_MEDIA_TYPE[kind]
                            ),
                        )
                    )
                    path = resolve_input_path(str(url), extra_roots=self._roots())
                elif pools[kind]:
                    path = resolve_input_path(
                        pools[kind].pop(0).url, extra_roots=self._roots()
                    )
                else:
                    raise ProviderError(
                        f"Composition clip {clip.get('label') or kind!r} has no "
                        f"{kind} input. Expected a chained {kind} asset but the "
                        "step received none.",
                        error_code=ProviderErrorCode.INVALID_INPUT,
                    )
                resolved.append(
                    _Input(
                        index=len(resolved),
                        path=path,
                        kind=kind,
                        start=_start(clip),
                        gain=gain,
                        label=str(clip.get("label") or kind),
                    )
                )
        return resolved

    # -- filter graph -------------------------------------------------------

    def _picture_end(self, shots: list[_Input], fallback: float) -> float:
        """When the last shot finishes.

        This — not the node's timeline — is how long the render lasts. A
        timeline is a ruler the user scrolls; exporting all of it would append
        however much black they happened to have scrolled to.
        """
        end = max((s.start + self._duration(s.path) for s in shots), default=0.0)
        return end if end > SILENCE_EPSILON else fallback

    def _video_chain(
        self, shots: list[_Input], picture_end: float
    ) -> tuple[list[str], str, bool]:
        """Filters for the picture track, its output label, and whether the
        video had to be re-encoded.

        A single shot starting at zero is the ordinary case and is left exactly
        as it is — copied, not re-encoded. Anything else is an edit: the shots
        are laid onto a black canvas at their own start times, so a gap between
        two of them is black rather than a frozen frame.
        """
        if len(shots) == 1 and shots[0].start <= SILENCE_EPSILON:
            return [], "0:v", False

        width, height = self._frame_size(shots[0].path)
        chains = [
            f"color=c=black:s={width}x{height}:r={_FALLBACK_FPS}:d={picture_end:.3f}[bg]"
        ]
        current = "[bg]"
        for position, shot in enumerate(shots):
            # `setpts` moves the shot to its start; `overlay` then shows it only
            # from that moment, so earlier shots keep the screen until it lands.
            chains.append(
                f"[{shot.index}:v]setpts=PTS-STARTPTS+{shot.start:.3f}/TB,"
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2[s{position}]"
            )
            label = f"[vv{position}]"
            chains.append(
                f"{current}[s{position}]overlay=eof_action=pass:"
                f"enable='gte(t,{shot.start:.3f})'{label}"
            )
            current = label
        # Kept bracketed: `-map` names a filter output that way, where the fast
        # path above names a stream on an input and must not be.
        return chains, current, True

    def _audio_chain(self, inputs: list[_Input]) -> tuple[list[str], str | None]:
        """Filters for everything audible, and the label carrying the mix."""
        chains: list[str] = []
        labels: list[str] = []
        for item in inputs:
            if item.gain <= SILENCE_EPSILON:
                continue  # muted, or faded to nothing — see SILENCE_EPSILON
            if item.kind == "video" and not self._has_audio_stream(item.path):
                continue
            label = f"[m{item.index}]"
            # `adelay` is what puts a clip where the user dragged it; `all=1`
            # applies it to every channel, or a stereo track loses one side.
            delay = f",adelay={int(item.start * 1000)}:all=1" if item.start > 0 else ""
            chains.append(f"[{item.index}:a]volume={item.gain:.4f}{delay}{label}")
            labels.append(label)

        if not labels:
            return [], None
        if len(labels) == 1:
            # `amix` with a single input is a no-op that still renormalizes;
            # the volume chain alone already produced what we want.
            return chains, labels[0]
        # normalize=0 keeps each clip at the level the user set. The default
        # divides by the input count, which turns "add a track" into "make
        # everything quieter" — the opposite of what a fader promises.
        chains.append(
            f"{''.join(labels)}amix=inputs={len(labels)}:"
            "duration=longest:dropout_transition=0:normalize=0[aout]"
        )
        return chains, "[aout]"

    # -- render -------------------------------------------------------------

    def generate(self, step: Step, config: RunnableConfig | None = None) -> Step:
        ffmpeg_bin = resolve_ffmpeg(self._ffmpeg_path)

        edit = step.params.get("edit") or {}
        try:
            timeline = float(edit.get("timeline_sec") or 0.0)
        except (TypeError, ValueError):
            timeline = 0.0

        inputs = self._resolve(edit, step)
        shots = [i for i in inputs if i.kind == "video"]
        if not shots:
            raise ProviderError(
                "Composition step has no video clips. The compiler should have "
                "rejected this graph before it reached a provider.",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        if not any(i.kind == "audio" for i in inputs):
            raise ProviderError(
                "Composition step has no audio clips. The compiler should have "
                "rejected this graph before it reached a provider.",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )

        picture_end = self._picture_end(shots, fallback=timeline)
        video_chains, video_label, reencoded = self._video_chain(shots, picture_end)
        audio_chains, audio_label = self._audio_chain(inputs)
        if audio_label is None:
            raise ProviderError(
                "Every audio clip in this composition is muted or silent. "
                "Raise a fader, or unmute a track.",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )

        out_path = get_output_path(step.step_id, "mp4", self._output_dir)
        cmd = [ffmpeg_bin]
        for item in inputs:
            cmd += ["-i", item.path]
        cmd += [
            "-filter_complex", ";".join([*video_chains, *audio_chains]),
            "-map", video_label,
            "-map", audio_label,
            # Only re-encode the picture when the edit actually changed it.
            *(["-c:v", "libx264", "-pix_fmt", "yuv420p"] if reencoded else ["-c:v", "copy"]),
            "-c:a", "aac",
            "-b:a", "192k",
            # The composition is as long as its picture track, on both paths.
            # `-t` trims a music bed that outruns the shot, and audio shorter
            # than the picture simply ends early inside it. This must never be
            # `-shortest`: that ends the file at the *shortest* stream, so one
            # second of audio under a four-second shot cut the render to one
            # second.
            "-t", f"{picture_end:.3f}",
            "-y",
            str(out_path),
        ]

        log.info(
            "compositor.render",
            step_id=step.step_id,
            shots=len(shots),
            audio_clips=sum(1 for i in inputs if i.kind == "audio"),
            picture_end_sec=round(picture_end, 2),
            reencoded=reencoded,
        )
        run_ffmpeg(cmd, timeout=self._timeout)

        asset = Asset(url=f"file://{quote(str(out_path.resolve()))}", media_type="video/mp4")
        asset.video = VideoMetadata(has_audio=True)
        asset.audio = AudioMetadata(codec="aac")
        # One entry per clip that survived into the render, named as the canvas
        # names it — the manifest then says what the composition is made of.
        asset.tracks = [
            Track(kind=item.kind, codec="aac" if item.kind == "audio" else None,
                  label=item.label)
            for item in inputs
            if item.kind == "video" or item.gain > SILENCE_EPSILON
        ]

        populate_file_asset_integrity(asset, out_path)

        step.assets.append(asset)
        step.step_type = StepType.MIX
        return step
