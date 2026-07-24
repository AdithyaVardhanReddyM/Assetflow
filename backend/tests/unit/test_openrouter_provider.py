"""Tests for the OpenRouter text provider — the LLM node's real adapter.

The failure this module guards against is a reasoning model (Kimi K2.x) burning
its whole `max_tokens` budget on chain-of-thought and returning an empty
`content`, which used to fail the step outright. The request disables reasoning
so the budget goes to the answer, and extraction falls back to the reasoning
field if a model ignores that and answers only there.

Everything runs against a stubbed `httpx.post` — no network, no real key.
"""

from __future__ import annotations

import httpx
import pytest
from genblaze_core import Modality
from genblaze_core.exceptions import ProviderError
from genblaze_core.models.step import Step

from app.engine import openrouter_provider
from app.engine.openrouter_provider import OpenRouterTextProvider


def _provider() -> OpenRouterTextProvider:
    return OpenRouterTextProvider(api_key="test-key")


def _step(prompt: str = "write a prompt for a mecha pilot character sheet") -> Step:
    return Step(model="moonshotai/kimi-k2.6", provider="openrouter", prompt=prompt,
                modality=Modality.TEXT)


def _stub_post(monkeypatch, message: dict, *, status_code: int = 200):
    """Replace httpx.post with one that records the body and returns `message`."""
    captured: dict = {}

    def fake_post(url, *, json, headers, timeout):  # noqa: A002 - mirror httpx
        captured["body"] = json
        return httpx.Response(
            status_code,
            json={"choices": [{"message": message}], "usage": {"cost": 0.001}},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    return captured


def test_request_disables_reasoning(monkeypatch):
    captured = _stub_post(monkeypatch, {"content": "a clean prompt"})
    _provider().generate(_step())
    assert captured["body"]["reasoning"] == {"enabled": False}


def test_content_is_extracted_and_carried_in_metadata(monkeypatch):
    _stub_post(monkeypatch, {"content": "  a clean prompt  "})
    result = _provider().generate(_step())
    asset = result.assets[-1]
    assert asset.media_type == "text/plain"
    assert asset.metadata["text"] == "a clean prompt"


def test_falls_back_to_reasoning_when_content_is_empty(monkeypatch):
    # A model that ignored reasoning.enabled and answered only in `reasoning`.
    _stub_post(monkeypatch, {"content": "", "reasoning": "the drafted answer"})
    result = _provider().generate(_step())
    assert result.assets[-1].metadata["text"] == "the drafted answer"


def test_falls_back_to_reasoning_content_field(monkeypatch):
    _stub_post(monkeypatch, {"content": None, "reasoning_content": "draft two"})
    result = _provider().generate(_step())
    assert result.assets[-1].metadata["text"] == "draft two"


def test_truly_empty_completion_still_errors(monkeypatch):
    _stub_post(monkeypatch, {"content": "", "reasoning": "   "})
    with pytest.raises(ProviderError) as exc:
        _provider().generate(_step())
    assert "empty completion" in str(exc.value).lower()


def test_non_string_content_does_not_crash(monkeypatch):
    # Defensive: a multimodal content array must not raise AttributeError; it
    # falls through to the empty-completion error instead.
    _stub_post(monkeypatch, {"content": [{"type": "text", "text": "x"}]})
    with pytest.raises(ProviderError) as exc:
        _provider().generate(_step())
    assert "empty completion" in str(exc.value).lower()
