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

export type AudioPeaks = {
  /** RMS envelope, 0..1, normalised so the loudest bucket is 1. */
  peaks: number[];
  /** ffprobe's duration — more reliable than a VBR mp3's element metadata. */
  durationSec: number;
};

/**
 * The waveform envelope for a stored audio asset.
 *
 * Decoded server-side because the bucket is private and B2 serves no CORS
 * headers, so the browser cannot read the bytes to decode them itself. Results
 * are memoised per asset: bytes behind an asset never change, and a canvas can
 * hold the same clip in several places (a node's well and its carousel).
 */
const peaksCache = new Map<string, Promise<AudioPeaks | null>>();

export function fetchAudioPeaks(
  assetId: string,
  auth: { token: string | null; userId: string | null },
): Promise<AudioPeaks | null> {
  const hit = peaksCache.get(assetId);
  if (hit) return hit;

  const inflight = (async (): Promise<AudioPeaks | null> => {
    try {
      const res = await fetch(`${API_URL}/v1/assets/${assetId}/peaks`, {
        headers: authHeaders(auth.token, auth.userId),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { peaks?: number[]; duration_sec?: number };
      return {
        peaks: Array.isArray(body.peaks) ? body.peaks : [],
        durationSec: typeof body.duration_sec === "number" ? body.duration_sec : 0,
      };
    } catch {
      // The player falls back to a browser decode, then to flat bars.
      return null;
    }
  })();

  peaksCache.set(assetId, inflight);
  // A transport failure should not poison the cache for the whole session.
  void inflight.then((result) => {
    if (!result?.peaks.length) peaksCache.delete(assetId);
  });
  return inflight;
}
