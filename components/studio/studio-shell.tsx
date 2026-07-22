"use client";

import * as React from "react";
import Image from "next/image";
import { useAuth } from "@clerk/nextjs";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Catalog } from "@/lib/studio/catalog";
import {
  type AssetPreview,
  type Graph,
  EMPTY_GRAPH,
  MAX_NODES,
} from "@/lib/studio/graph";
import { isCreateTool } from "@/lib/studio/node-ui";
import { fetchAssetPreviews, uploadAsset } from "@/lib/studio/assets-client";
import {
  createWorkflow,
  deleteWorkflow,
  loadWorkflow,
  saveWorkflow,
} from "@/app/studio/actions";
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
import { StudioCanvas, type CanvasApi } from "./canvas";
import { Toolbar, type ToolId } from "./toolbar";
import { TopBar, type SaveState } from "./top-bar";
import { PromptBar } from "./prompt-bar";
import { WorkflowCards, type WorkflowCard } from "./workflow-cards";

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const SAVE_DEBOUNCE_MS = 800;

const subscribeNoop = () => () => {};

function greetingForHour(hour: number) {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function StudioShell({
  firstName,
  workflows,
  catalog,
}: {
  firstName: string;
  workflows: WorkflowCard[];
  catalog: Catalog;
}) {
  const [mode, setMode] = React.useState<"home" | "canvas">("home");
  const [tool, setTool] = React.useState<ToolId>("move");
  const [prompt, setPrompt] = React.useState("");
  const [workflowId, setWorkflowId] = React.useState<string | null>(null);
  const [workflowName, setWorkflowName] = React.useState("Untitled workflow");
  const [zoom, setZoom] = React.useState(1);
  const [saveState, setSaveState] = React.useState<SaveState>("saved");
  const [touched, setTouched] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<WorkflowCard | null>(null);
  /**
   * Cards removed locally. Held as ids rather than a copy of the list so the
   * server's own refreshed `workflows` prop stays authoritative — once the row
   * is really gone this filter is simply a no-op, with no state to resync.
   */
  const [deletedIds, setDeletedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Bumped to remount the canvas when a *different* document is loaded. */
  const [session, setSession] = React.useState(0);
  const [seed, setSeed] = React.useState<{
    graph: Graph;
    assets: Record<string, AssetPreview>;
  }>({ graph: EMPTY_GRAPH, assets: {} });

  const { getToken, userId } = useAuth();

  const canvas = React.useRef<CanvasApi | null>(null);
  const modeRef = React.useRef(mode);
  const workflowIdRef = React.useRef<string | null>(null);
  const nameRef = React.useRef(workflowName);
  const graphRef = React.useRef<Graph>(EMPTY_GRAPH);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Serializes saves so a slow request cannot land after a newer one. */
  const savePromise = React.useRef<Promise<unknown>>(Promise.resolve());
  const creating = React.useRef<Promise<string | null> | null>(null);

  React.useEffect(() => {
    modeRef.current = mode;
    workflowIdRef.current = workflowId;
    nameRef.current = workflowName;
  });

  // Local-time greeting: client-only value with an SSR fallback, no effect.
  const greeting = React.useSyncExternalStore(
    subscribeNoop,
    () => greetingForHour(new Date().getHours()),
    () => "Welcome back",
  );

  const authFor = React.useCallback(
    async () => ({
      token: await getToken().catch(() => null),
      userId: userId ?? null,
    }),
    [getToken, userId],
  );

  // --- persistence --------------------------------------------------------

  /** Creates the row on first real content, so an abandoned canvas leaves nothing. */
  const ensureWorkflow = React.useCallback(async (): Promise<string | null> => {
    if (workflowIdRef.current) return workflowIdRef.current;
    // Two edits landing together must not each create a workflow.
    if (creating.current) return creating.current;

    creating.current = (async () => {
      const result = await createWorkflow({ name: nameRef.current });
      if (!result.ok) {
        toast.error(result.error);
        return null;
      }
      workflowIdRef.current = result.data.id;
      setWorkflowId(result.data.id);
      return result.data.id;
    })();

    const id = await creating.current;
    creating.current = null;
    return id;
  }, []);

  const flushSave = React.useCallback(
    (patch: { name?: string; graph?: Graph }) => {
      const run = savePromise.current.then(async () => {
        const id = await ensureWorkflow();
        if (!id) {
          setSaveState("error");
          return;
        }
        const result = await saveWorkflow({ id, ...patch });
        setSaveState(result.ok ? "saved" : "error");
        if (!result.ok) toast.error(result.error);
      });
      savePromise.current = run.catch(() => {});
      return run;
    },
    [ensureWorkflow],
  );

  const scheduleSave = React.useCallback(() => {
    if (modeRef.current !== "canvas") return;
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
      // An empty canvas is not worth a database row yet.
      if (!graph.nodes.length && !workflowIdRef.current) return;
      scheduleSave();
    },
    [scheduleSave],
  );

  // --- navigation ---------------------------------------------------------

  const enterCanvas = React.useCallback(() => setMode("canvas"), []);

  const resetDocument = React.useCallback(() => {
    workflowIdRef.current = null;
    graphRef.current = EMPTY_GRAPH;
    setWorkflowId(null);
    setWorkflowName("Untitled workflow");
    setSeed({ graph: EMPTY_GRAPH, assets: {} });
    setSession((n) => n + 1);
    setSaveState("saved");
    setTouched(false);
  }, []);

  const openWorkflow = React.useCallback(
    async (card: WorkflowCard) => {
      setOpening(true);
      setMode("canvas");
      setWorkflowName(card.name);

      const result = await loadWorkflow(card.id);
      if (!result.ok) {
        toast.error(result.error);
        setOpening(false);
        return;
      }

      // The graph stores only asset ids; presigned preview URLs are minted
      // fresh on open because the previous ones have expired.
      const uploadIds = result.data.graph.nodes
        .filter((n) => n.kind === "input.upload")
        .map((n) => n.data.asset_id)
        .filter((v): v is string => typeof v === "string");
      const assets = uploadIds.length
        ? await fetchAssetPreviews(uploadIds, await authFor())
        : {};

      workflowIdRef.current = result.data.id;
      graphRef.current = result.data.graph;
      setWorkflowId(result.data.id);
      setWorkflowName(result.data.name);
      setSeed({ graph: result.data.graph, assets });
      setSession((n) => n + 1);
      setSaveState("saved");
      setTouched(true);
      setOpening(false);
    },
    [authFor],
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

  const exitCanvas = React.useCallback(() => {
    // Don't let a pending debounce drop the last edit on the way out.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (workflowIdRef.current || graphRef.current.nodes.length) {
        void flushSave({ name: nameRef.current, graph: graphRef.current });
      }
    }
    setMode("home");
    setTool("move");
    setPrompt("");
    resetDocument();
  }, [flushSave, resetDocument]);

  // --- tools --------------------------------------------------------------

  const onToolSelect = React.useCallback(
    (id: ToolId) => {
      if (!isCreateTool(id)) {
        setTool(id);
        if (modeRef.current === "home") enterCanvas();
        return;
      }

      if (modeRef.current === "home") enterCanvas();
      setTouched(true);
      // Placement waits a frame so the node lands in the viewport the user is
      // actually looking at rather than the pre-morph one.
      requestAnimationFrame(() => {
        // "Upload" goes straight to the file picker — placing an empty node
        // first and making the user click it again is a step for nothing.
        if (id === "upload") {
          canvas.current?.openFilePicker();
          return;
        }
        const created = canvas.current?.addNode(id);
        if (!created) toast.error(`A workflow can hold ${MAX_NODES} nodes.`);
      });
    },
    [enterCanvas],
  );

  const onGenerate = React.useCallback(() => {
    const text = prompt.trim();
    if (modeRef.current === "home") enterCanvas();
    setTouched(true);
    requestAnimationFrame(() => {
      const created = canvas.current?.addNode("image", { prompt: text || undefined });
      if (!created) toast.error(`A workflow can hold ${MAX_NODES} nodes.`);
      else setPrompt("");
    });
  }, [prompt, enterCanvas]);

  const onUpload = React.useCallback(
    async (file: File) => {
      const asset = await uploadAsset(file, await authFor());
      if (!asset) toast.error(`Could not upload ${file.name}.`);
      return asset;
    },
    [authFor],
  );

  const onRun = React.useCallback((_nodeId: string, scope: "node" | "chain") => {
    toast(
      scope === "chain" ? "Run from here isn't wired up yet" : "Run isn't wired up yet",
      { description: "The canvas and its graph are saved — execution comes next." },
    );
  }, []);

  // Escape returns home, but only when focus is not in a field.
  React.useEffect(() => {
    if (mode !== "canvas") return;
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
      exitCanvas();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, exitCanvas]);

  const home = mode === "home";

  return (
    <TooltipProvider>
      <div className="fixed inset-0 overflow-hidden bg-[#f7f4ee] text-[#1f211c]">
        {/* Always mounted so the viewport and graph survive the morph. */}
        {/* data-studio-ghost drives the viewport fade from globals.css — see the
            note there on why this isn't a Tailwind variant. */}
        <div
          className={cn("absolute inset-0", home && "pointer-events-none")}
          data-studio-ghost={home}
          aria-hidden={home}
        >
          <StudioCanvas
            key={session}
            catalog={catalog}
            initialGraph={seed.graph}
            initialAssets={seed.assets}
            apiRef={canvas}
            onGraphChange={onGraphChange}
            onZoomChange={setZoom}
            onInteract={() => setTouched(true)}
            onUpload={onUpload}
            onRun={onRun}
            panMode={tool === "hand"}
          />
        </div>

        {/* Warm bloom behind the greeting, fades away on morph. Deliberately no
            dots here — the canvas grid below shows through unfaded, and a second
            copy would double up wherever the two fell in phase. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 transition-opacity duration-700",
            home ? "opacity-100" : "opacity-0",
          )}
          style={{
            background:
              "radial-gradient(640px 420px at 50% 28%, oklch(0.852 0.199 91.936 / 0.16), transparent 70%)",
          }}
        />

        {/* Top-left: brand at home, back + workflow name on canvas */}
        {home ? (
          <div className="fixed top-5 left-5 z-40 animate-[studio-drift-in_0.7s_cubic-bezier(0.32,0.72,0,1)_both]">
            <Image
              src="/assetflow_full_logo.svg"
              alt="Asset Flow"
              width={166}
              height={23}
              priority
            />
          </div>
        ) : (
          <div className="fixed top-4 left-4 z-40 flex h-10 items-center gap-1 border border-[#1f211c]/8 bg-white/88 px-1.5 shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md">
            <button
              type="button"
              aria-label="Back to home"
              onClick={exitCanvas}
              className="grid size-7 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
            >
              <ArrowLeftIcon className="size-4" />
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
        )}

        <TopBar
          visible={!home}
          zoom={zoom}
          onZoomIn={() => canvas.current?.zoomIn()}
          onZoomOut={() => canvas.current?.zoomOut()}
          onZoomReset={() => canvas.current?.resetZoom()}
          onFitView={() => canvas.current?.fitView()}
          saveState={saveState}
        />

        <Toolbar activeTool={tool} onSelect={onToolSelect} />

        {/* Greeting */}
        <div
          aria-hidden={!home}
          className={cn(
            "pointer-events-none fixed inset-x-0 top-[19vh] z-20 px-20 text-center transition-all duration-600 motion-reduce:transition-none",
            home ? "opacity-100" : "-translate-y-6 opacity-0 blur-sm",
          )}
          style={{ transitionTimingFunction: EASE }}
        >
          <h1 className="animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_both] text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.05] font-medium tracking-[-0.02em]">
            {greeting}, <span className="font-serif italic">{firstName}</span>
          </h1>
        </div>

        {/* Canvas empty-state hint, retires after first interaction */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none fixed top-[58%] left-1/2 z-10 -translate-x-1/2 text-center transition-opacity duration-500",
            !home && !touched && !opening ? "opacity-100" : "opacity-0",
          )}
        >
          <p className="text-[13px] text-[#a09a88]">
            Pick a tool to add a node · drop a file to upload · scroll to pan
          </p>
        </div>

        {/* Prompt bar — glides from center stage to the bottom dock */}
        <div
          className="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-4 transition-all duration-700 motion-reduce:transition-none"
          style={{
            transitionTimingFunction: EASE,
            top: home ? "29vh" : "100vh",
            transform: home ? "translateY(0)" : "translateY(calc(-100% - 20px))",
          }}
        >
          <div className="pointer-events-auto w-[min(760px,100%)]">
            <PromptBar
              value={prompt}
              onChange={(v) => {
                setPrompt(v);
                if (v.trim() && modeRef.current === "home") enterCanvas();
              }}
              onGenerate={onGenerate}
              onAttach={() => canvas.current?.openFilePicker()}
            />
          </div>
        </div>

        {/* Previous workflows — exits stage down on morph */}
        <div
          aria-hidden={!home}
          className={cn(
            "fixed inset-x-0 bottom-7 z-20 transition-all duration-500 motion-reduce:transition-none",
            home
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-16 opacity-0",
          )}
          style={{ transitionTimingFunction: EASE }}
        >
          <WorkflowCards
            workflows={visibleWorkflows}
            onOpen={openWorkflow}
            onDelete={setPendingDelete}
            onStartTemplate={(name) => {
              resetDocument();
              setWorkflowName(name);
              nameRef.current = name;
              enterCanvas();
            }}
          />
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
