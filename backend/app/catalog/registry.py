"""Loads the YAML catalog and resolves provider availability.

Availability resolution must never crash and must never *import* a provider
package — `find_spec` checks installability without executing module code, so a
broken or key-hungry adapter cannot take down the catalog endpoint (or startup).
Actual construction happens only in `app.engine.providers`.
"""

from __future__ import annotations

import importlib.util
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from app.catalog.models import (
    ModelDescriptor,
    ProviderDescriptor,
    ProviderStatus,
)

DATA_DIR = Path(__file__).parent / "data"


class PortSpec(BaseModel):
    id: str
    modality: str
    required: bool = False
    multi: bool = False
    # True when the port only exists if the selected model declares it in `accepts`.
    model_gated: bool = False


class NodeTypeDescriptor(BaseModel):
    kind: str
    label: str
    category: str
    description: str | None = None
    inputs: list[PortSpec] = Field(default_factory=list)
    outputs: list[PortSpec] = Field(default_factory=list)
    default_data: dict[str, Any] = Field(default_factory=dict)


class Catalog(BaseModel):
    providers: list[ProviderDescriptor]
    node_types: list[NodeTypeDescriptor]

    def provider(self, key: str) -> ProviderDescriptor | None:
        return next((p for p in self.providers if p.key == key), None)

    def model(self, provider_key: str, model_id: str) -> ModelDescriptor | None:
        provider = self.provider(provider_key)
        if provider is None:
            return None
        return next((m for m in provider.models if m.id == model_id), None)

    def node_type(self, kind: str) -> NodeTypeDescriptor | None:
        return next((n for n in self.node_types if n.kind == kind), None)

    @property
    def models(self) -> list[ModelDescriptor]:
        return [m for p in self.providers for m in p.models]


def resolve_status(provider: ProviderDescriptor) -> ProviderStatus:
    """Three cheap checks, none of which imports the provider package."""
    if provider.always_available:
        return ProviderStatus.READY
    if not provider.package or importlib.util.find_spec(provider.package) is None:
        return ProviderStatus.NOT_INSTALLED
    if provider.env_var and not os.getenv(provider.env_var):
        return ProviderStatus.MISSING_KEY
    return ProviderStatus.READY


def _load_yaml(name: str) -> dict[str, Any]:
    with (DATA_DIR / name).open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load_catalog() -> Catalog:
    raw_providers = _load_yaml("providers.yaml").get("providers", [])
    raw_node_types = _load_yaml("node_types.yaml").get("node_types", [])

    providers: list[ProviderDescriptor] = []
    for entry in raw_providers:
        provider = ProviderDescriptor.model_validate(entry)
        provider.status = resolve_status(provider)
        # Denormalize onto each model so a flat /catalog/models response is
        # self-describing and the canvas can grey out entries without a join.
        for model in provider.models:
            model.provider_key = provider.key
            model.provider_label = provider.label
            model.status = provider.status
        providers.append(provider)

    node_types = [NodeTypeDescriptor.model_validate(n) for n in raw_node_types]
    return Catalog(providers=providers, node_types=node_types)


@lru_cache(maxsize=1)
def get_catalog() -> Catalog:
    return load_catalog()


def refresh_catalog() -> Catalog:
    """Re-resolve availability (e.g. after credentials change). Used by /readyz."""
    get_catalog.cache_clear()
    return get_catalog()
