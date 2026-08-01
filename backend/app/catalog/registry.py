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
    # True when this is a *template* rather than a handle: the node expands it
    # into one port per item in its own data. The composite node's audio lanes
    # are the only user — see `audio_port_id` in graph/schema.py. A template
    # port never survives resolution, so nothing can connect to it.
    per_track: bool = False
    # Source roles this port takes, when its modality alone is too permissive.
    # A lipsync `speech` port is audio, but so are music and sound effects, and
    # neither drives a mouth. Empty means "any source of the right modality".
    # A source with no role of its own — an upload — always passes: a file
    # carries no claim about what is inside it.
    roles: list[str] = Field(default_factory=list)


class NodeTypeDescriptor(BaseModel):
    kind: str
    label: str
    category: str
    description: str | None = None
    inputs: list[PortSpec] = Field(default_factory=list)
    outputs: list[PortSpec] = Field(default_factory=list)
    default_data: dict[str, Any] = Field(default_factory=dict)


#: Retired provider keys, mapped to whoever serves their models now. Graphs
#: store the provider key alongside the model id, so a saved LLM node still
#: says "openrouter" long after Kimi K2.6 moved to Replicate — without this it
#: would compile to UNKNOWN_PROVIDER. Lookup-only: nothing re-emits these.
_PROVIDER_ALIASES = {"openrouter": "replicate"}


class Catalog(BaseModel):
    providers: list[ProviderDescriptor]
    node_types: list[NodeTypeDescriptor]

    def provider(self, key: str) -> ProviderDescriptor | None:
        key = _PROVIDER_ALIASES.get(key, key)
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


def _data_stamp() -> tuple[float, ...]:
    """Modification times of the YAML the catalog is built from."""
    stamps = []
    for name in ("providers.yaml", "node_types.yaml"):
        try:
            stamps.append((DATA_DIR / name).stat().st_mtime)
        except OSError:
            stamps.append(0.0)
    return tuple(stamps)


@lru_cache(maxsize=4)
def _catalog_for(_stamp: tuple[float, ...]) -> Catalog:
    return load_catalog()


def get_catalog() -> Catalog:
    """The catalog, rebuilt when its YAML changes.

    Keyed on the data files' mtimes rather than cached outright, because the
    catalog is hand-authored YAML read by a long-lived process: caching it for
    the life of the server means an edit to `node_types.yaml` does not reach the
    canvas until someone restarts, which reads as "my change did nothing" rather
    than "my change is cached" — and quietly serves ports the compiler no longer
    agrees with. `lib/studio/catalog.ts` makes the same call on the Next side.

    The cost is two `stat` calls per lookup; the parse itself still only happens
    when a file actually changed.
    """
    return _catalog_for(_data_stamp())


def refresh_catalog() -> Catalog:
    """Force a rebuild — after credentials change, where availability depends on
    the environment rather than on the files."""
    _catalog_for.cache_clear()
    return get_catalog()
