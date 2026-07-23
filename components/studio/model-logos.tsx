"use client";

/**
 * Brand marks for the model pickers — bare glyphs, no tile behind them.
 *
 * Marks come from `@lobehub/icons` (the AI-brand set: OpenAI, Runway, Gemini,
 * ByteDance, Flux, Kling, Luma, ElevenLabs, …). Decart is the one brand no
 * icon set carries, so its mark is the lead glyph of the wordmark on
 * decart.ai, inlined as a path. Anything still unmatched falls back to a
 * plain monogram letter.
 *
 * Everything renders in the design language's ink rather than brand hexes:
 * a picker full of competing brand colours would fight the cream canvas.
 */

import * as React from "react";
import {
  ByteDance,
  ElevenLabs,
  Flux,
  Gemini,
  Kling,
  Luma,
  OpenAI,
  Runway,
} from "@lobehub/icons";

import { cn } from "@/lib/utils";

// The "D" of the DECART wordmark, lifted from decart.ai's own SVG. evenodd
// keeps the counter punched out — the source painted it through a mask.
const DECART_D = (
  <svg viewBox="0 0 54 76" aria-hidden className="h-[85%]">
    <path
      fillRule="evenodd"
      fill="currentColor"
      d="M39.3135 0C40.9662 0.000206135 42.1191 1.32731 41.8891 2.96403L41.6804 4.44899C41.2203 7.72268 43.5273 10.3765 46.8331 10.3765H50.4313C52.0842 10.3765 53.2379 11.7037 53.0079 13.3406L46.4188 60.2245C46.1885 61.8612 44.662 63.1876 43.0092 63.1876H39.0634C35.7575 63.1876 32.7046 65.8415 32.2445 69.1152L31.8244 72.1039C31.5944 73.7406 30.0685 75.0678 28.4157 75.0679H12.6149C10.962 75.0679 9.80827 73.7407 10.0383 72.1039L10.4584 69.1152C10.9184 65.8415 8.61148 63.1876 5.30561 63.1876H2.60587C0.953098 63.1876 -0.200613 61.8612 0.0291398 60.2245L6.61825 13.3406C6.8483 11.7037 8.37505 10.3765 10.028 10.3765H13.0754C16.3813 10.3765 19.4342 7.72268 19.8943 4.44899L20.1029 2.96403C20.333 1.32719 21.8597 0 23.5127 0H39.3135ZM16.9835 53.9479C16.5234 57.2216 18.8304 59.8754 22.1363 59.8754H24.4098C27.7156 59.8754 30.7686 57.2216 31.2286 53.9479L35.8423 21.12C36.3024 17.8463 33.9954 15.1925 30.6896 15.1925H28.4161C25.1102 15.1925 22.0573 17.8463 21.5972 21.12L16.9835 53.9479Z"
    />
  </svg>
);

type BrandIcon = React.ComponentType<{ size?: number | string; className?: string }>;

type Rule = {
  match: (provider: string, modelId: string) => boolean;
  icon?: BrandIcon;
  node?: React.ReactNode;
};

// First match wins — model-specific rules before provider-wide ones, so a
// Seedream slug served through any provider still reads as Seedream.
const BRAND_RULES: Rule[] = [
  { match: (_p, id) => id.startsWith("seedream"), icon: ByteDance },
  // Seedance is ByteDance's video line — same house mark as Seedream.
  { match: (_p, id) => id.startsWith("seedance"), icon: ByteDance },
  // Before the runway-provider rule: gemini_omni_flash is *hosted* by Runway
  // but it is Gemini's model, and the mark should say whose it is.
  { match: (_p, id) => id.startsWith("gemini"), icon: Gemini },
  { match: (_p, id) => id.includes("flux"), icon: Flux },
  // Nano Banana is a Gemini-family model — the Gemini spark is its public mark.
  { match: (_p, id) => id.startsWith("google/"), icon: Gemini },
  { match: (_p, id) => id.startsWith("openai/"), icon: OpenAI },
  { match: (_p, id) => id.toLowerCase().startsWith("kling"), icon: Kling },
  { match: (p) => p === "runway", icon: Runway },
  { match: (p) => p === "decart", node: DECART_D },
  { match: (p) => p === "luma", icon: Luma },
  { match: (p) => p === "elevenlabs", icon: ElevenLabs },
];

const SIZES = {
  sm: { box: "size-4.5", icon: 15, text: "text-[10px]" },
  md: { box: "size-5.5", icon: 19, text: "text-[12px]" },
} as const;

export function ModelLogo({
  provider,
  modelId,
  label,
  size = "md",
  className,
}: {
  provider: string;
  modelId: string;
  /** Monogram source when no brand mark applies. */
  label: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const rule = BRAND_RULES.find((r) => r.match(provider, modelId));
  const s = SIZES[size];
  return (
    // An invisible fixed box, so rows of mixed marks and monograms still
    // align — the *tile* is gone, not the geometry.
    <span
      className={cn(
        "grid shrink-0 place-items-center text-[#1f211c]",
        s.box,
        className,
      )}
    >
      {rule?.icon ? (
        <rule.icon size={s.icon} />
      ) : (
        rule?.node ?? (
          <span className={cn("font-bold", s.text)}>{label.charAt(0)}</span>
        )
      )}
    </span>
  );
}
