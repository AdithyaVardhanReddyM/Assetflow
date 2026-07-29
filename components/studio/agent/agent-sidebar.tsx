"use client";

/**
 * The agent's chassis — the library sidebar mirrored to the left edge. Same
 * slide, same inert-when-closed, same capture-phase Escape (the canvas binds
 * Escape to leaving the workflow, so the panel eats it first). The bottom
 * prompt bar hides while this is open; the composer down here replaces it.
 */

import * as React from "react";
import { ShuffleIcon, XIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { ChatProposal } from "@/lib/studio/agent/spec";
import type { AssetPreview } from "@/lib/studio/graph";
import { AgentMessages } from "./agent-messages";
import { AgentInput, type TaggedNode } from "./agent-input";
import type { AgentSession } from "./use-agent-session";

export function AgentSidebar({
  open,
  onClose,
  session,
  taggedNode,
  onClearTag,
  onClearRemix,
  remixAsset,
}: {
  open: boolean;
  onClose: () => void;
  session: AgentSession;
  taggedNode: TaggedNode | null;
  onClearTag: () => void;
  /** Dismiss a staged remix — only offered while it hasn't been sent. */
  onClearRemix: () => void;
  /** Preview of the asset being remixed, for the card under the header. */
  remixAsset: AssetPreview | null;
}) {
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const [revising, setRevising] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  const proposal: ChatProposal | null = session.proposal;
  const rejected = proposal?.status === "rejected";
  const remix = session.remixTarget;

  const placeholder = revising
    ? "Describe the changes you'd like…"
    : rejected
      ? "Tell me what you'd like instead…"
      : remix?.pending
        ? "Describe your remix…"
        : "Ask for a workflow…";

  return (
    <aside
      aria-label="Workflow agent"
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "fixed top-0 left-0 z-50 flex h-full w-[380px] max-w-[92vw] flex-col border-r border-[#1f211c]/10 bg-[#f7f4ee] shadow-[24px_0_60px_-30px_rgba(31,33,28,0.4)]",
        "transition-transform duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        open ? "translate-x-0" : "pointer-events-none -translate-x-full",
      )}
    >
      {/* Amber-to-white wash, the brand colour dissolving into the paper —
          the panel's one indulgence; everything below stays quiet. */}
      <header className="relative shrink-0 overflow-hidden border-b border-[#1f211c]/8 bg-gradient-to-br from-primary/40 via-white/85 to-white px-4 pt-6 pb-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-10 -right-8 size-36 bg-primary/25 blur-3xl"
        />
        <h2 className="relative text-[19px] leading-tight font-medium tracking-[-0.01em]">
          Build it <span className="font-serif italic">together</span>
        </h2>
        <p className="relative mt-1 text-[12px] leading-5 text-[#8a8271]">
          Describe the piece; I&rsquo;ll wire the nodes.
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close agent"
          className="absolute top-4 right-3 grid size-7 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
        >
          <XIcon className="size-4" />
        </button>
      </header>

      {remix && (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-[#1f211c]/8 bg-white/70 px-4 py-2.5">
          {remixAsset?.url && remixAsset.modality === "image" ? (
            // Plain <img>/<video>: short-lived presigned B2 URLs, same rule
            // as every other thumbnail in the studio.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={remixAsset.url}
              alt=""
              className="size-10 shrink-0 border border-[#1f211c]/10 bg-[#1f211c]/5 object-cover"
            />
          ) : remixAsset?.url && remixAsset.modality === "video" ? (
            <video
              src={remixAsset.url}
              muted
              playsInline
              preload="metadata"
              className="size-10 shrink-0 border border-[#1f211c]/10 bg-[#1f211c] object-cover"
            />
          ) : (
            <div className="grid size-10 shrink-0 place-items-center border border-[#1f211c]/10 bg-[#1f211c]/5">
              <ShuffleIcon className="size-4 text-[#8a8271]" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold tracking-[0.18em] text-[#8a8271] uppercase">
              Remixing
            </p>
            <p className="truncate text-[12.5px] font-semibold text-[#1f211c]">
              {remix.filename ??
                remixAsset?.filename ??
                `A generated ${remixAsset?.modality ?? "asset"}`}
            </p>
          </div>
          {remix.pending && (
            <button
              type="button"
              aria-label="Cancel remix"
              onClick={onClearRemix}
              className="grid size-5 shrink-0 place-items-center text-[#8a8271] transition-colors hover:text-[#1f211c]"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      )}

      <AgentMessages
        session={session}
        proposal={proposal}
        runBusy={session.busy}
        onRevise={() => {
          setRevising(true);
          inputRef.current?.focus();
        }}
      />

      <AgentInput
        onSend={(text, files, tagged) => {
          setRevising(false);
          void session.send(text, files, tagged);
        }}
        disabled={session.pendingAsk !== null}
        busy={session.busy}
        uploading={session.uploading}
        placeholder={placeholder}
        taggedNode={taggedNode}
        onClearTag={onClearTag}
        inputRef={inputRef}
      />
    </aside>
  );
}
