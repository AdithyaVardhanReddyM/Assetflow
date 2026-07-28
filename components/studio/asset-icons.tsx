"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The brand tool icons in /public are flat black — no `currentColor` — so
 * rendering them as <img> would pin them black wherever they land, and the
 * prompt bar's active modality tab is cream-on-ink, where that reads as nothing
 * at all. Painting `currentColor` through the file as a mask instead lets them
 * inherit colour exactly like the Phosphor icons they sit beside.
 *
 * `weight` is accepted and ignored so these drop into the same slots as a
 * Phosphor `Icon`, which is handed one for its active/inactive fill.
 */
function assetIcon(src: string, name: string) {
  function AssetIcon({ className }: { className?: string; weight?: unknown }) {
    return (
      <span
        aria-hidden
        className={cn("inline-block shrink-0 bg-current", className)}
        style={{
          maskImage: `url("${src}")`,
          WebkitMaskImage: `url("${src}")`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskPosition: "center",
          WebkitMaskPosition: "center",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
        }}
      />
    );
  }
  AssetIcon.displayName = name;
  return AssetIcon;
}

export const ImageGenIcon = assetIcon("/image_gen.svg", "ImageGenIcon");
export const VideoGenIcon = assetIcon("/video_gen.svg", "VideoGenIcon");
export const TextToSpeechIcon = assetIcon(
  "/text_to_speech.svg",
  "TextToSpeechIcon",
);
export const MusicGenIcon = assetIcon("/music_gen.svg", "MusicGenIcon");
export const LlmIcon = assetIcon("/llm.svg", "LlmIcon");
export const CompositionIcon = assetIcon("/composition.svg", "CompositionIcon");
export const AgentIcon = assetIcon("/agent.svg", "AgentIcon");
