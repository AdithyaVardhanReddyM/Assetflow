"""Magic Text — decompose an image's typography into editable layers.

Two operations, both direct service calls rather than graph runs:

- **Layerize** hands an image to Ideogram's Layerize model (via Replicate) and
  gets back a text-erased base image plus structured text blocks (content,
  position, angle, font, size, color, hierarchy). The pair is stored in B2
  under ``magic-text/`` with a provenance manifest tying it to the source
  asset, and the JSON travels back to the canvas for the editor.
- **Register** takes the browser-composited edit (base + re-rendered text) and
  indexes it as a *generated* asset under the node it belongs to, backed by a
  lightweight completed Run row — that join is what puts the edit into the
  node's carousel and brings it back on reload via ``/workflows/{id}/results``.

Not a graph run because the layerize output is a JSON+image *pair* the modal
needs synchronously — the run pipeline's one-asset-per-step mold doesn't fit,
and nothing here needs the worker, retries, or SSE. The same reasoning as the
camera edit's synthetic subgraph, taken one step further.

Every layerize call bills (~$0.09) with no dedup here — the canvas caches the
result per source asset and only re-calls for a new take.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import struct
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select

from app.config import Settings, StorageMode, get_settings
from app.db.models import (
    Asset,
    AssetKind,
    Run,
    RunStatus,
    RunStep,
    StepStatus,
    Workflow,
)
from app.errors import AppError, NotFound
from app.logging import get_logger
from app.services.uploads import _store_b2, _store_local

log = get_logger(__name__)

LAYERIZE_MODEL = "ideogram-ai/layerize"
LAYERIZE_COST_USD = 0.09

#: Subject cutout for the occlusion sandwich (background → text → subject).
#: Runs on the text-ERASED base, never the original — a cutout of the original
#: could carry the old text's pixels back in on top of the edit.
CUTOUT_MODEL = "851-labs/background-remover"

_REPLICATE_API = "https://api.replicate.com/v1"
#: Layerize live-measures ~10–25s; leave generous slack before giving up.
_PREDICTION_TIMEOUT_SEC = 180
_POLL_INTERVAL_SEC = 1.5


class LayerizeUnavailable(AppError):
    status, code, title, retryable = (
        503,
        "layerize_unavailable",
        "Magic Text is not available",
        False,
    )


class LayerizeFailed(AppError):
    status, code, title, retryable = (
        502,
        "layerize_failed",
        "Layerize did not complete",
        True,
    )


def _replicate_token() -> str:
    token = os.getenv("REPLICATE_API_TOKEN")
    if not token:
        raise LayerizeUnavailable(
            "Set REPLICATE_API_TOKEN to enable Magic Text.",
        )
    return token


def png_dimensions(data: bytes) -> tuple[int, int] | None:
    """Width/height from a PNG's IHDR header, without an image library.

    The base image's real pixel size can disagree with the JSON's declared
    ``resolution`` (observed live: 960×1088 png vs "1024x1024" claimed), and
    the editor needs both to scale block coordinates onto real pixels.
    """
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return (width, height) if width and height else None


def pick_outputs(outputs: list[str]) -> tuple[str | None, str | None]:
    """(layers_json_url, base_image_url) from the model's output list.

    Observed order is [json, png] but classified by extension rather than
    trusted — an upstream reshuffle should not swap the poster for its JSON.
    """
    json_url = next((u for u in outputs if u.split("?")[0].endswith(".json")), None)
    image_url = next(
        (
            u
            for u in outputs
            if u.split("?")[0].lower().endswith((".png", ".webp", ".jpg", ".jpeg"))
        ),
        None,
    )
    return json_url, image_url


def parse_resolution(value: Any) -> tuple[int, int] | None:
    """The JSON's "1024x1024" resolution string — the block coordinate space."""
    if not isinstance(value, str) or "x" not in value:
        return None
    try:
        w, h = (int(part) for part in value.lower().split("x", 1))
    except ValueError:
        return None
    return (w, h) if w > 0 and h > 0 else None


async def _replicate_input_url(asset: Asset, settings: Settings) -> str:
    """A URL Replicate's fetcher can read this asset from.

    B2 mode presigns the private object. Local mode has no reachable URL at
    all, so the bytes go up through Replicate's file API first.
    """
    if settings.storage_mode is StorageMode.B2:
        from app.engine.manifests import presign

        # Generous TTL: the URL must outlive the prediction's queue time.
        return presign(asset.b2_key or asset.url, expires_in=3600)

    path = settings.local_media_dir / (asset.b2_key or "")
    if not path.is_file():
        raise NotFound("The asset's bytes are not reachable in storage.")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{_REPLICATE_API}/files",
            headers={"Authorization": f"Bearer {_replicate_token()}"},
            files={"content": (path.name, path.read_bytes(), asset.media_type)},
        )
        if resp.status_code >= 400:
            raise LayerizeFailed("Could not stage the image for layerize.")
        return resp.json()["urls"]["get"]


