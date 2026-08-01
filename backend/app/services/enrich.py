"""Asset enrichment — the metadata that makes the library searchable.

Runs *after* an asset lands (fire-and-forget from upload ingest and from the
run finalizer), never inside a request or an event stream: a vision call is
seconds long and worth nothing to the user until they search. Failure marks the
row `failed` and touches nothing else — an upload or a run must never be lost
to a captioning outage.

What gets extracted depends on what the asset is:

- images: one vision call → caption, tags, OCR text, palette. Uploads (brand
  assets) lean on this entirely — they have no prompt.
- videos: three ffmpeg keyframes → the same vision call, multi-image.
- generated audio: the prompt *is* the description. TTS speech indexes its own
  script; music and SFX get a cheap LLM pass turning the prompt into
  mood/genre/instrument tags. No STT anywhere, by design.
- uploaded audio: skipped (filename only) — not a thing users do here.
- LLM text output: indexes its own words.

Everything found is assembled into one text document: the tsvector generates
from it in the database, Jina embeds it, and the same JSON is written beside
the object in B2 — the bucket holds the metadata of record, Postgres indexes it.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import subprocess
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from genblaze_core.exceptions import ProviderError
from genblaze_gmicloud import achat
from pydantic import BaseModel
from sqlalchemy import select

from app.config import Settings, StorageMode, get_settings
from app.db.models import Asset, AssetEnrichment, AssetKind, EnrichmentStatus, RunStep
from app.logging import get_logger
from app.services.embeddings import embed_passage, vector_literal

log = get_logger(__name__)

#: Keyframes sampled per video — start, middle, end-ish. One multi-image call
#: describes them together; more frames buys little and doubles tokens.
_KEYFRAME_POINTS = (0.1, 0.5, 0.9)
_KEYFRAME_WIDTH = 512

#: Images larger than this are not inlined as data URLs (local mode only —
#: B2 assets travel by presigned URL and never through this process).
_MAX_INLINE_BYTES = 8 * 1024 * 1024

_VISION_SYSTEM = (
    "You are an asset librarian. Describe the provided media for search "
    "indexing. caption: one factual sentence. tags: 5-10 lowercase keywords. "
    "ocr_text: any legible text in the image, or null. palette: up to 5 "
    "dominant colors as lowercase hex strings. For multiple frames of one "
    "video, describe the video as a whole."
)

_AUDIO_SYSTEM = (
    "You are an audio librarian. Given the text prompt that generated an "
    "audio asset: caption: one sentence describing the audio. tags: 5-10 "
    "lowercase keywords covering mood, genre, instruments, and tempo."
)


# The classify step's contract, enforced on the wire: GenBlaze coerces these
# into the json_schema response_format GMI serves, so the reply is shaped
# JSON rather than prose-that-usually-is. The article's pipeline
# `step_type="classify"` hasn't shipped in the SDK yet; the standalone chat
# connector is the same machinery without the manifest.
class _DescribedFormat(BaseModel):
    caption: str
    tags: list[str]
    ocr_text: str | None
    palette: list[str]


class _AudioFormat(BaseModel):
    caption: str
    tags: list[str]

#: Model-id substrings that mark generated audio as music or sound effects
#: rather than speech. Matches the catalog's real ids (music_v2,
#: eleven_text_to_sound_v2) and the mocks (mock-audio-v1 is music).
_MUSICLIKE = ("music", "sound", "sfx", "audio")


# --- GMI Cloud, via GenBlaze's chat connector --------------------------------


def _parse_json_reply(content: str) -> dict[str, Any] | None:
    """The model's JSON, tolerating the fences it was told not to add."""
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _clean_described(parsed: dict[str, Any]) -> dict[str, Any]:
    tags = [
        str(t).strip().lower()
        for t in (parsed.get("tags") or [])
        if isinstance(t, (str, int, float)) and str(t).strip()
    ][:12]
    palette = [
        str(c).strip().lower()
        for c in (parsed.get("palette") or [])
        if isinstance(c, str) and c.strip().startswith("#")
    ][:6]
    caption = str(parsed.get("caption") or "").strip()[:500] or None
    ocr = str(parsed.get("ocr_text") or "").strip()[:2000] or None
    return {"caption": caption, "tags": tags, "ocr_text": ocr, "palette": palette}


