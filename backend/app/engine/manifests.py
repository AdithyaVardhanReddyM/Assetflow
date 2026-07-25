"""Read provenance manifests back out of storage.

Deliberately re-reads from B2 rather than echoing the database: the point of the
endpoint is to demonstrate that the canonical, hash-verified provenance record
really is in the bucket and still intact. Echoing our own row would prove nothing.
"""

from __future__ import annotations

import json
from functools import lru_cache
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


@lru_cache(maxsize=1)
def _signing_backend() -> Any:
    """A backend used only to mint presigned URLs.

    Separate from `_backend()` and cached because listing a page of assets
    presigns every row: constructing a fresh client each time would repeat the
    bucket preflight per asset. Signing itself is local HMAC work with no
    network call, so one long-lived client is all this needs.
    """
    settings = get_settings()
    from genblaze_s3 import S3StorageBackend

    return S3StorageBackend.for_backblaze(
        settings.b2_bucket,
        region=settings.b2_region,
        key_id=settings.b2_key_id,
        app_key=settings.b2_app_key,
        preflight=False,
    )


# Long enough for a provider to queue a job and only then fetch the input —
# Replicate downloads at dequeue, not at submit — and for ffmpeg to stream a
# whole composition. Short enough that a signature which leaks into a manifest
# is dead long before anyone reads that manifest back.
PROVIDER_URL_TTL = 6 * 3600


def sign_for_fetch(url: str, *, expires_in: int = PROVIDER_URL_TTL) -> str:
    """Presign a durable URL so something *outside* this process can fetch it.

    Our bucket is private, so a durable `https://s3.../assetflow/...` URL is a
    401 to everyone but us. Anything holding it that is not us — a provider's
    downloader fetching a reference image, ffmpeg opening a composition clip —
    needs a signature attached first.

    Passes through anything that is not ours (a provider CDN URL, a local-mode
    `/media` URL, a `file://` path), and returns the input unchanged if signing
    fails: the fetcher's own error names the URL, which beats one from here.
    """
    settings = get_settings()
    if settings.storage_mode is StorageMode.LOCAL or not settings.b2_configured:
        return url
    if not url.startswith("http"):
        return url
    try:
        backend = _signing_backend()
        key = backend.key_from_url(url)
        return backend.presigned_get_url(key, expires_in=expires_in) if key else url
    except Exception as exc:  # noqa: BLE001 - fall back to the durable URL
        log.warning("storage.sign_for_fetch_failed", error=f"{type(exc).__name__}: {exc}")
        return url


def preview_url(url_or_key: str | None, *, expires_in: int = 3600) -> str | None:
    """Best-effort presigned URL for rendering in an `<img>`/`<video>`.

    Returns None rather than raising: a thumbnail that cannot be signed should
    degrade to a placeholder, not fail the whole listing.
    """
    settings = get_settings()
    if settings.storage_mode is StorageMode.LOCAL:
        # Local media is already served unauthenticated from /media.
        return url_or_key
    if not url_or_key or not settings.b2_configured:
        return None
    try:
        backend = _signing_backend()
        key = (
            backend.key_from_url(url_or_key)
            if url_or_key.startswith("http")
            else url_or_key
        )
        return backend.presigned_get_url(key, expires_in=expires_in) if key else None
    except Exception as exc:  # noqa: BLE001 - a preview is not worth a 500
        log.warning("storage.preview_url_failed", error=f"{type(exc).__name__}: {exc}")
        return None


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

    # Recompute the canonical hash from the bytes just fetched, rather than
    # trusting the flag recorded at run time — this call's whole claim is that
    # the record in the bucket is *still* intact.
    verified_now: bool | None = None
    try:
        from genblaze_core.models.manifest import Manifest

        manifest = Manifest.model_validate(document)
        verified_now = manifest.verify_hash() and (
            run.manifest_hash is None or manifest.canonical_hash == run.manifest_hash
        )
    except Exception as exc:  # noqa: BLE001 - an unreadable manifest is "unverified", not a 500
        log.warning("manifest.reverify_failed", error=f"{type(exc).__name__}: {exc}")

    return {
        "manifest_uri": run.manifest_uri,
        "canonical_hash": run.manifest_hash,
        "verified": {"true": True, "false": False}.get(run.manifest_verified or ""),
        "verified_now": verified_now,
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
