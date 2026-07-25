/**
 * Relight — the light-source pose and the directive it becomes.
 *
 * The relight model (Qwen-Image-Edit + the dx8152 relight LoRA) exposes no
 * lighting parameters: direction, color and intensity travel as words. This
 * module owns the translation — the sphere widget edits a `LightPose`, and
 * `lightDirective` renders it as the bilingual instruction the LoRA was
 * trained on (`重新照明` + description), so what the panel previews is exactly
 * what the model is asked.
 */

import type { TakeEditSpec } from "./camera-edit";

/** The provider/model pair behind the Light tab — hidden from every picker. */
export const RELIGHT_PROVIDER = "replicate";
export const RELIGHT_MODEL = "qwen-edit-apps/qwen-image-edit-plus-lora-relight";

export type LightPose = {
  /** Degrees left(-)/right(+) of centre, front hemisphere. */
  azimuth: number;
  /** Degrees below(-)/above(+) the subject. */
  elevation: number;
  /** Backlight: the source sits behind the subject (the Back preset). */
  behind: boolean;
  /** Hex color of the light. */
  color: string;
  /** 0..100 — rendered as soft/balanced/strong/dramatic wording. */
  intensity: number;
};

export const NEUTRAL_LIGHT: LightPose = {
  azimuth: -35,
  elevation: 30,
  behind: false,
  color: "#FFFFFF",
  intensity: 70,
};

/** The six preset chips, in the reference layout's order. */
export const LIGHT_PRESETS: { id: string; label: string; pose: Partial<LightPose> }[] = [
  { id: "top", label: "Top", pose: { azimuth: 0, elevation: 62, behind: false } },
  { id: "front", label: "Front", pose: { azimuth: 0, elevation: 6, behind: false } },
  { id: "back", label: "Back", pose: { azimuth: 0, elevation: 20, behind: true } },
  { id: "bottom", label: "Bottom", pose: { azimuth: 0, elevation: -62, behind: false } },
  { id: "left", label: "Left", pose: { azimuth: -68, elevation: 12, behind: false } },
  { id: "right", label: "Right", pose: { azimuth: 68, elevation: 12, behind: false } },
];

/** The curated swatch row; any hex works via the custom picker. */
export const LIGHT_COLORS = [
  "#FFFFFF",
  "#FFD9A0",
  "#FFB347",
  "#FF5A3C",
  "#E24FB2",
  "#4F7DE2",
  "#5AD8D8",
  "#58C065",
];

// --- color naming -----------------------------------------------------------

