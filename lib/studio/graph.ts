/**
 * Canvas graph wire format — the TypeScript mirror of
 * `backend/app/graph/schema.py`.
 *
 * The Python compiler parses exactly this shape, so anything the canvas
 * persists has to match it field for field, `snake_case` handle names included.
 * React Flow spells the same concepts `sourceHandle`/`targetHandle` and keeps
 * node payloads under `data`, so `toFlow`/`fromFlow` below are the only places
 * the two vocabularies meet — nothing else should touch the raw wire shape.
 *
 * Node `data` is dropped through a typed Pydantic model on the backend and
 * re-dumped, which means **undeclared keys do not survive a round trip**. Any
 * editor state worth keeping has to exist in `schema.py` first; anything
 * genuinely ephemeral (preview URLs, in-flight status) belongs in
 * `FlowNodeData` below, which never leaves the browser.
 */

import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";

export const GRAPH_VERSION = 1 as const;

/** Mirrors MAX_NODES / MAX_EDGES in schema.py. */
export const MAX_NODES = 40;
export const MAX_EDGES = 80;

export const NODE_KINDS = [
  "input.text",
  "input.upload",
  "generate",
  "transform.composite",
  "output",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type Modality = "image" | "video" | "audio" | "text";

export type Position = { x: number; y: number };

export type GraphNode = {
  id: string;
  kind: NodeKind;
  position: Position;
  data: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  source_handle: string;
  target_handle: string;
};

export type Graph = {
  version: typeof GRAPH_VERSION;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export const EMPTY_GRAPH: Graph = { version: GRAPH_VERSION, nodes: [], edges: [] };

// --- per-kind node data ---------------------------------------------------

export type TextNodeData = { text: string };

export type UploadNodeData = {
  asset_id: string | null;
  title: string | null;
};

export type GenerateNodeData = {
  provider: string;
  model: string;
  modality: Modality;
  prompt: string | null;
  params: Record<string, unknown>;
  fallback_models: string[];
  expected_duration_sec?: number | null;
  title: string | null;
};

/** Mirrors the limits in schema.py. */
export const MAX_AUDIO_TRACKS = 6;
export const MAX_CLIPS_PER_TRACK = 12;
export const DEFAULT_TIMELINE_SEC = 30;
export const MAX_TIMELINE_SEC = 600;

/** The picture track's id and handle. A composition has exactly one. */
export const VIDEO_TRACK_ID = "video";

/**
 * One source placed on a track at a point in time.
 *
 * A clip is derived from an edge — connecting a node to a track creates one —
 * but its position is the user's, so it is stored. `source` is the key rather
 * than an index because clips are moved by dragging, and an index would hand a
 * moved clip someone else's start time.
 */
export type Clip = {
  source: string;
  start_sec: number;
  /** The canvas's best estimate of the source's length; advisory. */
  duration_sec: number | null;
};

export type CompositeTrack = {
  id: string;
  label: string | null;
  /** Linear gain, straight into ffmpeg's `volume` filter. 1 is unity, 2 is +6dB. */
  gain: number;
  muted: boolean;
  clips: Clip[];
};

export type CompositeNodeData = {
  op: "mux";
  timeline_sec: number;
  video: CompositeTrack;
  tracks: CompositeTrack[];
};

/**
 * The handle a composite node exposes for one audio lane. Mirrors
 * `audio_port_id` in `graph/schema.py` — the compiler resolves handles by this
 * exact name, so the two spellings must never drift.
 */
export function audioPortId(trackId: string): string {
  return `audio_${trackId}`;
}

/** The handle a track's clips arrive on, picture track included. */
export function trackPortId(trackId: string): string {
  return trackId === VIDEO_TRACK_ID ? VIDEO_TRACK_ID : audioPortId(trackId);
}

/**
 * A fresh lane id. Short because `CompositeTrack.id` is bounded at 16
 * characters on the backend, and random rather than positional because lanes
 * get deleted: an index would hand a new lane the port — and so the edges — of
 * a dead one.
 */
export function newTrackId(): string {
  return `t${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function newTrack(id = newTrackId()): CompositeTrack {
  return { id, label: null, gain: 1, muted: false, clips: [] };
}

function readTrack(raw: unknown, fallbackId: string): CompositeTrack {
  const t = (raw ?? {}) as Partial<CompositeTrack>;
  return {
    id: typeof t.id === "string" && t.id ? t.id : fallbackId,
    label: typeof t.label === "string" ? t.label : null,
    gain: typeof t.gain === "number" && Number.isFinite(t.gain) ? t.gain : 1,
    muted: Boolean(t.muted),
    clips: Array.isArray(t.clips)
      ? t.clips
          .filter((c): c is Clip => Boolean(c) && typeof c.source === "string")
          .slice(0, MAX_CLIPS_PER_TRACK)
          .map((c) => ({
            source: c.source,
            start_sec: Number.isFinite(c.start_sec) ? Math.max(0, c.start_sec) : 0,
            duration_sec:
              typeof c.duration_sec === "number" && Number.isFinite(c.duration_sec)
                ? c.duration_sec
                : null,
          }))
      : [],
  };
}

/**
 * The audio lanes on a composite node, read defensively: this drives which
 * handles render, so a document that predates tracks — or arrives malformed —
 * has to still open with one lane rather than a node with no audio inputs.
 */
export function compositeTracks(wire: Record<string, unknown> | undefined): CompositeTrack[] {
  const raw = wire?.tracks;
  if (!Array.isArray(raw) || !raw.length) return [newTrack("a1")];
  return raw
    .slice(0, MAX_AUDIO_TRACKS)
    .map((t, i) => readTrack(t, `a${i + 1}`))
    .filter((t) => t.id !== VIDEO_TRACK_ID);
}

/** The picture track, defaulted the same way. */
export function compositeVideoTrack(
  wire: Record<string, unknown> | undefined,
): CompositeTrack {
  return readTrack(wire?.video, VIDEO_TRACK_ID);
}

export function compositeTimeline(wire: Record<string, unknown> | undefined): number {
  const raw = wire?.timeline_sec;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.min(raw, MAX_TIMELINE_SEC)
    : DEFAULT_TIMELINE_SEC;
}

export type OutputNodeData = { label: string | null };

// --- React Flow side ------------------------------------------------------

/**
 * What a custom node component receives. `wire` is the part that persists;
 * everything beside it is view state rebuilt on load and never saved.
 */
export type FlowNodeData = {
  kind: NodeKind;
  wire: Record<string, unknown>;
  /** Resolved preview for upload nodes, hydrated from the assets table. */
  asset?: AssetPreview;
  /** True while an upload node's file is still in flight to B2. */
  uploading?: boolean;
  /** Live state from the run in flight (or the one just finished). */
  run?: NodeRunState;
  /**
   * This node's recent generations, newest first — what the carousel under a
   * generate node pages through. View state like `run`: hydrated from the
   * workflow's run history and advanced by run events, never saved in `wire`.
   */
  history?: NodeGeneration[];
};

/** One generated result of a node — a carousel entry. */
export type NodeGeneration = {
  assetId: string | null;
  /** A URL the browser can fetch — presigned B2 or local media. */
  url: string | null;
  mediaType: string | null;
  text?: string | null;
  /** Real pixel dimensions of the output, when known — drives the card shape. */
  width?: number | null;
  height?: number | null;
  createdAt?: string | null;
};

/** Mirrors the step statuses the run events carry. */
export type NodeRunStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type NodeRunOutput = {
  /** A URL the browser can actually fetch — presigned B2 or local media. */
  url: string | null;
  mediaType: string | null;
  /** An LLM step's words, shown directly rather than fetched from the file. */
  text?: string | null;
};

export type NodeRunState = {
  status: NodeRunStatus;
  /** 0..1 while running. */
  progress?: number | null;
  error?: string | null;
  output?: NodeRunOutput | null;
};

export type AssetPreview = {
  id: string;
  url: string;
  mediaType: string;
  modality: Modality;
  filename: string | null;
  width: number | null;
  height: number | null;
};

export type StudioNode = FlowNode<FlowNodeData>;
export type StudioEdge = FlowEdge;

// --- ids ------------------------------------------------------------------

/**
 * NodeId on the backend is `^[A-Za-z0-9_-]{1,64}$`, which a UUID satisfies
 * (hex plus hyphens). Edge ids are only length-bounded but use the same form.
 */
export function newId(): string {
  return crypto.randomUUID();
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// --- conversion -----------------------------------------------------------

export function toFlow(graph: Graph): { nodes: StudioNode[]; edges: StudioEdge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: n.position,
      data: { kind: n.kind, wire: n.data },
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.source_handle,
      targetHandle: e.target_handle,
    })),
  };
}

export function fromFlow(nodes: StudioNode[], edges: StudioEdge[]): Graph {
  return {
    version: GRAPH_VERSION,
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      // Round to whole pixels: the compiler's topological tie-break sorts on
      // position, so sub-pixel drift from a drag would reshuffle step order —
      // and with it the manifest hash — for a move the user cannot even see.
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: n.data.wire,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      source_handle: e.sourceHandle || "out",
      target_handle: e.targetHandle || "",
    })),
  };
}

// --- validation -----------------------------------------------------------

/**
 * Structural guard for the persistence boundary. This is deliberately *not* a
 * re-implementation of the compiler: it checks only what has to hold for the
 * document to be storable and re-openable. Semantic validation (ports,
 * modalities, arity, params) is the backend's `POST /v1/workflows/validate`,
 * which owns the catalog and must not be forked here.
 */
export function parseGraph(value: unknown): Graph | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== GRAPH_VERSION) return null;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  if (raw.nodes.length > MAX_NODES || raw.edges.length > MAX_EDGES) return null;

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const item of raw.nodes) {
    if (typeof item !== "object" || item === null) return null;
    const n = item as Record<string, unknown>;
    const id = n.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || seen.has(id)) return null;
    seen.add(id);
    if (!NODE_KINDS.includes(n.kind as NodeKind)) return null;
    const pos = n.position as Position | undefined;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
    if (typeof n.data !== "object" || n.data === null || Array.isArray(n.data)) return null;
    nodes.push({
      id,
      kind: n.kind as NodeKind,
      position: { x: pos.x, y: pos.y },
      data: n.data as Record<string, unknown>,
    });
  }

  const edges: GraphEdge[] = [];
  for (const item of raw.edges) {
    if (typeof item !== "object" || item === null) return null;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length < 1 || e.id.length > 64) return null;
    if (typeof e.source !== "string" || typeof e.target !== "string") return null;
    // Dangling edges are a compiler error, not a storage one — but an edge
    // naming a node that is not in this document cannot be drawn at all.
    if (!seen.has(e.source) || !seen.has(e.target)) return null;
    if (typeof e.target_handle !== "string" || !e.target_handle) return null;
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      source_handle: typeof e.source_handle === "string" ? e.source_handle : "out",
      target_handle: e.target_handle,
    });
  }

  return { version: GRAPH_VERSION, nodes, edges };
}
