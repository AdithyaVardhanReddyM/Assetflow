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
import {
  type AssetPreview,
  type Graph,
  type NodeGeneration,
  type NodeRunState,
  MAX_NODES,
} from "@/lib/studio/graph";
import { isCreateTool } from "@/lib/studio/node-ui";
import { fetchAssetPreviews, uploadAsset } from "@/lib/studio/assets-client";
import {
  type NodeResult,
  type RunEvent,
  type RunEventAsset,
  buildRunGraph,
  downloadResult,
  fetchRunAssets,
  fetchWorkflowResults,
  startRun,
  stepNodes,
  streamRun,
} from "@/lib/studio/runs-client";
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

  const { getToken, userId, isLoaded: authLoaded } = useAuth();

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
    // Wait for Clerk before latching: an effect that fires pre-auth sends no
    // identity, gets an empty answer, and would never run again.
    if (!authLoaded || resolvedFor.current === workflowId) return;
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
  }, [workflowId, initialGraph, authFor, authLoaded]);

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

  // --- runs ---------------------------------------------------------------

  const [runStates, setRunStates] = React.useState<Record<string, NodeRunState>>({});
  /**
   * Latest known result per node, across every run of this workflow. Feeds
   * two things: substitute inputs for scoped runs (Run-this-node uses the
   * upstream node's *result*, never re-runs it), and the Download button.
   */
  const nodeResults = React.useRef<Record<string, NodeResult>>({});
  /**
   * Recent generations per node, newest first — the carousel under each
   * generate node. Hydrated from run history on open, advanced as runs land.
   */
  const [histories, setHistories] = React.useState<Record<string, NodeGeneration[]>>({});

  /** Mirrors the backend's RESULTS_PER_NODE — what one node's carousel holds. */
  const HISTORY_LIMIT = 8;
  const prependGeneration = React.useCallback(
    (nodeId: string, generation: NodeGeneration) => {
      setHistories((current) => {
        const existing = current[nodeId] ?? [];
        // The same asset can arrive twice — terminal event, then the resolver
        // fallback — and must land as one carousel entry, not two.
        if (generation.assetId && existing.some((g) => g.assetId === generation.assetId)) {
          return current;
        }
        return {
          ...current,
          [nodeId]: [generation, ...existing].slice(0, HISTORY_LIMIT),
        };
      });
    },
    [],
  );
  /** Abort for the event stream in flight; a new run replaces the old feed. */
  const activeStream = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeStream.current?.(), []);

  // Re-hydrate results when the canvas opens: the graph stores no run output,
  // so yesterday's image comes back from the workflow's run history.
  const hydratedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    // Same pre-auth guard as the preview effect above: a fetch without the
    // caller's identity 404s, and the latch would swallow the retry.
    if (!authLoaded || hydratedFor.current === workflowId) return;
    hydratedFor.current = workflowId;
    let live = true;
    void (async () => {
      const results = await fetchWorkflowResults(workflowId, await authFor());
      if (!live || !Object.keys(results).length) return;
      // Anything a run produced in this session outranks the fetched history.
      setHistories((current) => ({ ...results, ...current }));
      const latest: Record<string, NodeResult> = {};
      for (const [nodeId, generations] of Object.entries(results)) {
        const r = generations[0];
        if (!r) continue;
        latest[nodeId] = {
          assetId: r.assetId,
          url: r.url,
          mediaType: r.mediaType,
          text: r.text ?? null,
        };
      }
      nodeResults.current = { ...latest, ...nodeResults.current };
      setRunStates((current) => {
        const next = { ...current };
        for (const [nodeId, r] of Object.entries(latest)) {
          if (next[nodeId]) continue; // a live run outranks history
          next[nodeId] = {
            status: "succeeded",
            progress: 1,
            output: { url: r.url, mediaType: r.mediaType, text: r.text },
          };
        }
        return next;
      });
    })();
    return () => {
      live = false;
    };
  }, [workflowId, authFor, authLoaded]);

  const patchRunState = React.useCallback(
    (nodeId: string, patch: Partial<NodeRunState>) => {
      setRunStates((current) => {
        const existing: NodeRunState = current[nodeId] ?? { status: "pending" };
        return { ...current, [nodeId]: { ...existing, ...patch } };
      });
    },
    [],
  );

  /**
   * When the run settles, swap ephemeral event URLs for ones the browser can
   * hold on to: `GET /v1/runs/{id}` lists the persisted asset rows, and the
   * assets endpoint mints presigned URLs for them (B2 is a private bucket —
   * the durable URLs on the rows themselves do not resolve from a browser).
   */
  const resolveRunOutputs = React.useCallback(
    async (runId: string) => {
      const auth = await authFor();
      const rows = await fetchRunAssets(runId, auth);
      if (!rows.length) return;
      const previews = await fetchAssetPreviews(
        rows.map((r) => r.id),
        auth,
      );
      for (const row of rows) {
        if (!row.node_id) continue;
        prependGeneration(row.node_id, {
          assetId: row.id,
          url: previews[row.id]?.url ?? row.url,
          mediaType: row.media_type,
          width: row.width ?? null,
          height: row.height ?? null,
        });
      }
      setRunStates((current) => {
        const next = { ...current };
        for (const row of rows) {
          if (!row.node_id) continue;
          const url = previews[row.id]?.url ?? row.url;
          const existing = next[row.node_id];
          const text = existing?.output?.text ?? null;
          nodeResults.current[row.node_id] = {
            assetId: row.id,
            url,
            mediaType: row.media_type,
            text,
          };
          next[row.node_id] = {
            status: existing?.status ?? "succeeded",
            progress: 1,
            output: { url, mediaType: row.media_type, text },
          };
        }
        return next;
      });
    },
    [authFor, prependGeneration],
  );

  const onRunEvent = React.useCallback(
    (runId: string, event: RunEvent) => {
      const nodeId = typeof event.node_id === "string" ? event.node_id : null;
      switch (event.type) {
        case "node.queued":
          if (nodeId) patchRunState(nodeId, { status: "pending" });
          break;
        case "node.started":
          if (nodeId) patchRunState(nodeId, { status: "running", progress: 0 });
          break;
        case "node.progress":
          if (nodeId)
            patchRunState(nodeId, {
              status: "running",
              progress:
                typeof event.progress_pct === "number" ? event.progress_pct : undefined,
            });
          break;
        case "node.completed": {
          if (!nodeId) break;
          const asset = (event.assets as RunEventAsset[] | undefined)?.[0];
          // Mid-run URLs may point at a provider CDN (usable) or at a file on
          // the worker (not); only hand the node something fetchable.
          const url = asset?.url?.startsWith("http") ? asset.url : null;
          patchRunState(nodeId, {
            status: "succeeded",
            progress: 1,
            output: { url, mediaType: asset?.media_type ?? null, text: asset?.text ?? null },
          });
          break;
        }
        case "node.failed":
          if (nodeId)
            patchRunState(nodeId, {
              status: "failed",
              error: typeof event.error === "string" ? event.error : "Generation failed",
            });
          break;
        case "node.skipped":
          if (nodeId) patchRunState(nodeId, { status: "skipped" });
          break;
        case "run.completed": {
          // The terminal event carries every persisted asset, already
          // presigned by the worker — no post-run fetches needed. The
          // round-trip resolver stays as the fallback for older events.
          const assets = event.assets as RunEventAsset[] | undefined;
          if (!assets?.length) {
            void resolveRunOutputs(runId);
            break;
          }
          for (const asset of assets) {
            if (!asset.node_id) continue;
            prependGeneration(asset.node_id, {
              assetId: asset.asset_id ?? null,
              url:
                asset.preview_url ??
                (asset.url?.startsWith("http") ? asset.url : null),
              mediaType: asset.media_type ?? null,
              text: asset.text ?? null,
              width: asset.width ?? null,
              height: asset.height ?? null,
            });
          }
          setRunStates((current) => {
            const next = { ...current };
            for (const asset of assets) {
              if (!asset.node_id) continue;
              const url =
                asset.preview_url ??
                (asset.url?.startsWith("http") ? asset.url : null);
              const text = asset.text ?? next[asset.node_id]?.output?.text ?? null;
              nodeResults.current[asset.node_id] = {
                assetId: asset.asset_id ?? null,
                url,
                mediaType: asset.media_type ?? null,
                text,
              };
              next[asset.node_id] = {
                status: "succeeded",
                progress: 1,
                output: { url, mediaType: asset.media_type ?? null, text },
              };
            }
            return next;
          });
          break;
        }
        case "run.failed":
          toast.error(
            typeof event.message === "string" && event.message
              ? event.message
              : "The run failed.",
          );
          void resolveRunOutputs(runId);
          break;
      }
    },
    [patchRunState, prependGeneration, resolveRunOutputs],
  );

  const onRun = React.useCallback(
    async (nodeId: string, scope: "node" | "chain") => {
      const built = buildRunGraph(graphRef.current, nodeId, scope, nodeResults.current);
      if (!built.ok) {
        toast.error(built.error);
        return;
      }
      const steps = stepNodes(built.graph);
      if (!steps.length) {
        toast.error("Nothing to run here yet — connect a generate node.");
        return;
      }

      // The graph travels inline with the request, so a pending debounce does
      // not need to land first — but flush it anyway: what runs should be what
      // a reload would reopen.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void flushSave({ name: nameRef.current, graph: graphRef.current });
      }

      activeStream.current?.();
      setRunStates((current) => {
        const next = { ...current };
        for (const step of steps) next[step.id] = { status: "pending" };
        return next;
      });

      const auth = await authFor();
      const started = await startRun(built.graph, workflowId, auth);
      if (!started.ok) {
        toast.error(started.error);
        setRunStates((current) => {
          const next = { ...current };
          for (const step of steps) delete next[step.id];
          return next;
        });
        return;
      }

      activeStream.current = streamRun(started.id, auth, (event) =>
        onRunEvent(started.id, event),
      );
    },
    [authFor, flushSave, onRunEvent, workflowId],
  );

  /** Save a node's result to disk — the Download button on result nodes. */
  const onDownload = React.useCallback(
    async (nodeId: string, generation?: NodeGeneration) => {
      const result = generation ?? nodeResults.current[nodeId];
      const live = runStates[nodeId]?.output;
      const source = result ?? { assetId: null, url: live?.url ?? null };
      if (!source.assetId && !source.url) return;

      const node = graphRef.current.nodes.find((n) => n.id === nodeId);
      const title =
        (typeof node?.data.title === "string" && node.data.title) || "assetflow-result";
      const mediaType = result?.mediaType ?? live?.mediaType ?? "";
      const ext =
        { "video/mp4": ".mp4", "image/png": ".png", "image/jpeg": ".jpg",
          "image/webp": ".webp", "audio/mpeg": ".mp3", "audio/wav": ".wav",
          "text/plain": ".txt" }[mediaType] ?? "";
      const saved = await downloadResult(source, `${title}${ext}`, await authFor());
      if (!saved && !source.url) toast.error("Nothing downloadable on this node yet.");
    },
    [authFor, runStates],
  );

  return (
    <TooltipProvider>
      <div className="fixed inset-0 overflow-hidden bg-[#f7f4ee] text-[#1f211c]">
        <ViewTransition enter="settle-in" default="none">
          <div className="absolute inset-0">
            <StudioCanvas
              catalog={catalog}
              initialGraph={initialGraph}
              assets={assets}
              runStates={runStates}
              histories={histories}
              onDownload={(id, generation) => void onDownload(id, generation)}
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
          <div className="pointer-events-auto w-full max-w-[940px]">
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
