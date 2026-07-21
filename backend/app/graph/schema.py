"""Canvas graph wire format.

This module is pure data — no GenBlaze, no database, no I/O — so the compiler
that consumes it can be exercised by a fast unit suite with no credentials.

Node `data` is validated per-kind rather than through a Pydantic discriminated
union: a union reports failures against every branch, which produces unusable
error messages on a canvas. Parsing per-kind lets us say exactly what is wrong
with the one node the user is editing.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

MAX_NODES = 40
MAX_EDGES = 80

NodeId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")]


class NodeKind(StrEnum):
    TEXT = "input.text"
    UPLOAD = "input.upload"
    GENERATE = "generate"
    COMPOSITE = "transform.composite"
    OUTPUT = "output"


#: Kinds that carry values but produce no GenBlaze step.
VIRTUAL_KINDS = {NodeKind.TEXT, NodeKind.OUTPUT}
#: Kinds that become a `.step()` call.
STEP_KINDS = {NodeKind.GENERATE, NodeKind.COMPOSITE}


class Position(BaseModel):
    x: float = 0.0
    y: float = 0.0


class Edge(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    source: NodeId
    target: NodeId
    source_handle: str = "out"
    target_handle: str


class TextNodeData(BaseModel):
    text: str = Field(default="", max_length=4000)


class UploadNodeData(BaseModel):
    asset_id: str | None = None


class GenerateNodeData(BaseModel):
    provider: str = "mock"
    model: str = "mock-video-v1"
    modality: Literal["video", "image", "audio", "text"] = "video"
    prompt: str | None = Field(default=None, max_length=4000)
    params: dict[str, Any] = Field(default_factory=dict)
    fallback_models: list[str] = Field(default_factory=list, max_length=3)
    expected_duration_sec: float | None = None


class CompositeNodeData(BaseModel):
    op: Literal["mux"] = "mux"


class OutputNodeData(BaseModel):
    label: str | None = Field(default=None, max_length=120)


_DATA_MODELS: dict[NodeKind, type[BaseModel]] = {
    NodeKind.TEXT: TextNodeData,
    NodeKind.UPLOAD: UploadNodeData,
    NodeKind.GENERATE: GenerateNodeData,
    NodeKind.COMPOSITE: CompositeNodeData,
    NodeKind.OUTPUT: OutputNodeData,
}


class Node(BaseModel):
    id: NodeId
    kind: NodeKind
    position: Position = Field(default_factory=Position)
    data: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_data_for_kind(self) -> Node:
        model = _DATA_MODELS[self.kind]
        # Round-tripping through the typed model applies defaults and coercion
        # while keeping `data` a plain dict for storage and diffing.
        self.data = model.model_validate(self.data).model_dump()
        return self

    def typed_data(self) -> Any:
        return _DATA_MODELS[self.kind].model_validate(self.data)

    @property
    def is_step(self) -> bool:
        return self.kind in STEP_KINDS

    @property
    def is_virtual(self) -> bool:
        return self.kind in VIRTUAL_KINDS

    def sort_key(self) -> tuple[float, float, str]:
        """Deterministic tie-break for topological ordering.

        Visual reading order (top-to-bottom, then left-to-right) makes step
        indices match what the user sees, and keeps ordering stable across
        re-saves so the manifest hash — and therefore the step cache — is stable.
        """
        return (self.position.y, self.position.x, self.id)


class Graph(BaseModel):
    version: Literal[1] = 1
    nodes: list[Node] = Field(default_factory=list, max_length=MAX_NODES)
    edges: list[Edge] = Field(default_factory=list, max_length=MAX_EDGES)

    def node(self, node_id: str) -> Node | None:
        return next((n for n in self.nodes if n.id == node_id), None)


class AssetRef(BaseModel):
    """A previously ingested upload, resolved from the assets table."""

    asset_id: str
    url: str
    media_type: str
    modality: str
    sha256: str | None = None
    size_bytes: int | None = None


class PlanLimits(BaseModel):
    max_steps: int = 12
    max_duration_sec: float = 1800.0
    max_cost_usd: float | None = None
    max_concurrency: int = 3
