/**
 * Magic Text client — types, font resolution, compositing, and API calls.
 *
 * The backend hands over Ideogram Layerize's decomposition verbatim
 * (`text_containers`); this module flattens it into editable blocks, maps its
 * font vocabulary onto Google Fonts the browser can actually load, and
 * re-renders the edited text onto the base image for export.
 *
 * Two coordinate spaces exist and must not be confused: the JSON's declared
 * `resolution` (what block x/y/size are measured in) and the base PNG's true
 * pixel size (observed to disagree upstream). The editor lays out in the
 * former; the composite scales into the latter.
 */

import { API_URL } from "./catalog";
import { type ApiAuth, authHeaders } from "./assets-client";

// --- wire types (the model's own vocabulary) -------------------------------

type WireSpan = {
  text?: string;
  color?: string;
  font_fx?: string[];
};

type WireItem = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  font_size?: number;
  font_file?: string;
  font_candidates?: string[];
  line_height?: number;
  alignment?: string;
  style_class?: string;
  spans?: WireSpan[];
};

type WireContainer = { id?: string; items?: WireItem[] };

export type LayerizeResponse = {
  base_asset: {
    id: string;
    preview_url: string | null;
    width: number | null;
    height: number | null;
  };
  cutout_asset: { id: string; preview_url: string | null } | null;
  resolution: [number, number] | null;
  base_size: [number, number] | null;
  containers: WireContainer[];
};

// --- editable blocks -------------------------------------------------------

export type FontChoice = {
  family: string;
  weight: number;
  italic: boolean;
  /** The upstream spelling, kept for provenance/debugging. */
  source: string;
};

export type MagicTextBlock = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  fontSize: number;
  lineHeight: number;
  alignment: "left" | "center" | "right";
  font: FontChoice;
  candidates: FontChoice[];
  color: string;
  allCaps: boolean;
  /** What the hierarchy calls this block — "h1", "body", … */
  styleClass: string;
  text: string;
  /**
   * Renders over the subject cutout instead of behind it. Only meaningful
   * when the layerize produced a cutout; blocks start behind, like the
   * original poster's occluded type.
   */
  aboveSubject: boolean;
};

export type LayerizeResult = {
  baseAssetId: string;
  baseUrl: string;
  /** The subject as an RGBA overlay for occlusion; null when none was found. */
  cutout: { assetId: string; url: string } | null;
  /** Block coordinate space (the JSON's `resolution`, else the PNG's size). */
  space: { w: number; h: number };
  /** The base PNG's true pixel size — the export canvas. */
  pixels: { w: number; h: number };
  blocks: MagicTextBlock[];
};

// --- font vocabulary -------------------------------------------------------

/** Upstream weight words (file names and `font__…__word` refs) → CSS weight. */
const WEIGHT_WORDS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  heavy: 900,
  black: 900,
};

