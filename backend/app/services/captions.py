"""Video captions — transcribe speech, then burn styled captions into the file.

Two operations, both direct service calls rather than graph runs (the same
reasoning as Magic Text: the modal needs the transcript JSON synchronously,
and the burn is a deterministic local edit, not a provider generation):

- **Transcribe** hands the video to ElevenLabs Scribe and gets back per-word
  timestamps. The canvas turns those into styled, positioned caption cues.
- **Burn** takes the cues the user approved (already grouped into lines by the
  editor, so what was previewed is exactly what renders), writes an ASS
  subtitle file, and re-encodes the video through ffmpeg's libass filter. The
  result is indexed as a *generated* asset under the node, backed by a
  lightweight completed Run — the join that puts it into the node's carousel
  and brings it back on reload via ``/workflows/{id}/results``.

The caption *look* is defined twice by design: `CAPTION_STYLES` here drives
the ASS render, `CAPTION_STYLES` in ``lib/studio/captions.ts`` drives the live
CSS preview. Sizes are fractions of video height and colors are shared hex —
change one side and you must change the other, same contract as
``graph.ts`` ↔ ``schema.py``.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select

from app.config import Settings, StorageMode, get_settings
from app.db.models import (
    Asset,
    AssetKind,
    Run,
    RunStatus,
    RunStep,
    StepStatus,
    Workflow,
)
from app.errors import AppError, NotFound
from app.logging import get_logger
from app.services.magic_text import _store

log = get_logger(__name__)

SCRIBE_MODEL = "scribe_v1"
#: Scribe bills ~$0.40/audio-hour; a 30s clip is ~$0.003. Recorded on the
#: burn's run step so provenance carries what the caption pass actually cost.
SCRIBE_COST_PER_SEC = 0.40 / 3600

_FFMPEG_TIMEOUT_SEC = 600


class CaptionsUnavailable(AppError):
    status, code, title, retryable = (
        503,
        "captions_unavailable",
        "Captions are not available",
        False,
    )


class TranscriptionFailed(AppError):
    status, code, title, retryable = (
        502,
        "transcription_failed",
        "Transcription did not complete",
        True,
    )


class CaptionBurnFailed(AppError):
    status, code, title, retryable = (
        502,
        "caption_burn_failed",
        "Captions could not be rendered",
        True,
    )


# --- styles -----------------------------------------------------------------

#: Accent + ink, straight from the canvas design system.
_ACCENT_HEX = "FACC15"
_INK_HEX = "1F211C"
_CREAM_HEX = "F7F4EE"


def _ass_color(hex_rgb: str, alpha: int = 0) -> str:
    """#RRGGBB → ASS &HAABBGGRR& (alpha 0 = opaque, 255 = invisible)."""
    r, g, b = hex_rgb[0:2], hex_rgb[2:4], hex_rgb[4:6]
    return f"&H{alpha:02X}{b}{g}{r}&".upper()


@dataclass(frozen=True)
class CaptionStyle:
    """One preset — everything the ASS Style line and event tags need."""

    id: str
    fontname: str  # the TTF's *internal* family name; libass matches on it
    size_frac: float  # fontsize as a fraction of video height
    uppercase: bool
    primary_hex: str = "FFFFFF"
    bold: bool = False
    italic: bool = False
    outline_frac: float = 0.0  # outline thickness, fraction of video height
    shadow_frac: float = 0.0
    #: "none" | "color" | "block" — how the currently spoken word is marked.
    highlight: str = "none"
    #: BorderStyle 3: an opaque box behind each line (the lower-third pill).
    boxed: bool = False
    box_alpha: int = 0x50  # ~70% opaque black


#: Mirrored in lib/studio/captions.ts — keep the two in sync.
CAPTION_STYLES: dict[str, CaptionStyle] = {
    style.id: style
    for style in (
        CaptionStyle(
            id="bold-social",
            fontname="Archivo Black",
            size_frac=0.062,
            uppercase=True,
            outline_frac=0.006,
            highlight="block",
        ),
        CaptionStyle(
            id="karaoke",
            fontname="Poppins SemiBold",
            size_frac=0.052,
            uppercase=True,
            outline_frac=0.005,
            highlight="color",
        ),
        CaptionStyle(
            id="outline",
            fontname="Archivo Black",
            size_frac=0.062,
            uppercase=True,
            outline_frac=0.011,
        ),
        CaptionStyle(
            id="classic",
            fontname="Poppins SemiBold",
            size_frac=0.046,
            uppercase=False,
            outline_frac=0.0025,
            shadow_frac=0.004,
        ),
        CaptionStyle(
            id="lower-third",
            fontname="Poppins SemiBold",
            size_frac=0.038,
            uppercase=False,
            boxed=True,
        ),
        CaptionStyle(
            id="editorial-serif",
            fontname="Instrument Serif",
            size_frac=0.06,
            uppercase=False,
            primary_hex=_CREAM_HEX,
            italic=True,
            shadow_frac=0.005,
        ),
    )
}


