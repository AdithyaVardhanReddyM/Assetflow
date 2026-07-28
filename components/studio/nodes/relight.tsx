"use client";

/**
 * The Light tab of an image node's expand modal: move the light source around
 * the displayed take and regenerate it under the new lighting.
 *
 * Same instrument family as the camera tab — the wireframe orbit sphere,
 * shared projection math — but here the thing riding the wires is a bulb, and
 * it throws a colored cone toward the take at the centre. Under the sphere:
 * the six preset chips, the color row, and the intensity slider. Because the
 * model is steered by words rather than numbers, the directive line above
 * Generate shows exactly what will be asked — the sphere feels continuous,
 * but what's promised is the nearest named direction, and the line says so.
 */

import * as React from "react";
import { ArrowCounterClockwiseIcon, LightbulbIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  type LightPose,
  LIGHT_COLORS,
  LIGHT_PRESETS,
  NEUTRAL_LIGHT,
  directiveSummary,
  relightSpec,
} from "@/lib/studio/relight";
import type { TakeEditSpec } from "@/lib/studio/camera-edit";
import {
  CENTER,
  EQUATOR,
  GRID,
  PoseSlider,
  RADIUS,
  STAGE,
  circlePaths,
  clamp,
  project,
  rad,
} from "./camera-angles";

const AZIMUTH_LIMIT = 80;
const ELEVATION_LIMIT = 70;

const SIN_T = Math.sin((14 * Math.PI) / 180);
const COS_T = Math.cos((14 * Math.PI) / 180);

// --- the light stage --------------------------------------------------------

type DragMode = "azimuth" | "light" | "orbit";

