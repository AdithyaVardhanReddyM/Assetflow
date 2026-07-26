"""Jina embeddings — the semantic half of library search.

One embedding space for every modality: an asset is embedded through the *text*
assembled about it (caption, tags, OCR, prompt, filename), never through its
pixels. That is what lets one query vector rank images, videos, and music
together — and it means an asset with no vision pass yet is still findable by
its prompt.

Asymmetric on purpose: documents are embedded with `retrieval.passage`, queries
with `retrieval.query`. jina-embeddings-v3 is trained for that split, and using
one task for both measurably flattens ranking.

Every function degrades to None rather than raising — a missing key or a Jina
outage turns search keyword-only and enrichment vector-less, neither of which
is worth failing an upload or a request over.
"""

from __future__ import annotations

import httpx

from app.config import Settings, get_settings
from app.logging import get_logger

log = get_logger(__name__)

JINA_URL = "https://api.jina.ai/v1/embeddings"
MODEL = "jina-embeddings-v3"
#: Must match the `vector(1024)` column — a mismatch fails at insert, loudly.
DIMENSIONS = 1024

#: Jina truncates internally past its context; sending more is pure cost.
_MAX_CHARS = 6000

#: Query → vector. Search re-embeds the same string on every keystroke pause;
#: no TTL because an embedding of a string never changes. Bounded like the
#: peaks cache: the cap only exists to bound a long-lived process.
_QUERY_CACHE_MAX = 512
_query_cache: dict[str, list[float]] = {}


async def _embed(
    texts: list[str], *, task: str, settings: Settings
) -> list[list[float]] | None:
    if not settings.jina_api_key or not texts:
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                JINA_URL,
                headers={"Authorization": f"Bearer {settings.jina_api_key}"},
                json={
                    "model": MODEL,
                    "task": task,
                    "dimensions": DIMENSIONS,
                    "input": [t[:_MAX_CHARS] for t in texts],
                },
            )
        if resp.status_code >= 400:
            log.warning(
                "embeddings.jina_error", status=resp.status_code, body=resp.text[:200]
            )
            return None
        data = resp.json().get("data") or []
        if len(data) != len(texts):
            log.warning("embeddings.jina_shape", sent=len(texts), got=len(data))
            return None
        # Jina may return items out of order; `index` is authoritative.
        ordered: list[list[float]] = [[] for _ in texts]
        for item in data:
            ordered[int(item["index"])] = item["embedding"]
        return ordered
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        log.warning("embeddings.jina_failed", error=f"{type(exc).__name__}: {exc}")
        return None


async def embed_passage(text: str, *, settings: Settings | None = None) -> list[float] | None:
    """One document's vector, or None when embeddings are unavailable."""
    if not text.strip():
        return None
    result = await _embed(
        [text], task="retrieval.passage", settings=settings or get_settings()
    )
    return result[0] if result else None


async def embed_query(text: str, *, settings: Settings | None = None) -> list[float] | None:
    """A search query's vector, cached — the hot path of every search."""
    key = text.strip().lower()
    if not key:
        return None
    hit = _query_cache.get(key)
    if hit is not None:
        return hit
    result = await _embed(
        [text], task="retrieval.query", settings=settings or get_settings()
    )
    if not result:
        return None
    if len(_query_cache) >= _QUERY_CACHE_MAX:
        _query_cache.pop(next(iter(_query_cache)))
    _query_cache[key] = result[0]
    return result[0]


def vector_literal(embedding: list[float]) -> str:
    """A pgvector text literal.

    Vectors go into SQL as `CAST(:v AS vector)` with this string rather than
    as bound arrays: asyncpg has no codec for the vector OID, and registering
    one would touch every pooled connection for the sake of two queries.
    """
    return "[" + ",".join(f"{v:.7g}" for v in embedding) + "]"
