"""Liveness and readiness.

`/healthz` answers "is the process up" and must stay dependency-free so it can be
a container health check. `/readyz` answers "can this instance actually do work"
and probes each subsystem independently — a missing provider key is reported, not
fatal, because mock mode is a legitimate way to run.
"""

from __future__ import annotations

import shutil
from functools import lru_cache
from typing import Any

from fastapi import APIRouter

from app.config import Settings, get_settings

router = APIRouter(tags=["health"])


@lru_cache(maxsize=1)
def ffmpeg_present() -> bool:
    """Deploy-time invariant, so caching it is safe."""
    return shutil.which("ffmpeg") is not None


@router.get("/healthz")
async def healthz() -> dict[str, Any]:
    settings = get_settings()
    return {"status": "ok", "env": settings.app_env, "version": "0.1.0"}


async def _probe_db(settings: Settings) -> dict[str, Any]:
    if not settings.db_configured:
        return {"configured": False, "connected": False, "reason": "DATABASE_URL not set"}
    try:
        from sqlalchemy import text

        from app.db.session import get_engine

        async with get_engine().connect() as conn:
            await conn.execute(text("select 1"))
        return {"configured": True, "connected": True}
    except Exception as exc:  # noqa: BLE001 - readiness must never raise
        return {"configured": True, "connected": False, "reason": f"{type(exc).__name__}: {exc}"}


def _probe_storage(settings: Settings) -> dict[str, Any]:
    info: dict[str, Any] = {"mode": settings.storage_mode.value}
    if settings.storage_mode == "local":
        info |= {"configured": True, "dir": str(settings.local_media_dir)}
    else:
        info |= {
            "configured": settings.b2_configured,
            "bucket": settings.b2_bucket or None,
            "region": settings.b2_region,
        }
        if not settings.b2_configured:
            info["reason"] = "B2_KEY_ID / B2_APP_KEY / B2_BUCKET not all set"
    return info


@router.get("/readyz")
async def readyz() -> dict[str, Any]:
    from app.catalog.registry import get_catalog

    settings = get_settings()
    db = await _probe_db(settings)
    storage = _probe_storage(settings)
    catalog = get_catalog()

    providers: dict[str, list[str]] = {"ready": [], "missing_key": [], "not_installed": []}
    for provider in catalog.providers:
        providers.setdefault(provider.status.value, []).append(provider.key)

    # Degraded rather than unhealthy: the app is useful in mock mode, and a
    # readiness flap on an optional provider should not pull the instance out.
    ready = db["connected"] and storage["configured"]
    return {
        "status": "ready" if ready else "degraded",
        "genblaze_mode": settings.genblaze_mode.value,
        "db": db,
        "storage": storage,
        "providers": providers,
        "ffmpeg": ffmpeg_present(),
    }