/** Anchor colors with bilingual names; the nearest one names the hex. */
const COLOR_NAMES: { rgb: [number, number, number]; en: string; zh: string }[] = [
  { rgb: [255, 255, 255], en: "neutral white", zh: "中性白色" },
  { rgb: [255, 217, 160], en: "warm golden", zh: "暖金色" },
  { rgb: [255, 179, 71], en: "amber", zh: "琥珀色" },
  { rgb: [255, 140, 60], en: "orange", zh: "橙色" },
  { rgb: [255, 90, 60], en: "warm red", zh: "暖红色" },
  { rgb: [220, 40, 40], en: "red", zh: "红色" },
  { rgb: [226, 79, 178], en: "pink-magenta", zh: "品红色" },
  { rgb: [150, 80, 220], en: "purple", zh: "紫色" },
  { rgb: [79, 125, 226], en: "blue", zh: "蓝色" },
  { rgb: [90, 216, 216], en: "cyan", zh: "青色" },
  { rgb: [88, 192, 101], en: "green", zh: "绿色" },
  { rgb: [230, 220, 100], en: "yellow", zh: "黄色" },
];

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function colorName(hex: string): { en: string; zh: string } {
  const rgb = hexToRgb(hex);
  if (!rgb) return COLOR_NAMES[0];
  let best = COLOR_NAMES[0];
  let bestDist = Infinity;
  for (const candidate of COLOR_NAMES) {
    const dist =
      (rgb[0] - candidate.rgb[0]) ** 2 +
      (rgb[1] - candidate.rgb[1]) ** 2 +
      (rgb[2] - candidate.rgb[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

// --- direction naming -------------------------------------------------------

/**
 * The pose's direction as words. Deliberately coarse — nine named positions
 * plus backlight — because the LoRA is steered by language: the sphere feels
 * continuous, but what's *asked* is the nearest named direction, and the
 * directive line shows it, so the panel never promises more precision than
 * the model can honor.
 */
export function directionName(pose: LightPose): { en: string; zh: string } {
  if (pose.behind) {
    return { en: "from behind the subject, as a backlight", zh: "从主体后方(逆光)" };
  }
  if (pose.elevation >= 45) {
    if (pose.azimuth <= -30) return { en: "from high on the left", zh: "从左上高处" };
    if (pose.azimuth >= 30) return { en: "from high on the right", zh: "从右上高处" };
    return { en: "from directly above", zh: "从正上方(顶光)" };
  }
  if (pose.elevation <= -45) {
    return { en: "from below", zh: "从下方(底光)" };
  }
  const vertical = pose.elevation >= 20 ? "upper " : pose.elevation <= -20 ? "lower " : "";
  const verticalZh = pose.elevation >= 20 ? "上" : pose.elevation <= -20 ? "下" : "";
  if (pose.azimuth <= -25) return { en: `from the ${vertical}left`, zh: `从左${verticalZh}方` };
  if (pose.azimuth >= 25) return { en: `from the ${vertical}right`, zh: `从右${verticalZh}方` };
  if (vertical) {
    return pose.elevation > 0
      ? { en: "from the front, slightly above", zh: "从正面偏上" }
      : { en: "from the front, slightly below", zh: "从正面偏下" };
  }
  return { en: "from the front", zh: "从正面" };
}

function intensityWords(intensity: number): { en: string; zh: string } {
  if (intensity < 25) return { en: "soft, subtle", zh: "柔和微弱的" };
  if (intensity < 55) return { en: "balanced, natural", zh: "自然适中的" };
  if (intensity < 80) return { en: "strong", zh: "强烈的" };
  return { en: "intense, dramatic", zh: "极强的戏剧性" };
}

// --- the directive ----------------------------------------------------------

/** The short English half — what the panel shows as a live preview. */
export function directiveSummary(pose: LightPose): string {
  const direction = directionName(pose).en;
  const color = colorName(pose.color);
  const intensity = intensityWords(pose.intensity).en;
  const colorPart = color.en === "neutral white" ? "" : ` ${color.en}`;
  return `${intensity}${colorPart} light ${direction}`;
}

/**
 * The full bilingual instruction sent as the run's prompt. Chinese first —
 * the LoRA's trigger phrase and training language — then the English
 * restatement, then a guard that only the lighting should move.
 */
export function lightDirective(pose: LightPose): string {
  const direction = directionName(pose);
  const color = colorName(pose.color);
  const intensity = intensityWords(pose.intensity);
  const colorZh = color.zh === "中性白色" ? "" : color.zh;
  const colorEn = color.en === "neutral white" ? "" : ` ${color.en} (${pose.color})`;
  return (
    `重新照明: 使用${direction.zh}的${intensity.zh}${colorZh}光对图片进行重新照明, ` +
    `保持画面内容和构图不变。` +
    `Relight the image with ${intensity.en}${colorEn} light ${direction.en}. ` +
    `Keep the subject, content and composition unchanged.`
  );
}

/** The whole pose as one run spec — what the Light tab hands `editTake`. */
export function relightSpec(pose: LightPose): TakeEditSpec {
  return {
    provider: RELIGHT_PROVIDER,
    model: RELIGHT_MODEL,
    prompt: lightDirective(pose),
    params: {},
  };
}
