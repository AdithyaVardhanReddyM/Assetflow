/**
 * Video captions — style presets, transcript→cue grouping, and API clients.
 *
 * The caption *look* is defined twice by design: `CAPTION_STYLES` here drives
 * the live CSS preview, `CAPTION_STYLES` in `backend/app/services/captions.py`
 * drives the ASS burn. Sizes are fractions of video height and colors are
 * shared hex — change one side and you must change the other, the same
 * contract as `graph.ts` ↔ `schema.py`.
 *
 * Grouping happens HERE, not on the server: lines are measured with the same
 * TTFs the burn uses (loaded via @font-face in globals.css), and travel to the
 * burn endpoint pre-wrapped. What the user previews is exactly what renders.
 */

import { API_URL } from "./catalog";
import { type ApiAuth, authHeaders } from "./assets-client";

// --- transcript -----------------------------------------------------------

export type CaptionWord = { text: string; start: number; end: number };

/** One on-screen caption: its display window and its measured lines. */
export type CaptionCue = { start: number; end: number; lines: CaptionWord[][] };

/**
 * Caption box center + width as fractions of the frame — format-agnostic —
 * plus `scale`, the user's size multiplier on the style's native font size
 * (the corner handle; 1 = as designed).
 */
export type CaptionPlacement = { x: number; y: number; w: number; scale: number };

export const DEFAULT_PLACEMENT: CaptionPlacement = { x: 0.5, y: 0.82, w: 0.8, scale: 1 };

/** The corner handle's range — half size to two-and-a-half times. */
export const MIN_CAPTION_SCALE = 0.5;
export const MAX_CAPTION_SCALE = 2.5;

export type Transcript = {
  hasSpeech: boolean;
  language: string | null;
  durationSec: number;
  words: CaptionWord[];
};

// --- styles ---------------------------------------------------------------

/** The canvas design system's accent + ink, and the cream the serif wears. */
export const CAPTION_ACCENT = "#FACC15";
export const CAPTION_INK = "#1F211C";

export type CaptionHighlight = "none" | "color" | "block";

export type CaptionStyleSpec = {
  id: string;
  label: string;
  /** The one-line "what this looks like", under the label. */
  hint: string;
  /** What the preset card renders before there is a transcript. */
  dummy: string;
  /** CSS family — same TTF libass burns with, registered in globals.css. */
  family: string;
  /** Fontsize as a fraction of video height. Mirrors the backend. */
  sizeFrac: number;
  uppercase: boolean;
  color: string;
  italic?: boolean;
  /** Outline thickness as a fraction of video height (0 = none). */
  strokeFrac?: number;
  shadow?: boolean;
  /** How the currently spoken word is marked. */
  highlight: CaptionHighlight;
  /** BorderStyle-3 pill behind each line (the lower third). */
  boxed?: boolean;
  /** Lines per cue before a new cue starts. */
  maxLines: number;
};

export const CAPTION_STYLES: CaptionStyleSpec[] = [
  {
    id: "bold-social",
    label: "Bold Social",
    hint: "All-caps, the spoken word on a yellow block",
    dummy: "EVERY WORD",
    family: '"Archivo Black"',
    sizeFrac: 0.062,
    uppercase: true,
    color: "#FFFFFF",
    strokeFrac: 0.006,
    highlight: "block",
    maxLines: 1,
  },
  {
    id: "karaoke",
    label: "Karaoke",
    hint: "The spoken word turns yellow as it lands",
    dummy: "AS IT LANDS",
    family: '"Poppins SemiBold"',
    sizeFrac: 0.052,
    uppercase: true,
    color: "#FFFFFF",
    strokeFrac: 0.005,
    highlight: "color",
    maxLines: 2,
  },
  {
    id: "outline",
    label: "Outline",
    hint: "Thick stroke, reads over any footage",
    dummy: "LOUD & CLEAR",
    family: '"Archivo Black"',
    sizeFrac: 0.062,
    uppercase: true,
    color: "#FFFFFF",
    strokeFrac: 0.011,
    highlight: "none",
    maxLines: 1,
  },
  {
    id: "classic",
    label: "Classic",
    hint: "Quiet white with a soft shadow",
    dummy: "A calm, clear line",
    family: '"Poppins SemiBold"',
    sizeFrac: 0.046,
    uppercase: false,
    color: "#FFFFFF",
    strokeFrac: 0.0025,
    shadow: true,
    highlight: "none",
    maxLines: 2,
  },
  {
    id: "lower-third",
    label: "Lower Third",
    hint: "Small text on a dark pill",
    dummy: "Out of the way",
    family: '"Poppins SemiBold"',
    sizeFrac: 0.038,
    uppercase: false,
    color: "#FFFFFF",
    highlight: "none",
    boxed: true,
    maxLines: 2,
  },
  {
    id: "editorial-serif",
    label: "Editorial",
    hint: "Instrument Serif italic — the human voice",
    dummy: "like a quote",
    family: '"Instrument Serif Caption"',
    sizeFrac: 0.06,
    uppercase: false,
    color: "#F7F4EE",
    italic: true,
    shadow: true,
    highlight: "none",
    maxLines: 2,
  },
];

export function captionStyle(id: string): CaptionStyleSpec {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0];
}

// --- grouping -------------------------------------------------------------

/** A silence this long ends the cue — the caption should not linger over it. */
const CUE_GAP_SEC = 1.0;
/** A cue on screen shorter than this flashes; extend it when there is room. */
const MIN_CUE_SEC = 0.9;

let measureCtx: CanvasRenderingContext2D | null = null;

