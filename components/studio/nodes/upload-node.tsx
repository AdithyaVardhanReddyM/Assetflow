"use client";

/**
 * A file the user brought in. The bytes live in B2 with their own provenance
 * manifest; this node holds only the `asset_id`, and the preview is hydrated
 * from the assets table at load time rather than persisted in the graph.
 */

import * as React from "react";
import { type NodeProps } from "@xyflow/react";
import {
  ArrowsClockwiseIcon,
  CopyIcon,
  DownloadSimpleIcon,
  LightningIcon,
  SpinnerIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { StudioNode, UploadNodeData } from "@/lib/studio/graph";
import { accentFor } from "@/lib/studio/node-ui";
import { useStudio } from "../studio-context";
import { OutputPort } from "./ports";
import {
  BarButton,
  BarDivider,
  FloatingBar,
  MoreMenu,
  NodeCaption,
  NodeCard,
  barChip,
  menuItem,
} from "./node-chrome";
import {
  DetailChip,
  ExpandButton,
  ExpandDetails,
  NodeExpandModal,
} from "./expand-modal";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

const NODE_WIDTH = 260;

export function UploadNode({ id, data, selected }: NodeProps<StudioNode>) {
  const { updateNode, deleteNode, duplicateNode, pickFileFor, runFrom } = useStudio();
  const wire = data.wire as unknown as UploadNodeData;
  const asset = data.asset;
  const uploading = data.uploading ?? false;
  const accent = accentFor(asset?.modality ?? "any");

  const [expanded, setExpanded] = React.useState(false);
  // Audio has no full-size view — only a visual asset offers the expand.
  const expandMedia =
    !uploading && asset && (asset.modality === "image" || asset.modality === "video")
      ? { url: asset.url, isVideo: asset.modality === "video" }
      : null;

  return (
    <div style={{ width: NODE_WIDTH }}>
      <NodeCaption
        value={wire.title ?? ""}
        placeholder={asset?.filename ?? "Upload"}
        onChange={(v) => updateNode(id, { title: v || null })}
      />

      <NodeCard selected={selected} className="group overflow-hidden">
        <OutputPort modality={asset?.modality ?? "any"} className="top-4" />

        <div className="relative flex min-h-44 items-center justify-center bg-[#faf8f4]">
          {expandMedia ? <ExpandButton onClick={() => setExpanded(true)} /> : null}
          {uploading ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <SpinnerIcon className="size-5 animate-spin text-[#8a8271]" />
              <p className="text-[12px] text-[#a09a88]">Uploading to B2…</p>
            </div>
          ) : asset ? (
            <>
              {asset.modality === "video" ? (
                <video
                  src={asset.url}
                  className="block w-full"
                  muted
                  playsInline
                  preload="metadata"
                />
              ) : asset.modality === "audio" ? (
                <div className="flex w-full flex-col gap-2 p-4">
                  <span
                    className="grid size-9 place-items-center"
                    style={{ background: accent.soft, color: accent.ink }}
                  >
                    <UploadSimpleIcon className="size-4.5" />
                  </span>
                  <audio src={asset.url} controls className="w-full" />
                </div>
              ) : (
                // Plain <img>: these are short-lived presigned B2 URLs on a
                // private bucket, which the Next image optimizer can neither
                // cache usefully nor be allowed to proxy by remote pattern.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={asset.url}
                  alt={wire.title ?? asset.filename ?? "Uploaded image"}
                  className="block w-full object-cover"
                />
              )}

              <button
                type="button"
                onClick={() => runFrom(id, "chain")}
                className="nodrag absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 bg-[#1f211c] px-3 py-1.5 text-[12px] font-semibold text-[#f7f4ee] opacity-0 shadow-[0_8px_20px_-6px_rgba(31,33,28,0.6)] transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <LightningIcon weight="fill" className="size-3.5" />
                Run from here
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => pickFileFor(id)}
              className="nodrag flex w-full flex-col items-center gap-2 px-4 py-10 text-center transition-colors hover:bg-[#1f211c]/3"
            >
              <span
                className="grid size-9 place-items-center"
                style={{ background: accent.soft, color: accent.ink }}
              >
                <UploadSimpleIcon className="size-4.5" />
              </span>
              <span className="text-[12px] font-medium text-[#4c4a41]">Choose a file</span>
              <span className="text-[11px] text-[#a09a88]">Image, video or audio</span>
            </button>
          )}
        </div>
      </NodeCard>

      {!asset && !uploading ? (
        <p className="mt-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[#a9743f]">
          <WarningIcon className="size-3.5 shrink-0" weight="fill" />
          No file attached yet
        </p>
      ) : null}

      <div className="flex justify-center">
        <FloatingBar>
          <button
            type="button"
            onClick={() => pickFileFor(id)}
            className={cn(barChip, "font-semibold text-[#1f211c]")}
          >
            <ArrowsClockwiseIcon className="size-3.5" />
            {asset ? "Replace" : "Upload"}
          </button>
          <BarDivider />
          <BarButton
            label="Download"
            icon={DownloadSimpleIcon}
            disabled={!asset}
            onClick={() => asset && window.open(asset.url, "_blank", "noopener,noreferrer")}
          />
          <BarButton label="Delete" icon={TrashIcon} danger onClick={() => deleteNode(id)} />
          <MoreMenu>
            <DropdownMenuItem onClick={() => duplicateNode(id)} className={menuItem}>
              <CopyIcon className="size-3.5" />
              Duplicate
            </DropdownMenuItem>
          </MoreMenu>
        </FloatingBar>
      </div>

      {expandMedia && asset ? (
        <NodeExpandModal open={expanded} onOpenChange={setExpanded} media={expandMedia}>
          <ExpandDetails
            heading={wire.title || asset.filename || "Upload"}
            onDownload={() => window.open(asset.url, "_blank", "noopener,noreferrer")}
            chips={<DetailChip>{asset.mediaType}</DetailChip>}
            footer={
              asset.width && asset.height ? `${asset.width} × ${asset.height} px` : null
            }
          />
        </NodeExpandModal>
      ) : null}
    </div>
  );
}
