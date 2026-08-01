/**
 * Browser-side client for the asset library page.
 *
 * Reads and deletes go straight to FastAPI, matching uploads: the tenant
 * scoping, presigning, and (for delete) the "index row only, B2 keeps the
 * provenance" rule all live there. Search, filtering, and sorting happen
 * client-side over the fetched window — the library is one tenant's media,
 * not an unbounded feed.
 */

import { API_URL } from "./catalog";
import { type ApiAuth, authHeaders } from "./assets-client";
import { type Graph, type NodeGeneration, parseGraph } from "./graph";

export type LibraryAsset = {
  id: string;
  kind: "upload" | "generated";
  /** Short-lived presigned URL — render from this, never persist it. */
  previewUrl: string | null;
  mediaType: string;
  modality: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  runId: string | null;
  filename: string | null;
  sha256: string | null;
  createdAt: string | null;
  /** Enrichment, present on search results only. */
  caption?: string | null;
  tags?: string[];
  /** Cosine similarity, semantic search hits only. */
  similarity?: number;
};

type AssetRow = {
  id: string;
  kind: "upload" | "generated";
  preview_url: string | null;
  media_type: string;
  modality: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  run_id: string | null;
  filename: string | null;
  sha256: string | null;
  created_at: string | null;
  caption?: string | null;
  tags?: string[];
  similarity?: number;
};

const PAGE = 200;
/** Two pages. Beyond this the library needs real server-side paging, not a
 *  longer first paint. */
const WINDOW = PAGE * 2;

export async function fetchLibrary(
  auth: ApiAuth,
  opts: {
    /** Leave out everything this workflow's own runs produced — the canvas
     *  panel is for bringing in work from *elsewhere*. Uploads belong to no
     *  workflow and are never excluded. */
    excludeWorkflowId?: string;
  } = {},
): Promise<LibraryAsset[] | null> {
  const headers = authHeaders(auth.token, auth.userId);
  const exclude = opts.excludeWorkflowId
    ? `&exclude_workflow_id=${encodeURIComponent(opts.excludeWorkflowId)}`
    : "";
  const out: LibraryAsset[] = [];
  try {
    for (let offset = 0; offset < WINDOW; offset += PAGE) {
      const res = await fetch(
        `${API_URL}/v1/assets?limit=${PAGE}&offset=${offset}${exclude}`,
        { headers },
      );
      if (!res.ok) return offset === 0 ? null : out;
      const body = (await res.json()) as { items: AssetRow[] };
      out.push(...body.items.map(toAsset));
      if (body.items.length < PAGE) break;
    }
    return out;
  } catch {
    // Backend unreachable — the page shows its offline state, not a crash.
    return offset0Safe(out);
  }
}

function offset0Safe(partial: LibraryAsset[]): LibraryAsset[] | null {
  return partial.length ? partial : null;
}

function toAsset(row: AssetRow): LibraryAsset {
  return {
    id: row.id,
    kind: row.kind,
    previewUrl: row.preview_url,
    mediaType: row.media_type,
    modality: row.modality,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    durationSec: row.duration_sec,
    runId: row.run_id,
    filename: row.filename,
    sha256: row.sha256,
    createdAt: row.created_at,
    caption: row.caption ?? null,
    tags: row.tags ?? [],
    similarity: row.similarity,
  };
}

// --- search ----------------------------------------------------------------

export type LibrarySearch = {
  /** Ranked by meaning — the "Best matches" section. */
  semantic: LibraryAsset[];
  /** Ranked by wording, excluding what semantic already claimed. */
  keyword: LibraryAsset[];
};

/**
 * Hybrid search over the enrichment index. Null on failure (offline, aborted),
 * which callers show as an error state — an empty result is `{[], []}`.
 */
