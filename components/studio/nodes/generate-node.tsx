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
  CheckIcon,
  CopyIcon,
  DownloadSimpleIcon,
  LightningIcon,
  PlayIcon,
  TrashIcon,
  WarningIcon,
  WaveformIcon,
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
import { ImageGenIcon, MusicGenIcon, VideoGenIcon } from "../asset-icons";
import { OutputPort, PortRail } from "./ports";
import {
  BarButton,
  BarDivider,
  FloatingBar,
  MoreMenu,
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

const NODE_WIDTH = 440;

const MODALITY_ICON = {
  image: ImageGenIcon,
  video: VideoGenIcon,
  audio: MusicGenIcon,
  text: WaveformIcon,
} as const;

const MODALITY_LABEL = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
} as const;

/** Aspect ratio of the preview well, so the node previews the shape it will produce. */
function previewRatio(params: Record<string, unknown>): string {
  const raw = params.aspect_ratio;
  if (typeof raw !== "string" || !raw.includes(":")) return "4 / 3";
  const [w, h] = raw.split(":");
  return Number(w) > 0 && Number(h) > 0 ? `${w} / ${h}` : "4 / 3";
}

export function GenerateNode({ id, data, selected }: NodeProps<StudioNode>) {
  const { catalog, updateNode, deleteNode, duplicateNode, runFrom } = useStudio();
  const wire = data.wire as unknown as GenerateNodeData;

  const model = findModel(catalog, wire.provider, wire.model);
  const modality = model?.modality ?? wire.modality;
  const ports = visiblePorts(catalog, "generate", model);
  const options = modelsForModality(catalog, modality);

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

  const Icon = MODALITY_ICON[modality] ?? ImageGenIcon;
  const accent = accentFor(modality);
  const promptDriven = connected.has("prompt");

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
  const unavailable = model ? statusReason(model) : null;

  return (
    <div style={{ width: NODE_WIDTH }}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 text-[#8a8271]" />
          <NodeCaption
            value={wire.title ?? ""}
            placeholder={MODALITY_LABEL[modality] ?? "Generate"}
            onChange={(v) => updateNode(id, { title: v || null })}
          />
        </span>
        <span className="mb-1.5 shrink-0 truncate text-[11px] text-[#8a8271]">
          {model?.label ?? "No model"}
        </span>
      </div>

      <NodeCard selected={selected}>
        <PortRail
          ports={ports}
          nodeModality={modality}
          connectedHandles={connected}
          // Anchored to the bottom of the preview well so the text port lands
          // level with the prompt box it feeds.
          className="top-0 bottom-[86px]"
        />
        <OutputPort modality={modality} className="top-11" />

        {/* Preview well */}
        <div
          className="relative flex items-center justify-center border-b border-[#1f211c]/8 bg-[#faf8f4]"
          style={
            modality === "audio"
              ? { height: 120 }
              : { aspectRatio: previewRatio(wire.params ?? {}) }
          }
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <span
              className="grid size-9 place-items-center"
              style={{ background: accent.soft, color: accent.ink }}
            >
              <Icon className="size-4.5" />
            </span>
            <p className="text-[12px] text-[#a09a88]">Your generation will appear here</p>
          </div>
        </div>

        {/* Prompt */}
        <div className="flex items-end gap-2 p-3">
          <textarea
            rows={2}
            value={promptDriven ? "" : (wire.prompt ?? "")}
            disabled={promptDriven}
            onChange={(e) => updateNode(id, { prompt: e.target.value || null })}
            placeholder={
              promptDriven
                ? "Driven by the connected text node"
                : `Describe the ${(MODALITY_LABEL[modality] ?? "output").toLowerCase()}…`
            }
            className="nodrag max-h-28 min-h-11 flex-1 resize-none bg-transparent text-[13px] leading-5 text-[#1f211c] outline-none placeholder:text-[#a09a88] disabled:text-[#a09a88]"
          />

          <div className="nodrag flex shrink-0 items-stretch">
            <button
              type="button"
              onClick={() => runFrom(id, "node")}
              className="flex h-9 items-center gap-1.5 bg-[#1f211c] px-3.5 text-[13px] font-semibold text-[#f7f4ee] transition-all duration-150 hover:brightness-125 active:scale-[0.97]"
            >
              <PlayIcon weight="fill" className="size-3.5" />
              Run
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Run options"
                    className="grid h-9 w-7 place-items-center border-l border-[#f7f4ee]/25 bg-[#1f211c] text-[#f7f4ee] transition-all duration-150 hover:brightness-125"
                  >
                    <CaretDownIcon className="size-3" weight="bold" />
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

      <div className="flex justify-center">
        <FloatingBar>
          {/* Model */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button type="button" className={cn(barChip, "font-semibold text-[#1f211c]")}>
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
              {options.length ? (
                options.map((m) => (
                  <DropdownMenuItem
                    key={`${m.provider}/${m.id}`}
                    onClick={() => selectModel(m)}
                    className="px-2.5 py-2 focus:bg-[#f7f4ee]"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1f211c]">
                        {m.label}
                        {m.status !== "ready" ? (
                          <WarningIcon className="size-3 text-[#a9743f]" weight="fill" />
                        ) : null}
                      </span>
                      <span className="truncate text-[11px] text-[#8a8271]">
                        {m.provider_label}
                      </span>
                    </span>
                    {wire.model === m.id && wire.provider === m.provider ? (
                      <CheckIcon className="ml-auto size-3.5 text-[#1f211c]" weight="bold" />
                    ) : null}
                  </DropdownMenuItem>
                ))
              ) : (
                <p className="px-2.5 py-2 text-[11px] leading-4 text-[#a09a88]">
                  No {modality} models in the catalog yet.
                </p>
              )}
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
          <BarButton label="Download" icon={DownloadSimpleIcon} disabled />
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
    </div>
  );
}
