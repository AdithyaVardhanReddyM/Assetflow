"use client";

/**
 * The canvas screen at `/workflow/{id}`.
 *
 * The document is handed in by the route, already loaded and tenant-scoped, so
 * this owns only what happens to it while it's open: edits, the debounced
 * save, and the way back out. There is no "new workflow" state here — a canvas
 * without a row could not have a URL, and `startWorkflow` on the home screen
 * has already created one by the time this mounts.
 */

import * as React from "react";
import { ViewTransition } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Catalog } from "@/lib/studio/catalog";
import { type AssetPreview, type Graph, MAX_NODES } from "@/lib/studio/graph";
import { isCreateTool } from "@/lib/studio/node-ui";
import { fetchAssetPreviews, uploadAsset } from "@/lib/studio/assets-client";
import { saveWorkflow } from "@/app/workflow/actions";
import {
  addComment,
  deleteComment,
  resolveComment,
  type CanvasComment,
} from "@/app/workflow/comments";
import { StudioCanvas, type CanvasApi } from "./canvas";
import { CommentModeHint, type CommentsApi } from "./comment-layer";
import { Toolbar, type ToolId } from "./toolbar";
import { TopBar, type SaveState } from "./top-bar";
import { PromptBar, type PromptSpec } from "./prompt-bar";

const SAVE_DEBOUNCE_MS = 800;

