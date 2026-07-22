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
#: Audio lanes one composite node may carry. Six is well past what the ffmpeg
#: `amix` filter starts sounding muddy at, and keeps the node a readable height.
MAX_AUDIO_TRACKS = 6
#: Clips one track may hold. A canvas node is not an edit suite; past this the
#: timeline is unreadable at node scale and the work belongs in a real NLE.
MAX_CLIPS_PER_TRACK = 12
#: The timeline the node opens on, and the ceiling it can be grown to.
DEFAULT_TIMELINE_SEC = 30.0
MAX_TIMELINE_SEC = 600.0

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
    #: Canvas-only caption. Node data is round-tripped through these models and
    #: re-dumped, so anything the editor wants to persist has to be declared —
    #: undeclared keys are silently dropped.
    title: str | None = Field(default=None, max_length=120)


class GenerateNodeData(BaseModel):
    provider: str = "mock"
    model: str = "mock-video-v1"
    modality: Literal["video", "image", "audio", "text"] = "video"
    prompt: str | None = Field(default=None, max_length=4000)
    params: dict[str, Any] = Field(default_factory=dict)
    fallback_models: list[str] = Field(default_factory=list, max_length=3)
    expected_duration_sec: float | None = None
    #: Canvas-only caption; never sent to a provider.
    title: str | None = Field(default=None, max_length=120)


#: The video track's handle. Fixed, because a composition has exactly one
#: picture track — extra footage becomes another clip on it, not another track.
VIDEO_TRACK_ID = "video"


def audio_port_id(track_id: str) -> str:
    """The input handle a composite node exposes for one of its audio lanes.

    Lanes get a handle each rather than sharing one, because every lane carries
    its own fader: the mix has to know which asset a gain belongs to, and a
    shared handle would only say how many arrived. The handle is `multi` —
    within a lane, each connected source becomes a clip on the timeline.
    """
    return f"audio_{track_id}"


class Clip(BaseModel):
    """One source placed on a track at a point in time.

    A clip is *derived* from an edge — connecting a node to a track creates
    one — but its position is the user's, so it has to be stored. `source` is
    the key rather than an index because clips are reordered by dragging, and
    an index would hand a moved clip someone else's start time.
    """

    source: NodeId
    #: Seconds from the start of the composition.
    start_sec: float = Field(default=0.0, ge=0.0, le=MAX_TIMELINE_SEC)
    #: What the canvas believes the source lasts, so a clip has a width before
    #: anything has been generated. Advisory only: the compositor measures the
    #: real asset, which is the only length that can be true at render time.
    duration_sec: float | None = Field(default=None, ge=0.0, le=MAX_TIMELINE_SEC)

    @property
    def end_sec(self) -> float:
        return self.start_sec + (self.duration_sec or 0.0)


class CompositeTrack(BaseModel):
    """One lane: a fader, a mute, and the clips laid along it."""

    #: Stable within its node, and the only thing tying a lane to its handle —
    #: so it must survive reordering, which a positional index would not.
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,16}$")
    #: Canvas-only lane name. Empty means "call it whatever is connected".
    label: str | None = Field(default=None, max_length=60)
    #: Linear gain, not decibels — it goes straight into ffmpeg's `volume`
    #: filter. 1.0 is unity and 2.0 is +6dB.
    gain: float = Field(default=1.0, ge=0.0, le=2.0)
    muted: bool = False
    clips: list[Clip] = Field(default_factory=list, max_length=MAX_CLIPS_PER_TRACK)

    @property
    def port_id(self) -> str:
        """The handle this lane's clips arrive on. The picture track keeps the
        bare `video` name; audio lanes are named per track."""
        return VIDEO_TRACK_ID if self.id == VIDEO_TRACK_ID else audio_port_id(self.id)

    @property
    def effective_gain(self) -> float:
        """What the mix actually applies. Mute is non-destructive: the fader
        keeps its position so unmuting restores the level the user set."""
        return 0.0 if self.muted else self.gain

    def clip_for(self, source: str) -> Clip | None:
        return next((c for c in self.clips if c.source == source), None)

    def ordered_clips(self) -> list[Clip]:
        """Left to right, which is both reading order and playback order."""
        return sorted(self.clips, key=lambda c: (c.start_sec, c.source))

    @model_validator(mode="after")
    def _dedupe_clips(self) -> CompositeTrack:
        # One clip per source per track: two would both be fed by the same
        # edge, and nothing would say which of them it meant.
        seen: set[str] = set()
        kept: list[Clip] = []
        for clip in self.clips:
            if clip.source in seen:
                continue
            seen.add(clip.source)
            kept.append(clip)
        self.clips = kept
        return self


def _default_audio_tracks() -> list[CompositeTrack]:
    return [CompositeTrack(id="a1")]


def _default_video_track() -> CompositeTrack:
    return CompositeTrack(id=VIDEO_TRACK_ID)


class CompositeNodeData(BaseModel):
    op: Literal["mux"] = "mux"
    #: How long the composition runs. The canvas grows this to fit the clips on
    #: it, so it is a result of the edit rather than a setting — but it is
    #: stored, because it is also the length of the black the picture falls back
    #: to where no clip covers the timeline.
    timeline_sec: float = Field(
        default=DEFAULT_TIMELINE_SEC, gt=0.0, le=MAX_TIMELINE_SEC
    )
    #: The picture, and whatever audio it carries of its own.
    video: CompositeTrack = Field(default_factory=_default_video_track)
    tracks: list[CompositeTrack] = Field(
        default_factory=_default_audio_tracks, max_length=MAX_AUDIO_TRACKS
    )

    @model_validator(mode="after")
    def _normalize(self) -> CompositeNodeData:
        # Two lanes sharing an id would resolve to one handle, so the second
        # one's edge would land on the first one's fader. Dropped rather than
        # rejected: a malformed document should still open on the canvas.
        seen: set[str] = set()
        kept: list[CompositeTrack] = []
        for track in self.tracks:
            if track.id in seen or track.id == VIDEO_TRACK_ID:
                continue
            seen.add(track.id)
            kept.append(track)
        self.tracks = kept or _default_audio_tracks()
        self.video.id = VIDEO_TRACK_ID
        return self

    def all_tracks(self) -> list[CompositeTrack]:
        """Mix order: the picture first, then the audio lanes top to bottom."""
        return [self.video, *self.tracks]


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
