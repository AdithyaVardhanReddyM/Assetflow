"""Compiler diagnostics.

These are returned as data, never raised, so `POST /v1/workflows/validate` can
drive live inline errors on the canvas while the user edits. Every diagnostic
carries the node or edge it belongs to, so the UI can anchor it precisely, and a
`hint` phrased as the next action to take.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class ErrorCode(StrEnum):
    # structural
    EMPTY_GRAPH = "E_EMPTY_GRAPH"
    DUPLICATE_NODE_ID = "E_DUPLICATE_NODE_ID"
    UNKNOWN_NODE = "E_UNKNOWN_NODE"
    UNKNOWN_KIND = "E_UNKNOWN_KIND"
    UNKNOWN_HANDLE = "E_UNKNOWN_HANDLE"
    CYCLE = "E_CYCLE"
    # wiring
    MODALITY_MISMATCH = "E_MODALITY_MISMATCH"
    PORT_ARITY = "E_PORT_ARITY"
    MISSING_REQUIRED_INPUT = "E_MISSING_REQUIRED_INPUT"
    MIXED_INPUTS = "E_MIXED_INPUTS"
    FANIN_UNSUPPORTED = "E_FANIN_UNSUPPORTED"
    NO_PROMPT = "E_NO_PROMPT"
    # catalog
    UNKNOWN_PROVIDER = "E_UNKNOWN_PROVIDER"
    UNKNOWN_MODEL = "E_UNKNOWN_MODEL"
    PROVIDER_UNAVAILABLE = "E_PROVIDER_UNAVAILABLE"
    MODALITY_UNSUPPORTED = "E_MODALITY_UNSUPPORTED"
    # params
    PARAM_UNKNOWN = "E_PARAM_UNKNOWN"
    PARAM_TYPE = "E_PARAM_TYPE"
    PARAM_RANGE = "E_PARAM_RANGE"
    PARAM_ENUM = "E_PARAM_ENUM"
    PARAM_REQUIRED = "E_PARAM_REQUIRED"
    # assets
    UNKNOWN_ASSET = "E_UNKNOWN_ASSET"
    ASSET_NOT_SET = "E_ASSET_NOT_SET"
    # limits
    LIMIT_STEPS = "E_LIMIT_STEPS"
    LIMIT_DURATION = "E_LIMIT_DURATION"
    LIMIT_COST = "E_LIMIT_COST"
    NO_STEPS = "E_NO_STEPS"


class WarningCode(StrEnum):
    MOCK_SUBSTITUTED = "W_MOCK_SUBSTITUTED"
    ORPHAN_NODE = "W_ORPHAN_NODE"
    UNUSED_OUTPUT = "W_UNUSED_OUTPUT"
    NO_OUTPUT_NODE = "W_NO_OUTPUT_NODE"


class Diagnostic(BaseModel):
    code: str
    message: str
    severity: Literal["error", "warning"] = "error"
    node_id: str | None = None
    node_ids: list[str] = Field(default_factory=list)
    edge_id: str | None = None
    port: str | None = None
    param: str | None = None
    hint: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True, exclude_defaults=False)


def error(code: ErrorCode, message: str, **kw: Any) -> Diagnostic:
    return Diagnostic(code=code.value, message=message, severity="error", **kw)


def warning(code: WarningCode, message: str, **kw: Any) -> Diagnostic:
    return Diagnostic(code=code.value, message=message, severity="warning", **kw)
