"""Storage: the B2 sink, and the local fallback that works with no credentials.

`build_sink()` is the *only* function that branches on storage mode, so turning
on B2 later is a configuration change rather than a code change.

In local mode we deliberately do **not** subclass `BaseSink`. The sink interface
is not pinned down in the SDK, and guessing wrong is a day lost. Instead the run
executes with `sink=None` and the worker materializes assets afterwards — same
observable outcome (real, playable, hashed media), none of the risk.
"""

from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.config import Settings, StorageMode, get_settings
from app.logging import get_logger

log = get_logger(__name__)

SAMPLES_DIR = Path(__file__).resolve().parents[1] / "static" / "samples"

_EXT_BY_MEDIA_TYPE = {
    "video/mp4": ".mp4",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
}

_SAMPLE_BY_MODALITY = {"video": "sample.mp4", "image": "sample.png", "audio": "sample.mp3"}


@dataclass(slots=True)
class MaterializedAsset:
    node_id: str | None
    genblaze_asset_id: str | None
    url: str
    media_type: str
    modality: str
    sha256: str | None = None
    size_bytes: int | None = None
    b2_key: str | None = None
    width: int | None = None
    height: int | None = None
    duration_sec: float | None = None


def build_sink(*, run_id: str, settings: Settings | None = None) -> Any | None:
    """Construct a fresh `ObjectStorageSink` per run, or None in local mode.

    Fresh per run is required, not stylistic: the pipeline closes the sink in its
    `finally` block, so a module-level singleton would be dead after one run.
    """
    settings = settings or get_settings()
    if settings.storage_mode is StorageMode.LOCAL:
        return None
    if not settings.b2_configured:
        log.warning("storage.b2_not_configured", run_id=run_id)
        return None

    from genblaze_core import KeyStrategy, ObjectStorageSink
    from genblaze_s3 import S3StorageBackend

    backend = S3StorageBackend.for_backblaze(
        settings.b2_bucket,
        region=settings.b2_region,
        key_id=settings.b2_key_id,
        app_key=settings.b2_app_key,
        # Bucket-wide config writes would be refused by a least-privilege,
        # bucket-scoped key. Lifecycle is declared in the B2 console instead.
        auto_lifecycle=False,
    )
    return ObjectStorageSink(
        backend,
        prefix=settings.b2_prefix,
        # Explicit: the SDK default is CONTENT_ADDRESSABLE, but a run-grouped
        # layout keyed by tenant is what makes the bucket browsable per customer.
        key_strategy=KeyStrategy.HIERARCHICAL,
        # Transfer during the run rather than only at write_run, so previews
        # point at durable URLs sooner.
        eager_transfer=True,
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _extension(media_type: str | None, url: str) -> str:
    if media_type and media_type in _EXT_BY_MEDIA_TYPE:
        return _EXT_BY_MEDIA_TYPE[media_type]
    suffix = Path(url.split("?")[0]).suffix
    return suffix if len(suffix) <= 5 else ".bin"


def _modality_of(media_type: str | None) -> str:
    if not media_type:
        return "image"
    top = media_type.split("/")[0]
    return {"video": "video", "audio": "audio", "image": "image"}.get(top, "image")


def _fetch(url: str, dest: Path) -> bool:
    try:
        with httpx.stream("GET", url, timeout=60.0, follow_redirects=True) as resp:
            resp.raise_for_status()
            with dest.open("wb") as fh:
                for chunk in resp.iter_bytes():
                    fh.write(chunk)
        return True
    except Exception as exc:  # noqa: BLE001 - any fetch failure falls back to a sample
        log.info("storage.fetch_failed", url=url, error=f"{type(exc).__name__}: {exc}")
        return False


def collect_assets(result: Any, *, run_id: str, settings: Settings | None = None) -> list[
    MaterializedAsset
]:
    """Read assets off a finished run, materializing them locally if needed."""
    settings = settings or get_settings()
    run = getattr(result, "run", None)
    if run is None:
        return []

    out: list[MaterializedAsset] = []
    local_mode = settings.storage_mode is StorageMode.LOCAL
    run_dir = settings.local_media_dir / run_id
    if local_mode:
        run_dir.mkdir(parents=True, exist_ok=True)

    # In B2 mode the sink has already rewritten asset URLs to the bucket; we
    # recover the object key so serving does not have to re-parse the URL on
    # every request. `preflight=False` keeps this to pure string parsing with no
    # network call — the run has already proven the credentials work.
    key_from_url = None
    if not local_mode and settings.b2_configured:
        try:
            from genblaze_s3 import S3StorageBackend

            key_from_url = S3StorageBackend.for_backblaze(
                settings.b2_bucket,
                region=settings.b2_region,
                key_id=settings.b2_key_id,
                app_key=settings.b2_app_key,
                preflight=False,
            ).key_from_url
        except Exception as exc:  # noqa: BLE001 - b2_key is an optimization
            log.warning("storage.key_parser_unavailable", error=f"{type(exc).__name__}: {exc}")

    for step in getattr(run, "steps", []) or []:
        node_id = (getattr(step, "metadata", None) or {}).get("node_id")
        for asset in getattr(step, "assets", None) or []:
            media_type = getattr(asset, "media_type", None) or "application/octet-stream"
            record = MaterializedAsset(
                node_id=node_id,
                genblaze_asset_id=getattr(asset, "asset_id", None),
                url=asset.url,
                media_type=media_type,
                modality=_modality_of(media_type),
                sha256=getattr(asset, "sha256", None),
                size_bytes=getattr(asset, "size_bytes", None),
                width=getattr(asset, "width", None),
                height=getattr(asset, "height", None),
                duration_sec=getattr(asset, "duration", None),
            )

            if local_mode:
                _materialize(record, run_dir=run_dir, run_id=run_id, settings=settings)
            elif key_from_url is not None and record.url.startswith("http"):
                record.b2_key = key_from_url(record.url)

            out.append(record)
    return out


def _materialize(
    record: MaterializedAsset, *, run_dir: Path, run_id: str, settings: Settings
) -> None:
    """Put real bytes on disk so the canvas has playable media without B2.

    Mock providers return unreachable URLs like `https://mock.test/video.mp4`, so
    a bundled sample stands in — the point is a working preview, not fidelity.
    """
    name = (record.genblaze_asset_id or "asset").replace("/", "_")
    dest = run_dir / f"{name}{_extension(record.media_type, record.url)}"

    fetched = record.url.startswith("http") and _fetch(record.url, dest)
    if not fetched:
        sample = SAMPLES_DIR / _SAMPLE_BY_MODALITY.get(record.modality, "sample.png")
        if not sample.exists():
            log.warning("storage.sample_missing", sample=str(sample))
            return
        shutil.copyfile(sample, dest)
        # The provider's declared media type may not match the stand-in bytes.
        record.media_type = {
            "video": "video/mp4", "audio": "audio/mpeg", "image": "image/png"
        }.get(record.modality, record.media_type)
        dest = dest.with_suffix(_EXT_BY_MEDIA_TYPE.get(record.media_type, dest.suffix))
        if not dest.exists():
            shutil.copyfile(sample, dest)

    record.sha256 = _sha256_file(dest)
    record.size_bytes = dest.stat().st_size
    record.b2_key = f"{run_id}/{dest.name}"
    record.url = f"{settings.local_media_base_url.rstrip('/')}/{run_id}/{dest.name}"