async def _run_prediction(model: str, input: dict[str, Any]) -> dict[str, Any]:
    """Create one Replicate prediction and wait it out. Returns the final body."""
    headers = {
        "Authorization": f"Bearer {_replicate_token()}",
        "Content-Type": "application/json",
        # Sync mode holds the response open up to 60s — usually the whole run.
        "Prefer": "wait=60",
    }
    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(
            f"{_REPLICATE_API}/models/{model}/predictions",
            headers=headers,
            json={"input": input},
        )
        if resp.status_code >= 400:
            detail = resp.json().get("detail", resp.text[:200]) if resp.content else ""
            raise LayerizeFailed(f"Replicate refused the layerize request. {detail}")
        body: dict[str, Any] = resp.json()

        waited = 0.0
        while body.get("status") in ("starting", "processing"):
            if waited > _PREDICTION_TIMEOUT_SEC:
                raise LayerizeFailed("Layerize timed out.")
            await asyncio.sleep(_POLL_INTERVAL_SEC)
            waited += _POLL_INTERVAL_SEC
            poll = await client.get(
                f"{_REPLICATE_API}/predictions/{body['id']}", headers=headers
            )
            if poll.status_code >= 400:
                raise LayerizeFailed("Lost track of the layerize prediction.")
            body = poll.json()

    if body.get("status") != "succeeded":
        raise LayerizeFailed(
            f"Layerize failed. {str(body.get('error') or '')[:300]}".strip()
        )
    return body


async def _fetch(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        resp = await client.get(url)
        if resp.status_code >= 400:
            raise LayerizeFailed("Could not download the layerize output.")
        return resp.content


async def _store(
    data: bytes, *, key: str, media_type: str, sha256: str, settings: Settings
) -> tuple[str, str]:
    """Bytes into B2 (or local media) under an explicit key → (url, key)."""
    if settings.storage_mode is StorageMode.B2:
        return await asyncio.to_thread(
            _store_b2,
            io.BytesIO(data),
            key=key,
            media_type=media_type,
            sha256=sha256,
            settings=settings,
        )
    return await asyncio.to_thread(
        _store_local, io.BytesIO(data), key=key, settings=settings
    )


def _key(settings: Settings, tenant_id: str, name: str) -> str:
    prefix = (
        f"{settings.b2_prefix}/{tenant_id}"
        if settings.storage_mode is StorageMode.B2
        else tenant_id
    )
    return f"{prefix}/magic-text/{name}"


def single_output_url(output: Any) -> str | None:
    """A prediction's output as one URL — some models emit a string, some a list."""
    if isinstance(output, str) and output.startswith("http"):
        return output
    if isinstance(output, list):
        return next(
            (u for u in output if isinstance(u, str) and u.startswith("http")), None
        )
    return None


async def _cutout_subject(
    session,
    *,
    base_bytes: bytes,
    base_key: str,
    tenant_id: str,
    settings: Settings,
) -> Asset | None:
    """The base image's salient subject as an RGBA layer, or None.

    Best-effort by design: the occlusion sandwich is an enhancement, and a
    poster with no clear subject (or a model hiccup) must degrade to the
    two-layer edit rather than fail the whole layerize.
    """
    try:
        if settings.storage_mode is StorageMode.B2:
            from app.engine.manifests import presign

            source_url = presign(base_key, expires_in=3600)
        else:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{_REPLICATE_API}/files",
                    headers={"Authorization": f"Bearer {_replicate_token()}"},
                    files={"content": ("base.png", base_bytes, "image/png")},
                )
                if resp.status_code >= 400:
                    return None
                source_url = resp.json()["urls"]["get"]

        prediction = await _run_prediction(
            CUTOUT_MODEL, {"image": source_url, "format": "png"}
        )
        url = single_output_url(prediction.get("output"))
        if not url:
            return None
        cutout_bytes = await _fetch(url)
        size = png_dimensions(cutout_bytes)

        sha = hashlib.sha256(cutout_bytes).hexdigest()
        stored_url, stored_key = await _store(
            cutout_bytes,
            key=_key(settings, tenant_id, f"{sha}-cutout.png"),
            media_type="image/png",
            sha256=sha,
            settings=settings,
        )
        cutout = Asset(
            tenant_id=tenant_id,
            kind=AssetKind.GENERATED,
            url=stored_url,
            b2_key=stored_key,
            media_type="image/png",
            modality="image",
            sha256=sha,
            size_bytes=len(cutout_bytes),
            width=size[0] if size else None,
            height=size[1] if size else None,
            filename="magic-text-cutout.png",
            asset_metadata={
                "source": "magic_text.cutout",
                "model": CUTOUT_MODEL,
                "base_b2_key": base_key,
                "prediction_id": prediction.get("id"),
            },
        )
        session.add(cutout)
        return cutout
    except (LayerizeFailed, LayerizeUnavailable, httpx.HTTPError, OSError):
        log.warning("magic_text.cutout_failed", tenant=tenant_id, key=base_key)
        return None


