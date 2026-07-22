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
import {
  type CompositeNodeData,
  type GenerateNodeData,
  type Modality as WireModality,
  type NodeKind,
  DEFAULT_TIMELINE_SEC,
  VIDEO_TRACK_ID,
  newTrack,
} from "./graph";

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
  lipsync: {
    kind: "generate",
    modality: "video",
    prefer: ["mock-lipsync-v1"],
    label: "Lip sync",
  },
  music: { kind: "generate", modality: "audio", label: "Music" },
  speech: {
    kind: "generate",
    modality: "audio",
    // The mock is named second so a keyless canvas still places a *speech*
    // node: falling through to "any audio model" would hand back Mock Audio,
    // which is music, and music is not something a lipsync node will take.
    prefer: ["eleven_multilingual_v2", "mock-speech-v1"],
    label: "Speech",
  },
  sfx: {
    kind: "generate",
    modality: "audio",
    prefer: ["eleven_text_to_sound_v2"],
    label: "Sound effects",
  },
  character: { kind: "generate", modality: "image", label: "Character sheet" },
  llm: {
    kind: "generate",
    modality: "text",
    prefer: ["mock-llm-v1"],
    label: "LLM",
  },
  text: { kind: "input.text", label: "Text" },
  composition: { kind: "transform.composite", label: "Composition" },
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
      // One audio lane to start. Its id is generated rather than fixed so two
      // composition nodes never share lane ids — which matters the moment one
      // is duplicated, since the copy carries its own edges.
      return {
        op: "mux",
        timeline_sec: DEFAULT_TIMELINE_SEC,
        video: newTrack(VIDEO_TRACK_ID),
        tracks: [newTrack()],
      } satisfies CompositeNodeData as unknown as Record<string, unknown>;

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

/**
 * What a node's output is *for*, past its modality. Only a generate node has
 * one, and it comes from the model rather than the node — same rule as
 * `out_role` in compile.py. An upload has none: a file makes no claim about
 * what is inside it, which is why an uploaded voice track may feed a port that
 * a music node may not.
 */
export function outputRole(
  kind: NodeKind,
  wire: Record<string, unknown>,
  catalog: Catalog,
): string | null {
  if (kind !== "generate") return null;
  const data = wire as unknown as GenerateNodeData;
  const model = catalog.models.find(
    (m) => m.provider === data.provider && m.id === data.model,
  );
  return model?.role ?? null;
}

/** Mirrors the `port.roles` gate in compile.py. */
export function rolesCompatible(
  sourceRole: string | null,
  portRoles: string[] | undefined,
): boolean {
  if (!portRoles?.length || sourceRole === null) return true;
  return portRoles.includes(sourceRole);
}

// --- accents --------------------------------------------------------------

/**
 * Muted duos that sit on the cream canvas without competing with the amber
 * `--primary`, which is reserved for the active tool and Generate. Kept warm
 * throughout — a cool blue read as foreign against the paper background.
 */
export type Accent = { soft: string; ink: string };

export const MODALITY_ACCENT: Record<string, Accent> = {
  image: { soft: "#f4e3d5", ink: "#a86a45" },
  video: { soft: "#ece1ee", ink: "#7b5f86" },
  audio: { soft: "#dfe9dd", ink: "#527d5a" },
  text: { soft: "#e8e4da", ink: "#6b6558" },
  any: { soft: "#e8e4da", ink: "#6b6558" },
};

/**
 * Accents keyed by a model's `role`, for nodes whose modality is too coarse to
 * tell them apart — the three audio tools otherwise share one green.
 *
 * These colour a node's own icon and the connector it emits from — and the few
 * *input* ports that constrain their sources by role (lipsync's `speech`), so
 * the two ends of a legal wire carry the same colour. Every other input port
 * stays on `MODALITY_ACCENT`: its colour is what tells you what may connect,
 * and where there is no role gate that is purely a question of modality.
 */
export const ROLE_ACCENT: Record<string, Accent> = {
  music: { soft: "#dfe9dd", ink: "#527d5a" },
  speech: { soft: "#f2e6c8", ink: "#8d6f24" },
  sfx: { soft: "#f2dcdf", ink: "#9d5763" },
  lipsync: { soft: "#e3e7d2", ink: "#6c7a42" },
  // The writing node deliberately keeps the neutral of the text it deals in,
  // one shade darker so its glyph still reads on the tile.
  llm: { soft: "#e8e4da", ink: "#5a5347" },
};

/** Looks up a role first, then a modality. Either may be passed. */
export function accentFor(key: string | undefined): Accent {
  if (!key) return MODALITY_ACCENT.any;
  return ROLE_ACCENT[key] ?? MODALITY_ACCENT[key] ?? MODALITY_ACCENT.any;
}

// --- placement ------------------------------------------------------------

/** Default footprint per kind, used to centre a node on the drop point. */
export const NODE_SIZE: Record<NodeKind, { width: number; height: number }> = {
  "input.text": { width: 300, height: 210 },
  "input.upload": { width: 260, height: 300 },
  generate: { width: 572, height: 480 },
  "transform.composite": { width: 572, height: 560 },
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
