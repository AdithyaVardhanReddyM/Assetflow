"""Replicate text generation — the LLM node's real provider.

Deliberately not a `genblaze_*` package, and deliberately separate from the
`replicate_provider` factory in `genblaze_adapters`: that one wraps GenBlaze's
image/video connector, while text-in/text-out only needs Replicate's plain
predictions API. The adapter still subclasses GenBlaze's `SyncProvider`, so LLM
steps run through the same pipeline, sink, event stream, and manifest as every
media step.

Replicate has no chat-completions endpoint. A prediction is created against
`/v1/models/{owner}/{name}/predictions`, `Prefer: wait` holds the response open
until it finishes (a K2.6 answer lands in ~1-2s, well inside the window), and
anything still running when that returns is polled out. Language models stream,
so `output` arrives as a *list of token strings* that has to be concatenated —
not a single string like the media models' output URLs.

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
import time
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

REPLICATE_API = "https://api.replicate.com/v1"
ENV_VAR = "REPLICATE_API_TOKEN"

#: Seconds Replicate holds the create call open before answering with a
#: still-running prediction. 60 is its documented ceiling.
_PREFER_WAIT_SEC = 60
_POLL_INTERVAL_SEC = 1.5

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
    422: ProviderErrorCode.INVALID_INPUT,
    429: ProviderErrorCode.RATE_LIMIT,
}


def _staged(text: str) -> Path:
    """Write the response into temp so the sink may read it.

    The sink refuses local sources outside temp or a provider `output_dir` — a
    guard against being coaxed into reading arbitrary files — so temp is where
    a synchronous provider's local output belongs.
    """
    out_dir = Path(tempfile.gettempdir()) / "assetflow-replicate"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{uuid.uuid4().hex}.txt"
    path.write_text(text, encoding="utf-8")
    return path


def _joined(output: Any) -> str:
    """The answer, from Replicate's streamed token list.

    A language model's `output` is `["The", " scar", "let", ...]`; the
    concatenation is the text. Tolerates a bare string in case a model is
    wrapped without streaming.
    """
    if isinstance(output, str):
        return output.strip()
    if isinstance(output, list):
        return "".join(p for p in output if isinstance(p, str)).strip()
    return ""


class ReplicateTextProvider(SyncProvider):
    """Text in, text out via Replicate's predictions endpoint."""

    name = "replicate"

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

    def _headers(self, *, wait: bool = False) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        if wait:
            headers["Prefer"] = f"wait={_PREFER_WAIT_SEC}"
        return headers

    def _fail_on_status(self, response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        code = _ERROR_CODE_BY_STATUS.get(
            response.status_code,
            ProviderErrorCode.SERVER_ERROR
            if response.status_code >= 500
            else ProviderErrorCode.MODEL_ERROR,
        )
        raise ProviderError(
            f"Replicate returned {response.status_code}: {response.text[:300]}",
            error_code=code,
        )

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            response = httpx.request(method, url, timeout=self._timeout, **kwargs)
        except httpx.TimeoutException as exc:
            raise ProviderError(
                "Replicate timed out.", error_code=ProviderErrorCode.TIMEOUT
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"Replicate request failed: {exc}",
                error_code=ProviderErrorCode.SERVER_ERROR,
            ) from exc
        self._fail_on_status(response)
        return response

    def _await_prediction(self, body: dict[str, Any]) -> dict[str, Any]:
        """Poll until the prediction leaves a running state, or time out."""
        deadline = time.monotonic() + self._timeout
        while body.get("status") in ("starting", "processing"):
            if time.monotonic() > deadline:
                raise ProviderError(
                    "Replicate did not finish in time.",
                    error_code=ProviderErrorCode.TIMEOUT,
                )
            time.sleep(_POLL_INTERVAL_SEC)
            poll_url = (body.get("urls") or {}).get("get") or (
                f"{REPLICATE_API}/predictions/{body.get('id')}"
            )
            body = self._request("GET", poll_url, headers=self._headers()).json()
        return body

    def generate(self, step: Step, config: RunnableConfig | None = None) -> Step:
        prompt = (step.prompt or "").strip()
        if not prompt:
            raise ProviderError(
                "The LLM step has no prompt.", error_code=ProviderErrorCode.INVALID_INPUT
            )

        params: dict[str, Any] = dict(step.params or {})
        system = str(params.get("system_prompt") or "").strip() or DEFAULT_SYSTEM_PROMPT

        payload: dict[str, Any] = {
            "prompt": prompt,
            "system_prompt": system,
            # This node writes clean, prompt-ready text that feeds straight into
            # image and video models — chain-of-thought is never wanted in the
            # output. On a reasoning model (Kimi K2.x is one) an enabled
            # reasoning trace silently eats the `max_tokens` budget: the answer
            # never gets emitted and the step fails on an empty completion.
            # "none" hands the whole budget to the answer.
            "reasoning_effort": "none",
        }
        if params.get("temperature") is not None:
            payload["temperature"] = float(params["temperature"])
        if params.get("max_tokens") is not None:
            payload["max_tokens"] = int(params["max_tokens"])

        created = self._request(
            "POST",
            f"{REPLICATE_API}/models/{step.model}/predictions",
            json={"input": payload},
            headers=self._headers(wait=True),
        )
        body = self._await_prediction(created.json())

        status = body.get("status")
        if status != "succeeded":
            detail = str(body.get("error") or status or "")[:300]
            raise ProviderError(
                f"Replicate did not complete the prediction. {detail}".strip(),
                error_code=ProviderErrorCode.MODEL_ERROR,
            )

        content = _joined(body.get("output"))
        if not content:
            raise ProviderError(
                "Replicate returned an empty completion.",
                error_code=ProviderErrorCode.MODEL_ERROR,
            )

        # No cost: Replicate prices predictions out of band and the response
        # carries only token counts, so the step keeps the catalog's estimate —
        # same as every other Replicate model here.
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


def text_provider(**kwargs: Any) -> ReplicateTextProvider:
    """Adapter factory, referenced from providers.yaml."""
    return ReplicateTextProvider(**kwargs)
