/**
 * The presentation layer between the toolbar and the wire format.
 *
 * Kept free of React so it can be imported from both server and client
 * components. Anything that needs an icon component lives in
 * `components/studio/nodes/ports.tsx` instead.
 */

import {
  type Catalog,
  type CatalogModel,
  type Modality,
  defaultParams,
  modelsForModality,
} from "./catalog";
import type { GenerateNodeData, Modality as WireModality, NodeKind } from "./graph";

/** Toolbar ids that place a node. The pointer tools are handled separately. */
export type CreateToolId =
  | "image"
  | "video"
  | "lipsync"
  | "music"
  | "speech"
  | "sfx"
  | "character"
  | "llm"
  | "text"
  | "composition"
  | "upload";

export type NodeBlueprint = {
  kind: NodeKind;
  /** Only meaningful for `generate`. */
  modality?: Modality;
  /**
   * Model ids to prefer when this tool creates a node, best first. The first
   * one the catalog actually has wins; otherwise any model of the right
   * modality does. Named rather than pinned so a tool keeps working when the
   * catalog gains or loses a provider.
   */
  prefer?: string[];
  label: string;
};

export const NODE_BLUEPRINTS: Record<CreateToolId, NodeBlueprint> = {
  image: { kind: "generate", modality: "image", label: "Image" },
  video: { kind: "generate", modality: "video", label: "Video" },
  lipsync: { kind: "generate", modality: "video", label: "Lip sync" },
  music: { kind: "generate", modality: "audio", label: "Music" },
  speech: {
    kind: "generate",
    modality: "audio",
    prefer: ["eleven_multilingual_v2"],
    label: "Speech",
  },
  sfx: {
    kind: "generate",
    modality: "audio",
    prefer: ["eleven_text_to_sound_v2"],
    label: "Sound effects",
  },
  character: { kind: "generate", modality: "image", label: "Character sheet" },
  llm: { kind: "generate", modality: "text", label: "LLM" },
  text: { kind: "input.text", label: "Text" },
  composition: { kind: "transform.composite", label: "Combine A/V" },
  upload: { kind: "input.upload", label: "Upload" },
};

export function isCreateTool(id: string): id is CreateToolId {
  return id in NODE_BLUEPRINTS;
}

/** The model a freshly placed node of this kind should start on. */
export function pickModel(
  catalog: Catalog,
  blueprint: NodeBlueprint,
): CatalogModel | undefined {
  if (blueprint.kind !== "generate" || !blueprint.modality) return undefined;
  const candidates = modelsForModality(catalog, blueprint.modality);
  for (const id of blueprint.prefer ?? []) {
    const hit = candidates.find((m) => m.id === id);
    if (hit) return hit;
  }
  return candidates[0];
}

/** Wire `data` for a newly placed node, seeded from the catalog. */
export function blueprintData(
  catalog: Catalog,
  blueprint: NodeBlueprint,
  overrides: { prompt?: string; title?: string } = {},
): Record<string, unknown> {
  switch (blueprint.kind) {
    case "input.text":
      return { text: overrides.prompt ?? "" } satisfies { text: string };

    case "input.upload":
      return { asset_id: null, title: overrides.title ?? null };

    case "transform.composite":
      return { op: "mux" };

    case "output":
      return { label: overrides.title ?? null };

    case "generate": {
      const model = pickModel(catalog, blueprint);
      const data: GenerateNodeData = {
        provider: model?.provider ?? "mock",
        model: model?.id ?? "",
        // The compiler rejects a node whose modality disagrees with its
        // model's, so follow the model when there is one.
        modality: (model?.modality ?? blueprint.modality ?? "image") as WireModality,
        prompt: overrides.prompt ?? null,
        params: model ? defaultParams(model) : {},
        fallback_models: [],
        title: overrides.title ?? null,
      };
      return data as unknown as Record<string, unknown>;
    }
  }
}

// --- connection typing ----------------------------------------------------

const ANY = "any";

/**
 * What a node emits on its `out` port. Mirrors how `plan_graph` resolves
 * `out_modality`: a generate node follows its *model*, not the modality
 * recorded on the node, and an upload takes the modality of its asset.
 */
export function outputModality(
  kind: NodeKind,
  wire: Record<string, unknown>,
  catalog: Catalog,
  assetModality?: string,
): string {
  switch (kind) {
    case "input.text":
      return "text";
    case "input.upload":
      return assetModality ?? ANY;
    case "transform.composite":
      return "video";
    case "output":
      return ANY;
    case "generate": {
      const data = wire as unknown as GenerateNodeData;
      const model = catalog.models.find(
        (m) => m.provider === data.provider && m.id === data.model,
      );
      return model?.modality ?? data.modality ?? ANY;
    }
  }
}

/** Mirrors `_modalities_compatible` in compile.py. */
export function modalitiesCompatible(source: string, target: string): boolean {
  return source === ANY || source === target || target === ANY;
}

// --- accents --------------------------------------------------------------

/**
 * Muted duos that sit on the cream canvas without competing with the amber
 * `--primary`, which is reserved for the active tool and Generate.
 */
export type Accent = { soft: string; ink: string };

export const MODALITY_ACCENT: Record<string, Accent> = {
  image: { soft: "#dbe6f5", ink: "#3f6ea8" },
  video: { soft: "#e6def5", ink: "#6f57a8" },
  audio: { soft: "#dceadd", ink: "#4d8358" },
  text: { soft: "#e8e4da", ink: "#6b6558" },
  any: { soft: "#e8e4da", ink: "#6b6558" },
};

export function accentFor(modality: string | undefined): Accent {
  return MODALITY_ACCENT[modality ?? "any"] ?? MODALITY_ACCENT.any;
}

// --- placement ------------------------------------------------------------

/** Default footprint per kind, used to centre a node on the drop point. */
export const NODE_SIZE: Record<NodeKind, { width: number; height: number }> = {
  "input.text": { width: 300, height: 210 },
  "input.upload": { width: 260, height: 300 },
  generate: { width: 440, height: 430 },
  "transform.composite": { width: 300, height: 150 },
  output: { width: 260, height: 130 },
};

/**
 * Nudge a new node when it would land exactly on an existing one — placing
 * three nodes from the toolbar without this stacks them invisibly.
 */
export function avoidOverlap(
  position: { x: number; y: number },
  taken: { x: number; y: number }[],
  step = 34,
): { x: number; y: number } {
  const next = { ...position };
  let guard = 0;
  while (
    guard++ < 40 &&
    taken.some((p) => Math.abs(p.x - next.x) < 24 && Math.abs(p.y - next.y) < 24)
  ) {
    next.x += step;
    next.y += step;
  }
  return next;
}
