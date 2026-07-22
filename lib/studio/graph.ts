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

export type CompositeNodeData = { op: "mux" };

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
