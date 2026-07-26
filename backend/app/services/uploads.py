"""Ingest a user's file into storage as an asset.

Uploads take the same road as generated media: content-hashed, written under a
tenant-scoped prefix, and recorded with a durable (never presigned) URL. That is
what makes an uploaded reference image a first-class part of a run's provenance
rather than an untracked side input.
"""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import BinaryIO

from sqlalchemy import select

from app.config import Settings, StorageMode, get_settings
from app.db.models import Asset, AssetKind
from app.errors import AppError, StorageError
from app.logging import get_logger

log = get_logger(__name__)

#: Cap on a single upload. Generous enough for a short clip, small enough that a
#: runaway request cannot fill the disk the spool file lives on.
MAX_UPLOAD_BYTES = 200 * 1024 * 1024

_EXT_BY_MEDIA_TYPE = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
}

_ALLOWED_TOP_LEVEL = {"image", "video", "audio"}


class UploadTooLarge(AppError):
    status, code, title, retryable = 413, "upload_too_large", "File is too large", False


class UnsupportedMedia(AppError):
    status, code, title, retryable = 415, "unsupported_media", "Unsupported file type", False


def modality_of(media_type: str) -> str:
    return media_type.split("/")[0]


def _extension(media_type: str, filename: str | None) -> str:
    if media_type in _EXT_BY_MEDIA_TYPE:
        return _EXT_BY_MEDIA_TYPE[media_type]
    suffix = Path(filename or "").suffix.lower()
    return suffix if 1 < len(suffix) <= 5 else ".bin"


def digest_and_size(stream: BinaryIO) -> tuple[str, int]:
    """Hash without loading the file into memory.

    FastAPI spools an UploadFile to disk past ~1 MB, so this reads back off that
    spool in chunks. Raises before hashing the whole thing if it runs over cap.
    """
    stream.seek(0)
    sha = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(1 << 20), b""):
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise UploadTooLarge(
                f"Files are limited to {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            )
        sha.update(chunk)
    stream.seek(0)
    return sha.hexdigest(), size


def _b2_backend(settings: Settings):
    from genblaze_s3 import S3StorageBackend

    return S3StorageBackend.for_backblaze(
        settings.b2_bucket,
        region=settings.b2_region,
        key_id=settings.b2_key_id,
        app_key=settings.b2_app_key,
        # Same reason as the run sink: a bucket-scoped key cannot write
        # bucket-wide lifecycle configuration.
        auto_lifecycle=False,
    )


def _store_b2(
    stream: BinaryIO,
    *,
    key: str,
    media_type: str,
    sha256: str,
    settings: Settings,
) -> tuple[str, str]:
    """Returns (durable_url, key). Blocking — call via a worker thread."""
    backend = _b2_backend(settings)
    backend.put(
        key,
        stream,
        content_type=media_type,
        # Provenance travels with the object, not only in our database: the
        # bucket stays readable as a record if the index is ever lost.
        metadata={"sha256": sha256, "source": "upload"},
    )
    return backend.get_durable_url(key), key


def _store_local(
    stream: BinaryIO, *, key: str, settings: Settings
) -> tuple[str, str]:
    dest = settings.local_media_dir / key
    dest.parent.mkdir(parents=True, exist_ok=True)
    stream.seek(0)
    with dest.open("wb") as fh:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            fh.write(chunk)
    return f"{settings.local_media_base_url.rstrip('/')}/{key}", key


async def ingest_upload(
    session,
    *,
    tenant_id: str,
    stream: BinaryIO,
    filename: str | None,
    media_type: str | None,
    settings: Settings | None = None,
) -> tuple[Asset, bool]:
    """Store a file and index it. Returns (asset, created).

    Re-uploading identical bytes is a no-op that returns the existing row — the
    partial unique index on (tenant, sha256) for uploads makes that a guarantee
    rather than a race. Generated assets are deliberately excluded from that
    dedup: two runs producing identical bytes are two artifacts with their own
    manifests.
    """
    settings = settings or get_settings()

    media_type = (media_type or "").split(";")[0].strip().lower()
    if modality_of(media_type) not in _ALLOWED_TOP_LEVEL:
        raise UnsupportedMedia(
            "Upload an image, video, or audio file.",
            hint=f"Received {media_type or 'an unknown type'}.",
        )

    sha256, size = digest_and_size(stream)

    existing = (
        await session.execute(
            select(Asset).where(
                Asset.tenant_id == tenant_id,
                Asset.sha256 == sha256,
                Asset.kind == AssetKind.UPLOAD,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        log.info("upload.deduped", tenant=tenant_id, sha256=sha256[:12])
        return existing, False

    # Tenant-first so the bucket is browsable per customer, content-addressed
    # within it so the same file never occupies two keys.
    key = f"{settings.b2_prefix}/{tenant_id}/uploads/{sha256}{_extension(media_type, filename)}"

    if settings.storage_mode is StorageMode.B2:
        if not settings.b2_configured:
            raise StorageError("Backblaze B2 is not configured.")
        # boto3 is blocking; keep it off the event loop.
        url, b2_key = await asyncio.to_thread(
            _store_b2,
            stream,
            key=key,
            media_type=media_type,
            sha256=sha256,
            settings=settings,
        )
    else:
        url, b2_key = await asyncio.to_thread(
            _store_local, stream, key=f"uploads/{sha256}{_extension(media_type, filename)}",
            settings=settings,
        )

    asset = Asset(
        tenant_id=tenant_id,
        kind=AssetKind.UPLOAD,
        url=url,
        b2_key=b2_key,
        media_type=media_type,
        modality=modality_of(media_type),
        sha256=sha256,
        size_bytes=size,
        filename=filename,
        asset_metadata={"source": "upload", "original_filename": filename or ""},
    )
    session.add(asset)
    await session.commit()
    await session.refresh(asset)
    log.info("upload.stored", tenant=tenant_id, key=b2_key, bytes=size)

    # Caption/tag/embed in the background — the upload response never waits on
    # a vision model. The dedupe path above skips this on purpose: the earlier
    # ingest already enriched (or is enriching) those bytes.
    from app.services.enrich import schedule_enrichment

    schedule_enrichment(asset.id)
    return asset, True
