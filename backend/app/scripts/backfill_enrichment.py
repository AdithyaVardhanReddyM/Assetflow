"""Enrich every asset that has no completed enrichment row.

    uv run python -m app.scripts.backfill_enrichment [--limit N] [--dry-run]

Idempotent and resumable: `done` rows are skipped, `failed` rows are retried,
and interrupting it loses nothing but time. Serial with a small pause between
assets — this walks straight at OpenRouter and Jina, and a burst would only
trade rate-limit errors for the minutes it saves.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select

from app.config import get_settings
from app.db.models import Asset, AssetEnrichment, EnrichmentStatus
from app.db.session import get_sessionmaker
from app.services.enrich import enrich_asset

PAUSE_SEC = 0.6


async def _pending_ids(limit: int | None) -> list[tuple[str, str, str]]:
    settings = get_settings()
    needs_work = (AssetEnrichment.asset_id.is_(None)) | (
        AssetEnrichment.status != EnrichmentStatus.DONE
    )
    if settings.jina_api_key:
        # Rows enriched before the Jina key existed are `done` but vector-less;
        # with a key now present they are re-run so semantic search covers them.
        needs_work = needs_work | (
            AssetEnrichment.embedding.is_(None) & AssetEnrichment.search_doc.is_not(None)
        )

    async with get_sessionmaker()() as session:
        stmt = (
            select(Asset.id, Asset.modality, Asset.kind)
            .outerjoin(AssetEnrichment, AssetEnrichment.asset_id == Asset.id)
            .where(needs_work)
            .order_by(Asset.created_at.desc())
        )
        if limit:
            stmt = stmt.limit(limit)
        return [(str(i), m, k.value) for i, m, k in (await session.execute(stmt)).all()]


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None, help="stop after N assets")
    parser.add_argument("--dry-run", action="store_true", help="list, don't enrich")
    args = parser.parse_args()

    settings = get_settings()
    if not settings.enrich_enabled:
        print("ENRICH_ENABLED is false — nothing to do.")
        return 1

    pending = await _pending_ids(args.limit)
    print(f"{len(pending)} asset(s) awaiting enrichment.")
    if args.dry_run or not pending:
        for asset_id, modality, kind in pending:
            print(f"  {asset_id}  {kind:<9} {modality}")
        return 0

    done = failed = 0
    for i, (asset_id, modality, kind) in enumerate(pending, start=1):
        # force: some selected rows are `done` (vector-less) and would
        # otherwise be skipped by enrich_asset's own idempotency check.
        ok = await enrich_asset(asset_id, force=True)
        done += ok
        failed += not ok
        print(f"[{i}/{len(pending)}] {'ok  ' if ok else 'FAIL'} {asset_id} ({kind} {modality})")
        if i < len(pending):
            await asyncio.sleep(PAUSE_SEC)

    print(f"Done: {done} enriched, {failed} failed.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
