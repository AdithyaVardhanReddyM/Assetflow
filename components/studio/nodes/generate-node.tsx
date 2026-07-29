"use client";

/**
 * The generate node — one GenBlaze step on the canvas.
 *
 * Everything variable about it comes from the catalog: which model options
 * exist, which input ports show, and which parameter chips sit in its action
 * bar. Nothing here is keyed off a specific model's identity.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type NodeProps,
  useNodeConnections,
  useNodesData,
  useUpdateNodeInternals,
} from "@xyflow/react";
import {
  CaretDownIcon,
  CopyIcon,
  DownloadSimpleIcon,
  LightningIcon,
  PlayIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  type CatalogModel,
  aspectOptionFor,
  findModel,
  modelsForModality,
  remapParams,
  statusReason,
  visiblePorts,
} from "@/lib/studio/catalog";
import type {
  FlowNodeData,
  GenerateNodeData,
  NodeGeneration,
  NodeRunState,
  StudioNode,
} from "@/lib/studio/graph";
import { CHARACTER_SHEET_RATIO, accentFor } from "@/lib/studio/node-ui";
import { useStudio } from "../studio-context";
import { LinkGlyph } from "../link-glyph";
import {
  ImageGenIcon,
  LlmIcon,
  MusicGenIcon,
  ThreeDGenIcon,
  VideoGenIcon,
} from "../asset-icons";
import { ModelLogo } from "../model-logos";
import { ModelMenuList } from "../model-menu";
import { DynamicModelStage } from "../three";
import { OutputPort, PortRail } from "./ports";
import { LoadingWell, RunBeam, RunWell, isRunBusy } from "./run-well";
import {
  PRESET_COPY,
  PRESET_ICON,
  PRESET_LABEL,
  ROLE_COPY,
  ROLE_ICON,
  ROLE_LABEL,
} from "./roles";
import {
  BarButton,
  BarDivider,
  FloatingBar,
  MoreMenu,
  NodeBodyControls,
  NodeCaption,
  NodeCard,
  ParamControl,
  barChip,
  formatParamValue,
  menuItem,
  menuSurface,
} from "./node-chrome";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type ExpandInput,
  DetailChip,
  ExpandButton,
  ExpandDetails,
  ExpandHeader,
  ExpandSectionLabel,
  NodeExpandModal,
  timeAgo,
} from "./expand-modal";
import {
  CaptionedTakeSection,
  CaptionsSection,
  CaptionStage,
  useCaptions,
} from "./captions";

/**
 * The card is inscribed in this box: a landscape node is MAX_WIDTH across, a
 * portrait one is MAX_WIDTH tall. MIN_WIDTH keeps the narrowest ratios wide
 * enough for the prompt row — the well's height still follows from the width,
 * so the shape stays exact.
 */
const MAX_WIDTH = 572;
const MIN_WIDTH = 390;
/** ~70% of MAX_WIDTH — see the note in `nodeShape` on why squares get less. */
const SQUARE_WIDTH = 400;
/**
 * Audio keeps the original 440 and is deliberately left out of the growth
 * above: its well is a fixed strip, not a preview, so a wider card would only
 * add empty space.
 */
const AUDIO_WIDTH = 440;
const AUDIO_WELL_HEIGHT = 120;
/**
 * Text is sized like audio and for the same reason: its result is words, not a
 * picture, so the well is a reading strip rather than a preview. Slightly
 * taller than audio's — a rewritten prompt is a paragraph, not a waveform.
 */
const TEXT_WIDTH = 440;
const TEXT_WELL_HEIGHT = 150;

const MODALITY_ICON = {
  image: ImageGenIcon,
  video: VideoGenIcon,
  audio: MusicGenIcon,
  text: LlmIcon,
  "3d": ThreeDGenIcon,
} as const;

const MODALITY_LABEL = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
  "3d": "3D",
} as const;

/** Landscape unless the node says otherwise — the shape most generations take. */
const DEFAULT_RATIO = "16:9";
/** What a model with no ratio control and no declared output shape falls back to. */
const SQUARE_RATIO = "1:1";

