"""Provider construction — the only place a `genblaze_*` adapter is instantiated.

Import and construction are both deferred to call time and both wrapped: an
adapter that raises on a missing key, or a package that fails to import, must
degrade to a typed error rather than taking down the process. The catalog
endpoint stays truthful because it uses `find_spec` and never comes through here.
"""

from __future__ import annotations

import importlib
from functools import lru_cache
from typing import Any

from app.catalog.registry import get_catalog
from app.errors import ProviderUnavailable
from app.graph.compile import FFMPEG_PROVIDER
from app.logging import get_logger

log = get_logger(__name__)


def _load_adapter(path: str) -> type[Any]:
    """Resolve a "module:ClassName" adapter reference."""
    module_name, _, attr = path.partition(":")
    if not module_name or not attr:
        raise ProviderUnavailable(f"Malformed adapter reference {path!r}.")
    module = importlib.import_module(module_name)
    return getattr(module, attr)


@lru_cache(maxsize=32)
def _adapter_for(provider_key: str, model_id: str) -> type[Any]:
    model = get_catalog().model(provider_key, model_id)
    if model is None:
        raise ProviderUnavailable(f"Unknown model {model_id!r} for provider {provider_key!r}.")
    return _load_adapter(model.adapter)


def build_provider(provider_key: str, model_id: str) -> Any:
    """Construct a GenBlaze provider for a planned step.

    Providers are constructed fresh per run. Adapters read their API key from the
    environment by default, so no key is ever passed through the request path.
    """
    if provider_key == FFMPEG_PROVIDER:
        # Ours, not GenBlaze's: `FFmpegCompositor` muxes exactly one video with
        # one audio and ignores params, so it can express neither the extra
        # lanes nor the faders a Composition node carries.
        from app.engine.compositor import TrackCompositor

        return TrackCompositor()

    try:
        adapter = _adapter_for(provider_key, model_id)
    except ProviderUnavailable:
        raise
    except ImportError as exc:
        catalog_provider = get_catalog().provider(provider_key)
        hint = catalog_provider.unavailable_reason() if catalog_provider else None
        raise ProviderUnavailable(
            f"The {provider_key} adapter is not installed.", hint=hint
        ) from exc
    except Exception as exc:
        raise ProviderUnavailable(f"Could not load the {provider_key} adapter.") from exc

    try:
        return adapter()
    except Exception as exc:
        catalog_provider = get_catalog().provider(provider_key)
        log.warning(
            "provider.construct_failed",
            provider=provider_key,
            model=model_id,
            error=f"{type(exc).__name__}: {exc}",
        )
        raise ProviderUnavailable(
            f"{catalog_provider.label if catalog_provider else provider_key} "
            "could not be initialized.",
            hint=catalog_provider.unavailable_reason() if catalog_provider else None,
        ) from exc
