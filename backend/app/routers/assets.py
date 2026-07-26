"""Asset library, search, lineage, and media serving."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, File, Query, Response, UploadFile, status
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import cast as sa_cast
from sqlalchemy import func, literal, or_, select

from app.config import StorageMode
from app.db.models import Asset, AssetEnrichment, Run, RunStep
from app.deps import CurrentUser, Session, SettingsDep
from app.errors import NotFound
from app.services.reconstruct import build_reconstruction, upstream_closure
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
    exclude_workflow_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    stmt = select(Asset).where(Asset.tenant_id == user.tenant_id)
    if modality:
        stmt = stmt.where(Asset.modality == modality)
    if run_id:
        stmt = stmt.where(Asset.run_id == run_id)
    if exclude_workflow_id:
        # What the canvas's library panel asks for: everything *except* what
        # this workflow already made. Uploads belong to no workflow and are
        # named explicitly, because `NOT IN` over a NULL yields NULL and would
        # quietly drop every one of them.
        stmt = stmt.where(
            or_(
                Asset.run_id.is_(None),
                Asset.run_id.not_in(
                    select(Run.id).where(Run.workflow_id == exclude_workflow_id)
                ),
            )
        )
    stmt = stmt.order_by(Asset.created_at.desc()).limit(limit).offset(offset)

    result = await session.execute(stmt)
    return {
        "items": [_serialize(a) for a in result.scalars()],
        "limit": limit,
        "offset": offset,
    }


# --- search -----------------------------------------------------------------

#: Below this cosine similarity a "match" is noise wearing a ranking; the
#: semantic section ends rather than padding itself. Measured, not guessed:
#: with jina-v3's asymmetric tasks, unrelated queries score ≤0.15 against our
#: documents and genuinely related ones ≥0.31 — 0.25 splits them with margin.
SIMILARITY_FLOOR = 0.25


class SearchBody(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    modality: str | None = None
    kind: str | None = None
    #: The canvas panel searches "everything but this workflow's own output".
    exclude_workflow_id: uuid.UUID | None = None
    limit: int = Field(default=12, ge=1, le=50)


def _search_filters(stmt, body: SearchBody, tenant_id: str):
    stmt = stmt.where(Asset.tenant_id == tenant_id)
    if body.modality:
        stmt = stmt.where(Asset.modality == body.modality)
    if body.kind in ("upload", "generated"):
        from app.db.models import AssetKind

        stmt = stmt.where(Asset.kind == AssetKind(body.kind))
    if body.exclude_workflow_id:
        # Same shape as list_assets: uploads (run_id null) always pass —
        # NOT IN over a NULL would silently drop every one of them.
        stmt = stmt.where(
            or_(
                Asset.run_id.is_(None),
                Asset.run_id.not_in(
                    select(Run.id).where(Run.workflow_id == body.exclude_workflow_id)
                ),
            )
        )
    return stmt


def _search_row(asset: Asset, enrichment: AssetEnrichment | None) -> dict[str, Any]:
    return {
        **_serialize(asset),
        "caption": enrichment.caption if enrichment else None,
        "tags": list(enrichment.tags or []) if enrichment else [],
    }


@router.post("/search")
async def search_assets(
    body: SearchBody, session: Session, user: CurrentUser
) -> dict[str, Any]:
    """Hybrid search: a semantic section and a keyword section, separately.

    Two sections rather than one fused ranking on purpose — "close in meaning"
    and "contains your words" are different claims, and showing them apart
    means neither can bury the other. The keyword section excludes whatever
    the semantic section already surfaced.
    """
    from app.services.embeddings import DIMENSIONS, embed_query, vector_literal

    # Jina's round trip runs while the keyword query holds the DB session —
    # one session cannot run two queries at once, but it can overlap the API.
    embed_task = asyncio.create_task(embed_query(body.query))

    needle = f"%{body.query.strip()}%"
    ts = func.websearch_to_tsquery("english", literal(body.query))
    keyword_stmt = _search_filters(
        select(Asset, AssetEnrichment)
        .outerjoin(AssetEnrichment, AssetEnrichment.asset_id == Asset.id)
        .where(
            or_(
                # Enriched rows match on the generated tsvector; rows the
                # backfill has not reached yet still match by filename.
                AssetEnrichment.search_text.op("@@")(ts),
                Asset.filename.ilike(needle),
            )
        )
        .order_by(
            func.coalesce(func.ts_rank(AssetEnrichment.search_text, ts), 0).desc(),
            Asset.created_at.desc(),
        )
        # Overfetched: rows the semantic section claims are dropped below.
        .limit(body.limit * 2),
        body,
        user.tenant_id,
    )
    keyword_rows = list((await session.execute(keyword_stmt)).all())

    semantic: list[dict[str, Any]] = []
    vector = await embed_task
    if vector is not None:
        from pgvector.sqlalchemy import Vector

        # The vector rides as a text literal under a cast: asyncpg has no
        # codec for the vector OID, and text→vector is Postgres's own parse.
        query_vec = sa_cast(literal(vector_literal(vector)), Vector(DIMENSIONS))
        distance = AssetEnrichment.embedding.cosine_distance(query_vec)
        semantic_stmt = _search_filters(
            select(Asset, AssetEnrichment, distance.label("distance"))
            .join(AssetEnrichment, AssetEnrichment.asset_id == Asset.id)
            .where(AssetEnrichment.embedding.is_not(None))
            .order_by(distance)
            .limit(body.limit),
            body,
            user.tenant_id,
        )
        for asset, enrichment, dist in (await session.execute(semantic_stmt)).all():
            similarity = 1.0 - float(dist)
            if similarity < SIMILARITY_FLOOR:
                break  # ordered by distance — everything after is worse
            semantic.append(
                {**_search_row(asset, enrichment), "similarity": round(similarity, 3)}
            )

    claimed = {row["id"] for row in semantic}
    keyword = [
        _search_row(asset, enrichment)
        for asset, enrichment in keyword_rows
        if str(asset.id) not in claimed
    ][: body.limit]

    return {"query": body.query, "semantic": semantic, "keyword": keyword}


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(
    asset_id: uuid.UUID, session: Session, user: CurrentUser
) -> Response:
    """Remove an asset from the library.

    Deletes only the index row. The bytes and the provenance manifest stay in
    B2, which is the system of record — a run manifest that references this
    artifact must keep resolving even after the library forgets it.
    """
    asset = await _get_owned(session, asset_id, user)
    await session.delete(asset)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{asset_id}")
async def get_asset(
    asset_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    return _serialize(await _get_owned(session, asset_id, user))


async def _build_chain(
    session: Session, run: Run, asset: Asset
) -> dict[str, Any] | None:
    """The asset's upstream hops, read off the run's graph snapshot.

    The snapshot is the graph that actually ran, so walking its edges backward
    from the asset's node gives the true derivation — including nodes whose
    canvas has since been edited or deleted.
    """
    closure = upstream_closure(run.graph_snapshot or {}, asset.node_id or "")
    if closure is None:
        return None
    nodes, depth, order = closure
    if len(order) == 1:
        # Nothing upstream — the flat lineage block already tells the story.
        return None

    steps = {
        s.node_id: s
        for s in (
            await session.execute(select(RunStep).where(RunStep.run_id == run.id))
        ).scalars()
    }
    produced: dict[str, list[Asset]] = {}
    for row in (
        await session.execute(select(Asset).where(Asset.run_id == run.id))
    ).scalars():
        if row.node_id:
            produced.setdefault(row.node_id, []).append(row)

    # Upload nodes reference a library asset by id instead of producing one.
    upload_refs: dict[str, str] = {}
    for nid in order:
        data = nodes[nid].get("data") or {}
        if nodes[nid].get("kind") == "input.upload" and data.get("asset_id"):
            try:
                upload_refs[nid] = str(uuid.UUID(str(data["asset_id"])))
            except ValueError:
                continue
    uploads: dict[str, Asset] = {}
    if upload_refs:
        rows = await session.execute(
            select(Asset).where(
                Asset.tenant_id == run.tenant_id,
                Asset.id.in_([uuid.UUID(a) for a in set(upload_refs.values())]),
            )
        )
        uploads = {str(a.id): a for a in rows.scalars()}

    hops: list[dict[str, Any]] = []
    for nid in order:
        node = nodes[nid]
        data = node.get("data") or {}
        step = steps.get(nid)
        outputs = produced.get(nid, [])
        if not outputs and nid in upload_refs:
            ref = uploads.get(upload_refs[nid])
            outputs = [ref] if ref is not None else []
        hops.append(
            {
                "node_id": nid,
                "kind": node.get("kind"),
                "depth": depth[nid],
                "title": data.get("title") or data.get("label"),
                "text": data.get("text") if node.get("kind") == "input.text" else None,
                "provider": step.provider if step else None,
                "model": step.model if step else None,
                "prompt": step.prompt if step else None,
                "step_type": step.step_type if step else None,
                "assets": [_serialize(a) for a in outputs],
            }
        )
    return {
        "hops": hops,
        "edges": [
            {"source": e.get("source"), "target": e.get("target")}
            for e in (run.graph_snapshot or {}).get("edges", [])
            if e.get("source") in depth and e.get("target") in depth
        ],
    }


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
        "chain": None,
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
        # Tri-state: null means "not applicable" (local storage), which is
        # different from "verification failed".
        "manifest_verified": {"true": True, "false": False}.get(
            (run.manifest_verified if run else None) or ""
        ),
        "node_id": asset.node_id,
        "provider": step.provider if step else None,
        "model": step.model if step else None,
        "prompt": step.prompt if step else None,
        "params": step.params if step else None,
        "step_type": step.step_type if step else None,
        "cost_usd": step.cost_usd if step else None,
    }
    if run is not None:
        body["chain"] = await _build_chain(session, run, asset)
    return body


@router.get("/{asset_id}/reconstruct")
async def get_reconstruction(
    asset_id: uuid.UUID, session: Session, user: CurrentUser
) -> dict[str, Any]:
    """The graph that made this asset, rebuilt for another canvas.

    Read-only: it hands back a fragment with fresh node ids and its takes, and
    the canvas decides where to put it. Nothing is written until the document
    that received it saves.
    """
    asset = await _get_owned(session, asset_id, user)
    return await build_reconstruction(session, asset=asset, tenant_id=user.tenant_id)


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


# --- audio peaks ------------------------------------------------------------

#: Buckets the server computes per clip. The canvas draws far fewer bars than
#: this and downsamples to whatever its width allows, so one cached array
#: serves every node size without a re-decode.
_PEAK_BUCKETS = 400
#: Samples to decode across the whole clip, whatever its length. Peak envelopes
#: need nothing like full rate — this keeps a ten-minute track's analysis the
#: same cost as a two-second one.
_PEAK_TARGET_SAMPLES = 120_000
#: ``asset_id -> (peaks, duration_sec)``. Bytes behind an asset never change, so
#: this needs no TTL; the cap is only there to bound a long-lived process.
_PEAKS_CACHE_MAX = 256
_peaks_cache: dict[str, tuple[list[float], float]] = {}


def _probe_duration(target: str) -> float:
    """Clip length in seconds via ffprobe, or 0.0 when it cannot be read."""
    import subprocess

    from genblaze_core.providers._ffmpeg_utils import resolve_ffmpeg

    probe = resolve_ffmpeg("ffmpeg").replace("ffmpeg", "ffprobe")
    try:
        out = subprocess.run(
            [
                probe, "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1",
                target,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        ).stdout.strip()
        return max(0.0, float(out))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0.0


def _decode_peaks(target: str, duration: float) -> list[float]:
    """RMS per bucket over the whole clip, normalised so the loudest bucket is 1.

    Decodes to mono 16-bit PCM at whatever rate lands near
    ``_PEAK_TARGET_SAMPLES`` for this duration. Reading straight from the
    presigned URL keeps the bytes out of this process's disk.
    """
    import array
    import subprocess

    from genblaze_core.providers._ffmpeg_utils import resolve_ffmpeg

    rate = 4000 if duration <= 0 else int(min(8000, max(500, _PEAK_TARGET_SAMPLES / duration)))
    try:
        raw = subprocess.run(
            [
                resolve_ffmpeg("ffmpeg"), "-nostdin", "-v", "error",
                "-i", target,
                "-f", "s16le", "-ac", "1", "-ar", str(rate),
                "-",
            ],
            capture_output=True,
            timeout=60,
            check=False,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []

    # s16le is two bytes a sample; a trailing odd byte would break `array`.
    samples = array.array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
    if not samples:
        return []

    per = max(1, len(samples) // _PEAK_BUCKETS)
    peaks: list[float] = []
    loudest = 0.0
    for start in range(0, per * _PEAK_BUCKETS, per):
        window = samples[start : start + per]
        if not window:
            break
        total = 0
        for value in window:
            total += value * value
        rms = (total / len(window)) ** 0.5
        loudest = max(loudest, rms)
        peaks.append(rms)

    if loudest <= 0:
        return [0.0] * len(peaks)
    return [round(p / loudest, 4) for p in peaks]


@router.get("/{asset_id}/peaks")
async def get_peaks(
    asset_id: uuid.UUID, session: Session, user: CurrentUser, settings: SettingsDep
) -> dict[str, Any]:
    """The waveform envelope and true duration for an audio asset.

    Computed here rather than in the browser because the bucket is private and
    B2 sends no CORS headers, so the canvas cannot `fetch()` the bytes to decode
    them itself (the same constraint that makes `/download` proxy). Returns
    empty peaks rather than an error when ffmpeg cannot read the clip — the
    player falls back to a flat bar rather than losing its transport controls.
    """
    asset = await _get_owned(session, asset_id, user)

    if not (asset.media_type or "").startswith("audio/"):
        raise NotFound(f"Asset {asset_id} is not audio.")

    key = str(asset_id)
    hit = _peaks_cache.get(key)
    if hit is None:
        if settings.storage_mode is StorageMode.LOCAL:
            target = asset.url
        else:
            from app.engine.manifests import presign

            target = presign(asset.b2_key or asset.url)

        duration = _probe_duration(target)
        peaks = _decode_peaks(target, duration)
        hit = (peaks, duration)
        if peaks:
            if len(_peaks_cache) >= _PEAKS_CACHE_MAX:
                _peaks_cache.pop(next(iter(_peaks_cache)))
            _peaks_cache[key] = hit

    peaks, duration = hit
    return {"peaks": peaks, "duration_sec": duration}


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
