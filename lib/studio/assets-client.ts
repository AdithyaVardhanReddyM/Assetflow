/**
 * Browser-side asset ingest and preview resolution.
 *
 * Uploads go to FastAPI rather than a Next route handler because that is where
 * the B2 credentials and the manifest-writing code already live — putting a
 * second writer in Node would duplicate both.
 */

import { API_URL } from "./catalog";
import type { AssetPreview, Modality } from "./graph";

type AssetPayload = {
  id: string;
  url: string;
  preview_url: string | null;
  media_type: string;
  modality: string;
  filename: string | null;
  width: number | null;
  height: number | null;
};

function toPreview(payload: AssetPayload): AssetPreview {
  return {
    id: payload.id,
    // `preview_url` is presigned and short-lived; `url` is the durable one and
    // only resolves on its own in local storage mode.
    url: payload.preview_url ?? payload.url,
    mediaType: payload.media_type,
    modality: payload.modality as Modality,
    filename: payload.filename,
    width: payload.width,
    height: payload.height,
  };
}

export type ApiAuth = { token: string | null; userId: string | null };

/**
 * Both headers, always. When the backend runs with AUTH_DEV_BYPASS it reads
 * `X-Dev-User` and ignores the token; otherwise it verifies the token and
 * ignores the header. Sending both keeps the tenant id — which is also the B2
 * prefix — identical to the one the Next server actions derive, in either mode.
 *
 * Exported for the runs client, which authenticates the same way.
 */
export function authHeaders(token: string | null, userId: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (userId) headers["X-Dev-User"] = userId;
  return headers;
}

export async function uploadAsset(
  file: File,
  auth: { token: string | null; userId: string | null },
): Promise<AssetPreview | null> {
  const body = new FormData();
  body.append("file", file);

  try {
    const res = await fetch(`${API_URL}/v1/assets`, {
      method: "POST",
      headers: authHeaders(auth.token, auth.userId),
      body,
    });
    if (!res.ok) return null;
    return toPreview((await res.json()) as AssetPayload);
  } catch {
    return null;
  }
}

/**
 * Re-resolves previews for a saved canvas. The graph stores only `asset_id`,
 * so opening a workflow has to mint fresh presigned URLs — the previous ones
 * have expired.
 */
export async function fetchAssetPreviews(
  ids: string[],
  auth: { token: string | null; userId: string | null },
): Promise<Record<string, AssetPreview>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return {};

  const headers = authHeaders(auth.token, auth.userId);
  const results = await Promise.all(
    unique.map(async (id) => {
      try {
        const res = await fetch(`${API_URL}/v1/assets/${id}`, { headers });
        if (!res.ok) return null;
        return toPreview((await res.json()) as AssetPayload);
      } catch {
        // A missing preview leaves that node showing its empty state, which is
        // recoverable; failing the whole canvas load would not be.
        return null;
      }
    }),
  );

  const out: Record<string, AssetPreview> = {};
  for (const asset of results) if (asset) out[asset.id] = asset;
  return out;
}
