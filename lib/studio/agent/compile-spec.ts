/**
 * GraphSpec → wire Graph.
 *
 * The client-side twin of the trust boundary: everything the LLM says is
 * checked here against the catalog before a single node lands on the canvas,
 * mirroring the same rules `isValidConnection` enforces for hand-drawn wires
 * (which themselves mirror `plan_graph`). Failures return human-readable
 * strings that go straight back to the model as a tool result, so it can
 * correct itself instead of the user seeing a broken graph.
 *
 * React-free: imported by the client session hook and by server code alike.
 */

import {
  type Catalog,
  type CatalogModel,
  remapParams,
  visiblePorts,
} from "../catalog";
import {
  type CompositeNodeData,
  type Graph,
  type GraphEdge,
  type GraphNode,
  GRAPH_VERSION,
  MAX_AUDIO_TRACKS,
  MAX_EDGES,
  audioPortId,
  newId,
  newTrack,
} from "../graph";
import {
  NODE_BLUEPRINTS,
  NODE_SIZE,
  blueprintData,
  modalitiesCompatible,
  outputModality,
  outputRole,
  rolesCompatible,
} from "../node-ui";
import type { AgentAttachment, GraphSpec, GraphSpecNode } from "./spec";

const COLUMN_GAP = 140;
const ROW_GAP = 70;

export type CompiledSpec = {
  ok: true;
  graph: Graph;
  /** Fragment extent, for placement math. Positions are normalized to (0,0). */
  size: { w: number; h: number };
  /** Spec-local id → the real node id that landed on the canvas. */
  idMap: Record<string, string>;
};

export type CompileFailure = { ok: false; errors: string[] };

type Prepared = {
  spec: GraphSpecNode;
  realId: string;
  kind: GraphNode["kind"];
  model?: CatalogModel;
  data: Record<string, unknown>;
  /** Modality of the upload's asset, for edge typing. */
  assetModality?: string;
};

/** Longest-path depth per node — the column each one renders in. */
function depths(
  order: string[],
  incoming: Map<string, string[]>,
): Map<string, number> {
  const depth = new Map<string, number>();
  for (const id of order) {
    const preds = incoming.get(id) ?? [];
    depth.set(id, preds.length ? Math.max(...preds.map((p) => depth.get(p) ?? 0)) + 1 : 0);
  }
  return depth;
}

/** Kahn's — returns null when the spec has a cycle. */
function topoSort(ids: string[], edges: { from: string; to: string }[]): string[] | null {
  const indegree = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.get(e.from)?.push(e.to);
  }
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return order.length === ids.length ? order : null;
}

/**
 * Keep an unrequested video duration short. The agent is told to leave
 * duration alone unless the user asked; this is the belt to that suspender —
 * an unlocked duration above 6s is pulled back to the model's floor-or-5.
 */
function guardDuration(node: GraphSpecNode, model: CatalogModel, params: Record<string, unknown>) {
  if (model.modality !== "video" || node.duration_locked) return;
  const spec = model.params.find(
    (p) => p.name === "duration" && (p.type === "integer" || p.type === "number"),
  );
  if (!spec) return;
  const value = Number(params[spec.name]);
  if (Number.isFinite(value) && value > 6) {
    params[spec.name] = Math.max(spec.min ?? 4, 5);
  }
}

