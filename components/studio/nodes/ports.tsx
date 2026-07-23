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
  "source_video",
  "source_audio",
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

/**
 * The second line of a port's tooltip, for ports that take less than their
 * modality would suggest. Naming both legal sources is the point: the rule is
 * "a voice", and the canvas has two ways to produce one.
 */
export function portHint(port: PortSpec): string | null {
  if (!port.roles?.length) return null;
  const sources = port.roles.map((r) => ROLE_LABEL[r] ?? r).join(" or ");
  return `From a ${sources} node, or an uploaded ${port.modality} file`;
}

export function portLabel(portId: string, nodeModality?: string): string {
  // A composition node names its handles per lane (`audio_<track id>`), so
  // there is no fixed case to match — the lane's own name is shown on the node
  // itself, and the port only has to say what class of thing it takes.
  if (portId.startsWith("audio_")) return "Audio track";
  switch (portId) {
    case "init_image":
      // The same conditioning image reads differently per modality: it is the
      // literal first frame of a video, but just a starting point for an image.
      return nodeModality === "video" ? "Start frame" : "Init image";
    case "end_frame":
      return "End frame";
    case "image_ref":
      return "Reference";
    case "source_video":
      return "Source video";
    case "source_audio":
      return "Source music";
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
  if (portId.startsWith("audio_")) return <MusicGenIcon className={className} />;
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
    case "source_video":
      return <VideoGenIcon className={className} />;
    case "source_audio":
      return <MusicGenIcon className={className} />;
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
export const PORT_OFFSET = "-40px";

/**
 * A single connector, positioned by its caller rather than by a rail.
 *
 * The composition node needs this: its ports belong to individual track rows,
 * so they cannot come from one evenly-spaced column the way a generate node's
 * do — each has to sit level with the lane it fills.
 */
export function LanePort({
  port,
  connected,
  className,
}: {
  port: PortSpec;
  connected: boolean;
  className?: string;
}) {
  return (
    <div style={{ left: PORT_OFFSET }} className={cn("absolute z-10", className)}>
      <PortDot port={port} connected={connected} />
    </div>
  );
}

function PortDot({
  port,
  nodeModality,
  connected,
}: {
  port: PortSpec;
  nodeModality?: string;
  connected: boolean;
}) {
  // A port that names the roles it takes wears the first one's accent and
  // glyph, so it matches the connector that legally fills it — the `speech`
  // input and a Speech node's output read as two ends of the same wire. Ports
  // with no role constraint stay on their modality's colour, which is then the
  // whole of what may connect.
  const roleKey = port.roles?.[0];
  const accent = accentFor(roleKey ?? port.modality);
  const RoleGlyph = roleKey ? ROLE_ICON[roleKey] : undefined;
  const label = portLabel(port.id, nodeModality);
  const hint = portHint(port);

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
                {RoleGlyph ? (
                  <RoleGlyph className="size-[15px]" />
                ) : (
                  <PortGlyph
                    portId={port.id}
                    nodeModality={nodeModality}
                    className="size-[15px]"
                  />
                )}
              </span>
            </Handle>
          </span>
        }
      />
      <TooltipContent
        side="left"
        sideOffset={8}
        className={cn(
          "bg-[#1f211c] text-[#f7f4ee]",
          // The hint is a second line, and the popup is an inline row by default.
          hint && "flex-col items-start gap-0.5",
        )}
      >
        <span className="flex items-center gap-1.5">
          {label}
          {port.multi ? <span className="text-[#f7f4ee]/50">multiple</span> : null}
        </span>
        {hint ? <span className="text-[11px] text-[#f7f4ee]/55">{hint}</span> : null}
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
  style,
}: {
  modality?: string;
  role?: string | null;
  className?: string;
  /** Merged over the rail offset, for nodes that place their output by pixel. */
  style?: React.CSSProperties;
}) {
  const accent = accentFor(role || modality);
  const RoleGlyph = role ? ROLE_ICON[role] : undefined;
  const glyphPort =
    modality === "video"
      ? "video"
      : modality === "audio"
        ? "audio"
        : modality === "text"
          ? "prompt"
          : "image_ref";

  return (
    <div style={{ right: PORT_OFFSET, ...style }} className={cn("absolute z-10", className)}>
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