/** "encode-sans-expanded" or "MontserratSubrayada" → "Encode Sans Expanded". */
function familyName(raw: string): string {
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * One upstream font reference → a loadable Google Fonts face. Two spellings
 * exist in the wild: file names ("Montserrat-ExtraBold.ttf") and triple-
 * underscore refs ("font__encode-sans-expanded__700"). Unknown shapes fall
 * back to Roboto so a block is never unstyleable.
 */
export function parseFontRef(ref: string | undefined | null): FontChoice {
  const fallback: FontChoice = {
    family: "Roboto",
    weight: 400,
    italic: false,
    source: ref ?? "",
  };
  if (!ref) return fallback;

  if (ref.startsWith("font__")) {
    const parts = ref.split("__");
    if (parts.length < 2 || !parts[1]) return fallback;
    const word = (parts[2] ?? "regular").toLowerCase();
    const italic = word.includes("italic");
    const weight =
      Number.parseInt(word, 10) ||
      WEIGHT_WORDS[word.replace("italic", "").replace(/\s/g, "")] ||
      400;
    return { family: familyName(parts[1]), weight, italic, source: ref };
  }

  const stem = ref.replace(/\.(ttf|otf|woff2?)$/i, "");
  const dash = stem.lastIndexOf("-");
  if (dash === -1) {
    return { family: familyName(stem), weight: 400, italic: false, source: ref };
  }
  const styleWord = stem.slice(dash + 1).toLowerCase();
  const italic = styleWord.includes("italic");
  const weightWord = styleWord.replace("italic", "");
  const weight = WEIGHT_WORDS[weightWord] ?? (italic && !weightWord ? 400 : undefined);
  // An unrecognised suffix is part of the family, not a weight ("Subrayada").
  if (weight === undefined && !italic) {
    return { family: familyName(stem), weight: 400, italic: false, source: ref };
  }
  return {
    family: familyName(stem.slice(0, dash)),
    weight: weight ?? 400,
    italic,
    source: ref,
  };
}

const loadedFonts = new Set<string>();

/**
 * Load one Google Fonts face and wait until the browser can measure with it.
 * Resolves (never rejects) on failure — a missing face degrades to the
 * fallback stack rather than blocking the editor.
 */
export async function loadFont(font: FontChoice): Promise<void> {
  const key = `${font.family}:${font.weight}:${font.italic ? 1 : 0}`;
  if (!loadedFonts.has(key)) {
    loadedFonts.add(key);
    const family = font.family.replace(/ /g, "+");
    const axis = font.italic
      ? `ital,wght@1,${font.weight}`
      : `wght@${font.weight}`;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${family}:${axis}&display=swap`;
    document.head.appendChild(link);
  }
  const spec = `${font.italic ? "italic " : ""}${font.weight} 32px "${font.family}"`;
  await Promise.race([
    document.fonts.load(spec).catch(() => []),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
}

export async function loadBlockFonts(blocks: MagicTextBlock[]): Promise<void> {
  const wanted = new Map<string, FontChoice>();
  for (const b of blocks) {
    wanted.set(`${b.font.family}:${b.font.weight}:${b.font.italic}`, b.font);
  }
  await Promise.all([...wanted.values()].map(loadFont));
}

// --- flattening ------------------------------------------------------------

const ALIGNMENTS = new Set(["left", "center", "right"]);

/** How many candidate faces the picker offers — beyond this it's noise. */
const CANDIDATE_LIMIT = 8;

export function flattenContainers(response: LayerizeResponse): LayerizeResult | null {
  const pixels = response.base_size ?? [
    response.base_asset.width ?? 0,
    response.base_asset.height ?? 0,
  ];
  if (!pixels[0] || !pixels[1] || !response.base_asset.preview_url) return null;
  const space = response.resolution ?? pixels;

  const blocks: MagicTextBlock[] = [];
  for (const container of response.containers ?? []) {
    for (const item of container.items ?? []) {
      const spans = (item.spans ?? []).filter((s) => (s.text ?? "").length > 0);
      const text = spans.map((s) => s.text).join("");
      if (!text.trim()) continue;
      const font = parseFontRef(item.font_file);
      const seen = new Set([`${font.family}:${font.weight}:${font.italic}`]);
      const candidates: FontChoice[] = [font];
      for (const ref of item.font_candidates ?? []) {
        const parsed = parseFontRef(ref);
        const key = `${parsed.family}:${parsed.weight}:${parsed.italic}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(parsed);
        if (candidates.length >= CANDIDATE_LIMIT) break;
      }
      blocks.push({
        id: `block-${blocks.length}`,
        x: item.x ?? 0,
        y: item.y ?? 0,
        width: item.width ?? space[0] * 0.5,
        height: item.height ?? (item.font_size ?? 24) * 1.4,
        angle: item.angle ?? 0,
        fontSize: item.font_size ?? 24,
        lineHeight: item.line_height ?? 1.2,
        alignment: ALIGNMENTS.has(item.alignment ?? "")
          ? (item.alignment as "left" | "center" | "right")
          : "left",
        font,
        candidates,
        // Multi-span blocks flatten to the first span's paint — a v1 liberty.
        color: spans[0]?.color ?? "#1f211c",
        allCaps: spans.some((s) => (s.font_fx ?? []).includes("all_caps")),
        styleClass: item.style_class ?? "body",
        text,
        aboveSubject: false,
      });
    }
  }
  if (!blocks.length) return null;

  return {
    baseAssetId: response.base_asset.id,
    baseUrl: response.base_asset.preview_url,
    cutout:
      response.cutout_asset?.preview_url != null
        ? {
            assetId: response.cutout_asset.id,
            url: response.cutout_asset.preview_url,
          }
        : null,
    space: { w: space[0], h: space[1] },
    pixels: { w: pixels[0], h: pixels[1] },
    blocks,
  };
}

// --- compositing -----------------------------------------------------------