/** Pixel width of `text` in the style's real font at `fontPx`. Client-only. */
function measure(text: string, style: CaptionStyleSpec, fontPx: number): number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * fontPx * 0.6; // canvas denied; rough
  measureCtx.font = `${style.italic ? "italic " : ""}${fontPx}px ${style.family}`;
  return measureCtx.measureText(text).width;
}

/**
 * Words → cues of measured lines that fit the caption box.
 *
 * The box is `placement.w` of the video's width; the font is the style's
 * fraction of its height — so regrouping happens whenever the user picks a
 * new style or resizes the box, and the burn always receives lines that were
 * actually previewed. Cues also break on sentence punctuation and on real
 * silences, so captions read as phrases rather than a word conveyor.
 */
export function buildCues(
  words: CaptionWord[],
  style: CaptionStyleSpec,
  placement: CaptionPlacement,
  videoW: number,
  videoH: number,
): CaptionCue[] {
  const fontPx = style.sizeFrac * placement.scale * videoH;
  // Slight inset so a line at exactly box width doesn't shave its edges.
  const maxLinePx = Math.max(60, placement.w * videoW * 0.94);
  const spacePx = measure(" ", style, fontPx);

  const cues: CaptionCue[] = [];
  let lines: CaptionWord[][] = [];
  let line: CaptionWord[] = [];
  let linePx = 0;

  const closeCue = () => {
    if (line.length) lines.push(line);
    line = [];
    linePx = 0;
    if (!lines.length) return;
    const flat = lines.flat();
    cues.push({
      start: flat[0].start,
      end: flat[flat.length - 1].end,
      lines,
    });
    lines = [];
  };

  for (const word of words) {
    const text = style.uppercase ? word.text.toUpperCase() : word.text;
    const wordPx = measure(text, style, fontPx);
    const prev = line[line.length - 1] ?? lines[lines.length - 1]?.at(-1);

    // A real pause ends the phrase, whatever the line had room for.
    if (prev && word.start - prev.end > CUE_GAP_SEC) closeCue();

    if (line.length && linePx + spacePx + wordPx > maxLinePx) {
      lines.push(line);
      line = [];
      linePx = 0;
      if (lines.length >= style.maxLines) closeCue();
    }
    line.push(word);
    linePx += (line.length > 1 ? spacePx : 0) + wordPx;

    if (/[.!?]$/.test(word.text.trim())) closeCue();
  }
  closeCue();

  // Let a blink-short cue linger to readability, up to the next cue's start.
  for (let i = 0; i < cues.length; i++) {
    const limit = cues[i + 1]?.start ?? Infinity;
    cues[i].end = Math.min(Math.max(cues[i].end, cues[i].start + MIN_CUE_SEC), limit);
  }
  return cues;
}

/** The cue on screen at `t`, if any. */
export function cueAt(cues: CaptionCue[], t: number): CaptionCue | null {
  return cues.find((c) => t >= c.start && t < c.end) ?? null;
}

/**
 * The word being spoken at `t` — the last word whose window has opened, so
 * highlight styles hold the word through the silence after it rather than
 * flickering back to plain.
 */
export function activeWordAt(cue: CaptionCue, t: number): CaptionWord | null {
  let active: CaptionWord | null = null;
  for (const word of cue.lines.flat()) {
    if (word.start <= t) active = word;
  }
  return active;
}

// --- API clients ----------------------------------------------------------

export async function transcribeAsset(
  assetId: string,
  auth: ApiAuth,
): Promise<{ ok: true; transcript: Transcript } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${assetId}/captions/transcribe`, {
      method: "POST",
      headers: authHeaders(auth.token, auth.userId),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error:
          (typeof body.detail === "string" && body.detail) ||
          "Transcription did not complete.",
      };
    }
    const words = Array.isArray(body.words)
      ? (body.words as CaptionWord[]).filter((w) => w && typeof w.text === "string")
      : [];
    return {
      ok: true,
      transcript: {
        hasSpeech: Boolean(body.has_speech) && words.length > 0,
        language: typeof body.language === "string" ? body.language : null,
        durationSec: typeof body.duration_sec === "number" ? body.duration_sec : 0,
        words,
      },
    };
  } catch {
    return { ok: false, error: "The backend is not reachable." };
  }
}

export type BurnedCaptions = {
  assetId: string;
  url: string | null;
  width: number | null;
  height: number | null;
  createdAt: string | null;
};

export async function burnCaptions(
  assetId: string,
  meta: {
    workflowId: string;
    nodeId: string;
    style: string;
    placement: CaptionPlacement;
    cues: CaptionCue[];
  },
  auth: ApiAuth,
): Promise<{ ok: true; burned: BurnedCaptions } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/assets/${assetId}/captions`, {
      method: "POST",
      headers: {
        ...authHeaders(auth.token, auth.userId),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow_id: meta.workflowId,
        node_id: meta.nodeId,
        style: meta.style,
        placement: meta.placement,
        cues: meta.cues,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error:
          (typeof body.detail === "string" && body.detail) ||
          "The caption render failed.",
      };
    }
    return {
      ok: true,
      burned: {
        assetId: String(body.id),
        url:
          (typeof body.preview_url === "string" && body.preview_url) ||
          (typeof body.url === "string" && body.url) ||
          null,
        width: typeof body.width === "number" ? body.width : null,
        height: typeof body.height === "number" ? body.height : null,
        createdAt: typeof body.created_at === "string" ? body.created_at : null,
      },
    };
  } catch {
    return { ok: false, error: "The backend is not reachable." };
  }
}
