"use client";

/**
 * The port rail — the circular connectors down the left edge of a node and the
 * single output on its right.
 *
 * Which ports exist is never decided here: `visiblePorts()` resolves them from
 * the catalog, including the model-gating rule that a `model_gated` port shows
 * only when the selected model declares it. This file owns presentation alone —
 * label, icon, order, colour.
 */

import * as React from "react";
import { Handle, Position } from "@xyflow/react";
import {
  AlignLeftSimpleIcon,
  AlignRightSimpleIcon,
  ArrowLineRightIcon,
  TextTIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { PortSpec } from "@/lib/studio/catalog";
import { accentFor } from "@/lib/studio/node-ui";
import { ImageGenIcon, MusicGenIcon, VideoGenIcon } from "../asset-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Display order, top to bottom. `prompt` is deliberately last and set apart —
 * on the canvas the text input reads as a different class of thing from the
 * image inputs above it.
 */
const PORT_ORDER = [
  "init_image",
  "end_frame",
  "image_ref",
  "video",
  "audio",
  "in",
  "prompt",
];

export function sortPorts(ports: PortSpec[]): PortSpec[] {
  return [...ports].sort((a, b) => {
    const ai = PORT_ORDER.indexOf(a.id);
    const bi = PORT_ORDER.indexOf(b.id);
    return (ai < 0 ? PORT_ORDER.length : ai) - (bi < 0 ? PORT_ORDER.length : bi);
  });
}

export function portLabel(portId: string, nodeModality?: string): string {
  switch (portId) {
    case "init_image":
      // The same conditioning image reads differently per modality: it is the
      // literal first frame of a video, but just a starting point for an image.
      return nodeModality === "video" ? "Start frame" : "Init image";
    case "end_frame":
      return "End frame";
    case "image_ref":
      return "Reference";
    case "prompt":
      return "Text";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "in":
      return "Input";
    default:
      return portId;
  }
}

/**
 * Renders the glyph for a port. A component rather than a function returning
 * one, so React sees a stable element type per branch instead of a fresh
 * component identity on every render.
 */
function PortGlyph({
  portId,
  nodeModality,
  className,
}: {
  portId: string;
  nodeModality?: string;
  className?: string;
}) {
  switch (portId) {
    case "init_image":
      return nodeModality === "video" ? (
        <AlignLeftSimpleIcon className={className} weight="fill" />
      ) : (
        <ImageGenIcon className={className} />
      );
    case "end_frame":
      return <AlignRightSimpleIcon className={className} weight="fill" />;
    case "image_ref":
      return <ImageGenIcon className={className} />;
    case "prompt":
      return <TextTIcon className={className} weight="fill" />;
    case "video":
      return <VideoGenIcon className={className} />;
    case "audio":
      return <MusicGenIcon className={className} />;
    default:
      return <ArrowLineRightIcon className={className} weight="fill" />;
  }
}

const DOT =
  "grid size-[30px] place-items-center rounded-full border border-white/70 shadow-[0_2px_8px_-2px_rgba(31,33,28,0.3)] transition-transform duration-150 hover:scale-110";

function PortDot({
  port,
  nodeModality,
  connected,
}: {
  port: PortSpec;
  nodeModality?: string;
  connected: boolean;
}) {
  const accent = accentFor(port.modality);
  const label = portLabel(port.id, nodeModality);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // The tooltip trigger wraps the handle rather than being it: React
          // Flow needs the handle's own pointer events to start a connection.
          <span className="relative flex">
            <Handle
              type="target"
              position={Position.Left}
              id={port.id}
              // Single-connection ports stay connectable: `onConnect` swaps the
              // existing edge out rather than making the user delete it first.
              // Refusing here would look like the port was simply broken.
              aria-label={label}
              className={cn(DOT, !port.multi && connected && "ring-2 ring-white")}
              style={{ background: accent.soft, color: accent.ink }}
            >
              {/* Icons must not swallow the pointer stream the handle needs. */}
              <PortGlyph
                portId={port.id}
                nodeModality={nodeModality}
                className="pointer-events-none size-[15px]"
              />
            </Handle>
          </span>
        }
      />
      <TooltipContent side="left" sideOffset={8} className="bg-[#1f211c] text-[#f7f4ee]">
        {label}
        {port.multi ? <span className="text-[#f7f4ee]/50">multiple</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The left rail. Bottom-anchored so the text port sits level with the prompt
 * box it feeds, with the image ports stacking upward above it.
 */
export function PortRail({
  ports,
  nodeModality,
  connectedHandles,
  className,
}: {
  ports: PortSpec[];
  nodeModality?: string;
  connectedHandles: Set<string>;
  className?: string;
}) {
  const ordered = sortPorts(ports);
  if (!ordered.length) return null;

  return (
    <div
      className={cn(
        "absolute -left-[15px] z-10 flex flex-col items-center justify-end gap-2.5",
        className,
      )}
    >
      {ordered.map((port, i) => (
        <div
          key={port.id}
          // Set the text port apart from the image group above it.
          className={port.id === "prompt" && i > 0 ? "mt-3" : undefined}
        >
          <PortDot
            port={port}
            nodeModality={nodeModality}
            connected={connectedHandles.has(port.id)}
          />
        </div>
      ))}
    </div>
  );
}

/** The single output connector, top-right. */
export function OutputPort({
  modality,
  className,
}: {
  modality?: string;
  className?: string;
}) {
  const accent = accentFor(modality);
  const glyphPort =
    modality === "video" ? "video" : modality === "audio" ? "audio" : "image_ref";

  return (
    <div className={cn("absolute -right-[15px] z-10", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="relative flex">
              <Handle
                type="source"
                position={Position.Right}
                id="out"
                aria-label="Output"
                className={DOT}
                style={{ background: accent.soft, color: accent.ink }}
              >
                <PortGlyph
                  portId={glyphPort}
                  nodeModality={modality}
                  className="pointer-events-none size-[15px]"
                />
              </Handle>
            </span>
          }
        />
        <TooltipContent
          side="right"
          sideOffset={8}
          className="bg-[#1f211c] text-[#f7f4ee]"
        >
          Drag to connect
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
