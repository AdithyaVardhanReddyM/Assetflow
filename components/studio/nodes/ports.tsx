"use client";

/**
 * The port rail — the connector islands that float clear of a node's left edge,
 * and the single output that floats off its right.
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
  MicrophoneIcon,
  TextTIcon,
  UserIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { PortSpec } from "@/lib/studio/catalog";
import { accentFor } from "@/lib/studio/node-ui";
import { ROLE_ICON, ROLE_LABEL } from "./roles";
import { ImageGenIcon, MusicGenIcon, VideoGenIcon } from "../asset-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Display order, top to bottom. `prompt` is deliberately last and set apart —
 * on the canvas the text input reads as a different class of thing from the
 * image inputs above it.
 */
const PORT_ORDER = [
  "avatar",
  "init_image",
  "end_frame",
  "image_ref",
  "video",
  "audio",
  "speech",
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
    case "avatar":
      return "Avatar";
    case "speech":
      return "Speech";
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
    case "avatar":
      return <UserIcon className={className} weight="fill" />;
    case "speech":
      return <MicrophoneIcon className={className} weight="fill" />;
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

/**
 * The handle is the 30px hit area only. Its look lives on the child span below,
 * because `globals.css` resets `border` on `.react-flow__handle` at a
 * specificity these utilities cannot beat — styling a child sidesteps that.
 */
const HIT_AREA = "grid size-[30px] place-items-center";

/**
 * Ports read as islands: they clear the card entirely (see `PORT_OFFSET`) and
 * carry their own border and elevation, so each is its own object rather than a
 * bump on the node's edge. `pointer-events-none` keeps the visual out of the
 * pointer stream React Flow needs to start a connection.
 */
const ISLAND =
  "pointer-events-none grid size-full place-items-center border border-[#1f211c]/10 shadow-[0_4px_12px_-2px_rgba(31,33,28,0.26),0_1px_2px_rgba(31,33,28,0.10)] transition-transform duration-150 group-hover/port:scale-110";

/**
 * How far the rails sit outside the card. The island is 30px, so this leaves a
 * ~10px gap of canvas between it and the card edge.
 */
const PORT_OFFSET = "-40px";

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
          <span className="group/port relative flex">
            <Handle
              type="target"
              position={Position.Left}
              id={port.id}
              // Single-connection ports stay connectable: `onConnect` swaps the
              // existing edge out rather than making the user delete it first.
              // Refusing here would look like the port was simply broken.
              aria-label={label}
              className={HIT_AREA}
            >
              <span
                className={cn(ISLAND, !port.multi && connected && "ring-2 ring-white")}
                style={{ background: accent.soft, color: accent.ink }}
              >
                <PortGlyph
                  portId={port.id}
                  nodeModality={nodeModality}
                  className="size-[15px]"
                />
              </span>
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
      style={{ left: PORT_OFFSET }}
      className={cn(
        "absolute z-10 flex flex-col items-center justify-end gap-2.5",
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

/**
 * The single output connector. Carries the model's `role` where it has one, so
 * a Speech node emits from a speech-marked connector rather than from the same
 * generic audio dot as Music — and colours it to match the node it belongs to.
 */
export function OutputPort({
  modality,
  role,
  className,
}: {
  modality?: string;
  role?: string | null;
  className?: string;
}) {
  const accent = accentFor(role || modality);
  const RoleGlyph = role ? ROLE_ICON[role] : undefined;
  const glyphPort =
    modality === "video" ? "video" : modality === "audio" ? "audio" : "image_ref";

  return (
    <div style={{ right: PORT_OFFSET }} className={cn("absolute z-10", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="group/port relative flex">
              <Handle
                type="source"
                position={Position.Right}
                id="out"
                aria-label="Output"
                className={HIT_AREA}
              >
                <span
                  className={ISLAND}
                  style={{ background: accent.soft, color: accent.ink }}
                >
                  {RoleGlyph ? (
                    <RoleGlyph className="size-[15px]" />
                  ) : (
                    <PortGlyph
                      portId={glyphPort}
                      nodeModality={modality}
                      className="size-[15px]"
                    />
                  )}
                </span>
              </Handle>
            </span>
          }
        />
        <TooltipContent
          side="right"
          sideOffset={8}
          className="bg-[#1f211c] text-[#f7f4ee]"
        >
          {role && ROLE_LABEL[role] ? `${ROLE_LABEL[role]} out` : "Drag to connect"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
