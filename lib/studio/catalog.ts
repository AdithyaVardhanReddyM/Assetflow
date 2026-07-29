/**
 * The server-driven palette.
 *
 * `backend/app/catalog/` is the source of truth for which models exist, what
 * parameters they take, and which input ports they expose — the canvas renders
 * from it rather than hardcoding a model list, which is what lets a new
 * provider appear on the node without a frontend change.
 *
 * It is fetched from FastAPI at render time. The fallback below is deliberately
 * small: only the `mock` provider, which is what `default_data` in
 * `node_types.yaml` selects anyway. That keeps the canvas fully usable with
 * nothing but `DATABASE_URL` while making it obvious, when the backend is down,
 * that the real breadth is missing rather than quietly shipping a stale mirror
 * of every provider.
 */

import { audioPortId, compositeTracks } from "./graph";

export type Modality = "image" | "video" | "audio" | "text" | "3d";

export type ProviderStatus = "ready" | "missing_key" | "not_installed";

export type ParamType = "number" | "integer" | "string" | "boolean" | "enum";

export type ParamOption = { value: string; label?: string };

export type ParamDescriptor = {
  name: string;
  type: ParamType;
  label?: string;
  help?: string;
  unit?: string;
  // "basic" is a bar chip, "advanced" hides in the overflow menu, "body" is a
  // full-width control in the node body (lyrics box, voice picker).
  group?: "basic" | "advanced" | "body";
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  max_length?: number;
  /** A string param rendered as a multi-line box. Only meaningful in "body". */
  multiline?: boolean;
  /**
   * A richer control than this param's type would get by default. "voice"
   * swaps the enum select for the picker that hangs tone, accent, age and a
   * playable sample off each option. `options` stays authoritative for which
   * values exist — the picker only decorates them.
   */
  ui?: "voice";
  options?: ParamOption[];
};

export type PortHandoff = {
  port: string;
  via: "external_inputs" | "param";
  param?: string | null;
  modality: Modality;
};

export type CatalogModel = {
  id: string;
  label: string;
  provider: string;
  provider_label: string;
  modality: Modality;
  /**
   * What the model is for, when modality is too coarse: music, text-to-speech
   * and sound effects are all `audio`. Drives the node's icon and caption.
   */
  role?: string | null;
  status: ProviderStatus;
  expected_duration_sec?: number | null;
  est_cost_usd?: number | null;
  output_media_type?: string | null;
  /**
   * Shape this model emits, for models with no `aspect_ratio` param to pick it
   * (lipsync follows its avatar). Absent means square.
   */
  output_aspect_ratio?: string | null;
  /** False for models driven entirely by their ports — the canvas drops the prompt box. */
  requires_prompt?: boolean;
  /**
   * True when the prompt is one of two exclusive drivers (Hunyuan 3D takes
   * prompt XOR reference image): a wired input stands in for the prompt.
   */
  prompt_optional_with_inputs?: boolean;
  params: ParamDescriptor[];
  accepts: PortHandoff[];
};

export type PortSpec = {
  id: string;
  modality: string;
  required: boolean;
  multi: boolean;
  model_gated: boolean;
  /**
   * Source roles this port takes, where its modality alone is too permissive —
   * lipsync's `speech` is audio, but so are music and sound effects. Empty (or
   * absent, on an older backend) means any source of the right modality.
   */
  roles?: string[];
  /**
   * True when this describes a *family* of handles rather than one: the
   * composite node expands it into a port per audio lane it carries. A template
   * is never itself connectable — see `visiblePorts`.
   */
  per_track?: boolean;
};

export type CatalogNodeType = {
  kind: string;
  label: string;
  category: string;
  description?: string | null;
  inputs: PortSpec[];
  outputs: PortSpec[];
  default_data: Record<string, unknown>;
};

export type Catalog = {
  models: CatalogModel[];
  nodeTypes: CatalogNodeType[];
  /** False when the backend was unreachable and the fallback is in play. */
  live: boolean;
};

// --- fallback -------------------------------------------------------------

// Empty on purpose: providers.yaml marks every mock model `hidden` (the real
// lineup owns the pickers; the mocks survive server-side as the compiler
// suite's substrate), and the API never serves hidden models — the fallback
// mirrors that absence. A backend-down canvas offers no models at all rather
// than mocks the live palette would not show.
const MOCK_MODELS: CatalogModel[] = [];

