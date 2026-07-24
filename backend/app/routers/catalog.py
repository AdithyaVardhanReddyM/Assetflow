"""Catalog endpoints — the canvas's server-driven palette and property panels.

Every model is always listed, with a `status` and a human-readable reason when
unavailable. Greying out an entry with "Set GEMINI_API_KEY to enable Google"
beats hiding it: the user can see what the product supports and how to unlock it.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
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
    # Hidden models stay compilable (the mock image model is the compiler
    # suite's substrate) but are not the canvas's business.
    models = [m for m in get_catalog().models if not m.hidden]
    if provider:
        models = [m for m in models if m.provider_key == provider]
    if modality:
        models = [m for m in models if m.modality.value == modality]
    if status:
        models = [m for m in models if m.status == status]
    return {"models": [_model_payload(m) for m in models]}


# --- voices -----------------------------------------------------------------

_VOICES_URL = "https://api.elevenlabs.io/v1/voices"
# Voice metadata is effectively static — an hour of staleness costs nothing and
# keeps a canvas full of TTS nodes from hammering ElevenLabs on every mount.
_VOICE_TTL_SEC = 3600.0
_voice_cache: tuple[float, dict[str, dict[str, Any]]] | None = None


def _offered_voice_ids() -> list[str]:
    """Voice IDs the catalog actually offers, in catalog order, deduped.

    Read off every `ui: voice` param rather than hardcoded here, so adding a
    voice to providers.yaml is the only edit adding a voice takes.
    """
    seen: dict[str, None] = {}
    for model in get_catalog().models:
        for param in model.params:
            if param.ui == "voice":
                for option in param.options:
                    seen.setdefault(option.value, None)
    return list(seen)


def _split_name(raw: str) -> tuple[str, str | None]:
    """ElevenLabs ships names as "Sarah - Mature, Reassuring, Confident".

    The tail is the most useful thing on the card — it is the voice's character
    in three words — but it belongs beside the name, not inside it.
    """
    name, sep, tail = raw.partition(" - ")
    return (name.strip(), tail.strip() or None) if sep else (raw.strip(), None)


def _fetch_voices(api_key: str) -> dict[str, dict[str, Any]]:
    """Voice metadata from ElevenLabs, keyed by voice ID. Cached for the TTL."""
    global _voice_cache

    now = time.monotonic()
    if _voice_cache is not None and now - _voice_cache[0] < _VOICE_TTL_SEC:
        return _voice_cache[1]

    resp = httpx.get(_VOICES_URL, headers={"xi-api-key": api_key}, timeout=10.0)
    resp.raise_for_status()

    by_id: dict[str, dict[str, Any]] = {}
    for voice in resp.json().get("voices", []):
        voice_id = voice.get("voice_id")
        if not voice_id:
            continue
        labels = voice.get("labels") or {}
        name, tagline = _split_name(str(voice.get("name") or ""))
        by_id[voice_id] = {
            "voice_id": voice_id,
            "name": name,
            "tagline": tagline,
            "description": voice.get("description"),
            # Public URLs — the browser plays them straight from ElevenLabs,
            # so no sample bytes ever transit this API.
            "preview_url": voice.get("preview_url"),
            "gender": labels.get("gender"),
            "age": labels.get("age"),
            "accent": labels.get("accent"),
            "use_case": labels.get("use_case"),
            "descriptive": labels.get("descriptive"),
            "language": labels.get("language"),
        }

    _voice_cache = (now, by_id)
    return by_id


@router.get("/voices")
async def list_voices() -> dict[str, Any]:
    """Tone/accent/age and a playable sample for each voice the catalog offers.

    Decoration only: the picker still renders every catalog option, so a
    missing key, a network blip or a voice ElevenLabs has since retired all
    degrade to the plain name rather than an empty list. `available` says which
    of the two the canvas is looking at.
    """
    offered = _offered_voice_ids()
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return {
            "voices": [],
            "available": False,
            "reason": "Set ELEVENLABS_API_KEY to load voice previews.",
        }

    try:
        by_id = _fetch_voices(api_key)
    except (httpx.HTTPError, ValueError) as exc:
        return {
            "voices": [],
            "available": False,
            "reason": f"ElevenLabs voice lookup failed: {exc}",
        }

    return {
        "voices": [by_id[v] for v in offered if v in by_id],
        "available": True,
    }


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