def _fonts_dir() -> Path:
    """The caption TTFs, shared with the web app so preview == burn."""
    override = os.getenv("CAPTIONS_FONTS_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "public" / "fonts" / "captions"


# --- ASS generation ---------------------------------------------------------


def _timestamp(seconds: float) -> str:
    """ASS event time — H:MM:SS.CC (centiseconds)."""
    total = max(0.0, seconds)
    cs = round(total * 100)
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _escape(text: str) -> str:
    """Word text with everything ASS could read as markup stripped."""
    return text.replace("\\", "").replace("{", "(").replace("}", ")").strip()


def _word_text(word: dict[str, Any], style: CaptionStyle) -> str:
    text = _escape(str(word.get("text", "")))
    return text.upper() if style.uppercase else text


def _cue_lines(cue: dict[str, Any]) -> list[list[dict[str, Any]]]:
    lines = cue.get("lines") or []
    return [line for line in lines if line]


def _line_text(
    line: list[dict[str, Any]],
    style: CaptionStyle,
    active: dict[str, Any] | None,
    block_bord: int,
) -> str:
    """One rendered line, the active word wrapped in its highlight tags."""
    parts: list[str] = []
    for word in line:
        text = _word_text(word, style)
        if not text:
            continue
        if active is not None and word is active:
            if style.highlight == "color":
                text = f"{{\\1c{_ass_color(_ACCENT_HEX)}}}{text}{{\\r}}"
            elif style.highlight == "block":
                # No per-word background in ASS — a fat accent-colored outline
                # around ink-colored text reads as the social-caption block.
                text = (
                    f"{{\\1c{_ass_color(_INK_HEX)}\\3c{_ass_color(_ACCENT_HEX)}"
                    f"\\bord{block_bord}}}{text}{{\\r}}"
                )
        parts.append(text)
    return " ".join(parts)


def build_ass(
    cues: list[dict[str, Any]],
    style_id: str,
    placement: dict[str, float],
    width: int,
    height: int,
) -> str:
    """The subtitle file, verbatim.

    ``cues`` arrive pre-grouped into lines by the editor (measured with the
    same fonts), so no libass wrapping happens — ``\\q2`` pins the breaks. The
    box center is ``placement`` in fractions of the frame, which is what makes
    the same math hold for landscape and vertical renders.
    """
    style = CAPTION_STYLES.get(style_id)
    if style is None:
        raise CaptionBurnFailed(f"Unknown caption style '{style_id}'.")

    # The corner handle's size multiplier; stroke, shadow, and the highlight
    # block all ride along so a grown caption keeps its proportions.
    scale = float(placement.get("scale", 1.0)) or 1.0
    fontsize = max(10, round(style.size_frac * scale * height))
    outline = round(style.outline_frac * scale * height, 1)
    shadow = round(style.shadow_frac * scale * height, 1)
    if style.boxed:
        # BorderStyle 3 draws the outline as box padding around each line.
        border_style, outline = 3, round(0.010 * scale * height, 1)
        back = _ass_color("000000", style.box_alpha)
    else:
        border_style = 1
        back = _ass_color("000000", 0x80)
    block_bord = max(4, round(0.008 * scale * height))

    pos_x = round(placement.get("x", 0.5) * width)
    pos_y = round(placement.get("y", 0.82) * height)

    header = "\n".join(
        [
            "[Script Info]",
            "; Generated by asset-flow captions",
            "ScriptType: v4.00+",
            f"PlayResX: {width}",
            f"PlayResY: {height}",
            "ScaledBorderAndShadow: yes",
            "WrapStyle: 2",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding",
            f"Style: Caption,{style.fontname},{fontsize},"
            f"{_ass_color(style.primary_hex)},{_ass_color(style.primary_hex)},"
            f"{_ass_color('000000')},{back},"
            f"{-1 if style.bold else 0},{-1 if style.italic else 0},0,0,"
            f"100,100,0,0,{border_style},{outline},{shadow},5,0,0,0,1",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
            "MarginV, Effect, Text",
        ]
    )

    tags = f"{{\\q2\\pos({pos_x},{pos_y})}}"
    events: list[str] = []

    def emit(start: float, end: float, text: str) -> None:
        if end - start < 0.01 or not text:
            return
        events.append(
            f"Dialogue: 0,{_timestamp(start)},{_timestamp(end)},"
            f"Caption,,0,0,0,,{tags}{text}"
        )

    for cue in cues:
        lines = _cue_lines(cue)
        if not lines:
            continue
        cue_start = float(cue.get("start", 0.0))
        cue_end = float(cue.get("end", cue_start))

        if style.highlight == "none":
            text = "\\N".join(
                _line_text(line, style, None, block_bord) for line in lines
            )
            emit(cue_start, cue_end, text)
            continue

        # One event per spoken word, each re-emitting the whole cue with that
        # word highlighted. Windows run to the *next* word's start so the text
        # never flickers out between words.
        words = [w for line in lines for w in line]
        for i, word in enumerate(words):
            start = max(cue_start, float(word.get("start", cue_start)))
            end = (
                float(words[i + 1].get("start", cue_end))
                if i + 1 < len(words)
                else cue_end
            )
            text = "\\N".join(
                _line_text(line, style, word, block_bord) for line in lines
            )
            emit(start, end, text)

    return header + "\n" + "\n".join(events) + "\n"


# --- transcription ----------------------------------------------------------


def _transcript_key(settings: Settings, asset: Asset) -> str:
    """Where this asset's transcript sidecar lives in storage.

    Keyed by asset id: the id names immutable stored bytes, so the sidecar is
    valid for as long as the asset exists — a new take is a new id.
    """
    prefix = (
        f"{settings.b2_prefix}/{asset.tenant_id}"
        if settings.storage_mode is StorageMode.B2
        else asset.tenant_id
    )
    return f"{prefix}/captions/transcripts/{asset.id}.json"


async def _cached_transcript(key: str, settings: Settings) -> dict | None:
    """The stored sidecar, or None. Absence and unreadability look the same —
    either way the answer is a fresh Scribe call."""
    if settings.storage_mode is StorageMode.B2:
        from app.engine.manifests import presign

        try:
            url = presign(key, expires_in=600)
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(url)
            if resp.status_code == 200:
                body = resp.json()
                return body if isinstance(body, dict) else None
        except Exception:  # noqa: BLE001 - a cache miss, whatever the cause
            return None
        return None

    path = settings.local_media_dir / key
    if not path.is_file():
        return None
    try:
        body = json.loads(path.read_text())
        return body if isinstance(body, dict) else None
    except (OSError, ValueError):
        return None


async def _asset_bytes(asset: Asset, settings: Settings) -> bytes:
    """The asset's stored bytes, whichever storage mode holds them."""
    if settings.storage_mode is StorageMode.B2:
        from app.engine.manifests import presign

        url = presign(asset.b2_key or asset.url, expires_in=3600)
        async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as client:
            resp = await client.get(url)
            if resp.status_code >= 400:
                raise NotFound("The asset's bytes are not reachable in storage.")
            return resp.content

    path = settings.local_media_dir / (asset.b2_key or "")
    if not path.is_file():
        raise NotFound("The asset's bytes are not reachable in storage.")
    return path.read_bytes()


def _scribe_client() -> Any:
    if not os.getenv("ELEVENLABS_API_KEY"):
        raise CaptionsUnavailable("Set ELEVENLABS_API_KEY to enable captions.")
    try:
        from elevenlabs.client import ElevenLabs
    except ImportError as exc:  # pragma: no cover - environment guard
        raise CaptionsUnavailable(
            "elevenlabs package not installed. Run: pip install elevenlabs"
        ) from exc
    return ElevenLabs()


async def transcribe_asset(asset: Asset, settings: Settings | None = None) -> dict:
    """Scribe's word-level transcript for one stored video (or audio) asset.

    Returns ``{"has_speech", "language", "duration_sec", "words"}`` where each
    word is ``{"text", "start", "end"}`` in seconds. ``has_speech`` is decided
    by Scribe's own word typing — sound effects and music come back as
    ``audio_event`` entries, never ``word``.

    Transcripts persist as storage sidecars keyed by asset id — the second
    request for the same take (another session, a reload, another user in the
    tenant) reads the sidecar and never re-bills Scribe.
    """
    settings = settings or get_settings()
    sidecar_key = _transcript_key(settings, asset)
    cached = await _cached_transcript(sidecar_key, settings)
    if cached is not None and isinstance(cached.get("words"), list):
        return cached

    data = await _asset_bytes(asset, settings)
    client = _scribe_client()

    def _convert() -> Any:
        return client.speech_to_text.convert(
            file=(asset.filename or "video.mp4", io.BytesIO(data), asset.media_type),
            model_id=SCRIBE_MODEL,
            timestamps_granularity="word",
            tag_audio_events=False,
        )

    try:
        result = await asyncio.to_thread(_convert)
    except Exception as exc:
        raise TranscriptionFailed(f"Scribe failed: {str(exc)[:300]}") from exc

    # Multichannel responses nest transcripts; take the first channel.
    if hasattr(result, "transcripts"):
        transcripts = result.transcripts
        result = transcripts[0] if transcripts else result

    words = [
        {
            "text": (w.text or "").strip(),
            "start": round(float(w.start or 0.0), 3),
            "end": round(float(w.end or 0.0), 3),
        }
        for w in (getattr(result, "words", None) or [])
        if getattr(w, "type", "word") == "word" and (w.text or "").strip()
    ]
    duration = float(getattr(result, "audio_duration_secs", None) or 0.0)
    if not duration and words:
        duration = words[-1]["end"]

    payload = {
        "has_speech": bool(words),
        "language": getattr(result, "language_code", None),
        "duration_sec": round(duration, 3),
        "words": words,
    }

    # Best-effort: a storage hiccup must not fail a transcription that
    # succeeded — the worst case is paying Scribe again next time.
    try:
        sidecar = json.dumps(payload).encode()
        await _store(
            sidecar,
            key=sidecar_key,
            media_type="application/json",
            sha256=hashlib.sha256(sidecar).hexdigest(),
            settings=settings,
        )
    except Exception:  # noqa: BLE001 - worst case is paying Scribe again
        log.warning("captions.transcript_store_failed", asset=str(asset.id))
    return payload


# --- burn -------------------------------------------------------------------


def _ffmpeg_bin() -> str:
    from genblaze_core.providers._ffmpeg_utils import resolve_ffmpeg

    return resolve_ffmpeg("ffmpeg")


def _probe_size(src: Path) -> tuple[int, int] | None:
    probe = _ffmpeg_bin().replace("ffmpeg", "ffprobe")
    try:
        out = subprocess.run(
            [
                probe, "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height", "-of", "csv=p=0", str(src),
            ],
            capture_output=True, text=True, timeout=60, check=False,
        ).stdout.strip()
        w, h = (int(p) for p in out.split(",")[:2])
        return (w, h) if w and h else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None


def burn_command(src: str, subs: str, fonts_dir: str, out: str) -> list[str]:
    """The ffmpeg invocation, exposed for the unit tests to assert on."""
    return [
        _ffmpeg_bin(), "-y", "-i", src,
        "-vf", f"ass={subs}:fontsdir={fonts_dir}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-c:a", "copy", "-movflags", "+faststart", out,
    ]


async def burn_captions(
    session,
    *,
    asset: Asset,
    tenant_id: str,
    user_id: str,
    workflow_id: uuid.UUID,
    node_id: str,
    cues: list[dict[str, Any]],
    style_id: str,
    placement: dict[str, float],
    settings: Settings | None = None,
) -> Asset:
    """Render the approved captions into the video and index the result.

    Mirrors ``register_text_edit``: a minimal completed Run + one step is what
    joins the new file into the node's carousel and ``/results`` hydration,
    and the step doubles as provenance — the manifest carries the full
    transcript, style, and placement, so the sealed record can say exactly
    which words were burned where.
    """
    settings = settings or get_settings()

    workflow = (
        await session.execute(
            select(Workflow).where(
                Workflow.id == workflow_id, Workflow.tenant_id == tenant_id
            )
        )
    ).scalar_one_or_none()
    if workflow is None:
        raise NotFound(f"Workflow {workflow_id} was not found.")

    source = await _asset_bytes(asset, settings)
    fonts = _fonts_dir()
    if not fonts.is_dir():
        raise CaptionsUnavailable(
            f"Caption fonts not found at {fonts} — set CAPTIONS_FONTS_DIR."
        )

    with tempfile.TemporaryDirectory(prefix="captions-") as tmp:
        tmp_dir = Path(tmp)
        src = tmp_dir / "source.mp4"
        src.write_bytes(source)

        size = (
            (asset.width, asset.height)
            if asset.width and asset.height
            else _probe_size(src)
        )
        if not size:
            raise CaptionBurnFailed("Could not read the video's dimensions.")
        width, height = size

        subs = tmp_dir / "subs.ass"
        subs.write_text(build_ass(cues, style_id, placement, width, height))
        out = tmp_dir / "out.mp4"

        # Bare filenames with cwd=tmp — the ass filter parses ':' and ','
        # in its arguments, and a temp-relative name has neither.
        cmd = burn_command("source.mp4", "subs.ass", str(fonts), "out.mp4")

        def _render() -> subprocess.CompletedProcess:
            return subprocess.run(
                cmd, cwd=tmp_dir, capture_output=True, text=True,
                timeout=_FFMPEG_TIMEOUT_SEC,
            )

        try:
            proc = await asyncio.to_thread(_render)
        except subprocess.TimeoutExpired as exc:
            raise CaptionBurnFailed("The caption render timed out.") from exc
        if proc.returncode != 0 or not out.is_file():
            tail = (proc.stderr or "")[-400:]
            raise CaptionBurnFailed(f"ffmpeg failed: {tail}")
        rendered = out.read_bytes()

    sha = hashlib.sha256(rendered).hexdigest()
    prefix = (
        f"{settings.b2_prefix}/{tenant_id}"
        if settings.storage_mode is StorageMode.B2
        else tenant_id
    )
    url, key = await _store(
        rendered,
        key=f"{prefix}/captions/{sha}-captioned.mp4",
        media_type="video/mp4",
        sha256=sha,
        settings=settings,
    )

    word_count = sum(len(line) for cue in cues for line in _cue_lines(cue))
    duration = max((float(c.get("end", 0.0)) for c in cues), default=0.0)
    manifest = {
        "kind": "captions.burn",
        "created_at": datetime.now(UTC).isoformat(),
        "source_asset_id": str(asset.id),
        "workflow_id": str(workflow_id),
        "node_id": node_id,
        "transcription": {"provider": "elevenlabs", "model": SCRIBE_MODEL},
        "style": style_id,
        "placement": placement,
        "cues": cues,
        "output": {"b2_key": key, "sha256": sha, "size": [width, height]},
        "rendered_by": "ffmpeg/libass",
    }
    manifest_bytes = json.dumps(manifest, indent=1).encode()
    manifest_url, _ = await _store(
        manifest_bytes,
        key=f"{prefix}/captions/{sha}-captioned.manifest.json",
        media_type="application/json",
        sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        settings=settings,
    )

    cost = round(duration * SCRIBE_COST_PER_SEC, 6)
    now = datetime.now(UTC)
    run = Run(
        tenant_id=tenant_id,
        owner_user_id=user_id,
        workflow_id=workflow_id,
        graph_snapshot={"version": 1, "nodes": [], "edges": []},
        plan_snapshot={"source": "captions", "steps": []},
        status=RunStatus.SUCCEEDED,
        manifest_uri=manifest_url,
        total_cost_usd=cost,
        started_at=now,
        finished_at=now,
    )
    session.add(run)
    await session.flush()

    session.add(
        RunStep(
            run_id=run.id,
            node_id=node_id,
            step_index=0,
            provider="captions",
            model=SCRIBE_MODEL,
            modality="video",
            step_type="edit",
            status=StepStatus.SUCCEEDED,
            params={
                "source_asset_id": str(asset.id),
                "style": style_id,
                "placement": placement,
                "words": word_count,
            },
            cost_usd=cost,
            started_at=now,
            finished_at=now,
        )
    )

    burned = Asset(
        tenant_id=tenant_id,
        kind=AssetKind.GENERATED,
        run_id=run.id,
        node_id=node_id,
        url=url,
        b2_key=key,
        media_type="video/mp4",
        modality="video",
        sha256=sha,
        size_bytes=len(rendered),
        width=width,
        height=height,
        manifest_uri=manifest_url,
        filename="captioned.mp4",
        asset_metadata={
            "source": "captions.burn",
            "base_asset_id": str(asset.id),
            "caption_style": style_id,
        },
    )
    session.add(burned)
    await session.commit()
    await session.refresh(burned)
    log.info(
        "captions.burned", tenant=tenant_id, node=node_id, style=style_id,
        words=word_count,
    )

    from app.services.enrich import schedule_enrichment

    schedule_enrichment(burned.id)
    return burned