export async function searchLibrary(
  query: string,
  auth: ApiAuth,
  opts: {
    modality?: string;
    kind?: string;
    excludeWorkflowId?: string;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<LibrarySearch | null> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(auth.token, auth.userId),
      },
      signal: opts.signal,
      body: JSON.stringify({
        query,
        modality: opts.modality && opts.modality !== "all" ? opts.modality : null,
        kind: opts.kind && opts.kind !== "all" ? opts.kind : null,
        exclude_workflow_id: opts.excludeWorkflowId ?? null,
        limit: opts.limit ?? 12,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { semantic: AssetRow[]; keyword: AssetRow[] };
    return {
      semantic: (body.semantic ?? []).map(toAsset),
      keyword: (body.keyword ?? []).map(toAsset),
    };
  } catch {
    return null;
  }
}

// --- provenance -----------------------------------------------------------

export type AssetLineage = {
  runId: string;
  workflowId: string | null;
  parentRunId: string | null;
  /** The run's manifest in B2 — the canonical record of how this was made. */
  manifestUri: string | null;
  manifestHash: string | null;
  /** Tri-state: null means storage never hash-bound the record (local mode). */
  manifestVerified: boolean | null;
  nodeId: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  params: Record<string, unknown> | null;
  stepType: string | null;
  costUsd: number | null;
};

/**
 * One pass of the graph that produced the asset, walked upstream across every
 * run that touched it. A pass, not a node: the same canvas node edited twice is
 * two hops, which is why `id` carries the run and `nodeId` alone cannot.
 */
export type LineageHop = {
  /** `${runId}:${nodeId}` — what the chain's edges refer to. */
  id: string;
  nodeId: string;
  /** The run this pass ran in; hops from different runs are different runs. */
  runId: string;
  workflowId: string | null;
  kind: string;
  /** Rows from the asset's own node: 0 is the step that made it. */
  depth: number;
  title: string | null;
  text: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  stepType: string | null;
  costUsd: number | null;
  assets: LibraryAsset[];
};

export type LineageChain = {
  hops: LineageHop[];
  edges: { source: string; target: string }[];
  /** True when the history was deeper than the walk was willing to open. */
  truncated: boolean;
};

export type AssetProvenance = {
  /** The asset's own manifest pointer, when it has one distinct from the run's. */
  manifestUri: string | null;
  /** Null for uploads and for rows whose run has been forgotten. */
  lineage: AssetLineage | null;
  /** Null when the asset's node had nothing upstream (or no snapshot). */
  chain: LineageChain | null;
};

type LineageRow = {
  run_id: string;
  workflow_id: string | null;
  parent_run_id: string | null;
  manifest_uri: string | null;
  manifest_hash: string | null;
  manifest_verified: boolean | null;
  node_id: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  params: Record<string, unknown> | null;
  step_type: string | null;
  cost_usd: number | null;
};

type HopRow = {
  id: string;
  node_id: string;
  run_id: string;
  workflow_id: string | null;
  kind: string;
  depth: number;
  title: string | null;
  text: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  step_type: string | null;
  cost_usd: number | null;
  assets: AssetRow[];
};

export async function fetchProvenance(
  id: string,
  auth: ApiAuth,
): Promise<AssetProvenance | null> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${id}/provenance`, {
      headers: authHeaders(auth.token, auth.userId),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      manifest_uri: string | null;
      lineage: LineageRow | null;
      chain: {
        hops: HopRow[];
        edges: { source: string; target: string }[];
        truncated?: boolean;
      } | null;
    };
    return {
      manifestUri: body.manifest_uri,
      lineage: body.lineage
        ? {
            runId: body.lineage.run_id,
            workflowId: body.lineage.workflow_id,
            parentRunId: body.lineage.parent_run_id,
            manifestUri: body.lineage.manifest_uri,
            manifestHash: body.lineage.manifest_hash,
            manifestVerified: body.lineage.manifest_verified ?? null,
            nodeId: body.lineage.node_id,
            provider: body.lineage.provider,
            model: body.lineage.model,
            prompt: body.lineage.prompt,
            params: body.lineage.params,
            stepType: body.lineage.step_type ?? null,
            costUsd: body.lineage.cost_usd,
          }
        : null,
      chain: body.chain
        ? {
            hops: body.chain.hops.map((hop) => ({
              id: hop.id,
              nodeId: hop.node_id,
              runId: hop.run_id,
              workflowId: hop.workflow_id,
              kind: hop.kind,
              depth: hop.depth,
              title: hop.title,
              text: hop.text,
              provider: hop.provider,
              model: hop.model,
              prompt: hop.prompt,
              stepType: hop.step_type,
              costUsd: hop.cost_usd ?? null,
              assets: (hop.assets ?? []).map(toAsset),
            })),
            edges: body.chain.edges ?? [],
            truncated: body.chain.truncated ?? false,
          }
        : null,
    };
  } catch {
    return null;
  }
}

// --- the run record --------------------------------------------------------

export type RunManifestRecord = {
  manifestUri: string | null;
  canonicalHash: string | null;
  /** Verification recorded when the run finished. */
  verified: boolean | null;
  /** Verification recomputed from the bytes just re-read out of B2. */
  verifiedNow: boolean | null;
  manifest: Record<string, unknown>;
};

/**
 * Re-read the run's canonical manifest out of B2 and re-verify its hash.
 * Deliberately not cached: the point of the call is proving the record is
 * still in the bucket, intact, right now.
 */
export async function fetchRunManifest(
  runId: string,
  auth: ApiAuth,
): Promise<RunManifestRecord | null> {
  try {
    const res = await fetch(`${API_URL}/v1/runs/${runId}/manifest`, {
      headers: authHeaders(auth.token, auth.userId),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      manifest_uri: string | null;
      canonical_hash: string | null;
      verified: boolean | null;
      verified_now: boolean | null;
      manifest: Record<string, unknown>;
    };
    return {
      manifestUri: body.manifest_uri,
      canonicalHash: body.canonical_hash,
      verified: body.verified,
      verifiedNow: body.verified_now ?? null,
      manifest: body.manifest,
    };
  } catch {
    return null;
  }
}

// --- reconstruction --------------------------------------------------------

export type Reconstruction = {
  /** The rebuilt chain, positioned relative to (0,0) for the caller to place. */
  graph: Graph;
  /** Inherited takes, keyed by the *new* node id — the carousels arrive full. */
  results: Record<string, NodeGeneration[]>;
  /** Sources whose library rows are gone; their nodes come back empty. */
  missingAssets: string[];
  nodeCount: number;
};

export type ReconstructionResult =
  | { ok: true; data: Reconstruction }
  /** `reason` distinguishes "nothing to rebuild" from "too big to place". */
  | { ok: false; reason: "no_run" | "no_graph" | "too_large" | "error"; nodeCount: number };

type GenerationRow = {
  asset_id: string;
  url: string | null;
  media_type: string | null;
  text: string | null;
  width: number | null;
  height: number | null;
  created_at: string | null;
};

/**
 * The graph that made an asset, ready to drop onto the current canvas.
 *
 * Walked on the server: a chain crosses a run boundary at every take edit and
 * every library asset used as an input, and resolving those here would be one
 * round trip per hop.
 */
export async function fetchReconstruction(
  assetId: string,
  auth: ApiAuth,
): Promise<ReconstructionResult> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${assetId}/reconstruct`, {
      headers: authHeaders(auth.token, auth.userId),
    });
    if (!res.ok) return { ok: false, reason: "error", nodeCount: 0 };
    const body = (await res.json()) as {
      available: boolean;
      reason?: string;
      graph?: unknown;
      results?: Record<string, GenerationRow[]>;
      missing_assets?: string[];
      node_count?: number;
    };
    const nodeCount = body.node_count ?? 0;
    if (!body.available || !body.graph) {
      const reason = body.reason;
      return {
        ok: false,
        reason:
          reason === "no_run" || reason === "no_graph" || reason === "too_large"
            ? reason
            : "error",
        nodeCount,
      };
    }
    // Through the same parser the persistence boundary uses: a fragment that
    // cannot be stored must not be placed on a canvas either.
    const graph = parseGraph(body.graph);
    if (!graph) return { ok: false, reason: "no_graph", nodeCount };

    const results: Record<string, NodeGeneration[]> = {};
    for (const [nodeId, rows] of Object.entries(body.results ?? {})) {
      results[nodeId] = rows.map((r) => ({
        assetId: r.asset_id,
        url: r.url,
        mediaType: r.media_type,
        text: r.text,
        width: r.width,
        height: r.height,
        createdAt: r.created_at,
      }));
    }
    return {
      ok: true,
      data: {
        graph,
        results,
        missingAssets: body.missing_assets ?? [],
        nodeCount: nodeCount || graph.nodes.length,
      },
    };
  } catch {
    return { ok: false, reason: "error", nodeCount: 0 };
  }
}