const FALLBACK_NODE_TYPES: CatalogNodeType[] = [
  {
    kind: "input.text",
    label: "Text",
    category: "input",
    inputs: [],
    outputs: [{ id: "out", modality: "text", required: false, multi: false, model_gated: false }],
    default_data: { text: "" },
  },
  {
    kind: "input.upload",
    label: "Upload",
    category: "input",
    inputs: [],
    outputs: [{ id: "out", modality: "any", required: false, multi: false, model_gated: false }],
    default_data: { asset_id: null, title: null },
  },
  {
    kind: "generate",
    label: "Generate",
    category: "generate",
    inputs: [
      { id: "prompt", modality: "text", required: false, multi: false, model_gated: false },
      { id: "init_image", modality: "image", required: false, multi: false, model_gated: true },
      { id: "end_frame", modality: "image", required: false, multi: false, model_gated: true },
      { id: "avatar", modality: "image", required: false, multi: false, model_gated: true },
      // Speech or music (an avatar can sing) or an upload may drive a mouth —
      // see the note on `roles` in node_types.yaml.
      { id: "speech", modality: "audio", required: false, multi: false, model_gated: true, roles: ["speech", "music"] },
      // The track a music model covers — mirrors node_types.yaml.
      { id: "source_audio", modality: "audio", required: false, multi: false, model_gated: true, roles: ["music"] },
      { id: "image_ref", modality: "image", required: false, multi: true, model_gated: true },
      // The video a v2v model edits — mirrors node_types.yaml.
      { id: "source_video", modality: "video", required: false, multi: false, model_gated: true },
    ],
    outputs: [{ id: "out", modality: "any", required: false, multi: false, model_gated: false }],
    default_data: {
      provider: "mock",
      model: "mock-video-v1",
      modality: "video",
      prompt: null,
      params: {},
      fallback_models: [],
      title: null,
    },
  },
  {
    kind: "transform.composite",
    label: "Composition",
    category: "transform",
    inputs: [
      // `multi` on both: a track is a timeline, so several sources can sit on
      // one, each becoming a clip the user positions in time.
      { id: "video", modality: "video", required: true, multi: true, model_gated: false },
      // A template the node expands per lane — see `per_track` on PortSpec.
      { id: "audio", modality: "audio", required: false, multi: true, model_gated: false, per_track: true },
    ],
    outputs: [{ id: "out", modality: "video", required: false, multi: false, model_gated: false }],
    default_data: {
      op: "mux",
      timeline_sec: 8,
      video: { id: "video", label: null, gain: 1, muted: false, clips: [] },
      tracks: [{ id: "a1", label: null, gain: 1, muted: false, clips: [] }],
    },
  },
  {
    kind: "output",
    label: "Output",
    category: "output",
    inputs: [{ id: "in", modality: "any", required: true, multi: false, model_gated: false }],
    outputs: [],
    default_data: { label: null },
  },
];

export const FALLBACK_CATALOG: Catalog = {
  models: MOCK_MODELS,
  nodeTypes: FALLBACK_NODE_TYPES,
  live: false,
};

// --- fetching -------------------------------------------------------------

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/**
 * Cache window for the catalog fetch.
 *
 * Zero in development: the catalog is hand-authored YAML, so a five-minute
 * window means an edit to `providers.yaml` does not reach the canvas until the
 * dev server is restarted — which reads as "my change did nothing" rather than
 * "my change is cached". The cost is two localhost requests per render.
 */
const CATALOG_REVALIDATE = process.env.NODE_ENV === "development" ? 0 : 300;

/**
 * Server-side only. Both endpoints are public (no tenant data), so this needs
 * no Clerk token. Revalidated rather than cached forever because provider
 * availability changes when a key is added to the environment.
 */
export async function fetchCatalog(): Promise<Catalog> {
  try {
    const [modelsRes, typesRes] = await Promise.all([
      fetch(`${API_URL}/v1/catalog/models`, {
        next: { revalidate: CATALOG_REVALIDATE },
      }),
      fetch(`${API_URL}/v1/catalog/node-types`, {
        next: { revalidate: CATALOG_REVALIDATE },
      }),
    ]);
    if (!modelsRes.ok || !typesRes.ok) return FALLBACK_CATALOG;

    const models = (await modelsRes.json()).models as CatalogModel[];
    const nodeTypes = (await typesRes.json()).node_types as CatalogNodeType[];
    if (!Array.isArray(models) || !Array.isArray(nodeTypes) || !models.length) {
      return FALLBACK_CATALOG;
    }
    return { models, nodeTypes, live: true };
  } catch {
    // Backend not running — the canvas still opens on the mock palette.
    return FALLBACK_CATALOG;
  }
}

// --- lookups --------------------------------------------------------------

export function findModel(
  catalog: Catalog,
  provider: string,
  modelId: string,
): CatalogModel | undefined {
  return catalog.models.find((m) => m.provider === provider && m.id === modelId);
}

