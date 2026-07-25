"""Magic Text endpoints — layerize an image, and register the edited result.

Sits under the assets prefix because both operations are asset-centric; the
work itself lives in ``services/magic_text.py``.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, File, Form, UploadFile, status

from app.deps import CurrentUser, Session
from app.errors import NotFound
from app.services.magic_text import layerize_asset, register_text_edit

router = APIRouter(prefix="/v1/assets", tags=["magic-text"])


@router.post("/{asset_id}/layerize")
async def layerize(
    asset_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    """Decompose an image's text into editable layers.

    Synchronous by design — the editor needs the JSON in hand before it can
    open, and the model live-measures well under this route's httpx timeouts.
    Bills per call; the canvas caches the result per source asset.
    """
    from app.routers.assets import _get_owned, _serialize

    asset = await _get_owned(session, asset_id, user)
    result = await layerize_asset(session, asset=asset, tenant_id=user.tenant_id)
    return {
        "base_asset": _serialize(result["base_asset"]),
        # The subject as an RGBA layer for the occlusion sandwich; null when
        # segmentation found nothing usable (the editor degrades to 2 layers).
        "cutout_asset": (
            _serialize(result["cutout_asset"]) if result["cutout_asset"] else None
        ),
        # The JSON's declared coordinate space and the base PNG's true pixel
        # size — observed to disagree, so the editor gets both and scales.
        "resolution": result["resolution"],
        "base_size": result["base_size"],
        "containers": result["containers"],
    }


@router.post("/text-edits", status_code=status.HTTP_201_CREATED)
async def create_text_edit(
    session: Session,
    user: CurrentUser,
    file: UploadFile = File(...),
    workflow_id: uuid.UUID = Form(...),
    node_id: str = Form(..., min_length=1, max_length=64),
    base_asset_id: uuid.UUID | None = Form(default=None),
) -> dict[str, Any]:
    """Index the browser-composited edit as a generation of ``node_id``."""
    from app.routers.assets import _serialize

    image = await file.read()
    if not image:
        raise NotFound("The edit upload was empty.")

    asset = await register_text_edit(
        session,
        tenant_id=user.tenant_id,
        user_id=user.user_id,
        workflow_id=workflow_id,
        node_id=node_id,
        image=image,
        base_asset_id=base_asset_id,
    )
    return _serialize(asset)