/**
 * Rename the library's label for an asset. Blank clears it, and the row falls
 * back to its derived name. Nothing about the stored file or its sealed
 * manifest moves — those record what was true when the run happened.
 */
export async function renameLibraryAsset(
  id: string,
  filename: string,
  auth: ApiAuth,
): Promise<LibraryAsset | null> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(auth.token, auth.userId),
      },
      body: JSON.stringify({ filename }),
    });
    if (!res.ok) return null;
    return toAsset((await res.json()) as AssetRow);
  } catch {
    return null;
  }
}

// --- stamped export --------------------------------------------------------

/** Media types the backend can write a provenance record into (mirrors
 *  `STAMPABLE` in the stamp service). Everything else downloads plain. */
export const STAMPABLE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "audio/mpeg",
]);

/**
 * Save a copy of the asset with its derivation stamped into the file's own
 * metadata — the copy meant for sharing, readable by anyone at /inspect.
 * The stored original is untouched; the stamp is applied per export.
 */
export async function downloadProvenanceExport(
  id: string,
  filename: string,
  auth: ApiAuth,
): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${id}/export`, {
      headers: authHeaders(auth.token, auth.userId),
    });
    if (!res.ok) return false;
    const href = URL.createObjectURL(await res.blob());
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(href);
    return true;
  } catch {
    return false;
  }
}

export async function deleteLibraryAsset(id: string, auth: ApiAuth): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${id}`, {
      method: "DELETE",
      headers: authHeaders(auth.token, auth.userId),
    });
    return res.ok;
  } catch {
    return false;
  }
}