export function modelsForModality(catalog: Catalog, modality: Modality): CatalogModel[] {
  // Ready providers first, then alphabetical — an unavailable model still gets
  // listed (with its reason) rather than hidden, so the palette shows what the
  // product supports and how to unlock it.
  return catalog.models
    .filter((m) => m.modality === modality)
    .sort((a, b) => {
      if ((a.status === "ready") !== (b.status === "ready")) return a.status === "ready" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

export function nodeType(catalog: Catalog, kind: string): CatalogNodeType | undefined {
  return catalog.nodeTypes.find((n) => n.kind === kind);
}

/**
 * The ports a node actually shows, mirroring the gating in
 * `plan_graph`: a `model_gated` port exists only when the selected model
 * declares it in `accepts`. Diverging from that would draw a handle the
 * compiler then rejects as UNKNOWN_HANDLE.
 */
export function visiblePorts(
  catalog: Catalog,
  kind: string,
  model?: CatalogModel,
  /** The node's own `wire` data — only consulted to expand `per_track` ports. */
  wire?: Record<string, unknown>,
): PortSpec[] {
  const type = nodeType(catalog, kind);
  if (!type) return [];

  const out: PortSpec[] = [];
  for (const port of type.inputs) {
    if (port.per_track) {
      // The catalog describes what one lane's port looks like; the node says
      // how many there are. Same expansion as `plan_graph`, in the same order.
      for (const track of compositeTracks(wire)) {
        out.push({ ...port, id: audioPortId(track.id), per_track: false });
      }
      continue;
    }
    if (port.model_gated && !model?.accepts.some((a) => a.port === port.id)) continue;
    out.push(port);
  }
  return out;
}

function ratioValue(value: string): number | null {
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  return w > 0 && h > 0 ? w / h : null;
}

/**
 * The `aspect_ratio` value that makes this model emit the given shape, or null
 * when it cannot. Mirrors `aspect_option_for` in `backend/app/graph/presets.py`:
 * compared numerically rather than by spelling, because providers disagree on
 * it — Runway's enum says "1920:1080" where everyone else says "16:9". A model
 * without the param has a fixed output shape, which either matches or doesn't.
 */
export function aspectOptionFor(model: CatalogModel, ratio: string): string | null {
  const target = ratioValue(ratio);
  if (target === null) return null;

  const spec = model.params.find((p) => p.name === "aspect_ratio");
  if (spec) {
    const values = (spec.options ?? []).map((o) => o.value);
    if (values.includes(ratio)) return ratio;
    return (
      values.find((v) => {
        const own = ratioValue(v);
        return own !== null && Math.abs(own - target) < 0.01;
      }) ?? null
    );
  }

  const declared = model.output_aspect_ratio;
  if (typeof declared === "string") {
    const own = ratioValue(declared);
    if (own !== null && Math.abs(own - target) < 0.01) return declared;
  }
  return null;
}

export function statusReason(model: CatalogModel): string | null {
  switch (model.status) {
    case "ready":
      return null;
    case "missing_key":
      return `Add an API key to enable ${model.provider_label}.`;
    case "not_installed":
      return `${model.provider_label} is not installed.`;
  }
}

/** Catalog defaults for a model, used when a node first picks it. */
export function defaultParams(model: CatalogModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of model.params) {
    if (p.default !== undefined && p.default !== null) out[p.name] = p.default;
  }
  return out;
}

/**
 * Re-seed a node's params when its model changes.
 *
 * Params are per-provider by design — ElevenLabs takes `duration_seconds` where
 * Runway takes `duration` — so carrying the old map across wholesale earns a
 * PARAM_UNKNOWN from the compiler. Start from the new model's defaults and keep
 * only values it also declares *and* would accept, so a deliberate "16:9"
 * survives the switch but a stale key does not.
 */
export function remapParams(
  previous: Record<string, unknown>,
  next: CatalogModel,
): Record<string, unknown> {
  const out = defaultParams(next);
  for (const spec of next.params) {
    const carried = previous[spec.name];
    if (carried === undefined || carried === null) continue;
    if (spec.type === "enum") {
      const allowed = (spec.options ?? []).some((o) => o.value === String(carried));
      if (!allowed) continue;
      out[spec.name] = String(carried);
      continue;
    }
    if (spec.type === "integer" || spec.type === "number") {
      const num = Number(carried);
      if (!Number.isFinite(num)) continue;
      if (spec.min !== undefined && num < spec.min) continue;
      if (spec.max !== undefined && num > spec.max) continue;
      out[spec.name] = spec.type === "integer" ? Math.round(num) : num;
      continue;
    }
    if (spec.type === "boolean") {
      if (typeof carried === "boolean") out[spec.name] = carried;
      continue;
    }
    if (typeof carried === "string") {
      if (spec.max_length !== undefined && carried.length > spec.max_length) continue;
      out[spec.name] = carried;
    }
  }
  return out;
}
