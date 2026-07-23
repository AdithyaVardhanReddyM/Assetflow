"use client";

/**
 * The workflow home screen — everything before a canvas exists.
 *
 * Every entry point here does the same two things: create a row, then navigate
 * to `/workflow/{id}`. The canvas is never a mode this component switches into,
 * which is what makes a canvas addressable at all — the prompt, the toolbar,
 * a template and "start from blank" differ only in what node the new document
 * is seeded with, and that seeding happens server-side in `startWorkflow`.
 */

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FrameCornersIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Catalog } from "@/lib/studio/catalog";
import { DOT_COLOR, DOT_GAP, isCreateTool } from "@/lib/studio/node-ui";
import { deleteWorkflow, startWorkflow, type WorkflowSeed } from "@/app/workflow/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Toolbar, type ToolId } from "./toolbar";
import { PromptBar, type PromptSpec } from "./prompt-bar";
import { WorkflowCards, type WorkflowCard } from "./workflow-cards";

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

const subscribeNoop = () => () => {};

function greetingForHour(hour: number) {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function WorkflowHome({
  firstName,
  workflows,
  catalog,
}: {
  firstName: string;
  workflows: WorkflowCard[];
  catalog: Catalog;
}) {
  const router = useRouter();

  const [prompt, setPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<WorkflowCard | null>(null);
  /**
   * Cards removed locally. Held as ids rather than a copy of the list so the
   * server's own refreshed `workflows` prop stays authoritative — once the row
   * is really gone this filter is simply a no-op, with no state to resync.
   */
  const [deletedIds, setDeletedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Local-time greeting: client-only value with an SSR fallback, no effect.
  const greeting = React.useSyncExternalStore(
    subscribeNoop,
    () => greetingForHour(new Date().getHours()),
    () => "Welcome back",
  );

  /**
   * Creates the canvas and goes to it. `busy` is never cleared on success —
   * the navigation unmounts this screen, and releasing it first would flash
   * the home screen back to life for the length of the route transition.
   */
  const open = React.useCallback(
    async (seed: WorkflowSeed, search = "") => {
      if (busy) return;
      setBusy(true);
      const result = await startWorkflow(seed);
      if (!result.ok) {
        toast.error(result.error);
        setBusy(false);
        return;
      }
      router.push(`/workflow/${result.data.id}${search}`);
    },
    [busy, router],
  );

  const onToolSelect = React.useCallback(
    (id: ToolId) => {
      // A create tool becomes the new canvas's first node; a pointer tool is
      // only a mode, so it rides along in the query string instead.
      if (isCreateTool(id)) return void open({ tool: id });
      void open({}, id === "move" ? "" : `?tool=${id}`);
    },
    [open],
  );

  const onGenerate = React.useCallback(
    (spec: PromptSpec) => {
      const text = prompt.trim();
      void open({
        tool: spec.modality,
        prompt: text,
        // Only the identity travels: the server re-resolves it against the
        // catalog rather than trusting a model shape off the wire.
        model: spec.model
          ? { provider: spec.model.provider, id: spec.model.id }
          : undefined,
        params: spec.params,
      });
    },
    [prompt, open],
  );

  const visibleWorkflows = React.useMemo(
    () => workflows.filter((w) => !deletedIds.has(w.id)),
    [workflows, deletedIds],
  );

  const confirmDelete = React.useCallback(async () => {
    const card = pendingDelete;
    if (!card) return;

    // Hide it now; the dialog closing onto a card that is still there reads as
    // a failure even when the request is merely slow.
    setDeletedIds((current) => new Set(current).add(card.id));
    setPendingDelete(null);

    const result = await deleteWorkflow(card.id);
    if (!result.ok) {
      setDeletedIds((current) => {
        const next = new Set(current);
        next.delete(card.id);
        return next;
      });
      toast.error(result.error);
      return;
    }
    toast.success(`Deleted “${card.name}”.`);
  }, [pendingDelete]);

  return (
    <TooltipProvider>
      <div
        className={cn(
          "fixed inset-0 overflow-hidden bg-[#f7f4ee] text-[#1f211c]",
          busy && "pointer-events-none",
        )}
      >
        {/* The canvas grid, painted in CSS — the home screen has no graph to
            mount a flow for, and the two routes have to meet on the same dots. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            backgroundImage: `radial-gradient(${DOT_COLOR} 1px, transparent 1px)`,
            backgroundSize: `${DOT_GAP}px ${DOT_GAP}px`,
          }}
        />

        {/* Warm bloom behind the greeting. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(640px 420px at 50% 28%, oklch(0.852 0.199 91.936 / 0.16), transparent 70%)",
          }}
        />

        <div className="fixed top-5 left-5 z-40 animate-[studio-drift-in_0.7s_cubic-bezier(0.32,0.72,0,1)_both]">
          <Image
            src="/assetflow_full_logo.svg"
            alt="Asset Flow"
            width={166}
            height={23}
            priority
          />
        </div>

        <Toolbar activeTool="move" onSelect={onToolSelect} />

        {/* Greeting */}
        <div className="pointer-events-none fixed inset-x-0 top-[19vh] z-20 px-20 text-center">
          <h1 className="animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_both] text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.05] font-medium tracking-[-0.02em]">
            {greeting}, <span className="font-serif italic">{firstName}</span>
          </h1>
        </div>

        {/* Prompt bar, and the way past it for anyone who'd rather not start
            from a sentence. */}
        <div
          className="fixed inset-x-0 top-[27vh] z-30 flex justify-center px-4"
          style={{ transitionTimingFunction: EASE }}
        >
          <div className="w-[min(760px,100%)]">
            <PromptBar
              catalog={catalog}
              value={prompt}
              onChange={setPrompt}
              onGenerate={onGenerate}
              onAttach={() => void open({ tool: "upload" })}
            />

            <div className="animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_150ms_both]">
              <div className="mt-4 flex items-center justify-center gap-3">
                <span aria-hidden className="h-px w-12 bg-[#1f211c]/12" />
                <span className="text-[11px] tracking-[0.18em] text-[#a09a88] uppercase">
                  or
                </span>
                <span aria-hidden className="h-px w-12 bg-[#1f211c]/12" />
              </div>

              <div className="mt-2.5 flex justify-center">
                <button
                  type="button"
                  onClick={() => void open({})}
                  className="flex h-9 items-center gap-2 border border-[#1f211c]/14 bg-white/70 px-4 text-[13px] font-semibold text-[#4c4a41] backdrop-blur-sm transition-all duration-150 hover:-translate-y-px hover:border-[#1f211c]/32 hover:bg-white hover:text-[#1f211c] hover:shadow-[0_10px_24px_-14px_rgba(31,33,28,0.5)]"
                >
                  <FrameCornersIcon className="size-4" />
                  Start from blank
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Previous workflows */}
        <div className="fixed inset-x-0 bottom-7 z-20">
          <WorkflowCards
            workflows={visibleWorkflows}
            onOpen={(card) => {
              setBusy(true);
              router.push(`/workflow/${card.id}`);
            }}
            onDelete={setPendingDelete}
            onStartTemplate={(name) => void open({ name })}
          />
        </div>

        {/* Held back a beat: a canvas usually opens faster than this would be
            readable, and a spinner that flashes is worse than none. */}
        <div
          aria-hidden={!busy}
          className={cn(
            "pointer-events-none fixed inset-0 z-50 grid place-items-center bg-[#f7f4ee]/40 backdrop-blur-[2px] transition-opacity duration-200",
            busy ? "opacity-100 delay-300" : "opacity-0",
          )}
        >
          <div className="flex items-center gap-2.5 border border-[#1f211c]/8 bg-white/92 px-4 py-2.5 text-[13px] font-medium text-[#4c4a41] shadow-[0_18px_44px_-12px_rgba(31,33,28,0.28)]">
            <Spinner className="size-3.5 text-[#8a8271]" />
            Opening canvas…
          </div>
        </div>

        <AlertDialog
          open={pendingDelete !== null}
          onOpenChange={(next) => {
            if (!next) setPendingDelete(null);
          }}
        >
          <AlertDialogContent className="border border-[#1f211c]/10 bg-white text-[#1f211c] shadow-[0_28px_70px_-20px_rgba(31,33,28,0.4)] ring-0">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[15px] font-semibold">
                Delete “{pendingDelete?.name}”?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[12px] leading-5 text-[#8a8271]">
                It comes off your recents. Media already generated from it stays
                in your library with its provenance intact.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirmDelete}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}