/**
 * The shape this node will produce.
 *
 * A model that exposes an `aspect_ratio` param is steered by the user, so the
 * node's own value wins and the param's default backs it. A model without that
 * param has nothing to steer — lipsync inherits its avatar's framing — so the
 * shape comes from whatever the catalog says it emits, and squares up when the
 * catalog is silent.
 */
function ratioOf(params: Record<string, unknown>, model?: CatalogModel): string {
  const spec = model?.params.find((p) => p.name === "aspect_ratio");
  if (spec) {
    const own = params.aspect_ratio;
    if (typeof own === "string" && own.includes(":")) return own;
    const fallback = spec.default;
    return typeof fallback === "string" && fallback.includes(":")
      ? fallback
      : DEFAULT_RATIO;
  }
  if (!model) return DEFAULT_RATIO;
  const declared = model.output_aspect_ratio;
  return typeof declared === "string" && declared.includes(":") ? declared : SQUARE_RATIO;
}

/**
 * Card width and well height for a ratio. The *node* takes the shape rather
 * than letterboxing a preview inside a fixed frame, so a 9:16 node reads as a
 * portrait card on the canvas at a glance.
 */
function nodeShape(ratio: string, modality: string): { width: number; well: number } {
  if (modality === "audio") return { width: AUDIO_WIDTH, well: AUDIO_WELL_HEIGHT };
  if (modality === "text") return { width: TEXT_WIDTH, well: TEXT_WELL_HEIGHT };

  const [w, h] = ratio.split(":").map(Number);
  const r = w > 0 && h > 0 ? w / h : 16 / 9;
  // A square at the full width covers nearly twice the canvas a 16:9 node does,
  // so squares inscribe in a smaller box. Landscape and portrait keep theirs.
  const box = Math.abs(r - 1) < 0.01 ? SQUARE_WIDTH : MAX_WIDTH;
  const width = Math.round(
    Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, r >= 1 ? box : MAX_WIDTH * r)),
  );
  return { width, well: Math.round(width / r) };
}

/**
 * The strip of this node's recent takes, under the prompt box. Newest first;
 * the active one is drawn larger, and picking one swaps it into the well so
 * two generations can be compared without losing either. Media only — an
 * LLM's takes are paragraphs, and a filmstrip of paragraphs reads as noise.
 */
