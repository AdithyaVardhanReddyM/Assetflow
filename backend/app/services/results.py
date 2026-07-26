"""Per-node generation history — what fills a node's carousel.

The graph stores no run output, so a reopened canvas asks for its takes back.
Normally they are found through the node's own workflow; a node *rebuilt* from
another workflow's history (see `services/reconstruct.py`) has none of its own
and is handed its origin's instead, which is what makes a reconstructed chain
arrive with its pictures already in it.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from app.db.models import Asset, AssetKind, Run

#: Takes one node's carousel holds. Mirrored by HISTORY_LIMIT in
#: components/studio/studio-shell.tsx.
RESULTS_PER_NODE = 8


def serialize_generation(asset: Asset, *, node_id: str) -> dict[str, Any]:
    """One carousel entry.

    `node_id` is passed rather than read off the asset: an adopted take belongs
    to the node that *inherited* it, which is not the node it was generated on.
    """
    from app.engine.manifests import preview_url

    return {
        "node_id": node_id,
        "asset_id": str(asset.id),
        # From the URL, not b2_key: in local mode the key is a bare relative
        # path while the URL is fetchable as-is.
        "url": preview_url(asset.url),
        "media_type": asset.media_type,
        "modality": asset.modality,
        "text": (asset.asset_metadata or {}).get("text"),
        # The card takes the generation's shape, so the canvas needs the real
        # pixel dimensions, not the requested ratio param.
        "width": asset.width,
        "height": asset.height,
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
    }


async def origin_generations(
    session: Any,
    *,
    tenant_id: str,
    origins: dict[str, tuple[str, str]],
) -> dict[str, list[Asset]]:
    """Takes inherited through `NodeOrigin`, newest first.

    `origins` maps the id a node has *here* to the `(workflow_id, node_id)` it
    was rebuilt from. Deliberately no ownership check on the origin workflow
    beyond the tenant: it may have been deleted since, and the run rows — which
    is where the takes actually are — outlive it.
    """
    pairs = set(origins.values())
    if not pairs:
        return {}

    workflow_ids: set[uuid.UUID] = set()
    for raw, _ in pairs:
        try:
            workflow_ids.add(uuid.UUID(raw))
        except ValueError:
            continue
    if not workflow_ids:
        return {}

    stmt = (
        select(Asset, Run.workflow_id)
        .join(Run, Asset.run_id == Run.id)
        .where(
            Run.workflow_id.in_(workflow_ids),
            Asset.tenant_id == tenant_id,
            Asset.kind == AssetKind.GENERATED,
            Asset.node_id.in_({node_id for _, node_id in pairs}),
        )
        .order_by(Asset.created_at.desc())
    )

    # The two IN clauses are a cross product, so a row can match a workflow from
    # one pair and a node from another; bucketing by the exact pair drops those.
    by_pair: dict[tuple[str, str], list[Asset]] = {}
    for asset, workflow_id in await session.execute(stmt):
        key = (str(workflow_id), asset.node_id)
        if key in pairs:
            by_pair.setdefault(key, []).append(asset)

    return {
        node_id: by_pair[pair][:RESULTS_PER_NODE]
        for node_id, pair in origins.items()
        if pair in by_pair
    }


def read_origins(graph: dict[str, Any] | None) -> dict[str, tuple[str, str]]:
    """`node id here -> (workflow id, node id) it was rebuilt from`."""
    origins: dict[str, tuple[str, str]] = {}
    for node in (graph or {}).get("nodes", []):
        node_id = node.get("id")
        origin = (node.get("data") or {}).get("origin")
        if not node_id or not isinstance(origin, dict):
            continue
        workflow_id, source_node = origin.get("workflow_id"), origin.get("node_id")
        if workflow_id and source_node:
            origins[node_id] = (str(workflow_id), str(source_node))
    return origins
