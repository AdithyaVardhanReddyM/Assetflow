"use client";

/**
 * The agent's chassis — the library sidebar mirrored to the left edge. Same
 * slide, same inert-when-closed, same capture-phase Escape (the canvas binds
 * Escape to leaving the workflow, so the panel eats it first). The bottom
 * prompt bar hides while this is open; the composer down here replaces it.
 */

import * as React from "react";
import { XIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { ChatProposal } from "@/lib/studio/agent/spec";
import { AgentMessages } from "./agent-messages";
import { AgentInput, type TaggedNode } from "./agent-input";
import type { AgentSession } from "./use-agent-session";

export function AgentSidebar({
  open,
  onClose,
  session,
  taggedNode,
  onClearTag,
}: {
  open: boolean;
  onClose: () => void;
  session: AgentSession;
  taggedNode: TaggedNode | null;
  onClearTag: () => void;
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

  const placeholder = revising
    ? "Describe the changes you'd like…"
    : rejected
      ? "Tell me what you'd like instead…"
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
      <header className="flex items-start justify-between gap-3 border-b border-[#1f211c]/8 px-4 pt-5 pb-4">
        <div>
          <span className="text-[10px] font-semibold tracking-[0.22em] text-[#8a8271] uppercase">
            Agent
          </span>
          <h2 className="mt-1.5 text-[17px] leading-tight font-medium tracking-[-0.01em]">
            Build it <span className="font-serif italic">together</span>
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close agent"
          className="grid size-7 shrink-0 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
        >
          <XIcon className="size-4" />
        </button>
      </header>

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