function LightStage({
  imageUrl,
  pose,
  onPose,
}: {
  imageUrl: string;
  pose: LightPose;
  onPose: (patch: Partial<LightPose>) => void;
}) {
  const stage = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ mode: DragMode } | null>(null);

  const toStage = React.useCallback((clientX: number, clientY: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect || !rect.width) return { x: CENTER, y: CENTER };
    const scale = STAGE / rect.width;
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  }, []);

  const applyPointer = React.useCallback(
    (mode: DragMode, clientX: number, clientY: number) => {
      const { x, y } = toStage(clientX, clientY);
      // Any drag chooses a position on the visible hemisphere, so a "Back"
      // pose returns to a front-lit one the moment the bulb moves.
      const patch: Partial<LightPose> = { behind: false };
      if (mode === "azimuth") {
        const azimuth = (Math.asin(clamp((x - CENTER) / RADIUS, -1, 1)) * 180) / Math.PI;
        patch.azimuth = clamp(Math.round(azimuth), -AZIMUTH_LIMIT, AZIMUTH_LIMIT);
      } else {
        // The bulb rides the meridian at the current azimuth; free orbit uses
        // both axes — azimuth from x exactly as the equator handle does.
        if (mode === "orbit") {
          const azimuth =
            (Math.asin(clamp((x - CENTER) / RADIUS, -1, 1)) * 180) / Math.PI;
          patch.azimuth = clamp(Math.round(azimuth), -AZIMUTH_LIMIT, AZIMUTH_LIMIT);
        }
        const sinE =
          ((CENTER - y) / RADIUS +
            Math.cos(rad(patch.azimuth ?? pose.azimuth)) * SIN_T) /
          COS_T;
        const elevation = (Math.asin(clamp(sinE, -1, 1)) * 180) / Math.PI;
        patch.elevation = clamp(
          Math.round(elevation),
          -ELEVATION_LIMIT,
          ELEVATION_LIMIT,
        );
      }
      onPose(patch);
    },
    [onPose, pose.azimuth, toStage],
  );

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      const handle = (e.target as HTMLElement).closest?.("[data-handle]");
      const mode = (handle?.getAttribute("data-handle") as DragMode | null) ?? "orbit";
      if (mode === "orbit") {
        const { x, y } = toStage(e.clientX, e.clientY);
        if (Math.hypot(x - CENTER, y - CENTER) > RADIUS * 1.12) return;
      }
      drag.current = { mode };
      stage.current?.setPointerCapture(e.pointerId);
      applyPointer(mode, e.clientX, e.clientY);
    },
    [applyPointer, toStage],
  );

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      applyPointer(drag.current.mode, e.clientX, e.clientY);
    },
    [applyPointer],
  );

  const endDrag = React.useCallback(() => {
    drag.current = null;
  }, []);

  const meridian = React.useMemo(
    () => circlePaths((t) => [pose.azimuth, t]),
    [pose.azimuth],
  );
  const azimuthHandle = project(pose.azimuth, 0);
  const bulb = project(pose.azimuth, pose.elevation);
  const northPole = project(0, 90);
  const southPole = project(0, -90);
  const pct = (v: number) => `${(v / STAGE) * 100}%`;
  /** The cone softens and the bulb dims when the light sits behind. */
  const presence = pose.behind ? 0.35 : 1;

  return (
    <div
      ref={stage}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="relative w-full cursor-grab touch-none overflow-hidden border border-[#1f211c]/10 bg-[#faf8f4] select-none active:cursor-grabbing"
      style={{ aspectRatio: "1" }}
    >
      <svg
        viewBox={`0 0 ${STAGE} ${STAGE}`}
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        <defs>
          {/* The light's throw, from the bulb toward the take. */}
          <linearGradient
            id="relight-cone"
            gradientUnits="userSpaceOnUse"
            x1={bulb.x}
            y1={bulb.y}
            x2={CENTER}
            y2={CENTER}
          >
            <stop offset="0%" stopColor={pose.color} stopOpacity={0.55 * presence} />
            <stop offset="100%" stopColor={pose.color} stopOpacity="0" />
          </linearGradient>
        </defs>

        <g stroke="#1f211c" fill="none" strokeWidth="0.75">
          {GRID.map((ring, i) => (
            <g key={i}>
              <path d={ring.back} opacity="0.05" />
              <path d={ring.front} opacity="0.13" />
            </g>
          ))}
        </g>
        <g stroke="#1f211c" fill="none">
          <path d={EQUATOR.back} strokeWidth="0.9" opacity="0.14" />
          <path d={EQUATOR.front} strokeWidth="1.1" opacity="0.5" />
          <path d={meridian.back} strokeWidth="0.9" opacity="0.14" />
          <path d={meridian.front} strokeWidth="1.1" opacity="0.5" />
        </g>
        <g fill="#1f211c" opacity="0.4">
          <rect x={northPole.x - 1.5} y={northPole.y - 1.5} width="3" height="3" />
          <rect x={southPole.x - 1.5} y={southPole.y - 1.5} width="3" height="3" />
        </g>

        {/* The cone: a triangle from the bulb spreading over the take. */}
        {(() => {
          const dx = CENTER - bulb.x;
          const dy = CENTER - bulb.y;
          const len = Math.hypot(dx, dy) || 1;
          // Perpendicular spread at the take's end of the throw.
          const spread = 26;
          const px2 = (-dy / len) * spread;
          const py2 = (dx / len) * spread;
          return (
            <polygon
              points={`${bulb.x},${bulb.y} ${CENTER + px2},${CENTER + py2} ${CENTER - px2},${CENTER - py2}`}
              fill="url(#relight-cone)"
            />
          );
        })()}
      </svg>

      {/* The take, flat at the centre, as the thing being lit. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border border-[#1f211c]/15 object-cover shadow-[0_14px_30px_-14px_rgba(31,33,28,0.45)]"
        style={{ width: "40%", aspectRatio: "1" }}
      />

      {/* Rotation handle on the equator. */}
      <button
        type="button"
        data-handle="azimuth"
        aria-label="Light rotation"
        className="absolute z-10 grid size-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center border border-[#1f211c]/45 bg-white shadow-[0_4px_10px_-4px_rgba(31,33,28,0.5)]"
        style={{ left: pct(azimuthHandle.x), top: pct(azimuthHandle.y) }}
      >
        <span className="size-1 bg-[#1f211c]" />
      </button>

      {/* The bulb, riding the meridian. Dims when the light sits behind. */}
      <button
        type="button"
        data-handle="light"
        aria-label="Light elevation"
        className="absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize place-items-center border border-[#1f211c]/20 bg-white shadow-[0_6px_14px_-6px_rgba(31,33,28,0.7)]"
        style={{
          left: pct(bulb.x),
          top: pct(bulb.y),
          opacity: presence,
          color: pose.color === "#FFFFFF" ? "#1f211c" : pose.color,
        }}
      >
        <LightbulbIcon className="size-3.5" weight="fill" />
      </button>

      {pose.behind ? (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 bg-[#faf8f4]/85 px-1.5 py-1 text-[10px] font-semibold text-[#8a8271]">
          Backlight — behind the subject
        </span>
      ) : null}
    </div>
  );
}

