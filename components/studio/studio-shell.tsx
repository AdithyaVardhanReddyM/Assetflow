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
  buildRunGraphForNodes,
  downloadResult,
  fetchRunAssets,
  fetchWorkflowResults,
  isStepKind,
  startRun,
  stepNodes,
  streamRun,
} from "@/lib/studio/runs-client";
import { belowContentAt } from "@/lib/studio/agent/placement";
import {
  type QuickPrompts,
  buildQuickImageGraph,
  buildQuickVideoGraph,
} from "@/lib/studio/agent/quick-graphs";
import type { AgentAttachment } from "@/lib/studio/agent/spec";
import type { LoadedChat } from "@/app/workflow/chat-actions";
import { type TakeEditSpec, buildTakeEditGraph } from "@/lib/studio/camera-edit";
import {
  fetchAssetBlob as fetchAssetBlobApi,
  registerTextEdit as registerTextEditApi,
  requestLayerize,
} from "@/lib/studio/magic-text";
import {
  type LibraryAsset,
  fetchLibrary,
  fetchReconstruction,
  searchLibrary,
} from "@/lib/studio/library-client";
import { saveWorkflow } from "@/app/workflow/actions";
import {
  addComment,
  deleteComment,
  resolveComment,
  type CanvasComment,
} from "@/app/workflow/comments";
import { StudioCanvas, type CanvasApi } from "./canvas";
import { CommentModeHint, type CommentsApi } from "./comment-layer";
import { LibrarySidebar } from "./library-sidebar";
import { Toolbar, type ToolId } from "./toolbar";
import { TopBar, type SaveState } from "./top-bar";
import {
  PromptBar,
  type PromptAttachment,
  type PromptSpec,
} from "./prompt-bar";
import { AgentSidebar } from "./agent/agent-sidebar";
import { type AgentBridge, useAgentSession } from "./agent/use-agent-session";

const SAVE_DEBOUNCE_MS = 800;

/**
 * Hydration — the previews and past generations the graph does not store — is
 * retried rather than attempted once. A single failed request used to be
 * indistinguishable from an empty workflow, which is how a node full of
 * generations could reopen looking like a fresh one.
 */
