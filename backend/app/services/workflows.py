"""Shared workflow/run services."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Asset
from app.graph.schema import AssetRef, Graph, NodeKind


async def load_asset_refs(
    session: AsyncSession, *, tenant_id: str, graph: Graph
) -> dict[str, AssetRef]:
    """Resolve the uploads referenced by a graph's upload nodes.

    Tenant-scoped by construction: an asset id belonging to someone else simply
    does not resolve, and the compiler then reports it as an unknown asset.
    """
    wanted: set[uuid.UUID] = set()
    for node in graph.nodes:
        if node.kind is not NodeKind.UPLOAD:
            continue
        asset_id = node.data.get("asset_id")
        if not asset_id:
            continue
        try:
            wanted.add(uuid.UUID(str(asset_id)))
        except ValueError:
            continue

    if not wanted:
        return {}

    rows = await session.execute(
        select(Asset).where(Asset.tenant_id == tenant_id, Asset.id.in_(wanted))
    )
    return {
        str(a.id): AssetRef(
            asset_id=str(a.id),
            url=a.url,
            media_type=a.media_type,
            modality=a.modality,
            sha256=a.sha256,
            size_bytes=a.size_bytes,
        )
        for a in rows.scalars()
    }