async def layerize_asset(
    session, *, asset: Asset, tenant_id: str, settings: Settings | None = None
) -> dict[str, Any]:
    """Run Layerize on an image asset; store and return the decomposition.

    Returns ``{base_asset, resolution, base_size, containers}`` where
    ``containers`` is the model's own text_containers JSON, untouched — the
    canvas owns the interpretation, mirroring how node params pass through.
    """
    settings = settings or get_settings()
    if asset.modality != "image":
        raise LayerizeFailed("Only images can be layerized.")

    input_url = await _replicate_input_url(asset, settings)
    prediction = await _run_prediction(
        LAYERIZE_MODEL, {"flat_graphic_image": input_url}
    )

    outputs = prediction.get("output") or []
    json_url, image_url = pick_outputs(outputs if isinstance(outputs, list) else [])
    if not json_url or not image_url:
        raise LayerizeFailed("Layerize returned no usable output.")

    layers_raw, base_bytes = await asyncio.gather(_fetch(json_url), _fetch(image_url))

    try:
        payload = json.loads(layers_raw)
        record = payload["data"][0]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        raise LayerizeFailed("Layerize returned malformed layer data.") from exc

    containers = record.get("text_containers") or []
    resolution = parse_resolution(record.get("resolution"))
    base_size = png_dimensions(base_bytes)

    sha = hashlib.sha256(base_bytes).hexdigest()
    base_url, base_key = await _store(
        base_bytes,
        key=_key(settings, tenant_id, f"{sha}-base.png"),
        media_type="image/png",
        sha256=sha,
        settings=settings,
    )

    cutout = await _cutout_subject(
        session,
        base_bytes=base_bytes,
        base_key=base_key,
        tenant_id=tenant_id,
        settings=settings,
    )

    # The manifest is the provenance record: which asset went in, which model
    # ran, and the full decomposition that came out. Written beside the bytes
    # so the bucket alone can answer "where did this come from".
    manifest = {
        "kind": "magic_text.layerize",
        "created_at": datetime.now(UTC).isoformat(),
        "source_asset_id": str(asset.id),
        "source_sha256": asset.sha256,
        "model": LAYERIZE_MODEL,
        "prediction_id": prediction.get("id"),
        "seed": record.get("seed"),
        "est_cost_usd": LAYERIZE_COST_USD,
        "base_image": {"b2_key": base_key, "sha256": sha, "size": base_size},
        "subject_cutout": (
            {"b2_key": cutout.b2_key, "sha256": cutout.sha256, "model": CUTOUT_MODEL}
            if cutout
            else None
        ),
        "resolution": record.get("resolution"),
        "text_containers": containers,
    }
    manifest_bytes = json.dumps(manifest, indent=1).encode()
    manifest_url, _manifest_key = await _store(
        manifest_bytes,
        key=_key(settings, tenant_id, f"{sha}-layerize.manifest.json"),
        media_type="application/json",
        sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        settings=settings,
    )

    base_asset = Asset(
        tenant_id=tenant_id,
        kind=AssetKind.GENERATED,
        # No run_id/node_id: the base is working material for the editor, not
        # a take — it must never surface in a node's carousel.
        url=base_url,
        b2_key=base_key,
        media_type="image/png",
        modality="image",
        sha256=sha,
        size_bytes=len(base_bytes),
        width=base_size[0] if base_size else None,
        height=base_size[1] if base_size else None,
        manifest_uri=manifest_url,
        filename="magic-text-base.png",
        asset_metadata={
            "source": "magic_text.layerize",
            "source_asset_id": str(asset.id),
            "model": LAYERIZE_MODEL,
            "prediction_id": prediction.get("id"),
        },
    )
    session.add(base_asset)
    await session.commit()
    await session.refresh(base_asset)
    if cutout is not None:
        await session.refresh(cutout)
    log.info(
        "magic_text.layerized",
        tenant=tenant_id,
        source=str(asset.id),
        blocks=sum(len(c.get("items") or []) for c in containers),
        cutout=cutout is not None,
    )

    return {
        "base_asset": base_asset,
        "cutout_asset": cutout,
        "resolution": resolution,
        "base_size": base_size,
        "containers": containers,
    }


