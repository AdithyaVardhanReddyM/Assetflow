"use client";

/**
 * The generate node — one GenBlaze step on the canvas.
 *
 * Everything variable about it comes from the catalog: which model options
 * exist, which input ports show, and which parameter chips sit in its action
 * bar. Nothing here is keyed off a specific model's identity.
 */

import * as React from "react";
import {
  type NodeProps,
  useNodeConnections,
  useUpdateNodeInternals,
} from "@xyflow/react";
import {
  CaretDownIcon,
  CopyIcon,
  DownloadSimpleIcon,
  LightningIcon,
  PlayIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  type CatalogModel,
  findModel,
  modelsForModality,
  remapParams,
  statusReason,
  visiblePorts,
} from "@/lib/studio/catalog";
import type { GenerateNodeData, StudioNode } from "@/lib/studio/graph";
import { accentFor } from "@/lib/studio/node-ui";
import { useStudio } from "../studio-context";
import { ImageGenIcon, LlmIcon, MusicGenIcon, VideoGenIcon } from "../asset-icons";
import { ModelLogo } from "../model-logos";
import { ModelMenuList } from "../model-menu";
import { OutputPort, PortRail } from "./ports";
import { RunBeam, RunWell, isRunBusy } from "./run-well";
import { ROLE_COPY, ROLE_ICON, ROLE_LABEL } from "./roles";
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
  menuItem,
  menuSurface,
} from "./node-chrome";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
} as const;

const MODALITY_LABEL = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
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

export function GenerateNode({ id, data, selected }: NodeProps<StudioNode>) {
  const { catalog, updateNode, deleteNode, duplicateNode, runFrom, downloadNode } =
    useStudio();
  const wire = data.wire as unknown as GenerateNodeData;

  const model = findModel(catalog, wire.provider, wire.model);
  const modality = model?.modality ?? wire.modality;
  // The model's role wins over its modality where it has one, so the three
  // audio tools do not all render as an identical "Audio" node.
  const role = model?.role ?? "";
  const ports = visiblePorts(catalog, "generate", model);
  // Same role only: a lip-sync node offers the lip-sync models and nothing
  // else, and they never appear on a plain video node — modality alone would
  // mix the two, since both are `video`.
  const options = modelsForModality(catalog, modality).filter(
    (m) => (m.role ?? "") === role,
  );

  const incoming = useNodeConnections({ handleType: "target" });
  const connected = React.useMemo(
    () => new Set(incoming.map((c) => c.targetHandle).filter(Boolean) as string[]),
    [incoming],
  );

  // Changing the model changes which handles exist; React Flow caches handle
  // geometry per node and would keep drawing edges to the old positions.
  const updateNodeInternals = useUpdateNodeInternals();
  const portKey = ports.map((p) => p.id).join(",");
  React.useEffect(() => {
    updateNodeInternals(id);
  }, [id, portKey, updateNodeInternals]);

  const Icon = ROLE_ICON[role] ?? MODALITY_ICON[modality] ?? ImageGenIcon;
  const kindLabel = ROLE_LABEL[role] ?? MODALITY_LABEL[modality] ?? "Generate";
  const accent = accentFor(role || modality);
  const copy = ROLE_COPY[role];
  const promptDriven = connected.has("prompt");
  const ratio = ratioOf(wire.params ?? {}, model);
  const shape = nodeShape(ratio, modality);

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
    updateNode(id, {
      provider: next.provider,
      model: next.id,
      // The compiler fails a node whose declared modality disagrees with its
      // model's, so these two always move together.
      modality: next.modality,
      params: remapParams(wire.params ?? {}, next),
    });
  }

  function setParam(name: string, value: unknown) {
    updateNode(id, { params: { ...(wire.params ?? {}), [name]: value } });
  }

  const basicParams = (model?.params ?? []).filter((p) => (p.group ?? "basic") === "basic");
  const advancedParams = (model?.params ?? []).filter((p) => p.group === "advanced");
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
            disabled={!data.run?.output}
            onClick={() => downloadNode(id)}
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
            While generating it wears the prompt bar's border beam. */}
        <RunBeam active={isRunBusy(data.run)}>
          <div
            className="relative flex items-center justify-center overflow-hidden bg-[#faf8f4]"
            style={{ height: shape.well }}
          >
            <RunWell run={data.run} modality={modality} />
            {data.run ? null : (
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

        {takesPrompt ? (
        <textarea
          rows={2}
          value={promptDriven ? "" : (wire.prompt ?? "")}
          disabled={promptDriven}
          onChange={(e) => updateNode(id, { prompt: e.target.value || null })}
          placeholder={
            promptDriven
              ? // Either a Text node's literal or an LLM node's rewrite — from
                // here they are the same thing: this box no longer decides.
                "Driven by the connected node"
              : (copy?.placeholder ?? `Describe the ${kindLabel.toLowerCase()}…`)
          }
          // `nodrag` keeps a click from dragging the node; `nowheel` keeps the
          // canvas from swallowing the wheel to pan with (`panOnScroll`), which
          // otherwise leaves a long prompt scrollable only by its scrollbar.
          className="nodrag nowheel thin-scrollbar max-h-28 min-h-7 w-full resize-none overflow-y-auto bg-transparent py-0.5 text-[13px] leading-5 text-[#1f211c] outline-none placeholder:text-[#a09a88] disabled:text-[#a09a88]"
        />
        ) : null}

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

      {unavailable ? (
        <p className="mt-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[#a9743f]">
          <WarningIcon className="size-3.5 shrink-0" weight="fill" />
          {unavailable}
        </p>
      ) : null}

    </div>
  );
}
