"use client";

/**
 * The edit studio at `/workflow/{id}/studio/{nodeId}` — the full-page home of
 * the granular take edits (camera angles, relight, magic text) that used to
 * live inside the node expand modal.
 *
 * Left, a control panel headed by the rotary knob that turns between tools;
 * right, the take on a dotted stage with pan and zoom. Generating hands the
 * run straight back to the canvas: the studio starts it and navigates to
 * `/workflow/{id}?run=…&node=…`, where the shell attaches to the stream and
 * the node wears the beam. A magic-text save registers the composite as the
 * node's newest generation and walks back the same way — the canvas
 * re-hydrates it from `/results` on arrival.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import {
  ArrowLeftIcon,
  CornersOutIcon,
  DownloadSimpleIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Position } from "@/lib/studio/graph";
import { fetchAssetPreviews } from "@/lib/studio/assets-client";
import { downloadResult, startRun } from "@/lib/studio/runs-client";
import {
  CAMERA_EDIT_MODEL,
  CAMERA_EDIT_PROVIDER,
  type TakeEditSpec,
  buildTakeEditGraph,
} from "@/lib/studio/camera-edit";
import {
  fetchAssetBlob as fetchAssetBlobApi,
  registerTextEdit as registerTextEditApi,
  requestLayerize,
} from "@/lib/studio/magic-text";
import { LinkGlyph } from "../link-glyph";
import { CameraAnglesPanel } from "../nodes/camera-angles";
import { RelightPanel } from "../nodes/relight";
import {
  MagicTextPanel,
  MagicTextStage,
  type MagicTextServices,
  useMagicText,
} from "../nodes/magic-text";
import { type EditKind, EditKnob } from "./knob";

/** How far the wheel and buttons may push the stage zoom. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Breathing room around the take when it is fitted to the stage. */
const FIT_PADDING = 56;

type Preview =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; url: string; filename: string | null };

type StageView = { scale: number; x: number; y: number };

