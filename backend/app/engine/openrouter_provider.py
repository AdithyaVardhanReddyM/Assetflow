"""OpenRouter text generation — the LLM node's real provider.

Deliberately not a `genblaze_*` package: OpenRouter is a plain HTTPS
chat-completions API, and text-in/text-out needs none of the submit/poll
machinery the media connectors exist for. The adapter still subclasses
GenBlaze's `SyncProvider`, so LLM steps run through the same pipeline, sink,
event stream, and manifest as every media step.

The response text is written to a temp file and returned as a `file://` asset —
the same shape the mock providers use — because the sink transfers and hashes
real bytes, which is what keeps text output inside the provenance story. The
words also ride in `metadata["text"]` so no consumer has to fetch and decode
the file to learn what the LLM said (GenBlaze reads that field itself for
moderation screening).
"""

from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

import httpx
from genblaze_core import Asset
from genblaze_core.exceptions import ProviderError
from genblaze_core.models.enums import ProviderErrorCode
from genblaze_core.models.step import Step
from genblaze_core.providers.base import SyncProvider
from genblaze_core.runnable.config import RunnableConfig

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
ENV_VAR = "OPENROUTER_API_KEY"

# Used when the node leaves `system_prompt` empty. Chained prompts feed
# straight into image/video models, so the default steers the model away from
# chat framing ("Sure! Here's...") that would end up inside a generation.
DEFAULT_SYSTEM_PROMPT = (
    "You are a writing assistant inside a media-generation workflow. "
    "Respond with only the requested text — no preamble, no commentary, "
    "no markdown fences."
)

_ERROR_CODE_BY_STATUS = {
    401: ProviderErrorCode.AUTH_FAILURE,
    402: ProviderErrorCode.AUTH_FAILURE,  # out of credits
    403: ProviderErrorCode.CONTENT_POLICY,
    408: ProviderErrorCode.TIMEOUT,
    429: ProviderErrorCode.RATE_LIMIT,
}


def _staged(text: str) -> Path:
    """Write the response into temp so the sink may read it.

    The sink refuses local sources outside temp or a provider `output_dir` — a
    guard against being coaxed into reading arbitrary files — so temp is where
    a synchronous provider's local output belongs.
    """
    out_dir = Path(tempfile.gettempdir()) / "assetflow-openrouter"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{uuid.uuid4().hex}.txt"
    path.write_text(text, encoding="utf-8")
    return path


class OpenRouterTextProvider(SyncProvider):
    """Text in, text out via OpenRouter's chat-completions endpoint."""

    name = "openrouter"

    def __init__(self, *, api_key: str | None = None, timeout: float = 120.0) -> None:
        super().__init__()
        key = api_key or os.getenv(ENV_VAR)
        if not key:
            # build_provider turns this into a typed ProviderUnavailable; the
            # catalog reports the same absence as `missing_key`.
            raise ProviderError(
                f"{ENV_VAR} is not set.", error_code=ProviderErrorCode.AUTH_FAILURE
            )
        self._api_key = key
        self._timeout = timeout

    def generate(self, step: Step, config: RunnableConfig | None = None) -> Step:
        prompt = (step.prompt or "").strip()
        if not prompt:
            raise ProviderError(
                "The LLM step has no prompt.", error_code=ProviderErrorCode.INVALID_INPUT
            )

        params: dict[str, Any] = dict(step.params or {})
        system = str(params.get("system_prompt") or "").strip() or DEFAULT_SYSTEM_PROMPT

        body: dict[str, Any] = {
            "model": step.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            # Ask OpenRouter to account the request so cost lands on the step.
            "usage": {"include": True},
        }
        if params.get("temperature") is not None:
            body["temperature"] = float(params["temperature"])
        if params.get("max_tokens") is not None:
            body["max_tokens"] = int(params["max_tokens"])

        try:
            response = httpx.post(
                OPENROUTER_URL,
                json=body,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    # Attribution headers OpenRouter asks apps to send.
                    "HTTP-Referer": "https://github.com/assetflow",
                    "X-Title": "AssetFlow",
                },
                timeout=self._timeout,
            )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                "OpenRouter timed out.", error_code=ProviderErrorCode.TIMEOUT
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"OpenRouter request failed: {exc}",
                error_code=ProviderErrorCode.SERVER_ERROR,
            ) from exc

        if response.status_code >= 400:
            code = _ERROR_CODE_BY_STATUS.get(
                response.status_code,
                ProviderErrorCode.SERVER_ERROR
                if response.status_code >= 500
                else ProviderErrorCode.MODEL_ERROR,
            )
            raise ProviderError(
                f"OpenRouter returned {response.status_code}: {response.text[:300]}",
                error_code=code,
            )

        data = response.json()
        try:
            content = (data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError(
                "OpenRouter returned an unexpected response shape.",
                error_code=ProviderErrorCode.MODEL_ERROR,
            ) from exc
        if not content:
            raise ProviderError(
                "OpenRouter returned an empty completion.",
                error_code=ProviderErrorCode.MODEL_ERROR,
            )

        usage = data.get("usage") or {}
        if isinstance(usage.get("cost"), (int, float)):
            step.cost_usd = float(usage["cost"])

        path = _staged(content)
        step.assets.append(
            Asset(
                # No sha256: the sink computes it from the bytes it transfers,
                # which is what makes Manifest.verify() meaningful.
                url=path.resolve().as_uri(),
                media_type="text/plain",
                size_bytes=path.stat().st_size,
                metadata={"text": content},
            )
        )
        return step


def text_provider(**kwargs: Any) -> OpenRouterTextProvider:
    """Adapter factory, referenced from providers.yaml."""
    return OpenRouterTextProvider(**kwargs)
