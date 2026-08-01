"""FastAPI application factory."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import StorageMode, get_settings
from app.errors import install_error_handlers
from app.logging import configure_logging, get_logger, request_id_var

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    from app.catalog.registry import get_catalog

    catalog = get_catalog()
    log.info(
        "startup",
        env=settings.app_env,
        genblaze_mode=settings.genblaze_mode.value,
        storage_mode=settings.storage_mode.value,
        db_configured=settings.db_configured,
        b2_configured=settings.b2_configured,
        providers_ready=[p.key for p in catalog.providers if p.status.value == "ready"],
    )

    if settings.storage_mode == StorageMode.LOCAL:
        settings.local_media_dir.mkdir(parents=True, exist_ok=True)

    if settings.db_configured:
        from app.db.verify import verify_schema

        # Warn rather than refuse to boot: /readyz already reports degraded, and
        # a hard failure here would make the container crash-loop where a clear
        # log line plus a red readiness probe is more debuggable.
        try:
            await verify_schema(raise_on_drift=False)
        except Exception as exc:  # noqa: BLE001
            log.warning("db.verify_failed", error=str(exc))

    # In development the worker rides along in the API process so `uv run
    # uvicorn ...` is the whole dev loop. In production it runs standalone
    # (`python -m app.workers`) — same Supervisor, different process.
    supervisor = None
    if settings.run_worker_in_process and settings.db_configured:
        from app.workers.supervisor import Supervisor

        supervisor = Supervisor()
        await supervisor.start()

    yield

    if supervisor is not None:
        await supervisor.stop()
    if settings.db_configured:
        from app.db.session import dispose_engine

        await dispose_engine()
    log.info("shutdown")


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(level=settings.log_level, json_output=settings.is_production)

    if settings.auth_dev_bypass and settings.is_production:
        raise RuntimeError("AUTH_DEV_BYPASS must never be enabled in production")

    app = FastAPI(
        title="asset-flow API",
        description="Compiles canvas graphs into GenBlaze pipelines and persists "
        "generated media plus provenance to Backblaze B2.",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=r"http://localhost(:\d+)?",
        # Bearer tokens, not cookies — so credentials are not needed and
        # allowing them would force an origin echo we do not want.
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        # X-Dev-User rides on every browser call next to the Bearer token (see
        # authHeaders in lib/studio/assets-client.ts) — without it here, every
        # preflight fails and the canvas reports the backend unreachable.
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "Last-Event-ID",
            "X-Dev-User",
        ],
        expose_headers=["X-Request-Id"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
        rid = request.headers.get("X-Request-Id") or uuid.uuid4().hex[:12]
        token = request_id_var.set(rid)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-Id"] = rid
        return response

    install_error_handlers(app)

    from app.routers import (
        assets,
        captions,
        catalog,
        events,
        health,
        inspect,
        magic_text,
        runs,
        workflows,
    )

    # magic_text before assets: both share the /v1/assets prefix, and its
    # literal /text-edits route must win over the assets router's /{asset_id}.
    for module in (
        health, catalog, workflows, runs, events, magic_text, captions, assets, inspect,
    ):
        app.include_router(module.router)

    # Local storage mode serves generated media straight off disk so the canvas
    # has real, playable assets before any B2 credential exists.
    if settings.storage_mode == StorageMode.LOCAL:
        settings.local_media_dir.mkdir(parents=True, exist_ok=True)
        app.mount("/media", StaticFiles(directory=settings.local_media_dir), name="media")

    return app
