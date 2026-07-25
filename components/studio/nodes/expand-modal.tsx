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
  CaretDownIcon,
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

/**
 * The identity strip at the top of an aside that carries sections below it:
 * what this is, when it was made, and the one action that always applies.
 * Scrolls away under the sticky section headers.
 */
export function ExpandHeader({
  title,
  meta,
  onDownload,
}: {
  /** What kind of thing this is — "Image", "Video". */
  title: string;
  /** The quiet second line: age, dimensions. */
  meta?: string | null;
  onDownload?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-2 px-5 pt-5 pb-4">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-[#1f211c]">{title}</p>
        {meta ? (
          <p className="mt-0.5 truncate text-[11px] text-[#a09a88]">{meta}</p>
        ) : null}
      </div>
      {onDownload ? (
        <button
          type="button"
          aria-label="Download"
          onClick={onDownload}
          className="grid size-7 shrink-0 place-items-center border border-[#1f211c]/10 text-[#4c4a41] transition-colors duration-150 hover:border-[#1f211c]/30 hover:bg-[#1f211c]/5 hover:text-[#1f211c]"
        >
          <DownloadSimpleIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * One collapsible section of an aside — the fact sheet, or one of the edit
 * tools. The caller owns which is open, so the modal can key other things off
 * it (the Text section hands the media pane to its own editor).
 *
 * The header sticks to the top of the scrolling aside, so a tall panel keeps
 * its label in view. Closed panels stay mounted — their tool keeps whatever
 * pose or selection it had — but go `inert`, so nothing hidden takes focus.
 */
export function ExpandSection({
  icon,
  label,
  hint,
  open,
  onToggle,
  dot,
  first,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  /** The one-line "what this does", under the label. */
  hint?: string | null;
  open: boolean;
  onToggle: () => void;
  /** A small accent mark — this tool is holding unsaved work. */
  dot?: boolean;
  /** Draws the top rule, for the section that opens a group. */
  first?: boolean;
  children: React.ReactNode;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const wasOpen = React.useRef(open);

  // A tool opened low in the column would otherwise unfold below the fold.
  React.useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    // Once the row has finished growing, so the browser knows how much panel
    // there is to bring into view.
    const timer = window.setTimeout(() => {
      root.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 210);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      ref={root}
      className={cn("border-b border-[#1f211c]/10", first && "border-t")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          // `sticky` is itself a containing block, so the edge rule below
          // positions against it without a second `relative`.
          "group sticky top-0 z-10 flex w-full items-center gap-2.5 px-5 py-3 text-left transition-colors duration-150",
          "focus-visible:inset-ring-1 focus-visible:inset-ring-[#1f211c]/35 focus-visible:outline-none",
          open ? "bg-[#faf8f4]" : "bg-white hover:bg-[#faf8f4]",
        )}
      >
        {/* The open marker: a rule down the column's edge. */}
        <span
          className={cn(
            "absolute inset-y-0 left-0 w-[2px] transition-colors duration-150",
            open ? "bg-[#1f211c]" : "bg-transparent",
          )}
        />
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center border transition-colors duration-150",
            open
              ? "border-[#1f211c] bg-[#1f211c] text-[#f7f4ee]"
              : "border-[#1f211c]/12 text-[#8a8271] group-hover:border-[#1f211c]/30 group-hover:text-[#4c4a41]",
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-[#1f211c]">
            {label}
          </span>
          {hint ? (
            <span className="mt-px block truncate text-[10.5px] text-[#a09a88]">
              {hint}
            </span>
          ) : null}
        </span>
        {dot ? <span className="size-1.5 shrink-0 bg-primary" /> : null}
        <CaretDownIcon
          className={cn(
            "size-3.5 shrink-0 text-[#a09a88] transition-transform duration-200 ease-out",
            open && "rotate-180 text-[#4c4a41]",
          )}
        />
      </button>

      {/* 0fr → 1fr, so the panel opens to whatever height it needs and keeps
          following its content while it stays open. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="px-5 pt-2 pb-5" inert={!open}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A quiet rule-and-label between groups of sections. */
export function ExpandSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 pt-5 pb-2 text-[10px] font-semibold tracking-[0.08em] text-[#a09a88] uppercase">
      {children}
    </p>
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
  padded = true,
}: {
  /**
   * Top-left line — the take's age, or a filename for an upload. Omitted when
   * the panel sits inside an `ExpandSection`, whose own header says as much.
   */
  heading?: string;
  onDownload?: () => void;
  prompt?: string | null;
  inputs?: ExpandInput[];
  chips?: React.ReactNode;
  /** Bottom line: dimensions and the like. */
  footer?: string | null;
  /** Off when a section supplies the column's padding instead. */
  padded?: boolean;
}) {
  const head = heading || onDownload;
  return (
    // Padded, this is the aside's only child and fills the column, so a
    // `footer` can sit on the floor of it. Inside a section it is content-sized
    // like any other panel.
    <div className={cn("flex flex-col", padded && "min-h-full flex-1 p-5")}>
      {head ? (
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
      ) : null}

      {prompt ? (
        <div className={cn(head && "mt-4")}>
          <p className="text-[10px] font-semibold tracking-[0.06em] text-[#a09a88] uppercase">
            Prompt
          </p>
          <p className="thin-scrollbar mt-1.5 max-h-48 overflow-y-auto border-l-2 border-[#1f211c]/12 bg-[#faf8f4]/70 py-2 pr-2 pl-2.5 text-[12.5px] leading-5 whitespace-pre-wrap text-[#1f211c]">
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
  stage,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  media: ExpandMedia;
  /**
   * Replaces the default full-size media view — the Magic Text editor takes
   * over the pane with its own interactive surface. The close button stays.
   */
  stage?: React.ReactNode;
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

        {/* The column scrolls as one, so section headers can stick to its top.
            Padding belongs to whatever is inside — sections run full-bleed.
            Left a block, not a flex column: a flex child would shrink to the
            column and hide its overflow from the scrollbar. */}
        <aside className="thin-scrollbar w-72 shrink-0 overflow-y-auto bg-white">
          {children}
        </aside>

        <div className="relative flex min-w-0 flex-1 items-center justify-center bg-[#15160f]">
          {stage ? (
            stage
          ) : media.isVideo ? (
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
