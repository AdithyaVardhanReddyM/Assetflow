"""Enrichment — the parts that need neither a database nor an API key.

The vision and Jina calls are covered by their defensive shells (they return
None on any failure); what matters here is everything decided *around* them:
how model replies are read, how the search document is assembled, which audio
gets which treatment, and the vector literal the raw-SQL cast depends on.
"""

from __future__ import annotations

from app.services.embeddings import DIMENSIONS, vector_literal
from app.services.enrich import (
    _clean_described,
    _is_musiclike,
    _parse_json_reply,
    assemble_doc,
)


# --- reading model replies ---------------------------------------------------


def test_parse_tolerates_the_fences_it_forbade():
    body = '{"caption": "a red fox", "tags": ["fox"]}'
    assert _parse_json_reply(body) == {"caption": "a red fox", "tags": ["fox"]}
    assert _parse_json_reply(f"```json\n{body}\n```") == _parse_json_reply(body)
    assert _parse_json_reply(f"```\n{body}\n```") == _parse_json_reply(body)


def test_parse_rejects_non_objects():
    assert _parse_json_reply("not json at all") is None
    assert _parse_json_reply('["a", "list"]') is None
    assert _parse_json_reply("") is None


def test_clean_bounds_and_normalizes():
    cleaned = _clean_described(
        {
            "caption": "  A poster.  " + "x" * 600,
            "tags": ["  Logo ", "BLUE", 42, "", None, *[f"t{i}" for i in range(20)]],
            "ocr_text": "  SALE 50% OFF  ",
            "palette": ["#FF0000", "not-a-color", "#00ff00", None],
        }
    )
    assert len(cleaned["caption"]) == 500
    assert cleaned["tags"][:3] == ["logo", "blue", "42"]
    assert len(cleaned["tags"]) == 12
    assert cleaned["ocr_text"] == "SALE 50% OFF"
    assert cleaned["palette"] == ["#ff0000", "#00ff00"]


def test_clean_empty_reply_is_all_nulls():
    cleaned = _clean_described({})
    assert cleaned == {"caption": None, "tags": [], "ocr_text": None, "palette": []}


# --- the document ------------------------------------------------------------


def test_doc_joins_only_what_exists():
    doc = assemble_doc(
        caption="a lighthouse at dusk",
        tags=["lighthouse", "dusk"],
        ocr_text=None,
        prompt="paint a lighthouse",
        filename="lighthouse.png",
    )
    assert doc.splitlines() == [
        "a lighthouse at dusk",
        "lighthouse dusk",
        "paint a lighthouse",
        "lighthouse.png",
    ]


def test_doc_truncates_but_keeps_the_caption():
    doc = assemble_doc(
        caption="the caption",
        tags=[],
        ocr_text=None,
        prompt="p" * 20_000,
        filename=None,
    )
    assert doc.startswith("the caption")
    assert len(doc) == 8000


def test_doc_of_nothing_is_empty():
    assert assemble_doc(caption=None, tags=[], ocr_text=None, prompt=None, filename=None) == ""


# --- audio routing -----------------------------------------------------------


def test_music_and_sfx_models_are_musiclike():
    assert _is_musiclike("music_v2")
    assert _is_musiclike("eleven_text_to_sound_v2")
    assert _is_musiclike("mock-sfx-v1")
    assert _is_musiclike("mock-audio-v1")


def test_tts_models_are_not():
    assert not _is_musiclike("eleven_v3")
    assert not _is_musiclike("eleven_flash_v2_5")
    assert not _is_musiclike("mock-speech-v1")
    assert not _is_musiclike(None)


# --- the vector literal ------------------------------------------------------


def test_vector_literal_round_trips_through_pgvector_syntax():
    lit = vector_literal([0.5, -1.0, 0.0000001])
    assert lit == "[0.5,-1,1e-07]"
    # The cast target is vector(1024); the literal must carry every dimension.
    full = vector_literal([0.1] * DIMENSIONS)
    assert full.count(",") == DIMENSIONS - 1
    assert full.startswith("[") and full.endswith("]")