async def register_text_edit(
    session,
    *,
    tenant_id: str,
    user_id: str,
    workflow_id: uuid.UUID,
    node_id: str,
    image: bytes,
    base_asset_id: uuid.UUID | None,
    settings: Settings | None = None,
) -> Asset:
    """Index a browser-composited text edit as a generation of ``node_id``.

    The carousel and reload hydration read generated assets through their run's
    workflow (``/results`` joins Asset.run_id → Run.workflow_id), so the edit
    gets a minimal completed Run + one step. The step doubles as provenance:
    ``/assets/{id}/provenance`` reports provider/model/params from it.
    """
    settings = settings or get_settings()

    workflow = (
        await session.execute(
            select(Workflow).where(
                Workflow.id == workflow_id, Workflow.tenant_id == tenant_id
            )
        )
    ).scalar_one_or_none()
    if workflow is None:
        raise NotFound(f"Workflow {workflow_id} was not found.")

    size = png_dimensions(image)
    sha = hashlib.sha256(image).hexdigest()
    url, key = await _store(
        image,
        key=_key(settings, tenant_id, f"{sha}-edit.png"),
        media_type="image/png",
        sha256=sha,
        settings=settings,
    )

    manifest = {
        "kind": "magic_text.edit",
        "created_at": datetime.now(UTC).isoformat(),
        "base_asset_id": str(base_asset_id) if base_asset_id else None,
        "workflow_id": str(workflow_id),
        "node_id": node_id,
        "edit_image": {"b2_key": key, "sha256": sha, "size": size},
        "composited_by": "canvas",
    }
    manifest_bytes = json.dumps(manifest, indent=1).encode()
    manifest_url, _ = await _store(
        manifest_bytes,
        key=_key(settings, tenant_id, f"{sha}-edit.manifest.json"),
        media_type="application/json",
        sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        settings=settings,
    )

    now = datetime.now(UTC)
    run = Run(
        tenant_id=tenant_id,
        owner_user_id=user_id,
        workflow_id=workflow_id,
        graph_snapshot={"version": 1, "nodes": [], "edges": []},
        plan_snapshot={"source": "magic_text", "steps": []},
        status=RunStatus.SUCCEEDED,
        manifest_uri=manifest_url,
        total_cost_usd=0.0,
        started_at=now,
        finished_at=now,
    )
    session.add(run)
    await session.flush()

    session.add(
        RunStep(
            run_id=run.id,
            node_id=node_id,
            step_index=0,
            provider="magic_text",
            model="text-edit",
            modality="image",
            step_type="edit",
            status=StepStatus.SUCCEEDED,
            params={"base_asset_id": str(base_asset_id) if base_asset_id else None},
            cost_usd=0.0,
            started_at=now,
            finished_at=now,
        )
    )

    edit_asset = Asset(
        tenant_id=tenant_id,
        kind=AssetKind.GENERATED,
        run_id=run.id,
        node_id=node_id,
        url=url,
        b2_key=key,
        media_type="image/png",
        modality="image",
        sha256=sha,
        size_bytes=len(image),
        width=size[0] if size else None,
        height=size[1] if size else None,
        manifest_uri=manifest_url,
        filename="magic-text-edit.png",
        asset_metadata={
            "source": "magic_text.edit",
            "base_asset_id": str(base_asset_id) if base_asset_id else None,
        },
    )
    session.add(edit_asset)
    await session.commit()
    await session.refresh(edit_asset)
    log.info("magic_text.edit_registered", tenant=tenant_id, node=node_id)

    # The edit is a real library asset; index it like any other generation.
    # (The layerize base/cutout above are deliberately not enriched — they are
    # editor scaffolding, and captioning them would fill search with copies.)
    from app.services.enrich import schedule_enrichment

    schedule_enrichment(edit_asset.id)
    return edit_asset
