"""Read provenance manifests back out of storage.

Deliberately re-reads from B2 rather than echoing the database: the point of the
endpoint is to demonstrate that the canonical, hash-verified provenance record
really is in the bucket and still intact. Echoing our own row would prove nothing.
"""

from __future__ import annotations

import json
from typing import Any

from app.config import StorageMode, get_settings
from app.db.models import Run
from app.errors import NotFound, StorageError
from app.logging import get_logger

log = get_logger(__name__)


def _backend() -> Any:
    settings = get_settings()
    if not settings.b2_configured:
        raise StorageError("Backblaze B2 is not configured.")
    from genblaze_s3 import S3StorageBackend

    return S3StorageBackend.for_backblaze(
        settings.b2_bucket,
        region=settings.b2_region,
        key_id=settings.b2_key_id,
        app_key=settings.b2_app_key,
    )


async def read_manifest(run: Run) -> dict[str, Any]:
    settings = get_settings()
    if settings.storage_mode is StorageMode.LOCAL:
        raise NotFound(
            "Manifests are only written to Backblaze B2.",
            hint="Set STORAGE_MODE=b2 with B2 credentials to enable provenance.",
        )
    if not run.manifest_uri:
        raise NotFound("This run has no manifest.")

    backend = _backend()
    key = backend.key_from_url(run.manifest_uri) or run.manifest_uri
    try:
        raw = backend.get(key)
    except Exception as exc:
        raise StorageError(f"Could not read the manifest: {type(exc).__name__}") from exc

    document = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
    return {
        "manifest_uri": run.manifest_uri,
        "canonical_hash": run.manifest_hash,
        "verified": {"true": True, "false": False}.get(run.manifest_verified or ""),
        "manifest": document,
    }


def presign(url_or_key: str, *, expires_in: int = 900) -> str:
    """Mint a short-lived URL for a private-bucket object.

    Never persist the result: a presigned URL embeds the access key id and has
    an expiry, so storing one would both leak and rot. Durable URLs go in the
    database and the manifest; presigning happens per request, at serve time.
    """
    backend = _backend()
    key = backend.key_from_url(url_or_key) if url_or_key.startswith("http") else url_or_key
    if not key:
        raise NotFound("Unrecognized asset URL.")
    return backend.presigned_get_url(key, expires_in=expires_in)