export function EditStudio({
  workflowId,
  workflowName,
  node,
  assetId,
  initialEdit,
}: {
  workflowId: string;
  workflowName: string;
  /** The canvas node this take belongs to — the run reuses its id. */
  node: { id: string; title: string | null; position: Position };
  /** The stored take being edited. */
  assetId: string;
  initialEdit: EditKind;
}) {
  const router = useRouter();
  const { getToken, userId, isLoaded: authLoaded } = useAuth();

  const authFor = React.useCallback(
    async () => ({
      token: await getToken().catch(() => null),
      userId: userId ?? null,
    }),
    [getToken, userId],
  );

  const [edit, setEdit] = React.useState<EditKind>(initialEdit);
  const [launching, setLaunching] = React.useState(false);

  // Keep the tool in the URL so a reload (or a shared link) reopens on it.
  const selectEdit = React.useCallback((kind: EditKind) => {
    setEdit(kind);
    const url = new URL(window.location.href);
    url.searchParams.set("edit", kind);
    window.history.replaceState(null, "", url);
  }, []);

  // --- the take ------------------------------------------------------------

  const [preview, setPreview] = React.useState<Preview>({ status: "loading" });
  /** Bumped by Try again — a new attempt, where the latch blocks a re-run. */
  const [attempt, setAttempt] = React.useState(0);
  const fetchedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    // Same pre-auth guard as the canvas: a fetch without the caller's
    // identity comes back empty, and the latch would swallow the retry.
    const key = `${assetId}:${attempt}`;
    if (!authLoaded || fetchedFor.current === key) return;
    fetchedFor.current = key;
    void (async () => {
      const found = await fetchAssetPreviews([assetId], await authFor());
      const asset = found[assetId];
      if (asset?.url) {
        setPreview({ status: "ready", url: asset.url, filename: asset.filename });
      } else {
        setPreview({ status: "error" });
      }
    })();
  }, [assetId, attempt, authFor, authLoaded]);

  const retryPreview = React.useCallback(() => {
    setPreview({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  // --- generate → hand the run back to the canvas --------------------------

  const generate = React.useCallback(
    async (spec: TakeEditSpec) => {
      if (launching) return;
      setLaunching(true);
      const graph = buildTakeEditGraph(
        { id: node.id, position: node.position, title: node.title },
        assetId,
        spec,
      );
      const started = await startRun(graph, workflowId, await authFor());
      if (!started.ok) {
        toast.error(started.error);
        setLaunching(false);
        return;
      }
      // The canvas attaches to the stream and the node wears the run;
      // `launching` stays true so Generate holds until the page is gone.
      router.push(
        `/workflow/${workflowId}?run=${started.id}&node=${encodeURIComponent(node.id)}`,
      );
    },
    [assetId, authFor, launching, node, router, workflowId],
  );

  // --- magic text ----------------------------------------------------------

  const services = React.useMemo<MagicTextServices>(
    () => ({
      layerizeAsset: async (id) => requestLayerize(id, await authFor()),
      fetchAssetBlob: async (id) => fetchAssetBlobApi(id, await authFor()),
      registerTextEdit: async (nodeId, image, baseAssetId) =>
        (await registerTextEditApi(
          image,
          { workflowId, nodeId, baseAssetId },
          await authFor(),
        )) !== null,
    }),
    [authFor, workflowId],
  );

  const magic = useMagicText({
    assetId,
    nodeId: node.id,
    services,
    // The edit is registered as the node's newest generation; the canvas
    // re-hydrates it from /results on arrival.
    onSaved: () => router.push(`/workflow/${workflowId}`),
  });

  const textStageLive =
    edit === "text" && magic.phase.name === "ready" && magic.result && magic.blocks;

  // --- stage pan & zoom ----------------------------------------------------

  const stageRef = React.useRef<HTMLDivElement>(null);
  const [imgSize, setImgSize] = React.useState<{ w: number; h: number } | null>(null);
  /** null until the first fit — the image is hidden rather than jumping. */
  const [view, setView] = React.useState<StageView | null>(null);

  const fitView = React.useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !imgSize) return;
    const rect = stage.getBoundingClientRect();
    const scale = Math.min(
      (rect.width - FIT_PADDING * 2) / imgSize.w,
      (rect.height - FIT_PADDING * 2) / imgSize.h,
      1,
    );
    setView({
      scale,
      x: (rect.width - imgSize.w * scale) / 2,
      y: (rect.height - imgSize.h * scale) / 2,
    });
  }, [imgSize]);

  React.useEffect(() => {
    if (imgSize && !view) fitView();
  }, [fitView, imgSize, view]);

  /** Zoom about a stage-local point, keeping it under the cursor. */
  const zoomAt = React.useCallback(
    (px: number, py: number, factor: number) => {
      setView((current) => {
        if (!current) return current;
        const scale = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, current.scale * factor),
        );
        const ratio = scale / current.scale;
        return {
          scale,
          x: px - (px - current.x) * ratio,
          y: py - (py - current.y) * ratio,
        };
      });
    },
    [],
  );

  const zoomCentred = React.useCallback(
    (factor: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      zoomAt(rect.width / 2, rect.height / 2, factor);
    },
    [zoomAt],
  );

  // A React wheel listener would be passive — preventDefault (needed to keep
  // the page from scroll-chaining) requires attaching our own.
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage || textStageLive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.002));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [textStageLive, zoomAt]);

  const dragFrom = React.useRef<{ x: number; y: number; view: StageView } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !view) return;
    dragFrom.current = { x: e.clientX, y: e.clientY, view };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    const from = dragFrom.current;
    if (!from) return;
    setView({
      ...from.view,
      x: from.view.x + (e.clientX - from.x),
      y: from.view.y + (e.clientY - from.y),
    });
  };
  const onStagePointerUp = () => {
    dragFrom.current = null;
  };

  // --- download ------------------------------------------------------------

  const download = React.useCallback(async () => {
    if (preview.status !== "ready") return;
    const name =
      preview.filename ?? `${node.title ?? "assetflow-take"}.png`;
    const saved = await downloadResult(
      { assetId, url: preview.url },
      name,
      await authFor(),
    );
    if (!saved) toast.error("The take could not be downloaded.");
  }, [assetId, authFor, node.title, preview]);

  // --- layout --------------------------------------------------------------

  const back = `/workflow/${workflowId}`;

  return (
    <TooltipProvider>
      <div className="fixed inset-0 flex bg-[#f7f4ee] text-[#1f211c]">
        {/* Control panel */}
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-[#1f211c]/10 bg-white">
          <EditKnob active={edit} onSelect={selectEdit} />

          <div className="thin-scrollbar flex-1 overflow-y-auto px-4 pt-4 pb-5">
            {preview.status === "ready" ? (
              <>
                {/* Closed tools stay mounted so a pose or a selection is
                    still there when the knob turns back. */}
                <div className={cn(edit !== "camera" && "hidden")} inert={edit !== "camera"}>
                  <CameraAnglesPanel
                    imageUrl={preview.url}
                    busy={launching}
                    onGenerate={(params) =>
                      generate({
                        provider: CAMERA_EDIT_PROVIDER,
                        model: CAMERA_EDIT_MODEL,
                        prompt: null,
                        params,
                      })
                    }
                  />
                </div>
                <div className={cn(edit !== "relight" && "hidden")} inert={edit !== "relight"}>
                  <RelightPanel
                    imageUrl={preview.url}
                    busy={launching}
                    onGenerate={generate}
                  />
                </div>
                <div className={cn(edit !== "text" && "hidden")} inert={edit !== "text"}>
                  <MagicTextPanel api={magic} />
                </div>
              </>
            ) : preview.status === "error" ? (
              <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
                <p className="text-[12.5px] leading-5 text-[#4c4a41]">
                  This take could not be loaded.
                </p>
                <button
                  type="button"
                  onClick={retryPreview}
                  className="flex h-8 items-center bg-[#1f211c] px-3 text-[12px] font-semibold text-[#f7f4ee] transition-all duration-150 hover:brightness-125 active:scale-[0.97]"
                >
                  Try again
                </button>
              </div>
            ) : (
              <div className="grid place-items-center py-12">
                <Spinner className="size-5 text-[#8a8271]" />
              </div>
            )}
          </div>

          <p className="shrink-0 px-4 py-3 font-serif text-[12.5px] italic text-[#8a8271]">
            Edits land back on the canvas as a new take.
          </p>
        </aside>

        {/* Stage */}
        <main
          ref={stageRef}
          className={cn(
            "relative min-w-0 flex-1 overflow-hidden",
            !textStageLive && "cursor-grab active:cursor-grabbing",
          )}
          style={{
            backgroundImage: "radial-gradient(rgba(31,33,28,0.22) 1px, transparent 1px)",
            backgroundSize: "26px 26px",
          }}
          onPointerDown={textStageLive ? undefined : onStagePointerDown}
          onPointerMove={textStageLive ? undefined : onStagePointerMove}
          onPointerUp={textStageLive ? undefined : onStagePointerUp}
          onPointerCancel={textStageLive ? undefined : onStagePointerUp}
        >
          {textStageLive && magic.result && magic.blocks ? (
            <MagicTextStage
              result={magic.result}
              blocks={magic.blocks}
              revision={magic.revision}
              selectedId={magic.selectedId}
              onSelect={magic.select}
              onTextChange={magic.setText}
              onPatchBlock={magic.patchBlock}
            />
          ) : preview.status === "ready" ? (
            <div
              className="absolute top-0 left-0 origin-top-left"
              style={
                view
                  ? {
                      transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    }
                  : { visibility: "hidden" }
              }
            >
              {/* Presigned B2 URL on a private bucket — the Next optimizer
                  cannot fetch it, same as everywhere else in the studio. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview.url}
                alt="The take being edited"
                draggable={false}
                onLoad={(e) =>
                  setImgSize({
                    w: e.currentTarget.naturalWidth,
                    h: e.currentTarget.naturalHeight,
                  })
                }
                className="max-w-none select-none shadow-[0_24px_70px_-24px_rgba(31,33,28,0.45)]"
              />
            </div>
          ) : (
            <div className="grid h-full place-items-center">
              {preview.status === "loading" ? (
                <Spinner className="size-6 text-[#8a8271]" />
              ) : (
                <p className="font-serif text-[15px] italic text-[#8a8271]">
                  Nothing to show — the take failed to load.
                </p>
              )}
            </div>
          )}

          {/* The way out, top left — opposite Download, both floating on the
              stage the way the canvas floats its own chrome. Wearing the
              workflow's name so it says where it goes back to. */}
          <Link
            href={back}
            className="absolute top-4 left-4 flex h-9 max-w-[260px] items-center gap-2 border border-[#1f211c]/10 bg-white/88 px-3 text-[12.5px] font-semibold text-[#4c4a41] shadow-[0_18px_44px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md transition-colors duration-150 hover:text-[#1f211c]"
          >
            <LinkGlyph className="size-4 shrink-0">
              <ArrowLeftIcon className="size-4 shrink-0" />
            </LinkGlyph>
            <span className="truncate">{workflowName}</span>
          </Link>

          {/* Download, top right. */}
          <button
            type="button"
            aria-label="Download this take"
            onClick={download}
            disabled={preview.status !== "ready"}
            className="absolute top-4 right-4 flex h-9 items-center gap-2 border border-[#1f211c]/10 bg-white/88 px-3 text-[12.5px] font-semibold text-[#4c4a41] shadow-[0_18px_44px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md transition-colors duration-150 hover:text-[#1f211c] disabled:opacity-50"
          >
            <DownloadSimpleIcon className="size-4" />
            Download
          </button>

          {/* Zoom island — the text stage fits itself, so it steps aside. */}
          {!textStageLive ? (
            <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-0.5 border border-primary bg-white/88 p-1.5 shadow-[0_18px_44px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => zoomCentred(1 / 1.25)}
                className="grid size-8 place-items-center text-[#4c4a41] transition-colors duration-150 hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
              >
                <MagnifyingGlassMinusIcon className="size-[17px]" />
              </button>
              <span className="w-12 text-center text-[11.5px] font-medium text-[#4c4a41] tabular-nums">
                {view ? `${Math.round(view.scale * 100)}%` : "—"}
              </span>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => zoomCentred(1.25)}
                className="grid size-8 place-items-center text-[#4c4a41] transition-colors duration-150 hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
              >
                <MagnifyingGlassPlusIcon className="size-[17px]" />
              </button>
              <span className="mx-1 h-5 w-px bg-[#1f211c]/10" />
              <button
                type="button"
                aria-label="Fit to view"
                onClick={fitView}
                className="grid size-8 place-items-center text-[#4c4a41] transition-colors duration-150 hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
              >
                <CornersOutIcon className="size-[17px]" />
              </button>
            </div>
          ) : (
            <p className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 border border-[#1f211c]/10 bg-white/88 px-3 py-1.5 font-serif text-[12.5px] italic text-[#8a8271] backdrop-blur-md">
              Click a layer on the image to retype it.
            </p>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