export function compileGraphSpec(
  spec: GraphSpec,
  catalog: Catalog,
  attachments: AgentAttachment[],
): CompiledSpec | CompileFailure {
  const errors: string[] = [];
  const byLocal = new Map<string, Prepared>();

  // -- resolve nodes ---------------------------------------------------------
  for (const node of spec.nodes) {
    if (byLocal.has(node.id)) {
      errors.push(`duplicate node id '${node.id}'`);
      continue;
    }
    const blueprint = NODE_BLUEPRINTS[node.tool];
    let model: CatalogModel | undefined;
    if (blueprint.kind === "generate") {
      if (node.model) {
        model = catalog.models.find((m) => m.id === node.model);
        if (!model) {
          errors.push(`node '${node.id}': unknown model '${node.model}' — omit it to use the default`);
          continue;
        }
        if (model.modality !== blueprint.modality) {
          errors.push(
            `node '${node.id}': model '${model.id}' is ${model.modality}, but tool '${node.tool}' needs ${blueprint.modality}`,
          );
          continue;
        }
      }
    }
    let assetModality: string | undefined;
    if (node.tool === "upload") {
      const hit = attachments.find((a) => a.assetId === node.asset_id);
      if (!hit) {
        errors.push(`node '${node.id}': asset_id must be one of the user's attachments`);
        continue;
      }
      assetModality = hit.modality;
    }

    // blueprintData resolves the default model itself when none was named.
    const params = node.params ?? {};
    const data = blueprintData(catalog, blueprint, {
      prompt: node.prompt,
      title:
        node.title ??
        (node.tool === "upload"
          ? attachments.find((a) => a.assetId === node.asset_id)?.filename ?? undefined
          : undefined),
      model,
      params: undefined, // seeded below once the model is known
    });
    if (blueprint.kind === "generate") {
      const resolved =
        model ??
        catalog.models.find(
          (m) =>
            m.provider === (data as { provider?: string }).provider &&
            m.id === (data as { model?: string }).model,
        );
      if (resolved) {
        const remapped = remapParams(params, resolved);
        guardDuration(node, resolved, remapped);
        (data as { params: Record<string, unknown> }).params = remapped;
        model = resolved;
      } else if ((data as { model?: string }).model === "") {
        errors.push(`node '${node.id}': no ${node.tool} model is available in the catalog`);
        continue;
      }
    }
    if (node.tool === "upload") {
      (data as { asset_id: string | null }).asset_id = node.asset_id ?? null;
    }

    byLocal.set(node.id, {
      spec: node,
      realId: newId(),
      kind: blueprint.kind,
      model,
      data,
      assetModality,
    });
  }

  // Every referenced attachment should land on the canvas — the agent is told
  // to wire each one in, and a silent miss would strand the user's file.
  for (const a of attachments) {
    const used = spec.nodes.some((n) => n.tool === "upload" && n.asset_id === a.assetId);
    if (!used) errors.push(`attachment '${a.filename ?? a.assetId}' has no upload node`);
  }

  if (errors.length) return { ok: false, errors };

  // -- resolve + validate edges ---------------------------------------------
  if (spec.edges.length > MAX_EDGES) {
    return { ok: false, errors: [`too many edges (max ${MAX_EDGES})`] };
  }
  const wireEdges: GraphEdge[] = [];
  const arity = new Map<string, number>();
  for (const edge of spec.edges) {
    const source = byLocal.get(edge.from);
    const target = byLocal.get(edge.to);
    if (!source || !target) {
      errors.push(`edge ${edge.from}→${edge.to}: unknown node id`);
      continue;
    }
    if (edge.from === edge.to) {
      errors.push(`edge ${edge.from}→${edge.to}: a node cannot feed itself`);
      continue;
    }

    let handle = edge.port;
    if (target.kind === "transform.composite") {
      const data = target.data as unknown as CompositeNodeData;
      if (edge.port === "video") {
        handle = "video";
      } else if (edge.port === "audio" || edge.port.startsWith("audio_")) {
        // One lane per audio source: the first edge takes the seeded lane,
        // each further edge grows its own, exactly as a user would add lanes.
        const taken = wireEdges.filter(
          (e) => e.target === target.realId && e.source_handle === "out" && e.target_handle.startsWith("audio_"),
        ).length;
        if (taken < data.tracks.length) {
          handle = audioPortId(data.tracks[taken].id);
        } else if (data.tracks.length < MAX_AUDIO_TRACKS) {
          const track = newTrack();
          data.tracks = [...data.tracks, track];
          handle = audioPortId(track.id);
        } else {
          errors.push(`edge ${edge.from}→${edge.to}: composition already has ${MAX_AUDIO_TRACKS} audio lanes`);
          continue;
        }
      } else {
        errors.push(`edge ${edge.from}→${edge.to}: composition ports are 'video' and 'audio'`);
        continue;
      }
      const port = visiblePorts(catalog, target.kind, undefined, target.data).find(
        (p) => p.id === handle,
      );
      if (!port) {
        errors.push(`edge ${edge.from}→${edge.to}: no port '${handle}'`);
        continue;
      }
      const sourceMod = outputModality(source.kind, source.data, catalog, source.assetModality);
      if (!modalitiesCompatible(sourceMod, port.modality)) {
        errors.push(
          `edge ${edge.from}→${edge.to}: '${edge.from}' emits ${sourceMod}, port '${edge.port}' takes ${port.modality}`,
        );
        continue;
      }
    } else if (target.kind === "generate") {
      const ports = visiblePorts(catalog, "generate", target.model);
      const port = ports.find((p) => p.id === handle);
      if (!port) {
        const names = ports.map((p) => p.id).join(", ");
        errors.push(
          `edge ${edge.from}→${edge.to}: model '${target.model?.id ?? "?"}' has no port '${handle}' (has: ${names})`,
        );
        continue;
      }
      const sourceMod = outputModality(source.kind, source.data, catalog, source.assetModality);
      if (!modalitiesCompatible(sourceMod, port.modality)) {
        errors.push(
          `edge ${edge.from}→${edge.to}: '${edge.from}' emits ${sourceMod}, port '${handle}' takes ${port.modality}`,
        );
        continue;
      }
      if (!rolesCompatible(outputRole(source.kind, source.data, catalog), port.roles)) {
        errors.push(
          `edge ${edge.from}→${edge.to}: port '${handle}' only takes ${port.roles?.join("/")} sources`,
        );
        continue;
      }
      if (!port.multi) {
        const key = `${target.realId}:${handle}`;
        const seen = arity.get(key) ?? 0;
        if (seen > 0) {
          errors.push(`edge ${edge.from}→${edge.to}: port '${handle}' takes a single wire`);
          continue;
        }
        arity.set(key, seen + 1);
      }
    } else {
      errors.push(`edge ${edge.from}→${edge.to}: '${edge.to}' (${target.kind}) has no inputs`);
      continue;
    }

    wireEdges.push({
      id: newId(),
      source: source.realId,
      target: target.realId,
      source_handle: "out",
      target_handle: handle,
    });
  }

  // A composition with nothing on its picture track can never run.
  for (const node of byLocal.values()) {
    if (node.kind !== "transform.composite") continue;
    const fed = wireEdges.some((e) => e.target === node.realId && e.target_handle === "video");
    if (!fed) errors.push(`node '${node.spec.id}': composition needs at least one video input`);
  }

  const order = topoSort(
    spec.nodes.map((n) => n.id),
    spec.edges,
  );
  if (!order) errors.push("the graph has a cycle — remove the loop");
  if (errors.length || !order) return { ok: false, errors };

  // -- layout ----------------------------------------------------------------
  const incoming = new Map<string, string[]>();
  for (const e of spec.edges) {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  }
  const depth = depths(order, incoming);
  const columns = new Map<number, Prepared[]>();
  // Spec order within a column, so the agent's narrative order survives layout.
  for (const node of spec.nodes) {
    const d = depth.get(node.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), byLocal.get(node.id)!]);
  }

  const colHeights = new Map<number, number>();
  for (const [d, members] of columns) {
    const h =
      members.reduce((sum, m) => sum + NODE_SIZE[m.kind].height, 0) +
      ROW_GAP * (members.length - 1);
    colHeights.set(d, h);
  }
  const maxHeight = Math.max(...colHeights.values());

  const nodes: GraphNode[] = [];
  let x = 0;
  for (let d = 0; columns.has(d); d++) {
    const members = columns.get(d)!;
    const width = Math.max(...members.map((m) => NODE_SIZE[m.kind].width));
    let y = Math.round((maxHeight - colHeights.get(d)!) / 2);
    for (const m of members) {
      nodes.push({
        id: m.realId,
        kind: m.kind,
        position: { x, y },
        data: m.data,
      });
      y += NODE_SIZE[m.kind].height + ROW_GAP;
    }
    x += width + COLUMN_GAP;
  }

  const idMap: Record<string, string> = {};
  for (const [local, prepared] of byLocal) idMap[local] = prepared.realId;

  return {
    ok: true,
    graph: { version: GRAPH_VERSION, nodes, edges: wireEdges },
    size: { w: x - COLUMN_GAP, h: maxHeight },
    idMap,
  };
}
