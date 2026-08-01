"""Public provenance inspection: drop a file, read its history.

Deliberately unauthenticated. The whole point of stamping provenance into an
export is that the person receiving the file — who has no account here — can
still see how it was made. Possession of the file is the credential: nothing
can be looked up by id or browsed, only resolved from bytes actually in hand.

Two ways a dropped file resolves:

- It carries our stamped record (see `services.provenance_stamp`). The record
  names the asset, and when the library still holds that asset the response is
  the live dossier — fresh thumbnails, current chain. When the library has
  forgotten it, the embedded snapshot itself is returned; the file remains the
  last copy of its own story.
- It is byte-identical to something in a library (a plain download, or a
  re-upload of one). The sha256 every sink already records matches it back.

A stamped copy whose metadata was stripped by some platform matches neither —
the response says so honestly rather than guessing.
"""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, UploadFile
from sqlalchemy import select

from app.db.models import Asset
from app.deps import Session
from app.errors import AppError
from app.routers.assets import provenance_body
from app.services.provenance_stamp import extract

router = APIRouter(prefix="/v1/inspect", tags=["inspect"])


class FileTooLarge(AppError):
    status, code, title = 413, "file_too_large", "File too large"


#: Generous for generated media; the cap exists so an anonymous endpoint
#: cannot be fed arbitrary bulk.
_MAX_BYTES = 512 * 1024 * 1024
_CHUNK = 1024 * 1024


async def _spool(file: UploadFile, dest: Path) -> tuple[str, int]:
    """Write the upload to `dest`, returning (sha256, size)."""
    digest = hashlib.sha256()
    size = 0
    with dest.open("wb") as out:
        while chunk := await file.read(_CHUNK):
            size += len(chunk)
            if size > _MAX_BYTES:
                raise FileTooLarge("Files over 512 MB cannot be inspected.")
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest(), size


async def _by_id(session: Session, raw: Any) -> Asset | None:
    import uuid

    try:
        asset_id = uuid.UUID(str(raw))
    except ValueError:
        return None
    return (
        await session.execute(select(Asset).where(Asset.id == asset_id))
    ).scalar_one_or_none()


async def _by_sha256(session: Session, sha256: str) -> Asset | None:
    return (
        (
            await session.execute(
                select(Asset)
                .where(Asset.sha256 == sha256)
                .order_by(Asset.created_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )


@router.post("")
async def inspect_file(session: Session, file: UploadFile = File(...)) -> dict[str, Any]:
    """Resolve a dropped file to its derivation.

    `source` in the response says how it resolved: ``embedded`` (stamped
    record, library row still live), ``snapshot`` (stamped record, library row
    gone — the embedded story is all there is), ``fingerprint`` (byte-identical
    to a library asset), or ``none``.
    """
    with tempfile.TemporaryDirectory(prefix="inspect-") as tmp:
        spooled = Path(tmp) / "upload"
        sha256, size = await _spool(file, spooled)
        embedded = extract(spooled, file.content_type)

    base: dict[str, Any] = {"sha256": sha256, "size_bytes": size, "embedded": embedded}

    if embedded is not None:
        asset = await _by_id(session, embedded.get("asset_id"))
        if asset is not None:
            # Tenant scope comes from the asset itself: whoever holds the
            # stamped file was handed its history on purpose.
            dossier = await provenance_body(session, asset, asset.tenant_id)
            return {**base, "found": True, "source": "embedded", **dossier}
        return {**base, "found": True, "source": "snapshot", "asset": None}

    asset = await _by_sha256(session, sha256)
    if asset is not None:
        dossier = await provenance_body(session, asset, asset.tenant_id)
        return {**base, "found": True, "source": "fingerprint", **dossier}

    return {**base, "found": False, "source": "none"}
