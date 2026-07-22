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

export type Modality = "image" | "video" | "audio" | "text";

export type ProviderStatus = "ready" | "missing_key" | "not_installed";

export type ParamType = "number" | "integer" | "string" | "boolean" | "enum";

export type ParamOption = { value: string; label?: string };

export type ParamDescriptor = {
  name: string;
  type: ParamType;
  label?: string;
  help?: string;
  unit?: string;
  group?: "basic" | "advanced";
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  max_length?: number;
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
  status: ProviderStatus;
  expected_duration_sec?: number | null;
  est_cost_usd?: number | null;
  output_media_type?: string | null;
  params: ParamDescriptor[];
  accepts: PortHandoff[];
};

export type PortSpec = {
  id: string;
  modality: string;
  required: boolean;
  multi: boolean;
  model_gated: boolean;
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

const MOCK_MODELS: CatalogModel[] = [
  {
    id: "mock-video-v1",
    label: "Mock Video",
    provider: "mock",
    provider_label: "Mock (no API key)",
    modality: "video",
    status: "ready",
    expected_duration_sec: 5,
    est_cost_usd: 0,
    output_media_type: "video/mp4",
    accepts: [
      { port: "init_image", via: "external_inputs", modality: "image" },
      { port: "end_frame", via: "external_inputs", modality: "image" },
      { port: "image_ref", via: "external_inputs", modality: "image" },
    ],
    params: [
      { name: "duration", type: "integer", label: "Duration", unit: "s", default: 5, min: 1, max: 10, step: 1 },
      {
        name: "aspect_ratio",
        type: "enum",
        label: "Aspect ratio",
        default: "16:9",
        options: [
          { value: "16:9", label: "Landscape" },
          { value: "9:16", label: "Portrait" },
          { value: "1:1", label: "Square" },
        ],
      },
    ],
  },
  {
    id: "mock-image-v1",
    label: "Mock Image",
    provider: "mock",
    provider_label: "Mock (no API key)",
    modality: "image",
    status: "ready",
    expected_duration_sec: 2,
    est_cost_usd: 0,
    output_media_type: "image/png",
    accepts: [
      { port: "init_image", via: "external_inputs", modality: "image" },
      { port: "image_ref", via: "external_inputs", modality: "image" },
    ],
    params: [
      {
        name: "aspect_ratio",
        type: "enum",
        label: "Aspect ratio",
        default: "1:1",
        options: [
          { value: "1:1", label: "Square" },
          { value: "16:9", label: "Landscape" },
          { value: "9:16", label: "Portrait" },
        ],
      },
    ],
  },
  {
    id: "mock-audio-v1",
    label: "Mock Audio",
    provider: "mock",
    provider_label: "Mock (no API key)",
    modality: "audio",
    status: "ready",
    expected_duration_sec: 3,
    est_cost_usd: 0,
    output_media_type: "audio/mpeg",
    accepts: [],
    params: [
      { name: "duration", type: "integer", label: "Duration", unit: "s", default: 8, min: 1, max: 60, step: 1 },
    ],
  },
];

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
      { id: "image_ref", modality: "image", required: false, multi: true, model_gated: true },
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
    label: "Combine A/V",
    category: "transform",
    inputs: [
      { id: "video", modality: "video", required: true, multi: false, model_gated: false },
      { id: "audio", modality: "audio", required: true, multi: false, model_gated: false },
    ],
    outputs: [{ id: "out", modality: "video", required: false, multi: false, model_gated: false }],
    default_data: { op: "mux" },
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
 * Server-side only. Both endpoints are public (no tenant data), so this needs
 * no Clerk token. Revalidated rather than cached forever because provider
 * availability changes when a key is added to the environment.
 */
export async function fetchCatalog(): Promise<Catalog> {
  try {
    const [modelsRes, typesRes] = await Promise.all([
      fetch(`${API_URL}/v1/catalog/models`, { next: { revalidate: 300 } }),
      fetch(`${API_URL}/v1/catalog/node-types`, { next: { revalidate: 300 } }),
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
): PortSpec[] {
  const type = nodeType(catalog, kind);
  if (!type) return [];
  return type.inputs.filter(
    (p) => !p.model_gated || Boolean(model?.accepts.some((a) => a.port === p.id)),
  );
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
 * Params are per-provider by design — Veo takes `duration_seconds` where Runway
 * takes `duration` — so carrying the old map across wholesale earns a
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
