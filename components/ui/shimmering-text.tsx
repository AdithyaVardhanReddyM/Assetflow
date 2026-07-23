"use client";

/**
 * Text with a light band sweeping through it — the studio's "working" voice.
 * Pure CSS (`.shimmer-text` in globals.css); no animation library involved.
 */

import { cn } from "@/lib/utils";

export function ShimmeringText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span className={cn("shimmer-text", className)} aria-live="polite">
      {text}
    </span>
  );
}
