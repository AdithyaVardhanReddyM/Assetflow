"use client";

/**
 * Full-size preview for a node's media: the corner expand button on the well
 * and the modal it opens — generation details on the left, the take itself on
 * the right.
 *
 * View state only. The modal shows whatever the node already knows (its wire
 * data, the displayed take, the upstream previews); nothing here is fetched
 * or persisted.
 */

import * as React from "react";
import {
  ArrowsOutSimpleIcon,
  DownloadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

/** What the modal blows up on its right half. */
export type ExpandMedia = { url: string; isVideo: boolean };

/** A thumbnail of something wired into the node — shown under the prompt. */
export type ExpandInput = { url: string; isVideo: boolean };

/** "4 months ago" for an ISO timestamp; null when absent or unparsable. */
export function timeAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const steps: [number, string][] = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, label] of steps) {
    if (sec >= size) {
      const n = Math.floor(sec / size);
      return `${n} ${label}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "Just now";
}

/**
 * The corner affordance over a preview well. Hidden until the well is hovered
 * — callers put `group` on the well container, same pattern as the upload
 * node's "Run from here" overlay.
 */
export function ExpandButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Expand"
      onClick={onClick}
      className={cn(
        "nodrag absolute top-2 left-2 z-10 grid size-7 place-items-center border border-[#1f211c]/10 bg-white/92 text-[#4c4a41] opacity-0 shadow-[0_8px_20px_-8px_rgba(31,33,28,0.4)] backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 hover:text-[#1f211c] focus-visible:opacity-100",
        className,
      )}
    >
      <ArrowsOutSimpleIcon className="size-4" />
    </button>
  );
}

/** One fact about the generation, worn as a small square chip. */
export function DetailChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-7 items-center gap-1.5 border border-[#1f211c]/10 bg-[#f7f4ee]/70 px-2 text-[11px] font-medium text-[#4c4a41]">
      {children}
    </span>
  );
}

/**
 * The left panel's standard anatomy: when + download on top, then the prompt,
 * the wired-in inputs, the fact chips, and dimensions pinned to the bottom.
 * Every slot is optional — an upload has no prompt, a composition no inputs.
 */
export function ExpandDetails({
  heading,
  onDownload,
  prompt,
  inputs,
  chips,
  footer,
}: {
  /** Top-left line — the take's age, or a filename for an upload. */
  heading: string;
  onDownload?: () => void;
  prompt?: string | null;
  inputs?: ExpandInput[];
  chips?: React.ReactNode;
  /** Bottom line: dimensions and the like. */
  footer?: string | null;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-[#8a8271]">{heading}</span>
        {onDownload ? (
          <button
            type="button"
            aria-label="Download"
            onClick={onDownload}
            className="grid size-7 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
          >
            <DownloadSimpleIcon className="size-4" />
          </button>
        ) : null}
      </div>

      {prompt ? (
        <div className="mt-4">
          <p className="text-[11px] font-medium text-[#a09a88]">Prompt</p>
          <p className="thin-scrollbar mt-1.5 max-h-48 overflow-y-auto text-[13px] leading-5 whitespace-pre-wrap text-[#1f211c]">
            {prompt}
          </p>
        </div>
      ) : null}

      {inputs?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {inputs.map((input, i) => (
            <span
              key={`${input.url}-${i}`}
              className="size-12 shrink-0 overflow-hidden border border-[#1f211c]/10 bg-[#faf8f4]"
            >
              {input.isVideo ? (
                <video
                  src={input.url}
                  muted
                  playsInline
                  preload="metadata"
                  className="pointer-events-none h-full w-full object-cover"
                />
              ) : (
                // Presigned B2 URLs on a private bucket — see the note in
                // upload-node on why the Next image optimizer is out.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={input.url} alt="" className="h-full w-full object-cover" />
              )}
            </span>
          ))}
        </div>
      ) : null}

      {chips ? <div className="mt-4 flex flex-wrap gap-1.5">{chips}</div> : null}

      {footer ? <p className="mt-auto pt-4 text-[11px] text-[#a09a88]">{footer}</p> : null}
    </div>
  );
}

export function NodeExpandModal({
  open,
  onOpenChange,
  media,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  media: ExpandMedia;
  /** The left panel — usually an `ExpandDetails`. */
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(840px,calc(100vh-3rem))] w-[min(1320px,calc(100vw-3rem))] max-w-none flex-row gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Media preview</DialogTitle>

        <aside className="thin-scrollbar w-72 shrink-0 overflow-y-auto bg-white p-5">
          {children}
        </aside>

        <div className="relative flex min-w-0 flex-1 items-center justify-center bg-[#15160f]">
          {media.isVideo ? (
            <video
              key={media.url}
              src={media.url}
              controls
              playsInline
              className="max-h-full max-w-full"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={media.url}
              src={media.url}
              alt="Full-size preview"
              className="max-h-full max-w-full object-contain"
            />
          )}
          <DialogClose
            render={
              <button
                type="button"
                aria-label="Close"
                className="absolute top-4 right-4 grid size-9 place-items-center bg-white text-[#1f211c] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)] transition-all duration-150 hover:scale-105"
              />
            }
          >
            <XIcon className="size-4" weight="bold" />
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
