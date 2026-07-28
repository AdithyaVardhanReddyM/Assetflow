"use client";

/**
 * Canvas-wide services the node components need.
 *
 * Node components are rendered by React Flow, not by us, so they cannot be
 * handed props directly — everything they need beyond their own `data` arrives
 * through here.
 */

import * as React from "react";

import type { TakeEditSpec } from "@/lib/studio/camera-edit";
import type {
  CaptionCue,
  CaptionPlacement,
  Transcript,
} from "@/lib/studio/captions";
import type { Catalog } from "@/lib/studio/catalog";
import type { AssetPreview, NodeGeneration } from "@/lib/studio/graph";
import type { LayerizeResult } from "@/lib/studio/magic-text";

export type RunScope = "node" | "chain";

export type StudioContextValue = {
  catalog: Catalog;
  /** Upload previews, keyed by asset id and hydrated from the assets table. */
  assets: Record<string, AssetPreview>;
  /** Shallow-merge a patch into a node's wire data. */
  updateNode: (id: string, patch: Record<string, unknown>) => void;
  /**
   * Drop whatever is wired into one input handle.
   *
   * Needed by nodes whose handles come and go: deleting a composition lane has
   * to take its edge with it, or the graph keeps an edge pointing at a handle
   * that no longer exists and the compiler rejects the whole workflow.
   */
  disconnectPort: (id: string, handle: string) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  /** Attach (or replace) the file behind an upload node. */
  pickFileFor: (id: string) => void;
  /** "Run" vs "Run from here" — the latter walks the connected chain downstream. */
  runFrom: (id: string, scope: RunScope) => void;
  /**
   * Re-generate a node's displayed take through a hidden edit model — the
   * expand modal's Camera and Light tabs. Runs `spec` on `assetId` under the
   * node's own id — the document is untouched, and the result arrives as a
   * normal generation in this node's carousel. The spec is already in the
   * model's vocabulary (`poseParams` / `lightDirective`).
   */
  editTake: (id: string, assetId: string, spec: TakeEditSpec) => void;
  /**
   * Magic Text (the expand modal's Text tab). `layerizeAsset` decomposes a
   * take into editable text blocks (bills per call — the panel caches per
   * asset); `fetchAssetBlob` proxies bytes through the API so a canvas can
   * draw them untainted (B2 sends no CORS headers); `registerTextEdit`
   * indexes the composited edit as a generation of the node — it lands in
   * the carousel immediately and re-hydrates from `/results` on reload.
   */
  layerizeAsset: (
    assetId: string,
  ) => Promise<{ ok: true; result: LayerizeResult } | { ok: false; error: string }>;
  fetchAssetBlob: (assetId: string) => Promise<Blob | null>;
  registerTextEdit: (
    nodeId: string,
    image: Blob,
    baseAssetId: string,
  ) => Promise<boolean>;
  /**
   * Captions (the expand modal's caption tool, video takes only).
   * `transcribeTake` runs ElevenLabs Scribe over one stored take and returns
   * word-level timings (bills per call — the panel caches per asset);
   * `burnTakeCaptions` renders approved cues into the file server-side and
   * indexes the result as a generation of the node, landing in the carousel
   * like a text edit does. `assetId` null means "this node's latest result" —
   * the composition node's client state carries no asset id.
   */
  transcribeTake: (
    nodeId: string,
    assetId: string | null,
  ) => Promise<{ ok: true; transcript: Transcript } | { ok: false; error: string }>;
  burnTakeCaptions: (
    nodeId: string,
    assetId: string | null,
    spec: { style: string; placement: CaptionPlacement; cues: CaptionCue[] },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Strip a caption burn: deletes the burned generation and rolls the node
   * back to the take beneath it. Only ever called on a `captioned` take.
   */
  removeCaptions: (nodeId: string, assetId: string) => Promise<boolean>;
  /**
   * Save a node's generated result to disk. Without `generation` this is the
   * node's latest result; with one (a carousel pick) it saves that take.
   */
  downloadNode: (id: string, generation?: NodeGeneration) => void;
  /**
   * Re-sign one asset's preview URL and swap it in wherever the canvas holds
   * it. Called by a well whose media failed to load — B2 links are presigned
   * for an hour, so a canvas left open outlives its own previews. Resolves
   * false when no *different* URL came back, which is the well's signal that
   * the asset is genuinely unreachable rather than merely expired.
   */
  refreshMedia: (nodeId: string, assetId: string) => Promise<boolean>;
};

const StudioContext = React.createContext<StudioContextValue | null>(null);

export function StudioProvider({
  value,
  children,
}: {
  value: StudioContextValue;
  children: React.ReactNode;
}) {
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioContextValue {
  const ctx = React.useContext(StudioContext);
  if (!ctx) throw new Error("useStudio must be used inside a StudioProvider");
  return ctx;
}