/** Greedy word-wrap against the block width, mirroring CSS `pre-wrap`. */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const hard of text.split("\n")) {
    const words = hard.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(probe).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = probe;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  block: MagicTextBlock,
  sx: number,
  sy: number,
): void {
  const text = block.allCaps ? block.text.toUpperCase() : block.text;
  if (!text.trim()) return;

  const size = block.fontSize * sx;
  ctx.save();
  // CSS rotates about the block's centre; the canvas mirrors that.
  ctx.translate((block.x + block.width / 2) * sx, (block.y + block.height / 2) * sy);
  ctx.rotate((block.angle * Math.PI) / 180);
  ctx.font = `${block.font.italic ? "italic " : ""}${block.font.weight} ${size}px "${block.font.family}", sans-serif`;
  ctx.fillStyle = block.color;
  ctx.textBaseline = "top";
  ctx.textAlign = block.alignment;

  const boxW = block.width * sx;
  const anchorX =
    block.alignment === "center" ? 0 : block.alignment === "right" ? boxW / 2 : -boxW / 2;
  // CSS line boxes centre glyphs inside line-height; the half-leading
  // offset keeps the first baseline where the editor showed it.
  const lineStep = size * block.lineHeight;
  const halfLeading = (block.lineHeight - 1) * size * 0.5;

  const lines = wrapLines(ctx, text, boxW * 1.02);
  lines.forEach((line, i) => {
    ctx.fillText(line, anchorX, -(block.height * sy) / 2 + halfLeading + i * lineStep);
  });
  ctx.restore();
}

/**
 * The layer sandwich → the final PNG, at the base's native size: base image,
 * then the blocks sitting behind the subject, then the subject cutout, then
 * the blocks pulled in front — matching the stage's paint order exactly.
 *
 * All bytes must arrive as Blobs fetched through the API (B2 sends no CORS
 * headers, so drawing straight from a presigned URL would taint the canvas
 * and kill `toBlob`).
 */
export async function compositeTextEdit(
  baseImage: Blob,
  result: LayerizeResult,
  blocks: MagicTextBlock[],
  cutoutImage?: Blob | null,
): Promise<Blob | null> {
  const bitmap = await createImageBitmap(baseImage);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(bitmap, 0, 0);
  const sx = bitmap.width / result.space.w;
  const sy = bitmap.height / result.space.h;

  for (const block of blocks) {
    if (!block.aboveSubject) drawBlock(ctx, block, sx, sy);
  }
  if (cutoutImage) {
    const cutout = await createImageBitmap(cutoutImage);
    // The cutout came from the base image, so it stretches to cover exactly.
    ctx.drawImage(cutout, 0, 0, canvas.width, canvas.height);
  }
  for (const block of blocks) {
    if (block.aboveSubject) drawBlock(ctx, block, sx, sy);
  }

  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// --- API calls -------------------------------------------------------------

export async function requestLayerize(
  assetId: string,
  auth: ApiAuth,
): Promise<{ ok: true; result: LayerizeResult } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${assetId}/layerize`, {
      method: "POST",
      headers: authHeaders(auth.token, auth.userId),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error:
          (typeof body.detail === "string" && body.detail) ||
          "Layerize did not complete.",
      };
    }
    const result = flattenContainers(body as unknown as LayerizeResponse);
    if (!result) {
      return { ok: false, error: "No editable text was found in this image." };
    }
    return { ok: true, result };
  } catch {
    return { ok: false, error: "The backend is not reachable." };
  }
}

/** The base image's bytes, proxied through the API for CORS-safe drawing. */
export async function fetchAssetBlob(assetId: string, auth: ApiAuth): Promise<Blob | null> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${assetId}/download`, {
      headers: authHeaders(auth.token, auth.userId),
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

export type RegisteredEdit = {
  assetId: string;
  url: string | null;
  width: number | null;
  height: number | null;
  createdAt: string | null;
};

export async function registerTextEdit(
  image: Blob,
  meta: { workflowId: string; nodeId: string; baseAssetId: string },
  auth: ApiAuth,
): Promise<RegisteredEdit | null> {
  try {
    const form = new FormData();
    form.append("file", image, "magic-text-edit.png");
    form.append("workflow_id", meta.workflowId);
    form.append("node_id", meta.nodeId);
    form.append("base_asset_id", meta.baseAssetId);
    const res = await fetch(`${API_URL}/v1/assets/text-edits`, {
      method: "POST",
      headers: authHeaders(auth.token, auth.userId),
      body: form,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      id: string;
      preview_url: string | null;
      width: number | null;
      height: number | null;
      created_at: string | null;
    };
    return {
      assetId: body.id,
      url: body.preview_url,
      width: body.width,
      height: body.height,
      createdAt: body.created_at,
    };
  } catch {
    return null;
  }
}
