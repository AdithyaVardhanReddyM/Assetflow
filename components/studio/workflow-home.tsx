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
import { ViewTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserButton, useAuth } from "@clerk/nextjs";
import { FolderSimpleIcon, FrameCornersIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Catalog } from "@/lib/studio/catalog";
import { DOT_COLOR, DOT_GAP, isCreateTool } from "@/lib/studio/node-ui";
import type { AgentAttachment } from "@/lib/studio/agent/spec";
import { uploadAsset } from "@/lib/studio/assets-client";
import type { AssetPreview } from "@/lib/studio/graph";
import { deleteWorkflow, startWorkflow, type WorkflowSeed } from "@/app/workflow/actions";
import { startAgentChat } from "@/app/workflow/chat-actions";
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
import { LinkPendingIcon } from "./link-pending-icon";
import { Toolbar, type ToolId } from "./toolbar";
import {
  PromptBar,
  type PromptAttachment,
  type PromptSpec,
} from "./prompt-bar";
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
  /**
   * Which control is mid-creation, so the spinner can live *in* it. A plain
   * boolean would only tell the screen that something is happening, which is
   * what a scrim over everything is for — and a scrim is the wrong answer to
   * "did my click land?".
   */
  const [pending, setPending] = React.useState<string | null>(null);
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
   * Creates the canvas and goes to it. `pending` is never cleared on success —
   * the navigation unmounts this screen, and releasing it first would snap the
   * control back to its resting label for the length of the route transition.
   */
  const open = React.useCallback(
    async (key: string, seed: WorkflowSeed, search = "") => {
      // One creation at a time: a second click while the first is in flight
      // would leave an orphan row behind whichever canvas won the navigation.
      if (pending) return;
      setPending(key);
      const result = await startWorkflow(seed);
      if (!result.ok) {
        toast.error(result.error);
        setPending(null);
        return;
      }
      router.push(`/workflow/${result.data.id}${search}`);
    },
    [pending, router],
  );

  const onToolSelect = React.useCallback(
    (id: ToolId) => {
      // A create tool becomes the new canvas's first node; a pointer tool is
      // only a mode, so it rides along in the query string instead.
      if (isCreateTool(id)) return void open(`tool:${id}`, { tool: id });
      void open(`tool:${id}`, {}, id === "move" ? "" : `?tool=${id}`);
    },
    [open],
  );

  const { getToken, userId } = useAuth();

  /** Files staged on the bar. Assets are tenant-scoped, not workflow-scoped,
   *  so they upload from here — before the canvas row even exists. */
  const [barFiles, setBarFiles] = React.useState<{ file: File; url: string }[]>([]);
  const [crafting, setCrafting] = React.useState(false);

  const barAttachments = React.useMemo<PromptAttachment[]>(
    () =>
      barFiles.map((f) => ({
        name: f.file.name,
        previewUrl: f.file.type.startsWith("image/") ? f.url : null,
      })),
    [barFiles],
  );

  const uploadBarFiles = React.useCallback(async (): Promise<AgentAttachment[]> => {
    if (!barFiles.length) return [];
    const auth = {
      token: await getToken().catch(() => null),
      userId: userId ?? null,
    };
    const uploads = await Promise.all(barFiles.map((f) => uploadAsset(f.file, auth)));
    if (uploads.some((a) => !a)) toast.error("Some attachments failed to upload.");
    return uploads
      .filter((a): a is AssetPreview => a !== null)
      .map((a) => ({
        assetId: a.id,
        mediaType: a.mediaType,
        modality: a.modality,
        filename: a.filename,
      }));
  }, [barFiles, getToken, userId]);

  const onGenerate = React.useCallback(
    async (spec: PromptSpec) => {
      const text = prompt.trim();

      // Agent: the row is created holding the first message, and the canvas
      // opens straight into the conversation — same row-is-the-handoff rule
      // as every other entry point.
      if (spec.tab === "agent") {
        if (!text && !barFiles.length) return;
        if (pending) return;
        setPending("prompt");
        const attachments = await uploadBarFiles();
        const result = await startAgentChat({ prompt: text, attachments });
        if (!result.ok) {
          toast.error(result.error);
          setPending(null);
          return;
        }
        router.push(`/workflow/${result.data.workflowId}`);
        return;
      }

      // No brief: the classic single-seeded-node path.
      if (!text) {
        void open("prompt", {
          tool: spec.modality,
          // Only the identity travels: the server re-resolves it against the
          // catalog rather than trusting a model shape off the wire.
          model: spec.model
            ? { provider: spec.model.provider, id: spec.model.id }
            : undefined,
          params: spec.params,
        });
        return;
      }

      // Quick chain: craft the prompts first ("Crafting…"), then let the
      // seed build the whole chain server-side so reload/back land on it.
      if (!spec.model) {
        toast.error("Pick a model first.");
        return;
      }
      setCrafting(true);
      const attachments = await uploadBarFiles();
      const aspect =
        typeof spec.params?.aspect_ratio === "string"
          ? spec.params.aspect_ratio
          : undefined;
      const needsStartFrame =
        spec.modality === "video" &&
        spec.model.accepts.some((a) => a.port === "init_image");
      const needsEndFrame =
        spec.modality === "video" &&
        spec.model.accepts.some((a) => a.port === "end_frame");

      let prompts = {
        prompt: text,
        startFramePrompt: null as string | null,
        endFramePrompt: null as string | null,
      };
      try {
        const res = await fetch("/api/agent/enhance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: spec.modality,
            prompt: text,
            aspect,
            needsStartFrame,
            needsEndFrame,
          }),
        });
        if (res.ok) {
          const body = (await res.json()) as {
            prompt?: string;
            videoPrompt?: string;
            startFramePrompt?: string | null;
            endFramePrompt?: string | null;
          };
          prompts = {
            prompt: body.videoPrompt ?? body.prompt ?? text,
            startFramePrompt: body.startFramePrompt ?? null,
            endFramePrompt: body.endFramePrompt ?? null,
          };
        }
      } catch {
        // Crafting is an upgrade, not a gate — the raw prompt seeds instead.
      }
      setCrafting(false);

      void open("prompt", {
        prompt: text,
        quick: {
          mode: spec.modality,
          model: { provider: spec.model.provider, id: spec.model.id },
          params: spec.params,
          count: spec.count,
          prompts,
          attachments,
        },
      });
    },
    [prompt, open, pending, barFiles, uploadBarFiles, router],
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
          pending && "pointer-events-none",
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

        {/* Account — the same avatar the canvas top-bar carries, so it holds
            its corner across the navigation into a workflow. The library sits
            beside it: media outlives any one canvas, so its door is on the
            home screen, not inside one. */}
        <div className="fixed top-4 right-4 z-40 flex items-center gap-2 animate-[studio-drift-in_0.7s_cubic-bezier(0.32,0.72,0,1)_both]">
          <Link
            href="/assets"
            className="flex h-10 items-center gap-2 border border-[#1f211c]/8 bg-white/88 px-3.5 text-[13px] font-semibold text-[#4c4a41] shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md transition-colors hover:text-[#1f211c]"
          >
            <LinkPendingIcon icon={<FolderSimpleIcon className="size-4" />} />
            Assets
          </Link>
          <div className="grid size-10 place-items-center rounded-full border border-[#1f211c]/8 bg-white/88 shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md">
            <UserButton appearance={{ elements: { userButtonAvatarBox: "size-7" } }} />
          </div>
        </div>

        {/* Named on both routes, so the toolbar holds still across the
            navigation instead of being torn down and rebuilt. */}
        <ViewTransition name="studio-toolbar">
          <Toolbar
            activeTool="move"
            busyTool={pending?.startsWith("tool:") ? pending.slice(5) : null}
            onSelect={onToolSelect}
          />
        </ViewTransition>

        {/* Greeting */}
        <ViewTransition exit="lift-out" default="none">
          <div className="pointer-events-none fixed inset-x-0 top-[19vh] z-20 px-20 text-center">
            <h1 className="animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_both] text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.05] font-medium tracking-[-0.02em]">
              {greeting}, <span className="font-serif italic">{firstName}</span>
            </h1>
          </div>
        </ViewTransition>

        {/* Prompt bar, and the way past it for anyone who'd rather not start
            from a sentence. */}
        <div
          className="fixed inset-x-0 top-[27vh] z-30 flex justify-center px-4"
          style={{ transitionTimingFunction: EASE }}
        >
          {/* Room for the bar to grow into: it sets its own width per modality,
              so this only has to stop being the thing that limits it. */}
          <div className="w-full max-w-[940px]">
            {/* The morph that carries the screen: this same bar is docked at
                the bottom of the canvas, so it glides down rather than one
                copy vanishing while another appears. */}
            <ViewTransition name="studio-prompt-bar" share="morph">
              <div>
                <PromptBar
                  catalog={catalog}
                  value={prompt}
                  onChange={setPrompt}
                  onGenerate={(spec) => void onGenerate(spec)}
                  busy={pending === "prompt" ? true : crafting ? "crafting" : false}
                  onAttach={() => void open("tool:upload", { tool: "upload" })}
                  attachments={barAttachments}
                  onAttachFiles={(files) =>
                    setBarFiles((current) => [
                      ...current,
                      ...files.map((file) => ({
                        file,
                        url: URL.createObjectURL(file),
                      })),
                    ])
                  }
                  onRemoveAttachment={(index) =>
                    setBarFiles((current) => {
                      const removed = current[index];
                      if (removed) URL.revokeObjectURL(removed.url);
                      return current.filter((_, i) => i !== index);
                    })
                  }
                />
              </div>
            </ViewTransition>

            <ViewTransition exit="lift-out" default="none">
              <div className="animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_150ms_both]">
                {/* The greeting's serif italic, borrowed one size down — the
                    rule fades out at both ends so it reads as a seam, not a
                    divider. */}
                <div className="mt-4 flex items-center justify-center gap-3.5">
                  <span
                    aria-hidden
                    className="h-px w-16 bg-gradient-to-r from-transparent to-[#1f211c]/18"
                  />
                  <span className="font-serif text-[17px] leading-none text-[#8a8271] italic">
                    or
                  </span>
                  <span
                    aria-hidden
                    className="h-px w-16 bg-gradient-to-l from-transparent to-[#1f211c]/18"
                  />
                </div>

                <div className="mt-2.5 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void open("blank", {})}
                    className="flex h-9 items-center gap-2 border border-[#1f211c]/14 bg-white px-4 text-[13px] font-semibold text-[#4c4a41] transition-colors duration-150 hover:border-[#1f211c]/32 hover:text-[#1f211c]"
                  >
                    {pending === "blank" ? (
                      <>
                        <Spinner className="size-4 text-[#8a8271]" />
                        Creating workflow…
                      </>
                    ) : (
                      <>
                        <FrameCornersIcon className="size-4" />
                        Start from blank
                      </>
                    )}
                  </button>
                </div>
              </div>
            </ViewTransition>
          </div>
        </div>

        {/* Previous workflows */}
        <ViewTransition exit="lift-out" default="none">
          <div className="fixed inset-x-0 bottom-7 z-20">
            <WorkflowCards
              workflows={visibleWorkflows}
              busyId={
                pending?.startsWith("card:")
                  ? pending.slice(5)
                  : pending?.startsWith("template:")
                    ? pending
                    : null
              }
              onOpen={(card) => {
                if (pending) return;
                setPending(`card:${card.id}`);
                router.push(`/workflow/${card.id}`);
              }}
              onDelete={setPendingDelete}
              onStartTemplate={(name) => void open(`template:${name}`, { name })}
            />
          </div>
        </ViewTransition>

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