function GenerationCarousel({
  history,
  activeId,
  onSelect,
}: {
  history: NodeGeneration[];
  /** null selects the newest — the state every fresh generation resets to. */
  activeId: string | null;
  onSelect: (assetId: string | null) => void;
}) {
  return (
    <div className="nodrag nowheel thin-scrollbar mt-1.5 flex items-center justify-center gap-1.5 overflow-x-auto px-1 py-1">
      {history.map((gen, i) => {
        const active = activeId ? gen.assetId === activeId : i === 0;
        const isVideo = gen.mediaType?.startsWith("video/");
        const isAudio = gen.mediaType?.startsWith("audio/");
        // A GLB has no still to shrink — a glyph tile, like audio's.
        const isModel = gen.mediaType?.startsWith("model/");
        return (
          <button
            key={gen.assetId ?? gen.url ?? i}
            type="button"
            aria-label={`Generation ${history.length - i} of ${history.length}`}
            aria-current={active || undefined}
            onClick={() => onSelect(i === 0 ? null : gen.assetId)}
            className={cn(
              "relative shrink-0 overflow-hidden bg-[#faf8f4] transition-all duration-150",
              active
                ? "size-14 border-2 border-[#1f211c]"
                : "size-10 border border-[#1f211c]/15 opacity-75 hover:opacity-100",
            )}
          >
            {isAudio || isModel || !gen.url ? (
              <span className="grid h-full w-full place-items-center text-[#a09a88]">
                {isModel ? (
                  <ThreeDGenIcon className="size-4" />
                ) : (
                  <MusicGenIcon className="size-4" />
                )}
              </span>
            ) : isVideo ? (
              // First frame as the thumbnail; playback stays in the well.
              <video
                src={gen.url}
                muted
                playsInline
                preload="metadata"
                className="pointer-events-none h-full w-full object-cover"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={gen.url}
                alt=""
                className="pointer-events-none h-full w-full object-cover"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The words a prompt-driven node will actually run with: a Text node's literal,
 * or an LLM node's rewrite once it has produced one. From here the two are the
 * same thing — text arriving from upstream — so both read out identically.
 *
 * Empty is a real state, not a failure: an LLM that has not run yet has nothing
 * to show, and neither has an empty Text node.
 */
function drivingText(source: { data: FlowNodeData } | undefined): string {
  if (!source) return "";
  if (source.data.kind === "input.text") {
    const text = source.data.wire.text;
    return typeof text === "string" ? text.trim() : "";
  }
  return source.data.run?.output?.text?.trim() ?? "";
}

/**
 * What an upstream node currently shows, as a modal input thumbnail. Media
 * only — an audio source or an LLM has nothing a thumbnail could depict.
 */
function sourceThumb(node: { data: FlowNodeData } | undefined): ExpandInput | null {
  if (!node) return null;
  const d = node.data;
  if (d.kind === "input.upload") {
    if (!d.asset) return null;
    if (d.asset.modality !== "image" && d.asset.modality !== "video") return null;
    return { url: d.asset.url, isVideo: d.asset.modality === "video" };
  }
  const out = d.history?.[0] ?? (d.run?.status === "succeeded" ? d.run.output : null);
  const url = out?.url ?? null;
  const mediaType = out?.mediaType ?? null;
  if (!url || !mediaType) return null;
  if (!mediaType.startsWith("image/") && !mediaType.startsWith("video/")) return null;
  return { url, isVideo: mediaType.startsWith("video/") };
}

export function GenerateNode({ id, data, selected }: NodeProps<StudioNode>) {
  const {
    catalog,
    updateNode,
    deleteNode,
    duplicateNode,
    runFrom,
    downloadNode,
    refreshMedia,
  } = useStudio();
  const wire = data.wire as unknown as GenerateNodeData;

  const model = findModel(catalog, wire.provider, wire.model);
  const modality = model?.modality ?? wire.modality;
  // The model's role wins over its modality where it has one, so the three
  // audio tools do not all render as an identical "Audio" node.
  const role = model?.role ?? "";
  // A preset ("character_sheet") is the node's own specialization — sharper
  // than role or modality, so it wins the icon, the copy, and the picker.
  const preset = wire.preset ?? "";
  const ports = visiblePorts(catalog, "generate", model);
  // Same role only: a lip-sync node offers the lip-sync models and nothing
  // else, and they never appear on a plain video node — modality alone would
  // mix the two, since both are `video`. A character sheet narrows further,
  // to the image models that can actually emit its 16:9 canvas.
  const options = modelsForModality(catalog, modality).filter(
    (m) =>
      (m.role ?? "") === role &&
      (preset !== "character_sheet" ||
        aspectOptionFor(m, CHARACTER_SHEET_RATIO) !== null),
  );

  const incoming = useNodeConnections({ handleType: "target" });
  const connected = React.useMemo(
    () => new Set(incoming.map((c) => c.targetHandle).filter(Boolean) as string[]),
    [incoming],
  );

  // Whatever is wired into `prompt`, so the box can read out its text rather
  // than only announce that it exists. At most one edge lands here — a
  // single-connection port replaces rather than accumulates — so the first
  // connection is the one driving this node.
  const promptSourceIds = React.useMemo(
    () =>
      incoming
        .filter((c) => c.targetHandle === "prompt")
        .slice(0, 1)
        .map((c) => c.source),
    [incoming],
  );
  const promptSource = useNodesData<StudioNode>(promptSourceIds)[0];

  // Whatever is wired into the media ports — the modal shows their previews as
  // the generation's inputs (the start/end frames, the reference images).
  const mediaSourceIds = React.useMemo(
    () =>
      Array.from(
        new Set(
          incoming.filter((c) => c.targetHandle !== "prompt").map((c) => c.source),
        ),
      ),
    [incoming],
  );
  const mediaSources = useNodesData<StudioNode>(mediaSourceIds);
  const inputThumbs = React.useMemo(
    () => mediaSources.map(sourceThumb).filter((t): t is ExpandInput => t !== null),
    [mediaSources],
  );

  // Changing the model changes which handles exist; React Flow caches handle
  // geometry per node and would keep drawing edges to the old positions.
  const updateNodeInternals = useUpdateNodeInternals();
  const portKey = ports.map((p) => p.id).join(",");
  React.useEffect(() => {
    updateNodeInternals(id);
  }, [id, portKey, updateNodeInternals]);

  const Icon =
    PRESET_ICON[preset] ?? ROLE_ICON[role] ?? MODALITY_ICON[modality] ?? ImageGenIcon;
  const kindLabel =
    PRESET_LABEL[preset] ?? ROLE_LABEL[role] ?? MODALITY_LABEL[modality] ?? "Generate";
  const accent = accentFor(role || modality);
  const copy = PRESET_COPY[preset] ?? ROLE_COPY[role];
  const promptDriven = connected.has("prompt");
  const drivenText = promptDriven ? drivingText(promptSource) : "";

  // --- generation history -------------------------------------------------

  const history = React.useMemo(
    () => (modality === "text" ? [] : (data.history ?? [])),
    [modality, data.history],
  );
  /** null shows the newest take; an id pins an earlier one for comparison. */
  const [pinnedId, setPinnedId] = React.useState<string | null>(null);
  // A fresh generation always takes the stage: the pin resets to newest.
  const newestId = history[0]?.assetId ?? null;
  React.useEffect(() => {
    setPinnedId(null);
  }, [newestId]);

  // While a run is in flight or has just failed, the live state owns the well;
  // otherwise the pinned take (or the newest) is what's on show.
  const liveOwnsWell =
    isRunBusy(data.run) ||
    data.run?.status === "failed" ||
    data.run?.status === "skipped";
  const displayed = liveOwnsWell
    ? undefined
    : ((pinnedId ? history.find((g) => g.assetId === pinnedId) : undefined) ??
      history[0]);
  /**
   * Nothing to show *yet* — the canvas is still fetching this node's past
   * generations. Distinct from having none, which is what the empty state is
   * for; a node with a result must never spend that fetch claiming to be new.
   */
  const loading = Boolean(data.hydrating) && !history.length && !data.run;
  const wellRun: NodeRunState | undefined = displayed
    ? {
        status: "succeeded",
        progress: 1,
        output: {
          url: displayed.url,
          mediaType: displayed.mediaType,
          text: displayed.text ?? null,
        },
      }
    : data.run;

  // The displayed take's real dimensions beat the requested ratio param, so
  // the card reshapes when the carousel switches to a differently-framed take
  // — and `nodeShape` already re-measures handles when the geometry moves.
  // Asset rows don't always record dimensions (a provider may not report
  // them), so the well also measures the media as it loads and that fills in.
  const [measured, setMeasured] = React.useState<
    Record<string, { w: number; h: number }>
  >({});
  const displayedKey = displayed?.assetId ?? displayed?.url ?? null;
  const onMediaSize = React.useCallback(
    (w: number, h: number) => {
      if (!displayedKey) return;
      setMeasured((current) =>
        current[displayedKey]?.w === w && current[displayedKey]?.h === h
          ? current
          : { ...current, [displayedKey]: { w, h } },
      );
    },
    [displayedKey],
  );
  const dims =
    displayed?.width && displayed?.height
      ? { w: displayed.width, h: displayed.height }
      : displayedKey
        ? measured[displayedKey]
        : undefined;
  const ratio = dims ? `${dims.w}:${dims.h}` : ratioOf(wire.params ?? {}, model);
  const shape = nodeShape(ratio, modality);

  // --- expand modal -------------------------------------------------------

  const [expanded, setExpanded] = React.useState(false);
  // Only a settled visual take expands — audio and text have no full-size
  // view, and a busy or failed well has nothing to blow up yet. 3D counts as
  // visual: its full-size view is the orbitable stage.
  const expandMedia =
    !liveOwnsWell &&
    displayed?.url &&
    (modality === "image" || modality === "video" || modality === "3d")
      ? {
          url: displayed.url,
          isVideo:
            modality === "video" || Boolean(displayed.mediaType?.startsWith("video/")),
        }
      : null;
  /**
   * The take the edit studio would open on. The granular tools (camera,
   * relight, magic text) need a *stored* still — the take travels to the
   * studio by asset id, so a mid-run URL with no asset row behind it (or a
   * video) has nothing to edit. A character sheet's take is three fixed
   * panels, not a scene to orbit — no studio.
   */
  const editAssetId =
    expandMedia && !expandMedia.isVideo && modality === "image" && !preset
      ? (displayed?.assetId ?? null)
      : null;

  // The canvas lives at /workflow/{id}; the studio is a sub-route of it, so
  // the workflow id doesn't need to travel through the node context.
  const pathname = usePathname();
  const studioHref = editAssetId
    ? `${pathname}/studio/${id}?asset=${editAssetId}`
    : null;

  // Captions target the displayed video take; inert for stills and audio —
  // and for a take that is itself a caption burn, which only offers removal.
  // A mid-run URL with no asset row behind it can't be transcribed — the
  // shell resolves null to the node's latest *stored* result.
  const videoTake = expandMedia?.isVideo ? expandMedia : null;
  const captionedTake = Boolean(videoTake && displayed?.captioned);
  const captions = useCaptions({
    nodeId: id,
    assetId: displayed?.assetId ?? null,
    takeKey:
      videoTake && !captionedTake ? (displayed?.assetId ?? videoTake.url) : null,
  });

  // A model driven entirely by its ports has nothing to describe, so it shows
  // neither the text box nor the port that would fill it.
  const takesPrompt = model?.requires_prompt !== false;

  // The rail is split across two surfaces: media inputs sit beside the preview,
  // `prompt` beside the prompt box it fills.
  const promptPort = takesPrompt ? ports.find((p) => p.id === "prompt") : undefined;
  const mediaPorts = ports.filter((p) => p.id !== "prompt");

  // The card's width is part of its geometry, so React Flow has to re-measure
  // the handles when the ratio changes or edges keep their old endpoints.
  React.useEffect(() => {
    updateNodeInternals(id);
  }, [id, shape.width, shape.well, updateNodeInternals]);

  function selectModel(next: CatalogModel) {
    let params = remapParams(wire.params ?? {}, next);
    if (preset === "character_sheet") {
      // Locked to the sheet's canvas, in whatever spelling this provider's
      // enum uses ("16:9", or Runway's "1920:1080").
      const option = aspectOptionFor(next, CHARACTER_SHEET_RATIO);
      if (option) params = { ...params, aspect_ratio: option };
    }
    updateNode(id, {
      provider: next.provider,
      model: next.id,
      // The compiler fails a node whose declared modality disagrees with its
      // model's, so these two always move together.
      modality: next.modality,
      params,
    });
  }

  function setParam(name: string, value: unknown) {
    updateNode(id, { params: { ...(wire.params ?? {}), [name]: value } });
  }

  // A character sheet's ratio is not the user's to pick — the chip disappears
  // rather than offering a choice the compiler would overrule.
  const lockedParams = preset === "character_sheet" ? ["aspect_ratio"] : [];
  const basicParams = (model?.params ?? []).filter(
    (p) => (p.group ?? "basic") === "basic" && !lockedParams.includes(p.name),
  );
  const advancedParams = (model?.params ?? []).filter(
    (p) => p.group === "advanced" && !lockedParams.includes(p.name),
  );
  // Full-width controls that sit in the node body (the lyrics box, the voice
  // picker) rather than shrinking into a bar chip.
  const bodyParams = (model?.params ?? []).filter((p) => p.group === "body");
  const unavailable = model ? statusReason(model) : null;

  return (
    <div style={{ width: shape.width }}>
      {/* Properties, above the preview they act on. */}
      <div className="flex justify-center">
        <FloatingBar className="mt-0 mb-2">
          {/* Model */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button type="button" className={cn(barChip, "font-semibold text-[#1f211c]")}>
                  {model ? (
                    <ModelLogo
                      provider={model.provider}
                      modelId={model.id}
                      label={model.label}
                      size="sm"
                    />
                  ) : null}
                  <span className="max-w-28 truncate">{model?.label ?? "Pick a model"}</span>
                  <CaretDownIcon className="size-3 text-[#a09a88]" />
                </button>
              }
            />
            <DropdownMenuContent
              align="start"
              side="bottom"
              sideOffset={8}
              className={cn(menuSurface, "w-72 p-1.5")}
            >
              <ModelMenuList
                models={options}
                selected={{ provider: wire.provider, id: wire.model }}
                onSelect={selectModel}
                emptyLabel={`No ${modality} models in the catalog yet.`}
              />
            </DropdownMenuContent>
          </DropdownMenu>

          {basicParams.length ? <BarDivider /> : null}
          {basicParams.map((param) => (
            <ParamControl
              key={param.name}
              param={param}
              value={(wire.params ?? {})[param.name]}
              onChange={(v) => setParam(param.name, v)}
            />
          ))}

          <BarDivider />
          <BarButton
            label="Download"
            icon={DownloadSimpleIcon}
            disabled={!data.run?.output && !history.length}
            // Saves what the well is showing — a pinned earlier take included.
            onClick={() => downloadNode(id, displayed ?? undefined)}
          />
          <BarButton label="Delete" icon={TrashIcon} danger onClick={() => deleteNode(id)} />
          <MoreMenu>
            <DropdownMenuItem onClick={() => duplicateNode(id)} className={menuItem}>
              <CopyIcon className="size-3.5" />
              Duplicate
            </DropdownMenuItem>
            {advancedParams.length ? (
              <>
                <div className="mt-1 px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.04em] text-[#a09a88] uppercase">
                  Advanced
                </div>
                {advancedParams.map((param) => (
                  <div key={param.name} className="flex items-center justify-between gap-2 px-1.5 py-0.5">
                    <span className="text-[11px] text-[#4c4a41]">
                      {param.label ?? param.name}
                    </span>
                    <ParamControl
                      param={param}
                      value={(wire.params ?? {})[param.name]}
                      onChange={(v) => setParam(param.name, v)}
                    />
                  </div>
                ))}
              </>
            ) : null}
          </MoreMenu>
        </FloatingBar>
      </div>

      <NodeCard selected={selected}>
        {/* Media inputs belong to the preview; `prompt` rides with the prompt
            box below, so each port sits beside the thing it actually feeds. */}
        <PortRail
          ports={mediaPorts}
          nodeModality={modality}
          connectedHandles={connected}
          className="inset-y-0 justify-center"
        />
        <OutputPort
          modality={modality}
          role={role}
          className="top-1/2 -translate-y-1/2"
        />

        {/* Preview well — the card's own shape, not a frame matted inside one.
            While generating it wears the prompt bar's border beam, and while
            the canvas is still fetching what this node holds, the same one. */}
        <RunBeam active={isRunBusy(data.run) || loading}>
          <div
            className="group relative flex items-center justify-center overflow-hidden bg-[#faf8f4]"
            style={{ height: shape.well }}
          >
            <RunWell
              run={wellRun}
              modality={modality}
              assetId={displayed?.assetId}
              onMediaSize={onMediaSize}
              onStale={(assetId) => refreshMedia(id, assetId)}
            />
            {expandMedia ? <ExpandButton onClick={() => setExpanded(true)} /> : null}
            {wellRun ? null : loading ? (
              <LoadingWell />
            ) : (
              <div className="flex flex-col items-center gap-2.5 px-3 text-center">
                <span
                  className="grid size-10 place-items-center"
                  style={{ background: accent.soft, color: accent.ink }}
                >
                  <Icon className="size-5" />
                </span>
                <p className="text-[11.5px] tracking-[0.01em] text-[#a09a88]">
                  {copy?.well ?? `Your ${kindLabel.toLowerCase()} will appear here`}
                </p>
              </div>
            )}
          </div>
        </RunBeam>
      </NodeCard>

      {/* Body controls — the model's central choices (a voice, a lyrics box)
          at full width, catalog-driven off `group: "body"`. */}
      {bodyParams.length ? (
        <NodeCard selected={selected} className="mt-1.5 p-2.5">
          <NodeBodyControls
            params={bodyParams}
            values={wire.params ?? {}}
            onChange={setParam}
          />
        </NodeCard>
      ) : null}

      {/* Prompt — its own surface, detached from the preview card. Its footer
          carries the node's whole identity (name and model), so what will run
          sits with the text that drives it. */}
      <NodeCard selected={selected} className="mt-1.5 flex flex-col gap-1.5 p-2.5">
        {promptPort ? (
          <PortRail
            ports={[promptPort]}
            nodeModality={modality}
            connectedHandles={connected}
            className="inset-y-0 justify-center"
          />
        ) : null}

        {!takesPrompt ? null : promptDriven ? (
          // Connected, so this row stops being an input and becomes a readout
          // of the upstream text — held in a chip to say the words are the
          // connection's, not something typed here. Until there are any (an
          // empty Text node, an LLM that has not run), the chip states the fact
          // of the connection instead.
          <div className="flex min-h-7 items-center py-0.5">
            <span
              title={drivenText || undefined}
              className={cn(
                "line-clamp-2 max-w-full bg-[#1f211c]/6 px-2 py-1 text-[13px] leading-5 break-words",
                drivenText ? "text-[#4c4a41]" : "text-[#8a8271]",
              )}
            >
              {drivenText || "Prompt connected"}
            </span>
          </div>
        ) : (
          <textarea
            rows={2}
            value={wire.prompt ?? ""}
            onChange={(e) => updateNode(id, { prompt: e.target.value || null })}
            placeholder={
              // Hunyuan's payload is prompt XOR image_url — with a reference
              // wired, whatever is typed here never reaches the model.
              modality === "3d" && connected.has("image_ref")
                ? "Reference image drives this — the prompt is ignored"
                : (copy?.placeholder ?? `Describe the ${kindLabel.toLowerCase()}…`)
            }
            // `nodrag` keeps a click from dragging the node; `nowheel` keeps the
            // canvas from swallowing the wheel to pan with (`panOnScroll`), which
            // otherwise leaves a long prompt scrollable only by its scrollbar.
            className="nodrag nowheel thin-scrollbar max-h-28 min-h-7 w-full resize-none overflow-y-auto bg-transparent py-0.5 text-[13px] leading-5 text-[#1f211c] outline-none placeholder:text-[#a09a88]"
          />
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-[#8a8271]">
            <Icon className="size-3.5 shrink-0" />
            {/* Sized to its own text so the separator sits right after the
                name; `min-w-0` still lets it compress on a narrow ratio. */}
            <NodeCaption
              value={wire.title ?? ""}
              placeholder={kindLabel}
              onChange={(v) => updateNode(id, { title: v || null })}
              className="mb-0 min-w-0 shrink truncate px-0"
              style={{
                width: `${Math.max((wire.title ?? kindLabel).length, 4) + 1}ch`,
              }}
            />
            {/* Both truncate, so a long name and a long model id share the row
                instead of one pushing Run off the edge on a narrow ratio. */}
            <span className="shrink-0 text-[#cfc8b7]">·</span>
            {model ? (
              <ModelLogo
                provider={model.provider}
                modelId={model.id}
                label={model.label}
                size="sm"
                className="text-[#8a8271]"
              />
            ) : null}
            <span className="max-w-[45%] shrink-0 truncate">
              {model?.label ?? "No model"}
            </span>
          </span>

          <div className="nodrag flex shrink-0 items-stretch">
            <button
              type="button"
              onClick={() => runFrom(id, "node")}
              className="flex h-7 items-center gap-1.5 bg-[#1f211c] px-2.5 text-[12px] font-semibold text-[#f7f4ee] transition-all duration-150 hover:brightness-125 active:scale-[0.97]"
            >
              <PlayIcon weight="fill" className="size-3" />
              Run
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Run options"
                    className="grid h-7 w-5 place-items-center border-l border-[#f7f4ee]/25 bg-[#1f211c] text-[#f7f4ee] transition-all duration-150 hover:brightness-125"
                  >
                    <CaretDownIcon className="size-2.5" weight="bold" />
                  </button>
                }
              />
              <DropdownMenuContent
                align="end"
                side="top"
                sideOffset={8}
                className={cn(menuSurface, "w-56 p-1.5")}
              >
                <DropdownMenuItem onClick={() => runFrom(id, "node")} className={menuItem}>
                  <PlayIcon className="size-3.5" />
                  Run this node
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => runFrom(id, "chain")} className={menuItem}>
                  <LightningIcon className="size-3.5" />
                  <span className="flex flex-col">
                    Run from here
                    <span className="text-[10px] font-normal text-[#a09a88]">
                      This node and everything downstream
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </NodeCard>

      {/* Earlier takes, newest first. Appears once there is something to
          compare against — a single generation is already on the well. */}
      {history.length > 1 ? (
        <GenerationCarousel
          history={history}
          activeId={pinnedId}
          onSelect={setPinnedId}
        />
      ) : null}

      {unavailable ? (
        <p className="mt-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[#a9743f]">
          <WarningIcon className="size-3.5 shrink-0" weight="fill" />
          {unavailable}
        </p>
      ) : null}

      {expandMedia ? (
        <NodeExpandModal
          open={expanded}
          onOpenChange={setExpanded}
          media={expandMedia}
          stage={
            modality === "3d" ? (
              <DynamicModelStage url={expandMedia.url} />
            ) : videoTake && captions.stageActive ? (
              <CaptionStage url={videoTake.url} captions={captions} />
            ) : undefined
          }
        >
          {(() => {
            const detailProps = {
              prompt: (promptDriven ? drivenText : (wire.prompt ?? "")) || null,
              inputs: inputThumbs,
              chips: (
                <>
                  {model ? (
                    <DetailChip>
                      <ModelLogo
                        provider={model.provider}
                        modelId={model.id}
                        label={model.label}
                        size="sm"
                      />
                      <span className="max-w-36 truncate">{model.label}</span>
                    </DetailChip>
                  ) : null}
                  {(model?.params ?? [])
                    .filter((p) => (p.group ?? "basic") !== "body")
                    .map((param) => {
                      const text = formatParamValue(
                        param,
                        (wire.params ?? {})[param.name],
                      );
                      if (text === "—") return null;
                      return (
                        <DetailChip key={param.name}>
                          {/* A bare "On" says nothing — booleans keep their name. */}
                          {param.type === "boolean"
                            ? `${param.label ?? param.name} ${text}`
                            : text}
                        </DetailChip>
                      );
                    })}
                </>
              ),
            };
            const when = timeAgo(displayed?.createdAt);
            const size = dims ? `${dims.w} × ${dims.h} px` : null;

            // A video take's one tool is captions; stills route to the studio.
            if (videoTake) {
              return (
                <div className="flex min-h-full flex-col">
                  <ExpandHeader
                    title={kindLabel}
                    meta={[when, size].filter(Boolean).join(" · ") || null}
                    onDownload={() => downloadNode(id, displayed ?? undefined)}
                  />
                  <ExpandSectionLabel>Captions</ExpandSectionLabel>
                  <div className="px-5 pb-5">
                    {captionedTake ? (
                      <CaptionedTakeSection
                        nodeId={id}
                        assetId={displayed?.assetId ?? null}
                      />
                    ) : (
                      <CaptionsSection captions={captions} />
                    )}
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col">
                    <ExpandDetails footer={size} {...detailProps} />
                  </div>
                </div>
              );
            }

            // Nothing to edit — the fact sheet is the whole column.
            if (!studioHref) {
              return (
                <ExpandDetails
                  heading={when ?? kindLabel}
                  onDownload={() => downloadNode(id, displayed ?? undefined)}
                  footer={size}
                  {...detailProps}
                />
              );
            }

            return (
              <div className="flex min-h-full flex-col">
                <ExpandHeader
                  title={kindLabel}
                  meta={[when, size].filter(Boolean).join(" · ") || null}
                  onDownload={() => downloadNode(id, displayed ?? undefined)}
                />

                {/* The granular edits — camera, relight, magic text — live on
                    their own page now, where the take gets a whole canvas. */}
                <div className="px-5 pb-5">
                  <Link
                    href={studioHref}
                    className="flex h-9 w-full items-center justify-center gap-2 bg-primary text-[13px] font-semibold text-primary-foreground transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97]"
                  >
                    <LinkGlyph className="size-4">
                      <SlidersHorizontalIcon className="size-4" weight="bold" />
                    </LinkGlyph>
                    Open in Studio
                  </Link>
                </div>

                <div className="flex min-h-0 flex-1 flex-col border-t border-[#1f211c]/10">
                  <ExpandDetails footer={size} {...detailProps} />
                </div>
              </div>
            );
          })()}
        </NodeExpandModal>
      ) : null}
    </div>
  );
}