// --- the panel --------------------------------------------------------------

export function RelightPanel({
  imageUrl,
  busy,
  onGenerate,
}: {
  /** The take being relit — shown at the sphere's centre. */
  imageUrl: string;
  /** True while this node is already generating; Generate holds until done. */
  busy: boolean;
  /** Receives the pose as a ready-to-run spec (directive prompt included). */
  onGenerate: (spec: TakeEditSpec) => void;
}) {
  const [pose, setPose] = React.useState<LightPose>(NEUTRAL_LIGHT);
  const patchPose = React.useCallback(
    (patch: Partial<LightPose>) => setPose((current) => ({ ...current, ...patch })),
    [],
  );
  const customColor = !LIGHT_COLORS.includes(pose.color.toUpperCase());

  return (
    // Sized by its content — the aside's section opens to whatever this needs.
    <div className="flex flex-col">
      <div className="relative">
        <LightStage imageUrl={imageUrl} pose={pose} onPose={patchPose} />
        <button
          type="button"
          onClick={() => setPose(NEUTRAL_LIGHT)}
          className="absolute right-1.5 bottom-1.5 flex items-center gap-1 bg-[#faf8f4]/85 px-1.5 py-1 text-[10.5px] font-semibold text-[#8a8271] transition-colors duration-150 hover:text-[#1f211c]"
        >
          <ArrowCounterClockwiseIcon className="size-3" />
          Reset
        </button>
      </div>

      {/* The six canned positions, in the reference layout's order. */}
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {LIGHT_PRESETS.map((preset) => {
          const active = preset.pose.behind
            ? pose.behind
            : !pose.behind &&
              pose.azimuth === preset.pose.azimuth &&
              pose.elevation === preset.pose.elevation;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => patchPose(preset.pose)}
              className={cn(
                "h-8 border text-[11.5px] font-semibold transition-colors duration-150",
                active
                  ? "border-[#1f211c] bg-[#1f211c] text-[#f7f4ee]"
                  : "border-[#1f211c]/14 text-[#4c4a41] hover:border-[#1f211c]/35",
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-[10px] font-semibold tracking-[0.06em] text-[#a09a88] uppercase">
        Color
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        {LIGHT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Light color ${color}`}
            onClick={() => patchPose({ color })}
            className={cn(
              "size-6 shrink-0 border transition-all duration-150",
              pose.color.toUpperCase() === color
                ? "scale-110 border-[#1f211c]"
                : "border-[#1f211c]/20 hover:border-[#1f211c]/45",
            )}
            style={{ background: color }}
          />
        ))}
        <label
          className={cn(
            "relative size-6 shrink-0 cursor-pointer border",
            customColor ? "scale-110 border-[#1f211c]" : "border-[#1f211c]/20",
          )}
          title="Custom color"
          style={{
            background: customColor
              ? pose.color
              : "conic-gradient(#ff5a3c, #e6dc64, #58c065, #4f7de2, #e24fb2, #ff5a3c)",
          }}
        >
          <input
            type="color"
            value={pose.color}
            onChange={(e) => patchPose({ color: e.target.value.toUpperCase() })}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Custom light color"
          />
        </label>
      </div>

      <div className="mt-4">
        <PoseSlider
          label="Intensity"
          hint="How hard the new light hits"
          readout={`${Math.round(pose.intensity)}%`}
          min={0}
          max={100}
          value={Math.round(pose.intensity)}
          onChange={(intensity) => patchPose({ intensity })}
        />
      </div>

      <div className="pt-5">
        <p className="mb-2 text-[10.5px] text-[#a09a88]">{directiveSummary(pose)}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => onGenerate(relightSpec(pose))}
          className="flex h-9 w-full items-center justify-center gap-2 bg-primary text-[13px] font-semibold text-primary-foreground transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 disabled:hover:brightness-100"
        >
          <LightbulbIcon className="size-4" weight="fill" />
          {busy ? "Generating…" : "Generate"}
        </button>
      </div>
    </div>
  );
}
