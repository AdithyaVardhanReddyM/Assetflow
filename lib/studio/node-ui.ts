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
   * The specialized role this tool places, where modality is too coarse — three
   * of the audio tools and two of the video ones share a modality and differ
   * only here. Absent means plain generation for the modality: a model carrying
   * *any* role is then the wrong answer, since a role exists precisely to say
   * this model is not the general case.
   */
  role?: string;
  /**
   * Model ids to prefer when this tool creates a node, best first. The first
   * one the catalog actually has wins; otherwise any model of the right
   * modality *and role* does. Named rather than pinned so a tool keeps working
   * when the catalog gains or loses a provider.
   */
  prefer?: string[];
  label: string;
};

export const NODE_BLUEPRINTS: Record<CreateToolId, NodeBlueprint> = {
  // Seedream 5.0 Lite is the house default for image work: cheapest of the
  // real image models and fast. `prefer` only wins when its key is present,
  // so a keyless canvas still falls back gracefully.
  image: {
    kind: "generate",
    modality: "image",
    prefer: ["seedream-5.0-lite"],
    label: "Image",
  },
  // Seedance 2.0 Fast is the house default for video: cheap, quick, and the
  // full port rail (frames + references). Same ready-only rule as image.
  video: {
    kind: "generate",
    modality: "video",
    prefer: ["seedance-2-0-fast-260128"],
    label: "Video",
  },
  // Both lip-sync models re-drive the mouth in an existing video from a wired
  // track; PixVerse (Replicate) is the house default, Kling the alternative.
  lipsync: {
    kind: "generate",
    modality: "video",
    role: "lipsync",
    prefer: ["pixverse/lipsync"],
    label: "Lip sync",
  },
  music: {
    kind: "generate",
    modality: "audio",
    role: "music",
    prefer: ["music_v2"],
    label: "Music",
  },
  speech: {
    kind: "generate",
    modality: "audio",
    role: "speech",
    // Eleven v3 is the expressive flagship; Flash v2.5 stays the pick for
    // whoever wants latency over delivery.
    prefer: ["eleven_v3"],
    label: "Speech",
  },
  sfx: { kind: "generate", modality: "audio", role: "sfx", label: "Sound effects" },
  // No role: a character sheet is an ordinary image generation with a
  // particular prompt, not a model class of its own — so it opens on the same
  // default image model.
  character: {
    kind: "generate",
    modality: "image",
    prefer: ["seedream-5.0-lite"],
    label: "Character sheet",
  },
  llm: { kind: "generate", modality: "text", role: "llm", label: "LLM" },
  text: { kind: "input.text", label: "Text" },
  composition: { kind: "transform.composite", label: "Composition" },
  upload: { kind: "input.upload", label: "Upload" },
};

export function isCreateTool(id: string): id is CreateToolId {
  return id in NODE_BLUEPRINTS;
}

/**
 * The model a freshly placed node of this kind should start on.
 *
 * Role is a filter rather than a preference: `modelsForModality` orders by
 * readiness then label, so without it the Video tool lands on whichever video
 * model happens to sort first — "Mock Lip Sync" before "Mock Video" — and
 * places a node the user did not ask for. A tool that names no role wants the
 * models that claim none.
 */
export function pickModel(
  catalog: Catalog,
  blueprint: NodeBlueprint,
): CatalogModel | undefined {
  if (blueprint.kind !== "generate" || !blueprint.modality) return undefined;
  const wanted = blueprint.role ?? "";
  const candidates = modelsForModality(catalog, blueprint.modality).filter(
    (m) => (m.role ?? "") === wanted,
  );
  for (const id of blueprint.prefer ?? []) {
    // Only a *usable* preference wins. An unavailable model is still listed in
    // the catalog (with the key that would unlock it), so preferring it by id
    // alone would open a keyless canvas on a node that cannot run when a mock
    // of the same role is sitting right there.
    const hit = candidates.find((m) => m.id === id && m.status === "ready");
    if (hit) return hit;
  }
  // Nothing of this role in the catalog: leave the node on "Pick a model"
  // rather than seeding it with a model of the wrong kind, which the user would
  // have to notice and undo.
  return candidates[0];
}

/** Wire `data` for a newly placed node, seeded from the catalog. */
export function blueprintData(
  catalog: Catalog,
  blueprint: NodeBlueprint,
  overrides: {
    prompt?: string;
    title?: string;
    /** A model already chosen (the prompt bar) — wins over the blueprint's pick. */
    model?: CatalogModel;
    /** Params to seed with; the model's catalog defaults otherwise. */
    params?: Record<string, unknown>;
  } = {},
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
      const model = overrides.model ?? pickModel(catalog, blueprint);
      const data: GenerateNodeData = {
        provider: model?.provider ?? "mock",
        model: model?.id ?? "",
        // The compiler rejects a node whose modality disagrees with its
        // model's, so follow the model when there is one.
        modality: (model?.modality ?? blueprint.modality ?? "image") as WireModality,
        prompt: overrides.prompt ?? null,
        params: overrides.params ?? (model ? defaultParams(model) : {}),
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
