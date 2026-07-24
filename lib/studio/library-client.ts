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
  createdAt: string | null;
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
  created_at: string | null;
};

const PAGE = 200;
/** Two pages. Beyond this the library needs real server-side paging, not a
 *  longer first paint. */
const WINDOW = PAGE * 2;

export async function fetchLibrary(auth: ApiAuth): Promise<LibraryAsset[] | null> {
  const headers = authHeaders(auth.token, auth.userId);
  const out: LibraryAsset[] = [];
  try {
    for (let offset = 0; offset < WINDOW; offset += PAGE) {
      const res = await fetch(`${API_URL}/v1/assets?limit=${PAGE}&offset=${offset}`, {
        headers,
      });
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
    createdAt: row.created_at,
  };
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
