"""Specialized flavors of the generate node.

A preset is not a model role: any capable image model can draw a character
sheet, so the specialization lives on the *node* and shapes how it compiles —
the prompt it actually runs with, and the params it is allowed to vary.
Shared between the compiler (literal prompts) and the runner (prompts an
upstream LLM writes, which do not exist until run time).
"""

from __future__ import annotations

from app.catalog.models import ModelDescriptor

CHARACTER_SHEET = "character_sheet"

#: The one shape a character sheet comes in. Wide, because the sheet is a
#: side-by-side collage — three panels do not fit a square or a portrait.
CHARACTER_SHEET_RATIO = "16:9"

_CHARACTER_SHEET_TEMPLATE = (
    "Character reference sheet on a single 16:9 canvas, arranged as three "
    "clearly separated panels: a close-up portrait of the character's face, "
    "a full-body front view, and a full-body back view. One and the same "
    "character in every panel — identical face, hair, proportions, and "
    "outfit throughout. Plain neutral studio background, even lighting, "
    "no text or labels. If a reference image is provided, match its "
    "character's identity and outfit exactly."
)


def character_sheet_prompt(description: str | None) -> str:
    """The prompt a character-sheet node actually runs with.

    The template alone is a complete instruction — a node driven purely by a
    reference image has nothing to type — so an empty description is legal
    rather than an error.
    """
    text = (description or "").strip()
    return f"{_CHARACTER_SHEET_TEMPLATE} The character: {text}" if text else _CHARACTER_SHEET_TEMPLATE


def _ratio_value(value: str) -> float | None:
    parts = value.split(":")
    if len(parts) != 2:
        return None
    try:
        w, h = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    return w / h if w > 0 and h > 0 else None


def aspect_option_for(model: ModelDescriptor, ratio: str) -> str | None:
    """The `aspect_ratio` value that makes this model emit the given shape.

    Compared numerically rather than by spelling, because providers disagree
    on it: Runway's enum says "1920:1080" where everyone else says "16:9".
    A model without the param has a fixed output shape, which either is the
    wanted ratio or the model simply cannot produce it — returns None.
    """
    target = _ratio_value(ratio)
    if target is None:
        return None

    spec = next((p for p in model.params if p.name == "aspect_ratio"), None)
    if spec is not None:
        values = [o.value for o in spec.options]
        if ratio in values:
            return ratio
        for value in values:
            own = _ratio_value(value)
            if own is not None and abs(own - target) < 0.01:
                return value
        return None

    declared = model.output_aspect_ratio
    if declared is not None:
        own = _ratio_value(declared)
        if own is not None and abs(own - target) < 0.01:
            return declared
    return None