const HYDRATE_ATTEMPTS = 3;
const HYDRATE_BACKOFF_MS = 600;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function StudioShell({
  workflowId,
  initialName,
  initialGraph,
  initialComments,
  catalog,
  initialTool = "move",
  initialChat = null,
}: {
  workflowId: string;
  initialName: string;
  initialGraph: Graph;
  initialComments: CanvasComment[];
  catalog: Catalog;
  /** Carried from the home screen's toolbar; pointer tools only. */
  initialTool?: ToolId;
  /** The workflow's agent thread, loaded with the page. An open one means the
   *  conversation is mid-flight (often the home screen's handoff) — the
   *  sidebar opens on it immediately. */
  initialChat?: LoadedChat | null;
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
   * The upload previews on this document, still being fetched. Nodes wear the
   * loading shimmer while it is true rather than the "choose a file" empty
   * state, which is a lie about a node that has a file.
   */
  const [hydratingUploads, setHydratingUploads] = React.useState(() =>
    initialGraph.nodes.some(
      (n) => n.kind === "input.upload" && typeof n.data.asset_id === "string",
    ),
  );

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
    // `hydratingUploads` was seeded from this same condition, so a document
    // with nothing to resolve is already showing its nodes as settled.
    if (!ids.length) return;

    // Deliberately no unmount guard. Under StrictMode this effect mounts,
    // tears down and mounts again; a `live` flag would drop the answer to the
    // first fetch while the latch above silences the second, and every upload
    // node would sit empty until a reload. A late setState on an unmounted
    // tree is a no-op, which is the cheaper failure by far.
    void (async () => {
      let pending = ids;
      const found: Record<string, AssetPreview> = {};
      for (let attempt = 0; attempt < HYDRATE_ATTEMPTS && pending.length; attempt += 1) {
        if (attempt) await wait(HYDRATE_BACKOFF_MS * attempt);
        const resolved = await fetchAssetPreviews(pending, await authFor());
        if (Object.keys(resolved).length) {
          Object.assign(found, resolved);
          pending = pending.filter((id) => !found[id]);
          setAssets({ ...found });
        }
      }
      // Nothing came back at all — release the latch so reopening this canvas
      // (or a StrictMode remount) tries again rather than latching failure in.
      if (!Object.keys(found).length) resolvedFor.current = null;
      setHydratingUploads(false);
    })();
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

  const onUpload = React.useCallback(
    async (file: File) => {
      const asset = await uploadAsset(file, await authFor());
      if (!asset) toast.error(`Could not upload ${file.name}.`);
      return asset;
    },
    [authFor],
  );

  /**
   * Upload for graphs placed via `insertGraph` (agent proposals, quick
   * chains): those upload nodes are born pointing at an asset id, so the
   * preview has to land in the shell's store — the canvas-local one only
   * learns about files that came through its own picker.
   */
  const uploadTracked = React.useCallback(
    async (file: File) => {
      const asset = await onUpload(file);
      if (asset) setAssets((current) => ({ ...current, [asset.id]: asset }));
      return asset;
    },
    [onUpload],
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

  /**
   * The workflow's past generations, still being fetched. Every step node on
   * the document shimmers while it is true: which nodes have results is
   * precisely what this request is on its way to find out, so the alternative
   * is showing "your image will appear here" over an image that exists.
   */
  const [hydratingResults, setHydratingResults] = React.useState(() =>
    initialGraph.nodes.some((n) => isStepKind(n.kind)),
  );

  // Re-hydrate results when the canvas opens: the graph stores no run output,
  // so yesterday's image comes back from the workflow's run history.
  const hydratedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    // Same pre-auth guard as the preview effect above: a fetch without the
    // caller's identity 404s, and the latch would swallow the retry.
    if (!authLoaded || hydratedFor.current === workflowId) return;
    hydratedFor.current = workflowId;
    // No unmount guard, for the reason spelled out on the preview effect.
    void (async () => {
      let results: Record<string, NodeGeneration[]> | null = null;
      for (let attempt = 0; attempt < HYDRATE_ATTEMPTS; attempt += 1) {
        if (attempt) await wait(HYDRATE_BACKOFF_MS * attempt);
        // null is a failed request; {} is a workflow that has never been run.
        results = await fetchWorkflowResults(workflowId, await authFor());
        if (results) break;
      }
      if (!results) hydratedFor.current = null; // let a remount try again
      const found = results;
      if (found && Object.keys(found).length) {
        // Anything a run produced in this session outranks the fetched history.
        setHistories((current) => ({ ...found, ...current }));
        const latest: Record<string, NodeResult> = {};
        for (const [nodeId, generations] of Object.entries(found)) {
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
      }
      // Last, so no node blinks through its empty state on the way to its
      // result — these land in one batch with the state above.
      setHydratingResults(false);
    })();
  }, [workflowId, authFor, authLoaded, initialGraph]);

  /**
   * Current histories and run states, readable from a callback that must not
   * be rebuilt every time a run event lands — a changing `refreshMedia` would
   * churn the whole node context mid-run.
   */
  const historiesRef = React.useRef(histories);
  const runStatesRef = React.useRef(runStates);
  React.useEffect(() => {
    historiesRef.current = histories;
    runStatesRef.current = runStates;
  });

  /**
   * Mint a fresh preview URL for one asset and swap it in wherever this canvas
   * is holding the stale one. Called by a well whose media failed to load: B2
   * links are presigned for an hour, and a canvas left open outlives them.
   */
  const refreshMedia = React.useCallback(
    async (nodeId: string, assetId: string): Promise<boolean> => {
      const stale =
        historiesRef.current[nodeId]?.find((g) => g.assetId === assetId)?.url ??
        runStatesRef.current[nodeId]?.output?.url ??
        null;

      const resolved = await fetchAssetPreviews([assetId], await authFor());
      const fresh = resolved[assetId]?.url ?? null;
      // The same link back means the signature was never the problem — the
      // object itself is unreachable, and swapping it in would only loop.
      if (!fresh || fresh === stale) return false;

      setHistories((current) => {
        const existing = current[nodeId];
        if (!existing?.some((g) => g.assetId === assetId)) return current;
        return {
          ...current,
          [nodeId]: existing.map((g) =>
            g.assetId === assetId ? { ...g, url: fresh } : g,
          ),
        };
      });
      setRunStates((current) => {
        const existing = current[nodeId];
        // Only the take that failed: a run that has moved on since owns the
        // well now, and rewriting its URL would drag the old one back.
        if (!existing?.output || (stale !== null && existing.output.url !== stale)) {
          return current;
        }
        return {
          ...current,
          [nodeId]: { ...existing, output: { ...existing.output, url: fresh } },
        };
      });
      const result = nodeResults.current[nodeId];
      if (result && (result.assetId === assetId || result.url === stale)) {
        nodeResults.current[nodeId] = { ...result, url: fresh };
      }
      return true;
    },
    [authFor],
  );

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
          if (nodeId)
            patchRunState(nodeId, { status: "running", progress: 0, progressMessage: null });
          break;
        case "node.progress": {
          if (!nodeId) break;
          const patch: Partial<NodeRunState> = {
            status: "running",
            // Every tick restates the provider's wording (or lack of one), so
            // "Waiting in queue" clears the moment generation actually starts.
            progressMessage:
              typeof event.message === "string" && event.message ? event.message : null,
          };
          // Absent pct must not wipe the last real one — spreading an explicit
          // `undefined` into the run state would.
          if (typeof event.progress_pct === "number") patch.progress = event.progress_pct;
          patchRunState(nodeId, patch);
          break;
        }
        case "node.completed": {
          if (!nodeId) break;
          const asset = (event.assets as RunEventAsset[] | undefined)?.[0];
          // Mid-run URLs may point at a provider CDN (usable) or at a file on
          // the worker (not); only hand the node something fetchable.
          const url = asset?.url?.startsWith("http") ? asset.url : null;
          patchRunState(nodeId, {
            status: "succeeded",
            progress: 1,
            progressMessage: null,
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

  /**
   * Start a run and feed its events back onto the canvas — the shared tail of
   * every way a run begins. `stepIds` are the nodes that will exist as steps:
   * they flip to pending immediately (and back, if the request is refused).
   */
  const launchRun = React.useCallback(
    async (runGraph: Graph, stepIds: string[]) => {
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
        for (const id of stepIds) next[id] = { status: "pending" };
        return next;
      });

      const auth = await authFor();
      const started = await startRun(runGraph, workflowId, auth);
      if (!started.ok) {
        toast.error(started.error);
        setRunStates((current) => {
          const next = { ...current };
          for (const id of stepIds) delete next[id];
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
      await launchRun(
        built.graph,
        steps.map((s) => s.id),
      );
    },
    [launchRun],
  );

  /**
   * Regenerate one node's displayed take through a hidden edit model (camera
   * pose, relight) — the runs the expand modal's edit tabs start.
   * Deliberately not a document edit: the node keeps its own model, and the
   * take travels back in as a synthetic upload under the node's own id, so
   * the result lands in this node's carousel and re-hydrates there on reopen
   * like any other generation.
   */
  const onEditTake = React.useCallback(
    async (nodeId: string, assetId: string, spec: TakeEditSpec) => {
      const node = graphRef.current.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const title = typeof node.data.title === "string" ? node.data.title : null;
      const graph = buildTakeEditGraph(
        { id: node.id, position: node.position, title },
        assetId,
        spec,
      );
      await launchRun(graph, [nodeId]);
    },
    [launchRun],
  );

  // --- agent --------------------------------------------------------------

  const [agentOpen, setAgentOpen] = React.useState(
    initialChat?.chat.status === "open",
  );
  /** The current selection, with titles resolved at event time — reading the
   *  graph ref during render is off-limits under the compiler. */
  const [selectedNodes, setSelectedNodes] = React.useState<
    { id: string; title: string }[]
  >([]);
  /** Node ids whose tag chip was dismissed — cleared when selection moves. */
  const [tagDismissed, setTagDismissed] = React.useState<string | null>(null);
  /** Files staged on the bottom bar for the next agent/quick submit. */
  const [barFiles, setBarFiles] = React.useState<{ file: File; url: string }[]>([]);
  const [crafting, setCrafting] = React.useState(false);

  /** One combined run for a whole proposal — the backend sequences the steps. */
  const runSubgraph = React.useCallback(
    async (nodeIds: string[]) => {
      const built = buildRunGraphForNodes(graphRef.current, nodeIds, nodeResults.current);
      if (!built.ok) {
        toast.error(built.error);
        return false;
      }
      const steps = stepNodes(built.graph);
      if (!steps.length) {
        toast.error("Nothing to run in this proposal.");
        return false;
      }
      await launchRun(
        built.graph,
        steps.map((s) => s.id),
      );
      return true;
    },
    [launchRun],
  );

  const bridge = React.useMemo<AgentBridge>(
    () => ({
      graph: () => graphRef.current,
      insertGraph: (graph, at) => {
        setTouched(true);
        return canvas.current?.insertGraph(graph, at) ?? false;
      },
      removeNodes: (ids) => canvas.current?.removeNodes(ids),
      updateNodeData: (id, patch) => canvas.current?.updateNodeData(id, patch),
      runSubgraph,
      upload: uploadTracked,
    }),
    [runSubgraph, uploadTracked],
  );

  const session = useAgentSession({
    workflowId,
    catalog,
    initialChat,
    bridge,
    onFinished: () => setAgentOpen(false),
  });

  const onSelectionChange = React.useCallback((ids: string[]) => {
    setTagDismissed(null);
    setSelectedNodes(
      ids.flatMap((id) => {
        const node = graphRef.current.nodes.find((n) => n.id === id);
        if (!node) return [];
        const title =
          typeof node.data.title === "string" && node.data.title
            ? node.data.title
            : typeof node.data.model === "string" && node.data.model
              ? node.data.model
              : node.kind;
        return [{ id, title }];
      }),
    );
  }, []);

  /** The single selected node, offered as a tag in the agent composer. */
  const taggedNode =
    agentOpen && selectedNodes.length === 1 && selectedNodes[0].id !== tagDismissed
      ? selectedNodes[0]
      : null;

  const stageFiles = React.useCallback((files: File[]) => {
    setBarFiles((current) => [
      ...current,
      ...files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
  }, []);

  const clearBarFiles = React.useCallback(() => {
    setBarFiles((current) => {
      current.forEach((f) => URL.revokeObjectURL(f.url));
      return [];
    });
  }, []);

  const barAttachments = React.useMemo<PromptAttachment[]>(
    () =>
      barFiles.map((f) => ({
        name: f.file.name,
        previewUrl: f.file.type.startsWith("image/") ? f.url : null,
      })),
    [barFiles],
  );

  /**
   * The quick Image/Video submit: one structured LLM pass turns the brief
   * into production prompts ("Crafting…"), then the whole chain lands below
   * whatever is already on the canvas. Nothing runs — that is the user's move.
   * The enhance call is an upgrade, not a gate: if it fails, the raw prompt
   * ships instead.
   */
  const quickGenerate = React.useCallback(
    async (spec: PromptSpec, text: string) => {
      const model = spec.model;
      if (!model) {
        toast.error("Pick a model first.");
        return;
      }
      setCrafting(true);
      try {
        const auth = await authFor();
        const uploads = await Promise.all(
          barFiles.map((f) => uploadAsset(f.file, auth)),
        );
        const attachments: AgentAttachment[] = uploads
          .filter((a): a is AssetPreview => a !== null)
          .map((a) => ({
            assetId: a.id,
            mediaType: a.mediaType,
            modality: a.modality,
            filename: a.filename,
          }));
        if (attachments.length) {
          setAssets((current) => {
            const next = { ...current };
            for (const [i, a] of uploads.entries()) {
              if (a) next[a.id] = a;
              else toast.error(`Could not upload ${barFiles[i]?.file.name}.`);
            }
            return next;
          });
        }

        const aspect =
          typeof spec.params?.aspect_ratio === "string"
            ? spec.params.aspect_ratio
            : undefined;
        const needsStartFrame =
          spec.modality === "video" && model.accepts.some((a) => a.port === "init_image");
        const needsEndFrame =
          spec.modality === "video" && model.accepts.some((a) => a.port === "end_frame");

        let prompts: QuickPrompts = { prompt: text };
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
          // Offline enhance falls through to the raw prompt below.
        }

        const compiled =
          spec.modality === "image"
            ? buildQuickImageGraph(
                catalog,
                model,
                prompts.prompt,
                spec.params ?? {},
                spec.count ?? 1,
                attachments,
              )
            : buildQuickVideoGraph(
                catalog,
                model,
                prompts,
                spec.params ?? {},
                attachments,
              );
        if (!compiled.ok) {
          toast.error(compiled.errors[0] ?? "Couldn't build that chain.");
          return;
        }
        const placed = canvas.current?.insertGraph(
          compiled.graph,
          belowContentAt(graphRef.current, compiled.size),
        );
        if (!placed) {
          toast.error(`A workflow can hold ${MAX_NODES} nodes.`);
          return;
        }
        setPrompt("");
        clearBarFiles();
      } finally {
        setCrafting(false);
      }
    },
    [authFor, barFiles, catalog, clearBarFiles],
  );

  const onGenerate = React.useCallback(
    (spec: PromptSpec) => {
      const text = prompt.trim();
      setTouched(true);

      if (spec.tab === "agent") {
        if (!text && !barFiles.length) return;
        setAgentOpen(true);
        void session.send(
          text,
          barFiles.map((f) => f.file),
          [],
        );
        setPrompt("");
        clearBarFiles();
        return;
      }

      // No brief means no chain to craft — keep the old fast path: one node,
      // pre-set to the bar's model and params.
      if (!text) {
        const created = canvas.current?.addNode(spec.modality, {
          model: spec.model,
          params: spec.params,
        });
        if (!created) toast.error(`A workflow can hold ${MAX_NODES} nodes.`);
        return;
      }

      void quickGenerate(spec, text);
    },
    [prompt, barFiles, session, clearBarFiles, quickGenerate],
  );

  // --- magic text ---------------------------------------------------------

  const onLayerize = React.useCallback(
    async (assetId: string) => requestLayerize(assetId, await authFor()),
    [authFor],
  );

  const onFetchAssetBlob = React.useCallback(
    async (assetId: string) => fetchAssetBlobApi(assetId, await authFor()),
    [authFor],
  );

  /**
   * Index a composited text edit as this node's newest generation. No run is
   * in flight, so the node's carousel and result state advance directly —
   * the same shape a `run.completed` event would have left them in.
   */
  const onRegisterTextEdit = React.useCallback(
    async (nodeId: string, image: Blob, baseAssetId: string): Promise<boolean> => {
      const registered = await registerTextEditApi(
        image,
        { workflowId, nodeId, baseAssetId },
        await authFor(),
      );
      if (!registered) return false;
      prependGeneration(nodeId, {
        assetId: registered.assetId,
        url: registered.url,
        mediaType: "image/png",
        width: registered.width,
        height: registered.height,
        createdAt: registered.createdAt,
      });
      nodeResults.current[nodeId] = {
        assetId: registered.assetId,
        url: registered.url,
        mediaType: "image/png",
        text: null,
      };
      setRunStates((current) => ({
        ...current,
        [nodeId]: {
          status: "succeeded",
          progress: 1,
          output: { url: registered.url, mediaType: "image/png", text: null },
        },
      }));
      return true;
    },
    [authFor, prependGeneration, workflowId],
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

  // --- the library panel ---------------------------------------------------

  const [libraryOpen, setLibraryOpen] = React.useState(false);
  /** null after a failed fetch, which the panel shows differently from empty. */
  const [libraryAssets, setLibraryAssets] = React.useState<LibraryAsset[] | null>(null);
  const [libraryLoading, setLibraryLoading] = React.useState(false);
  const [reconstructing, setReconstructing] = React.useState<string | null>(null);

  const loadLibrary = React.useCallback(async () => {
    setLibraryLoading(true);
    // Everything except what this canvas already made — the panel is for
    // bringing work in from elsewhere.
    const items = await fetchLibrary(await authFor(), { excludeWorkflowId: workflowId });
    setLibraryAssets(items);
    setLibraryLoading(false);
  }, [authFor, workflowId]);

  /** The panel's search, scoped like its listing: everything but this canvas. */
  const searchPanelLibrary = React.useCallback(
    async (query: string, modality: string) =>
      searchLibrary(query, await authFor(), {
        modality,
        excludeWorkflowId: workflowId,
        limit: 8,
      }),
    [authFor, workflowId],
  );

  const toggleLibrary = React.useCallback(() => {
    const next = !libraryOpen;
    setLibraryOpen(next);
    // Fetched on first open rather than on mount: most canvas sessions never
    // ask for it, and the list is only useful once it is on screen.
    if (next && libraryAssets === null && !libraryLoading) void loadLibrary();
  }, [libraryOpen, libraryAssets, libraryLoading, loadLibrary]);

  /**
   * Rebuild the graph that produced a library asset and drop it on the canvas.
   *
   * The takes come back with it: the fragment's nodes carry an `origin`, so
   * the carousels are seeded now and `/results` re-fills them from the same
   * pointer on the next reload.
   */
  const onReconstruct = React.useCallback(
    async (asset: LibraryAsset) => {
      setReconstructing(asset.id);
      const result = await fetchReconstruction(asset.id, await authFor());
      setReconstructing(null);

      if (!result.ok) {
        toast.error(
          result.reason === "no_run"
            ? "This one was uploaded, not generated — there's no graph behind it."
            : result.reason === "no_graph"
              ? "The run behind this asset didn't keep a graph."
              : result.reason === "too_large"
                ? `That chain is ${result.nodeCount} nodes — more than one workflow can hold.`
                : "Couldn't rebuild that chain.",
        );
        return;
      }

      const { graph, results, missingAssets, nodeCount } = result.data;
      if (!canvas.current?.insertGraph(graph)) {
        toast.error(
          `That chain needs ${nodeCount} nodes and this canvas can hold ${MAX_NODES}.`,
        );
        return;
      }
      setTouched(true);

      // Upload nodes in the fragment point at assets this canvas has never
      // resolved, and the graph stores only the id — without this they would
      // sit empty until a reload went and fetched their previews.
      const uploadIds = graph.nodes
        .filter((n) => n.kind === "input.upload")
        .map((n) => n.data.asset_id)
        .filter((id): id is string => typeof id === "string");
      if (uploadIds.length) {
        void fetchAssetPreviews(uploadIds, await authFor()).then((resolved) => {
          if (Object.keys(resolved).length) {
            setAssets((current) => ({ ...current, ...resolved }));
          }
        });
      }

      // Same shape the reopen hydration leaves behind: the well shows the
      // latest take, the carousel holds the rest.
      if (Object.keys(results).length) {
        setHistories((current) => ({ ...current, ...results }));
        const latest: Record<string, NodeResult> = {};
        for (const [nodeId, generations] of Object.entries(results)) {
          const newest = generations[0];
          if (!newest) continue;
          latest[nodeId] = {
            assetId: newest.assetId,
            url: newest.url,
            mediaType: newest.mediaType,
            text: newest.text ?? null,
          };
        }
        nodeResults.current = { ...nodeResults.current, ...latest };
        setRunStates((current) => {
          const next = { ...current };
          for (const [nodeId, r] of Object.entries(latest)) {
            next[nodeId] = {
              status: "succeeded",
              progress: 1,
              output: { url: r.url, mediaType: r.mediaType, text: r.text },
            };
          }
          return next;
        });
      }

      toast.success(
        `Rebuilt ${graph.nodes.length} ${graph.nodes.length === 1 ? "node" : "nodes"}.`,
        missingAssets.length
          ? {
              description: `${missingAssets.length} source ${
                missingAssets.length === 1 ? "file is" : "files are"
              } no longer in your library, so ${
                missingAssets.length === 1 ? "its node" : "those nodes"
              } came back empty.`,
            }
          : undefined,
      );
    },
    [authFor],
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
              hydratingResults={hydratingResults}
              hydratingUploads={hydratingUploads}
              onRefreshMedia={refreshMedia}
              onDownload={(id, generation) => void onDownload(id, generation)}
              apiRef={canvas}
              onGraphChange={onGraphChange}
              onZoomChange={setZoom}
              onInteract={() => setTouched(true)}
              onCanvasFull={() => toast.error(`A workflow can hold ${MAX_NODES} nodes.`)}
              onUpload={onUpload}
              onRun={onRun}
              onEditTake={onEditTake}
              onLayerize={onLayerize}
              onFetchAssetBlob={onFetchAssetBlob}
              onRegisterTextEdit={onRegisterTextEdit}
              panMode={tool === "hand"}
              fitOnMount={initialGraph.nodes.length > 0}
              comments={comments}
              commentMode={tool === "comment"}
              onSelectionChange={onSelectionChange}
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
          libraryOpen={libraryOpen}
          onToggleLibrary={toggleLibrary}
        />

        <LibrarySidebar
          open={libraryOpen}
          onClose={() => setLibraryOpen(false)}
          assets={libraryAssets}
          loading={libraryLoading}
          onRetry={() => void loadLibrary()}
          onReconstruct={(asset) => void onReconstruct(asset)}
          reconstructing={reconstructing}
          onSearch={searchPanelLibrary}
        />

        <AgentSidebar
          open={agentOpen}
          onClose={() => setAgentOpen(false)}
          session={session}
          taggedNode={taggedNode}
          onClearTag={() => setTagDismissed(selectedNodes[0]?.id ?? null)}
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
            instead of one copy disappearing as another appears. Hidden while
            the agent panel is open — the composer in there replaces it. */}
        {!agentOpen && (
          <div
            className={cn(
              "pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4",
              "transition-[padding] duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              // Recentre in what is left of the canvas instead of running under
              // the panel.
              libraryOpen && "sm:pr-[396px]",
            )}
          >
            <div className="pointer-events-auto w-full max-w-[940px]">
              <ViewTransition name="studio-prompt-bar" share="morph">
                <div>
                  <PromptBar
                    catalog={catalog}
                    value={prompt}
                    onChange={setPrompt}
                    onGenerate={onGenerate}
                    onAttach={() => canvas.current?.openFilePicker()}
                    busy={crafting ? "crafting" : false}
                    attachments={barAttachments}
                    onAttachFiles={stageFiles}
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
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