async def _chat(
    *,
    system: str,
    content: Any,
    response_format: type[BaseModel],
    settings: Settings,
) -> dict[str, Any] | None:
    """One structured chat call; None on any failure — enrichment degrades.

    `achat` runs the blocking HTTP call in a worker thread, so a slow vision
    call never stalls the event loop the way the sink flush once did.
    """
    try:
        resp = await achat(
            settings.enrich_vision_model,
            messages=[{"role": "user", "content": content}],
            system=system,
            response_format=response_format,
            max_tokens=600,
            timeout=90.0,
            # Descriptions, not deliberation. Today's Flash-Lite spends zero
            # reasoning tokens unprompted, but a capped budget plus an enabled
            # trace is how reasoning models return empty content (see the LLM
            # node's provider for the long version).
            reasoning_effort="none",
        )
    except ProviderError as exc:
        log.warning(
            "enrich.vision_failed", code=str(exc.error_code), error=str(exc)[:200]
        )
        return None
    parsed = _parse_json_reply(resp.text)
    if parsed is None:
        log.warning("enrich.vision_unparseable", head=resp.text[:120])
    return parsed


async def describe_images(
    sources: list[str], *, context: str | None, settings: Settings
) -> dict[str, Any] | None:
    """Caption/tags/OCR/palette for one or more frames of the same asset."""
    if not os.getenv("GMI_API_KEY") or not sources:
        return None
    prompt = "Describe this media for search."
    if context:
        prompt += f' It was generated from the prompt: "{context[:500]}"'
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    content += [{"type": "image_url", "image_url": {"url": s}} for s in sources]
    parsed = await _chat(
        system=_VISION_SYSTEM,
        content=content,
        response_format=_DescribedFormat,
        settings=settings,
    )
    return _clean_described(parsed) if parsed else None


async def describe_audio_prompt(
    prompt: str, *, settings: Settings
) -> dict[str, Any] | None:
    """Mood/genre/instrument tags for music or SFX, derived from its prompt."""
    if not os.getenv("GMI_API_KEY") or not prompt.strip():
        return None
    parsed = await _chat(
        system=_AUDIO_SYSTEM,
        content=f'The generation prompt was: "{prompt[:1000]}"',
        response_format=_AudioFormat,
        settings=settings,
    )
    if not parsed:
        return None
    cleaned = _clean_described(parsed)
    cleaned["ocr_text"] = None
    cleaned["palette"] = []
    return cleaned


# --- media sources ----------------------------------------------------------


def _fetchable_url(asset: Asset, settings: Settings) -> str | None:
    """A URL the vision model can fetch, or None when only bytes will do."""
    if settings.storage_mode is StorageMode.B2:
        from app.engine.manifests import sign_for_fetch

        return sign_for_fetch(asset.url)
    return None


async def _image_source(asset: Asset, settings: Settings) -> str | None:
    """The image as something a vision model accepts: presigned URL, or a data
    URL in local mode (localhost is not fetchable from GMI Cloud)."""
    url = _fetchable_url(asset, settings)
    if url:
        return url
    if asset.size_bytes and asset.size_bytes > _MAX_INLINE_BYTES:
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(asset.url)
            resp.raise_for_status()
            data = resp.content
    except httpx.HTTPError:
        return None
    if len(data) > _MAX_INLINE_BYTES:
        return None
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{asset.media_type};base64,{encoded}"


