/**
 * Client for the public inspect endpoint — the receiving end of a stamped
 * export. No auth anywhere here on purpose: the person dropping the file is
 * exactly the person who was handed it, account or not. Possession of the
 * bytes is the credential; nothing can be browsed or looked up by id.
 */

import { API_URL } from "./catalog";

/** One pass of the derivation, unified across the two places it can come
 *  from: the live library chain (thumbnails included) or the compact record
 *  embedded in the file itself (ids and hashes only — presigned URLs rot,
 *  so the stamp never carries any). */
export type InspectHop = {
  /** `${runId}:${nodeId}` — the same identity the chain's edges refer to. */
  id: string;
  kind: string;
  /** Rows from the file's own step: 0 made it, higher is further upstream. */
  depth: number;
  title: string | null;
  /** input.text hops carry their text here, in the author's own words. */
  text: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  stepType: string | null;
  /** Short-lived presigned preview, live-library sources only. */
  previewUrl: string | null;
  previewMediaType: string | null;
  assetFilename: string | null;
  assetSha256: string | null;
};

export type InspectReport = {
  /** SHA-256 of the bytes actually dropped. */
  sha256: string;
  sizeBytes: number;
  found: boolean;
  /**
   * How the file resolved: `embedded` — it carries a stamped record and the
   * library still holds the asset; `snapshot` — stamped record, library row
   * gone, the file is the last copy of its own story; `fingerprint` —
   * byte-identical to a stored original; `none` — no record, no match.
   */
  source: "embedded" | "snapshot" | "fingerprint" | "none";
  /** The original's fingerprint, when known — differs from `sha256` for a
   *  stamped copy, because the stamp itself changed the bytes. */
  originalSha256: string | null;
  prompt: string | null;
  model: string | null;
  provider: string | null;
  manifestHash: string | null;
  createdAt: string | null;
  /** Sources at the end, the file's own step first (sorted by depth). */
  hops: InspectHop[];
  /** The run snapshots' own wiring, by hop id — what the graph draws. */
  edges: { source: string; target: string }[];
  truncated: boolean;
};

type WireHopAsset = {
  id?: string;
  sha256?: string | null;
  preview_url?: string | null;
  media_type?: string | null;
  filename?: string | null;
};

type WireHop = {
  id: string;
  kind?: string;
  depth?: number;
  title?: string | null;
  text?: string | null;
  provider?: string | null;
  model?: string | null;
  prompt?: string | null;
  step_type?: string | null;
  /** Live chain shape. */
  assets?: WireHopAsset[];
  /** Embedded-record shape. */
  asset?: WireHopAsset | null;
};

type WireBody = {
  sha256: string;
  size_bytes: number;
  found: boolean;
  source: "embedded" | "snapshot" | "fingerprint" | "none";
  embedded?: {
    sha256?: string | null;
    created_at?: string | null;
    chain?: {
      hops?: WireHop[];
      edges?: { source: string; target: string }[];
      truncated?: boolean;
    } | null;
    step?: {
      provider?: string | null;
      model?: string | null;
      prompt?: string | null;
    } | null;
    run?: { manifest_hash?: string | null } | null;
  } | null;
  asset?: { sha256?: string | null; created_at?: string | null } | null;
  lineage?: {
    provider?: string | null;
    model?: string | null;
    prompt?: string | null;
    manifest_hash?: string | null;
  } | null;
  chain?: {
    hops?: WireHop[];
    edges?: { source: string; target: string }[];
    truncated?: boolean;
  } | null;
};

function toHop(row: WireHop): InspectHop {
  const live = row.assets?.[0] ?? null;
  const stamped = row.asset ?? null;
  return {
    id: row.id,
    kind: row.kind ?? "",
    depth: row.depth ?? 0,
    title: row.title ?? null,
    text: row.text ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    prompt: row.prompt ?? null,
    stepType: row.step_type ?? null,
    previewUrl: live?.preview_url ?? null,
    previewMediaType: live?.media_type ?? null,
    assetFilename: live?.filename ?? null,
    assetSha256: live?.sha256 ?? stamped?.sha256 ?? null,
  };
}

/**
 * Ask the API what a file is. Null means the request itself failed (offline,
 * too large) — different from a clean "nothing known", which comes back as
 * `found: false`.
 */
export async function inspectFile(file: File): Promise<InspectReport | null> {
  const form = new FormData();
  form.append("file", file);
  let body: WireBody;
  try {
    const res = await fetch(`${API_URL}/v1/inspect`, { method: "POST", body: form });
    if (!res.ok) return null;
    body = (await res.json()) as WireBody;
  } catch {
    return null;
  }

  // A live chain (fresh thumbnails) beats the embedded copy of the same
  // story; the embedded record is the only story a `snapshot` has left.
  const chain = body.chain ?? body.embedded?.chain ?? null;
  const hops = (chain?.hops ?? []).map(toHop).sort((a, b) => a.depth - b.depth);

  return {
    sha256: body.sha256,
    sizeBytes: body.size_bytes,
    found: body.found,
    source: body.source,
    originalSha256: body.asset?.sha256 ?? body.embedded?.sha256 ?? null,
    prompt: body.lineage?.prompt ?? body.embedded?.step?.prompt ?? null,
    model: body.lineage?.model ?? body.embedded?.step?.model ?? null,
    provider: body.lineage?.provider ?? body.embedded?.step?.provider ?? null,
    manifestHash:
      body.lineage?.manifest_hash ?? body.embedded?.run?.manifest_hash ?? null,
    createdAt: body.asset?.created_at ?? body.embedded?.created_at ?? null,
    hops,
    edges: chain?.edges ?? [],
    truncated: chain?.truncated ?? false,
  };
}
