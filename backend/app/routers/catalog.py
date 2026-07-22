"""Catalog endpoints — the canvas's server-driven palette and property panels.

Every model is always listed, with a `status` and a human-readable reason when
unavailable. Greying out an entry with "Set GEMINI_API_KEY to enable Google"
beats hiding it: the user can see what the product supports and how to unlock it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.catalog.models import ModelDescriptor, ProviderStatus
from app.catalog.registry import get_catalog

router = APIRouter(prefix="/v1/catalog", tags=["catalog"])


def _model_payload(model: ModelDescriptor) -> dict[str, Any]:
    return {
        "id": model.id,
        "label": model.label,
        "provider": model.provider_key,
        "provider_label": model.provider_label,
        "modality": model.modality.value,
        "role": model.role,
        "status": model.status.value,
        "expected_duration_sec": model.expected_duration_sec,
        "est_cost_usd": model.est_cost_usd,
        "output_media_type": model.output_media_type,
        "output_aspect_ratio": model.output_aspect_ratio,
        "requires_prompt": model.requires_prompt,
        "params": [p.model_dump(exclude_none=True) for p in model.params],
        "accepts": [a.model_dump() for a in model.accepts],
    }


@router.get("/providers")
async def list_providers() -> dict[str, Any]:
    catalog = get_catalog()
    return {
        "providers": [
            {
                "key": p.key,
                "label": p.label,
                "status": p.status.value,
                "reason": p.unavailable_reason(),
                "env_var": p.env_var,
                "signup_url": p.signup_url,
                "modalities": p.modalities,
                "model_count": len(p.models),
            }
            for p in catalog.providers
        ]
    }


@router.get("/models")
async def list_models(
    provider: str | None = Query(default=None),
    modality: str | None = Query(default=None),
    status: ProviderStatus | None = Query(default=None),
) -> dict[str, Any]:
    models = get_catalog().models
    if provider:
        models = [m for m in models if m.provider_key == provider]
    if modality:
        models = [m for m in models if m.modality.value == modality]
    if status:
        models = [m for m in models if m.status == status]
    return {"models": [_model_payload(m) for m in models]}


@router.get("/node-types")
async def list_node_types() -> dict[str, Any]:
    catalog = get_catalog()
    return {
        "node_types": [
            {
                "kind": n.kind,
                "label": n.label,
                "category": n.category,
                "description": n.description,
                "inputs": [p.model_dump() for p in n.inputs],
                "outputs": [p.model_dump() for p in n.outputs],
                "default_data": n.default_data,
            }
            for n in catalog.node_types
        ]
    }
