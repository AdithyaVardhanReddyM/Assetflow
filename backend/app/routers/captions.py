"""Caption endpoints — transcribe a video's speech, and burn approved cues.

Sits under the assets prefix because both operations are asset-centric; the
work itself lives in ``services/captions.py``. Same shape as the Magic Text
router, for the same reasons.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, status
from pydantic import BaseModel, Field

from app.deps import CurrentUser, Session
from app.services.captions import (
    CAPTION_STYLES,
    burn_captions,
    transcribe_asset,
)

router = APIRouter(prefix="/v1/assets", tags=["captions"])


@router.post("/{asset_id}/captions/transcribe")
async def transcribe(
    asset_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    """Scribe's word-level transcript for one stored video.

    Synchronous by design — the caption editor needs the words in hand before
    it can preview anything, and a short clip transcribes in seconds. Bills
    per call; the canvas caches the result per asset.
    """
    from app.routers.assets import _get_owned

    asset = await _get_owned(session, asset_id, user)
    return await transcribe_asset(asset)


class CaptionWord(BaseModel):
    text: str = Field(min_length=1, max_length=200)
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class CaptionCue(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    #: Lines exactly as the editor previewed them — the burn re-wraps nothing.
    lines: list[list[CaptionWord]]


class CaptionPlacement(BaseModel):
    """Caption box center + width as fractions of the frame, and the user's
    size multiplier on the style's native font size (1 = as designed)."""

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    scale: float = Field(default=1, ge=0.25, le=4)


class BurnRequest(BaseModel):
    workflow_id: uuid.UUID
    node_id: str = Field(min_length=1, max_length=64)
    style: str
    placement: CaptionPlacement
    cues: list[CaptionCue] = Field(min_length=1)


@router.post("/{asset_id}/captions", status_code=status.HTTP_201_CREATED)
async def burn(
    asset_id: uuid.UUID, body: BurnRequest, session: Session, user: CurrentUser
) -> dict[str, Any]:
    """Render the cues into the video and index it as a generation of the node."""
    from app.errors import BadRequest
    from app.routers.assets import _get_owned, _serialize

    if body.style not in CAPTION_STYLES:
        raise BadRequest(f"Unknown caption style '{body.style}'.")

    asset = await _get_owned(session, asset_id, user)
    burned = await burn_captions(
        session,
        asset=asset,
        tenant_id=user.tenant_id,
        user_id=user.user_id,
        workflow_id=body.workflow_id,
        node_id=body.node_id,
        cues=[cue.model_dump() for cue in body.cues],
        style_id=body.style,
        placement=body.placement.model_dump(),
    )
    return _serialize(burned)
