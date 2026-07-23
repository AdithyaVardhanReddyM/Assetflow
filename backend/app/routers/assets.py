"""Asset library, lineage, and media serving."""

from __future__ import annotations

import uuid
from typing import Any

import httpx
from fastapi import APIRouter, File, Query, Response, UploadFile, status
from fastapi.responses import RedirectResponse, StreamingResponse
from sqlalchemy import select

from app.config import StorageMode
from app.db.models import Asset, Run, RunStep
from app.deps import CurrentUser, Session, SettingsDep
from app.errors import NotFound
from app.services.uploads import ingest_upload

router = APIRouter(prefix="/v1/assets", tags=["assets"])


def _serialize(asset: Asset) -> dict[str, Any]:
    from app.engine.manifests import preview_url

    return {
        "id": str(asset.id),
        "kind": asset.kind.value,
        "url": asset.url,
        "content_url": f"/v1/assets/{asset.id}/content",
        # Short-lived and deliberately not persisted anywhere. `content_url`
        # needs an Authorization header, which an <img> cannot send, so the
        # canvas renders from this instead.
        "preview_url": preview_url(asset.b2_key or asset.url),
        "media_type": asset.media_type,
        "modality": asset.modality,
        "sha256": asset.sha256,
        "size_bytes": asset.size_bytes,
        "width": asset.width,
        "height": asset.height,
        "duration_sec": asset.duration_sec,
        "run_id": str(asset.run_id) if asset.run_id else None,
        "node_id": asset.node_id,
        "filename": asset.filename,
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
    }


async def _get_owned(session: Session, asset_id: uuid.UUID, user: CurrentUser) -> Asset:
    result = await session.execute(
        select(Asset).where(Asset.id == asset_id, Asset.tenant_id == user.tenant_id)
    )
    asset = result.scalar_one_or_none()
    if asset is None:
        raise NotFound(f"Asset {asset_id} was not found.")
    return asset


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload_asset(
    session: Session,
    user: CurrentUser,
    response: Response,
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """Ingest a user's file so the canvas can reference it by asset id.

    Returns 200 rather than 201 when the bytes were already in this tenant's
    library — the client gets the same asset either way, and the status says
    whether anything new was stored.
    """
    asset, created = await ingest_upload(
        session,
        tenant_id=user.tenant_id,
        stream=file.file,
        filename=file.filename,
        media_type=file.content_type,
    )
    if not created:
        response.status_code = status.HTTP_200_OK
    return _serialize(asset)


@router.get("")
async def list_assets(
    session: Session,
    user: CurrentUser,
    modality: str | None = Query(default=None),
    run_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    stmt = select(Asset).where(Asset.tenant_id == user.tenant_id)
    if modality:
        stmt = stmt.where(Asset.modality == modality)
    if run_id:
        stmt = stmt.where(Asset.run_id == run_id)
    stmt = stmt.order_by(Asset.created_at.desc()).limit(limit).offset(offset)

    result = await session.execute(stmt)
    return {
        "items": [_serialize(a) for a in result.scalars()],
        "limit": limit,
        "offset": offset,
    }


@router.get("/{asset_id}")
async def get_asset(
    asset_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    return _serialize(await _get_owned(session, asset_id, user))


@router.get("/{asset_id}/provenance")
async def get_provenance(
    asset_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    """Where did this come from — which model, prompt, run, and manifest."""
    asset = await _get_owned(session, asset_id, user)
    body: dict[str, Any] = {
        "asset": _serialize(asset),
        "manifest_uri": asset.manifest_uri,
        "lineage": None,
    }
    if asset.run_id is None:
        return body

    run = await session.get(Run, asset.run_id)
    step = None
    if asset.node_id:
        step = (
            await session.execute(
                select(RunStep).where(
                    RunStep.run_id == asset.run_id, RunStep.node_id == asset.node_id
                )
            )
        ).scalar_one_or_none()

    body["lineage"] = {
        "run_id": str(asset.run_id),
        "workflow_id": str(run.workflow_id) if run and run.workflow_id else None,
        "parent_run_id": str(run.parent_run_id) if run and run.parent_run_id else None,
        "manifest_uri": run.manifest_uri if run else None,
        "manifest_hash": run.manifest_hash if run else None,
        "node_id": asset.node_id,
        "provider": step.provider if step else None,
        "model": step.model if step else None,
        "prompt": step.prompt if step else None,
        "params": step.params if step else None,
        "cost_usd": step.cost_usd if step else None,
    }
    return body


@router.get("/{asset_id}/content")
async def get_content(
    asset_id: uuid.UUID, session: Session, user: CurrentUser, settings: SettingsDep
) -> RedirectResponse:
    """Redirect to playable bytes.

    The bucket is private, so this mints a short-lived presigned URL per request
    rather than exposing a permanent public link. `<img>`/`<video>` follow the
    redirect fine; note that a cross-origin `fetch()` will not, because B2 sends
    no CORS headers on the redirect target.
    """
    asset = await _get_owned(session, asset_id, user)

    if settings.storage_mode is StorageMode.LOCAL:
        return RedirectResponse(asset.url, status_code=307)

    from app.engine.manifests import presign

    return RedirectResponse(presign(asset.b2_key or asset.url), status_code=307)


_EXT_BY_MEDIA_TYPE = {
    "video/mp4": ".mp4",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "text/plain": ".txt",
}


@router.get("/{asset_id}/download")
async def download_content(
    asset_id: uuid.UUID, session: Session, user: CurrentUser, settings: SettingsDep
) -> StreamingResponse:
    """Stream the bytes through the API with an attachment disposition.

    A redirect cannot serve the Save-As path: the canvas has to `fetch()` the
    bytes to hand them to a download, and B2 sends no CORS headers — so the
    redirect target is unreachable from the browser. Proxying through here
    keeps the download inside the API's own CORS policy.
    """
    asset = await _get_owned(session, asset_id, user)

    if settings.storage_mode is StorageMode.LOCAL:
        target = asset.url
    else:
        from app.engine.manifests import presign

        target = presign(asset.b2_key or asset.url)

    client = httpx.AsyncClient(timeout=120.0, follow_redirects=True)
    upstream = await client.send(
        client.build_request("GET", target), stream=True
    )
    if upstream.status_code >= 400:
        await upstream.aclose()
        await client.aclose()
        raise NotFound("The asset's bytes are not reachable in storage.")

    stem = (asset.filename or asset.node_id or "asset").rsplit(".", 1)[0]
    filename = f"{stem}{_EXT_BY_MEDIA_TYPE.get(asset.media_type, '')}" or "asset"

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        body(),
        media_type=asset.media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