export function StudioShell({
  workflowId,
  initialName,
  initialGraph,
  initialComments,
  catalog,
  initialTool = "move",
}: {
  workflowId: string;
  initialName: string;
  initialGraph: Graph;
  initialComments: CanvasComment[];
  catalog: Catalog;
  /** Carried from the home screen's toolbar; pointer tools only. */
  initialTool?: ToolId;
}) {
  const router = useRouter();

  const [tool, setTool] = React.useState<ToolId>(initialTool);
  const [prompt, setPrompt] = React.useState("");
  const [workflowName, setWorkflowName] = React.useState(initialName);
  const [zoom, setZoom] = React.useState(1);
  const [saveState, setSaveState] = React.useState<SaveState>("saved");
  const [leaving, setLeaving] = React.useState(false);
  const [touched, setTouched] = React.useState(() => initialGraph.nodes.length > 0);
  const [assets, setAssets] = React.useState<Record<string, AssetPreview>>({});
  const [commentItems, setCommentItems] = React.useState(initialComments);

  const { getToken, userId } = useAuth();

  const canvas = React.useRef<CanvasApi | null>(null);
  const nameRef = React.useRef(workflowName);
  const graphRef = React.useRef<Graph>(initialGraph);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Serializes saves so a slow request cannot land after a newer one. */
  const savePromise = React.useRef<Promise<unknown>>(Promise.resolve());
  /**
   * The canvas reports its document once on mount. That echo is the document
   * we were just given, so treating it as an edit would write every canvas
   * back to the database simply for having been opened.
   */
  const settled = React.useRef(false);

  React.useEffect(() => {
    nameRef.current = workflowName;
  });

  const authFor = React.useCallback(
    async () => ({
      token: await getToken().catch(() => null),
      userId: userId ?? null,
    }),
    [getToken, userId],
  );

  // --- previews -----------------------------------------------------------

  /**
   * The graph stores only `asset_id`; the presigned URLs behind uploads expire,
   * so they are minted fresh on open. Guarded by id rather than run on mount so
   * an unstable `getToken` identity cannot turn this into a refetch loop.
   */
  const resolvedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (resolvedFor.current === workflowId) return;
    resolvedFor.current = workflowId;

    const ids = initialGraph.nodes
      .filter((n) => n.kind === "input.upload")
      .map((n) => n.data.asset_id)
      .filter((v): v is string => typeof v === "string");
    if (!ids.length) return;

    let live = true;
    void (async () => {
      const resolved = await fetchAssetPreviews(ids, await authFor());
      if (live) setAssets(resolved);
    })();
    return () => {
      live = false;
    };
  }, [workflowId, initialGraph, authFor]);

  // --- persistence --------------------------------------------------------

  const flushSave = React.useCallback(
    (patch: { name?: string; graph?: Graph }) => {
      const run = savePromise.current.then(async () => {
        const result = await saveWorkflow({ id: workflowId, ...patch });
        setSaveState(result.ok ? "saved" : "error");
        if (!result.ok) toast.error(result.error);
      });
      savePromise.current = run.catch(() => {});
      return run;
    },
    [workflowId],
  );

  const scheduleSave = React.useCallback(() => {
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void flushSave({ name: nameRef.current, graph: graphRef.current });
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  React.useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const onGraphChange = React.useCallback(
    (graph: Graph) => {
      graphRef.current = graph;
      if (!settled.current) {
        settled.current = true;
        return;
      }
      scheduleSave();
    },
    [scheduleSave],
  );

  // --- navigation ---------------------------------------------------------

  /**
   * `leaving` is never cleared — the navigation unmounts this screen, and
   * releasing it first would flick the arrow back for the length of the route
   * transition.
   */
  const exitCanvas = React.useCallback(async () => {
    if (leaving) return;
    setLeaving(true);

    // Don't let a pending debounce drop the last edit on the way out — and
    // wait for it to land rather than racing it, because the recents list we
    // are returning to renders the name and timestamp this save writes.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      void flushSave({ name: nameRef.current, graph: graphRef.current });
    }
    await savePromise.current.catch(() => {});

    router.push("/workflow");
  }, [leaving, flushSave, router]);

  // Escape returns home, but only when focus is not in a field.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) {
        (el as HTMLElement).blur();
        return;
      }
      void exitCanvas();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitCanvas]);

  // --- tools --------------------------------------------------------------

  const onToolSelect = React.useCallback((id: ToolId) => {
    if (!isCreateTool(id)) {
      setTool(id);
      return;
    }

    setTouched(true);
    // "Upload" goes straight to the file picker — placing an empty node first
    // and making the user click it again is a step for nothing.
    if (id === "upload") {
      canvas.current?.openFilePicker();
      return;
    }
    const created = canvas.current?.addNode(id);
    if (!created) toast.error(`A workflow can hold ${MAX_NODES} nodes.`);
  }, []);

  const onGenerate = React.useCallback(
    (spec: PromptSpec) => {
      const text = prompt.trim();
      setTouched(true);
      // The bar already decided model and params; the node carries them.
      const created = canvas.current?.addNode(spec.modality, {
        prompt: text || undefined,
        model: spec.model,
        params: spec.params,
      });
      if (!created) toast.error(`A workflow can hold ${MAX_NODES} nodes.`);
      else setPrompt("");
    },
    [prompt],
  );

  const onUpload = React.useCallback(
    async (file: File) => {
      const asset = await uploadAsset(file, await authFor());
      if (!asset) toast.error(`Could not upload ${file.name}.`);
      return asset;
    },
    [authFor],
  );

  // --- comments -----------------------------------------------------------

  /**
   * Held here rather than refetched per change: a comment is small and the
   * server hands back the row it wrote, so the list can be advanced from the
   * response instead of paying a round trip to re-read what we already know.
   */
  const comments = React.useMemo<CommentsApi>(
    () => ({
      items: commentItems,
      currentUserId: userId ?? null,
      add: async ({ x, y, body }) => {
        const result = await addComment({ workflowId, x, y, body });
        if (!result.ok) {
          toast.error(result.error);
          return false;
        }
        setCommentItems((current) => [...current, result.data]);
        return true;
      },
      reply: async (parentId, body) => {
        const result = await addComment({ workflowId, parentId, body });
        if (!result.ok) {
          toast.error(result.error);
          return false;
        }
        setCommentItems((current) => [...current, result.data]);
        return true;
      },
      setResolved: async (id, resolved) => {
        // Optimistic: resolving is a toggle the user watches, and a spinner on
        // a checkmark reads as failure.
        setCommentItems((current) =>
          current.map((c) =>
            c.id === id
              ? { ...c, resolvedAt: resolved ? new Date().toISOString() : null }
              : c,
          ),
        );
        const result = await resolveComment(id, resolved);
        if (!result.ok) {
          setCommentItems((current) =>
            current.map((c) =>
              c.id === id
                ? { ...c, resolvedAt: resolved ? null : new Date().toISOString() }
                : c,
            ),
          );
          toast.error(result.error);
        }
      },
      remove: async (id) => {
        const removed = commentItems.filter(
          (c) => c.id === id || c.parentId === id,
        );
        setCommentItems((current) =>
          current.filter((c) => c.id !== id && c.parentId !== id),
        );
        const result = await deleteComment(id);
        if (!result.ok) {
          setCommentItems((current) =>
            [...current, ...removed].sort((a, b) =>
              a.createdAt.localeCompare(b.createdAt),
            ),
          );
          toast.error(result.error);
        }
      },
    }),
    [commentItems, workflowId, userId],
  );

  const onRun = React.useCallback((_nodeId: string, scope: "node" | "chain") => {
    toast(
      scope === "chain" ? "Run from here isn't wired up yet" : "Run isn't wired up yet",
      { description: "The canvas and its graph are saved — execution comes next." },
    );
  }, []);

  return (
    <TooltipProvider>
      <div className="fixed inset-0 overflow-hidden bg-[#f7f4ee] text-[#1f211c]">
        <ViewTransition enter="settle-in" default="none">
          <div className="absolute inset-0">
            <StudioCanvas
              catalog={catalog}
              initialGraph={initialGraph}
              assets={assets}
              apiRef={canvas}
              onGraphChange={onGraphChange}
              onZoomChange={setZoom}
              onInteract={() => setTouched(true)}
              onUpload={onUpload}
              onRun={onRun}
              panMode={tool === "hand"}
              fitOnMount={initialGraph.nodes.length > 0}
              comments={comments}
              commentMode={tool === "comment"}
            />
          </div>
        </ViewTransition>

        {/* Top-left: back out, and the name this document saves under */}
        <div className="fixed top-4 left-4 z-40 flex h-10 items-center gap-1 border border-[#1f211c]/8 bg-white/88 px-1.5 shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md">
          <button
            type="button"
            aria-label="Back to workflows"
            aria-busy={leaving || undefined}
            disabled={leaving}
            onClick={() => void exitCanvas()}
            className="grid size-7 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c] disabled:hover:bg-transparent"
          >
            {leaving ? (
              <Spinner className="size-4 text-[#8a8271]" />
            ) : (
              <ArrowLeftIcon className="size-4" />
            )}
          </button>
          <div className="mx-0.5 h-4 w-px bg-[#1f211c]/10" />
          <input
            value={workflowName}
            onChange={(e) => {
              setWorkflowName(e.target.value);
              nameRef.current = e.target.value;
              scheduleSave();
            }}
            aria-label="Workflow name"
            spellCheck={false}
            style={{ width: `${Math.max(workflowName.length, 6) + 1}ch` }}
            className="max-w-56 bg-transparent px-1.5 py-1 text-[13px] font-semibold outline-none hover:bg-[#1f211c]/5 focus:bg-[#1f211c]/5"
          />
        </div>

        <TopBar
          visible
          zoom={zoom}
          onZoomIn={() => canvas.current?.zoomIn()}
          onZoomOut={() => canvas.current?.zoomOut()}
          onZoomReset={() => canvas.current?.resetZoom()}
          onFitView={() => canvas.current?.fitView()}
          saveState={saveState}
        />

        {/* Same name as the home screen's, so it stays put across the
            navigation rather than flickering out and back in. */}
        <ViewTransition name="studio-toolbar">
          <Toolbar activeTool={tool} onSelect={onToolSelect} />
        </ViewTransition>

        {/* Empty-state hint, retires after first interaction */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none fixed top-[58%] left-1/2 z-10 -translate-x-1/2 text-center transition-opacity duration-500",
            touched || tool === "comment" ? "opacity-0" : "opacity-100",
          )}
        >
          <p className="text-[13px] text-[#a09a88]">
            Pick a tool to add a node · drop a file to upload · scroll to pan
          </p>
        </div>

        {tool === "comment" ? <CommentModeHint /> : null}

        {/* Prompt bar, docked. The home screen holds the same bar centre-stage
            under this name, which is what lets it glide down into the dock
            instead of one copy disappearing as another appears. */}
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4">
          <div className="pointer-events-auto w-[min(760px,100%)]">
            <ViewTransition name="studio-prompt-bar" share="morph">
              <div>
                <PromptBar
                  catalog={catalog}
                  value={prompt}
                  onChange={setPrompt}
                  onGenerate={onGenerate}
                  onAttach={() => canvas.current?.openFilePicker()}
                />
              </div>
            </ViewTransition>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
