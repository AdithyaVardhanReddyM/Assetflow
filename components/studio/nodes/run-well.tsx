"use client";

/**
 * What a node's preview well shows once a run has touched it.
 *
 * Rendered by the generate and composition nodes in place of their empty-state
 * placeholder. Returns null when the node has no run state, so callers keep
 * their own placeholder markup for the untouched case.
 *
 * Every busy state — queued, running, waiting on the result — is one voice: a
 * shimmering "Generating" (the surrounding card carries a border beam, wired
 * in the node components via `isRunBusy`). No spinners, no percentages.
 */

import * as React from "react";
import { WarningIcon } from "@phosphor-icons/react";
import { BorderBeam } from "border-beam";

import { ShimmeringText } from "@/components/ui/shimmering-text";
import type { NodeRunState } from "@/lib/studio/graph";

/**
 * The prompt bar's border beam, wrapped around a node's preview card while it
 * generates. Same preset and the same `.beam-colour-only` palette override —
 * the two surfaces must read as one system, not two shimmers.
 */
export function RunBeam({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <BorderBeam
      size="md"
      colorVariant="sunset"
      theme="light"
      borderRadius={0}
      brightness={1.05}
      saturation={1.15}
      hueRange={10}
      duration={4}
      className="beam-colour-only"
      style={
        {
          "--beam-stroke-opacity": 8.4,
          "--beam-inner-opacity": 3.4,
          "--beam-bloom-opacity": 0,
        } as React.CSSProperties
      }
    >
      {children}
    </BorderBeam>
  );
}

/** True while the node should wear the border beam and shimmer. */
export function isRunBusy(run: NodeRunState | undefined): boolean {
  if (!run) return false;
  if (run.status === "pending" || run.status === "running") return true;
  // Succeeded but the displayable result hasn't landed yet.
  return run.status === "succeeded" && !run.output?.url && !run.output?.text;
}

export function RunWell({
  run,
  modality,
}: {
  run: NodeRunState | undefined;
  modality: string;
}): React.ReactElement | null {
  if (!run) return null;

  if (isRunBusy(run)) {
    return (
      <ShimmeringText
        text="Generating"
        className="text-[13px] font-medium tracking-[0.02em]"
      />
    );
  }

  if (run.status === "failed") {
    return (
      <div className="flex flex-col items-center gap-2 px-4 text-center">
        <WarningIcon weight="fill" className="size-5 text-[#a9743f]" />
        <p className="max-h-20 overflow-y-auto text-[11.5px] break-words text-[#a9743f]">
          {run.error ?? "Generation failed"}
        </p>
      </div>
    );
  }

  if (run.status === "skipped") {
    return (
      <p className="px-4 text-center text-[11.5px] text-[#a09a88]">
        Skipped — an upstream node failed
      </p>
    );
  }

  // Succeeded. An LLM's words render directly; media renders by its type.
  const output = run.output;
  if (output?.text || modality === "text") {
    return (
      <div className="nodrag nowheel thin-scrollbar h-full w-full overflow-y-auto p-3">
        <p className="text-[12.5px] leading-5 whitespace-pre-wrap text-[#1f211c]">
          {output?.text ?? "The model returned no text."}
        </p>
      </div>
    );
  }
  if (output?.url) {
    if (modality === "video" || output.mediaType?.startsWith("video/")) {
      return (
        <video
          key={output.url}
          src={output.url}
          controls
          playsInline
          preload="metadata"
          className="nodrag block h-full w-full object-contain"
        />
      );
    }
    if (modality === "audio" || output.mediaType?.startsWith("audio/")) {
      return (
        <div className="nodrag flex w-full items-center px-4">
          <audio key={output.url} src={output.url} controls className="w-full" />
        </div>
      );
    }
    return (
      // Presigned B2 URLs on a private bucket — see the note in upload-node
      // on why the Next image optimizer is not usable here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={output.url}
        src={output.url}
        alt="Generated result"
        className="block h-full w-full object-cover"
      />
    );
  }
  return null;
}
