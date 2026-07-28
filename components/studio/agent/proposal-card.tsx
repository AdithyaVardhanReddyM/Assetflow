"use client";

/**
 * A placed proposal's verdict card: Reject / Revise / Accept / Run. Run wears
 * the brand amber — it is this card's Generate. Once acted on (or superseded
 * by a newer proposal), the card freezes with its outcome.
 */

import * as React from "react";
import { PlayIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

export type ProposalOutcome = "accepted" | "rejected" | "replaced" | null;

const action =
  "h-8 border border-[#1f211c]/16 bg-white px-2.5 text-[12px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/35 hover:text-[#1f211c] disabled:opacity-50";

export function ProposalCard({
  summary,
  nodeCount,
  active,
  outcome,
  busy,
  onReject,
  onRevise,
  onAccept,
  onRun,
}: {
  summary: string;
  nodeCount: number;
  /** This is the live proposal, still awaiting a verdict. */
  active: boolean;
  outcome: ProposalOutcome;
  /** A run is being kicked off from this card. */
  busy: boolean;
  onReject: () => void;
  onRevise: () => void;
  onAccept: () => void;
  onRun: () => void;
}) {
  return (
    <div className="border border-[#1f211c]/12 bg-white p-3 shadow-[0_10px_30px_-18px_rgba(31,33,28,0.4)]">
      <span className="text-[10px] font-semibold tracking-[0.18em] text-[#8a8271] uppercase">
        Proposed graph · {nodeCount} node{nodeCount === 1 ? "" : "s"}
      </span>
      <p className="mt-1 text-[12.5px] leading-5 text-[#1f211c]">{summary}</p>

      {active ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={onReject} disabled={busy} className={action}>
            Reject
          </button>
          <button type="button" onClick={onRevise} disabled={busy} className={action}>
            Revise
          </button>
          <button type="button" onClick={onAccept} disabled={busy} className={action}>
            Accept
          </button>
          <button
            type="button"
            onClick={onRun}
            disabled={busy}
            className="flex h-8 items-center gap-1.5 bg-primary px-3 text-[12px] font-semibold text-primary-foreground shadow-[0_8px_20px_-8px_oklch(0.75_0.16_85_/_0.9)] transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97] disabled:opacity-60"
          >
            {busy ? <Spinner className="size-3.5" /> : <PlayIcon weight="fill" className="size-3.5" />}
            Run
          </button>
        </div>
      ) : (
        <p
          className={cn(
            "mt-2 text-[11.5px] font-semibold",
            outcome === "accepted" && "text-[#527d5a]",
            outcome === "rejected" && "text-[#9d5763]",
            (outcome === "replaced" || outcome === null) && "text-[#8a8271]",
          )}
        >
          {outcome === "accepted" && "Accepted — on the canvas."}
          {outcome === "rejected" && "Rejected — removed from the canvas."}
          {outcome === "replaced" && "Superseded by a newer proposal."}
          {outcome === null && "No longer active."}
        </p>
      )}
    </div>
  );
}