def _extract_keyframes(target: str, duration: float) -> list[str]:
    """Data URLs of a few JPEG frames, pulled straight off the (presigned) URL.

    Blocking — call via a worker thread. Frames rather than the file because a
    vision model wants pictures, and three stills at 512px describe a clip for
    a fraction of the upload."""
    from genblaze_core.providers._ffmpeg_utils import resolve_ffmpeg

    ffmpeg = resolve_ffmpeg("ffmpeg")
    frames: list[str] = []
    with tempfile.TemporaryDirectory(prefix="assetflow-enrich-") as tmp:
        for i, fraction in enumerate(_KEYFRAME_POINTS):
            seek = max(0.0, (duration or 0.0) * fraction)
            out = Path(tmp) / f"frame-{i}.jpg"
            try:
                subprocess.run(
                    [
                        ffmpeg, "-nostdin", "-v", "error",
                        "-ss", f"{seek:.2f}",
                        "-i", target,
                        "-frames:v", "1",
                        "-vf", f"scale={_KEYFRAME_WIDTH}:-2",
                        "-q:v", "5",
                        str(out),
                    ],
                    capture_output=True,
                    timeout=60,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            if out.is_file() and out.stat().st_size > 0:
                encoded = base64.b64encode(out.read_bytes()).decode("ascii")
                frames.append(f"data:image/jpeg;base64,{encoded}")
    return frames


async def _video_sources(asset: Asset, settings: Settings) -> list[str]:
    target = _fetchable_url(asset, settings) or asset.url
    duration = asset.duration_sec or 0.0
    if duration <= 0:
        from app.routers.assets import _probe_duration

        duration = await asyncio.to_thread(_probe_duration, target)
    return await asyncio.to_thread(_extract_keyframes, target, duration)


# --- the document -----------------------------------------------------------


def assemble_doc(
    *,
    caption: str | None,
    tags: list[str],
    ocr_text: str | None,
    prompt: str | None,
    filename: str | None,
    extra: str | None = None,
) -> str:
    """The one text both search representations derive from.

    Order matters only for truncation: the strongest signals go first so a
    pathological prompt cannot push the caption past the embedding window.
    """
    parts = [caption, " ".join(tags), ocr_text, prompt, filename, extra]
    return "\n".join(p.strip() for p in parts if p and p.strip())[:8000]


def _is_musiclike(model: str | None) -> bool:
    lowered = (model or "").lower()
    return any(marker in lowered for marker in _MUSICLIKE)


# --- the sidecar ------------------------------------------------------------


async def _write_sidecar(
    asset: Asset, payload: dict[str, Any], settings: Settings
) -> str | None:
    """The enrichment JSON, beside the object it describes.

    B2 only: the sidecar's whole point is that the bucket remains a complete
    record without this database. Local mode has no such story to tell."""
    if settings.storage_mode is not StorageMode.B2 or not asset.b2_key:
        return None
    from app.services.uploads import _store_b2

    data = json.dumps(payload, indent=1).encode()
    key = f"{asset.b2_key}.enrichment.json"
    try:
        await asyncio.to_thread(
            _store_b2,
            io.BytesIO(data),
            key=key,
            media_type="application/json",
            sha256=hashlib.sha256(data).hexdigest(),
            settings=settings,
        )
        return key
    except Exception as exc:  # noqa: BLE001 - a sidecar is not worth a failed row
        log.warning("enrich.sidecar_failed", error=f"{type(exc).__name__}: {exc}")
        return None


# --- orchestration ----------------------------------------------------------


async def _step_for(session: Any, asset: Asset) -> RunStep | None:
    if asset.run_id is None or not asset.node_id:
        return None
    return (
        await session.execute(
            select(RunStep).where(
                RunStep.run_id == asset.run_id, RunStep.node_id == asset.node_id
            )
        )
    ).scalar_one_or_none()


async def enrich_asset(
    asset_id: uuid.UUID | str, *, force: bool = False, settings: Settings | None = None
) -> bool:
    """Enrich one asset. Opens its own session — safe to fire and forget.

    Returns True when the row ended `done` (including the deliberate skips),
    False on failure or when enrichment is disabled.
    """
    settings = settings or get_settings()
    if not settings.enrich_enabled:
        return False
    if isinstance(asset_id, str):
        asset_id = uuid.UUID(asset_id)

    from app.db.session import get_sessionmaker

    async with get_sessionmaker()() as session:
        asset = await session.get(Asset, asset_id)
        if asset is None:
            return False

        row = await session.get(AssetEnrichment, asset_id)
        if row is not None and row.status is EnrichmentStatus.DONE and not force:
            return True
        if row is None:
            row = AssetEnrichment(asset_id=asset.id, tenant_id=asset.tenant_id)
            session.add(row)
        row.status = EnrichmentStatus.PENDING
        row.error = None
        await session.commit()

        try:
            return await _enrich(session, asset, row, settings)
        except Exception as exc:  # noqa: BLE001 - never let enrichment raise into a caller
            log.warning(
                "enrich.failed", asset=str(asset_id), error=f"{type(exc).__name__}: {exc}"
            )
            try:
                row.status = EnrichmentStatus.FAILED
                row.error = f"{type(exc).__name__}: {exc}"[:500]
                await session.commit()
            except Exception:  # noqa: BLE001
                pass
            return False


async def _enrich(
    session: Any, asset: Asset, row: AssetEnrichment, settings: Settings
) -> bool:
    step = await _step_for(session, asset)
    prompt = (step.prompt if step else None) or None
    described: dict[str, Any] | None = None
    extra: str | None = None

    if asset.modality == "image":
        source = await _image_source(asset, settings)
        described = (
            await describe_images([source], context=prompt, settings=settings)
            if source
            else None
        )
    elif asset.modality == "video":
        frames = await _video_sources(asset, settings)
        described = (
            await describe_images(frames, context=prompt, settings=settings)
            if frames
            else None
        )
    elif asset.modality == "audio":
        if asset.kind is AssetKind.UPLOAD:
            # Deliberately skipped: uploaded audio is rare here and has no
            # prompt — the filename is all the signal there is.
            pass
        elif _is_musiclike(step.model if step else None):
            described = await describe_audio_prompt(prompt or "", settings=settings)
        else:
            # TTS speech: the prompt is the script — index the words spoken.
            extra = "speech voice narration"
    elif asset.modality == "text":
        words = (asset.asset_metadata or {}).get("text") or ""
        extra = str(words)[:4000]
    elif asset.modality == "3d":
        # No visual describer for meshes — the prompt (folded in by
        # assemble_doc) is the searchable signal.
        extra = "3d model mesh glb"

    caption = (described or {}).get("caption")
    if not caption and asset.modality == "audio" and prompt and not _is_musiclike(
        step.model if step else None
    ):
        caption = f"Spoken audio: {prompt[:300]}"
    if not caption and asset.modality == "3d" and prompt:
        caption = f"3D model: {prompt[:300]}"
    tags = list((described or {}).get("tags") or [])
    ocr_text = (described or {}).get("ocr_text")
    palette = list((described or {}).get("palette") or [])

    doc = assemble_doc(
        caption=caption,
        tags=tags,
        ocr_text=ocr_text,
        prompt=prompt,
        filename=asset.filename,
        extra=extra,
    )

    embedding = await embed_passage(doc, settings=settings) if doc else None

    sidecar_payload = {
        "version": 1,
        "asset_id": str(asset.id),
        "sha256": asset.sha256,
        "caption": caption,
        "tags": tags,
        "ocr_text": ocr_text,
        "palette": palette,
        "prompt": prompt,
        "model": settings.enrich_vision_model if described else None,
        "created_at": datetime.now(UTC).isoformat(),
    }
    sidecar_key = await _write_sidecar(asset, sidecar_payload, settings)

    row.status = EnrichmentStatus.DONE
    row.caption = caption
    row.tags = tags
    row.ocr_text = ocr_text
    row.palette = palette
    row.prompt = prompt
    row.search_doc = doc or None
    row.model = settings.enrich_vision_model if described else None
    row.sidecar_key = sidecar_key
    await session.commit()

    if embedding:
        # Raw SQL with a text-literal cast: asyncpg has no codec for the
        # vector OID, and this is the only write that needs one.
        from sqlalchemy import text as sql_text

        await session.execute(
            sql_text(
                "UPDATE asset_enrichment SET embedding = CAST(:v AS vector) "
                "WHERE asset_id = :id"
            ),
            {"v": vector_literal(embedding), "id": str(asset.id)},
        )
        await session.commit()

    log.info(
        "enrich.done",
        asset=str(asset.id),
        modality=asset.modality,
        vision=bool(described),
        embedded=bool(embedding),
        sidecar=bool(sidecar_key),
    )
    return True


# --- fire-and-forget --------------------------------------------------------

#: Strong references, or an in-flight enrichment could be garbage-collected.
_tasks: set[asyncio.Task[Any]] = set()


def schedule_enrichment(asset_id: uuid.UUID | str) -> None:
    """Enrich in the background. Never raises; a no-op with no running loop."""
    if not get_settings().enrich_enabled:
        return
    try:
        task = asyncio.get_running_loop().create_task(enrich_asset(asset_id))
    except RuntimeError:
        return
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
