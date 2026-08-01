"""Tests for the Replicate text provider — the LLM node's real adapter.

Two failures this module guards against:

- A language model on Replicate returns `output` as a *list of streamed token
  strings*, not a string. Anything that treats it like a media model's output
  loses the answer.
- A reasoning model (Kimi K2.x) burning its whole `max_tokens` budget on
  chain-of-thought and returning nothing. The request sets
  `reasoning_effort: "none"` so the budget goes to the answer.

Everything runs against a stubbed `httpx.request` — no network, no real key.
"""

from __future__ import annotations

import httpx
import pytest
from genblaze_core import Modality
from genblaze_core.exceptions import ProviderError
from genblaze_core.models.step import Step

from app.engine.replicate_text_provider import ReplicateTextProvider


def _provider() -> ReplicateTextProvider:
    return ReplicateTextProvider(api_key="test-key")


def _step(prompt: str = "write a prompt for a mecha pilot character sheet") -> Step:
    return Step(model="moonshotai/kimi-k2.6", provider="replicate", prompt=prompt,
                modality=Modality.TEXT)


def _stub(monkeypatch, *bodies: dict, status_code: int = 200):
    """Replace httpx.request with one that records calls and replays `bodies`.

    Each call returns the next body, so a test can hand back a `processing`
    prediction first and a finished one on the poll.
    """
    calls: list[dict] = []
    queue = list(bodies)

    def fake_request(method, url, *, timeout, headers, json=None):
        calls.append({"method": method, "url": url, "headers": headers, "body": json})
        body = queue.pop(0) if len(queue) > 1 else queue[0]
        return httpx.Response(
            status_code, json=body, request=httpx.Request(method, url)
        )

    monkeypatch.setattr(httpx, "request", fake_request)
    return calls


def _succeeded(output) -> dict:
    return {"id": "pred-1", "status": "succeeded", "output": output}


def test_request_disables_reasoning_and_targets_the_model(monkeypatch):
    calls = _stub(monkeypatch, _succeeded(["a clean prompt"]))
    _provider().generate(_step())
    create = calls[0]
    assert create["url"].endswith("/models/moonshotai/kimi-k2.6/predictions")
    assert create["body"]["input"]["reasoning_effort"] == "none"
    # Without Prefer the create call returns immediately and every run pays a
    # poll round-trip it did not need.
    assert create["headers"]["Prefer"].startswith("wait=")


def test_streamed_token_list_is_joined_into_the_answer(monkeypatch):
    # The shape a real Kimi K2.6 prediction returns.
    _stub(monkeypatch, _succeeded(["The", " scar", "let", " bicycle", "."]))
    result = _provider().generate(_step())
    asset = result.assets[-1]
    assert asset.media_type == "text/plain"
    assert asset.metadata["text"] == "The scarlet bicycle."


def test_bare_string_output_is_accepted(monkeypatch):
    _stub(monkeypatch, _succeeded("  a clean prompt  "))
    result = _provider().generate(_step())
    assert result.assets[-1].metadata["text"] == "a clean prompt"


def test_system_prompt_and_tuning_params_are_forwarded(monkeypatch):
    calls = _stub(monkeypatch, _succeeded(["ok"]))
    step = _step()
    step.params = {"system_prompt": "be terse", "temperature": 0.2, "max_tokens": 64}
    _provider().generate(step)
    payload = calls[0]["body"]["input"]
    assert payload["system_prompt"] == "be terse"
    assert payload["temperature"] == 0.2
    assert payload["max_tokens"] == 64


def test_running_prediction_is_polled_to_completion(monkeypatch):
    monkeypatch.setattr("app.engine.replicate_text_provider._POLL_INTERVAL_SEC", 0)
    calls = _stub(
        monkeypatch,
        {"id": "pred-1", "status": "processing",
         "urls": {"get": "https://api.replicate.com/v1/predictions/pred-1"}},
        _succeeded(["polled answer"]),
    )
    result = _provider().generate(_step())
    assert result.assets[-1].metadata["text"] == "polled answer"
    assert calls[-1]["method"] == "GET"


def test_failed_prediction_raises(monkeypatch):
    _stub(monkeypatch, {"id": "pred-1", "status": "failed", "error": "model exploded"})
    with pytest.raises(ProviderError) as exc:
        _provider().generate(_step())
    assert "model exploded" in str(exc.value)


def test_empty_completion_errors(monkeypatch):
    _stub(monkeypatch, _succeeded([]))
    with pytest.raises(ProviderError) as exc:
        _provider().generate(_step())
    assert "empty completion" in str(exc.value).lower()


def test_non_string_output_does_not_crash(monkeypatch):
    # Defensive: a dict output must not raise AttributeError; it falls through
    # to the empty-completion error instead.
    _stub(monkeypatch, _succeeded({"text": "x"}))
    with pytest.raises(ProviderError) as exc:
        _provider().generate(_step())
    assert "empty completion" in str(exc.value).lower()


def test_http_error_maps_to_a_typed_provider_error(monkeypatch):
    _stub(monkeypatch, {"detail": "no credit"}, status_code=402)
    with pytest.raises(ProviderError) as exc:
        _provider().generate(_step())
    assert "402" in str(exc.value)
