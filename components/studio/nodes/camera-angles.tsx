"use client";

/**
 * The Camera tab of an image node's expand modal: orbit the camera around the
 * displayed take and regenerate it from the new pose.
 *
 * The centrepiece is an instrument, not a form — a wireframe orbit sphere with
 * the take held at its centre. Two square handles ride the wires: one on the
 * equator ring for rotation, one on its meridian for elevation, and the open
 * sphere drags as a free orbit. The sliders underneath are the same pose in
 * numbers; sphere and sliders move each other.
 *
 * The pose leaves here in the *model's* vocabulary via `poseParams` — the
 * panel never starts the run itself. Nothing is persisted: a camera edit is a
 * one-off regeneration, and the pose resets with the modal.
 */

import * as React from "react";
import { ArrowCounterClockwiseIcon, CameraIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import {
  type CameraPose,
  AZIMUTH_LIMIT,
  ELEVATION_LIMIT,
  NEUTRAL_POSE,
  poseIsNeutral,
  poseParams,
  tiltOf,
} from "@/lib/studio/camera-edit";

// --- projection -------------------------------------------------------------
// Shared with the relight panel (nodes/relight.tsx), which draws the same
// wireframe globe with a light where the camera would be.

/** ViewBox edge; the stage renders fluid but thinks in these units. */
export const STAGE = 248;
export const CENTER = STAGE / 2;
export const RADIUS = STAGE * 0.4;
/** The sphere tips this much toward the viewer, so the wires read as 3D. */
const TILT = (14 * Math.PI) / 180;
const COS_T = Math.cos(TILT);
const SIN_T = Math.sin(TILT);

export const rad = (deg: number) => (deg * Math.PI) / 180;
export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * Orthographic projection of a point on the unit sphere (azimuth/elevation in
 * degrees) onto the stage, after the viewer's tilt. `front` is which side of
 * the sphere it lands on — back wires draw dimmer.
 */
export function project(
  aDeg: number,
  eDeg: number,
): { x: number; y: number; front: boolean } {
  const a = rad(aDeg);
  const e = rad(eDeg);
  const x = Math.cos(e) * Math.sin(a);
  const y = Math.sin(e);
  const z = Math.cos(e) * Math.cos(a);
  return {
    x: CENTER + RADIUS * x,
    y: CENTER - RADIUS * (y * COS_T - z * SIN_T),
    front: y * SIN_T + z * COS_T >= 0,
  };
}

/**
 * One great circle as two SVG paths, split where it passes behind the sphere.
 * `at` maps the parameter t (0..360) to a point in azimuth/elevation degrees.
 */
export function circlePaths(at: (t: number) => [number, number], samples = 96): {
  front: string;
  back: string;
} {
  let front = "";
  let back = "";
  let prev: ReturnType<typeof project> | null = null;
  for (let i = 0; i <= samples; i += 1) {
    const p = project(...at((i / samples) * 360));
    const cmd = `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    if (prev && prev.front === p.front) {
      if (p.front) front += ` L ${cmd}`;
      else back += ` L ${cmd}`;
    } else {
      if (p.front) front += ` M ${cmd}`;
      else back += ` M ${cmd}`;
    }
    prev = p;
  }
  return { front, back };
}

/** The fixed wires: latitude rings and a fan of meridians, drawn once. */
export const GRID: { front: string; back: string }[] = [
  ...[-50, -25, 25, 50].map((e) => circlePaths((t) => [t, e])),
  ...[0, 45, 90, 135].map((a) => circlePaths((t) => [a, t])),
];

export const EQUATOR = circlePaths((t) => [t, 0]);

// --- pose helpers -----------------------------------------------------------

function azimuthLabel(azimuth: number): string {
  const a = Math.round(azimuth);
  if (a === 0) return "Centred";
  return `${Math.abs(a)}° ${a > 0 ? "right" : "left"}`;
}

const TILT_LABEL: Record<-1 | 0 | 1, string> = {
  [-1]: "Bird's-eye",
  0: "Level",
  1: "Worm's-eye",
};

function zoomLabel(zoom: number): string {
  const steps = Math.round(zoom / 10);
  return steps === 0 ? "None" : `+${steps}`;
}

/** The pose as one readable directive — what the model will be asked to do. */
function poseSentence(pose: CameraPose): string {
  const parts: string[] = [];
  if (Math.round(pose.azimuth) !== 0) parts.push(azimuthLabel(pose.azimuth).toLowerCase());
  const tilt = tiltOf(pose.elevation);
  if (tilt !== 0) parts.push(TILT_LABEL[tilt].toLowerCase());
  if (Math.round(pose.zoom / 10) !== 0) parts.push(`push in ${Math.round(pose.zoom / 10)}`);
  if (pose.wideAngle) parts.push("wide-angle");
  return parts.length ? `Camera ${parts.join(" · ")}` : "Camera unchanged";
}

// --- the orbit stage --------------------------------------------------------

type DragMode = "azimuth" | "elevation" | "orbit";

function OrbitStage({
  imageUrl,
  pose,
  onPose,
}: {
  imageUrl: string;
  pose: CameraPose;
  onPose: (patch: Partial<CameraPose>) => void;
}) {
  const stage = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ mode: DragMode; lastX: number; lastY: number } | null>(null);

  /** Pointer position in viewBox units, whatever size the stage renders at. */
  const toStage = React.useCallback((clientX: number, clientY: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect || !rect.width) return { x: CENTER, y: CENTER };
    const scale = STAGE / rect.width;
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  }, []);

  const applyPointer = React.useCallback(
    (mode: DragMode, clientX: number, clientY: number, dx: number, dy: number) => {
      const { x, y } = toStage(clientX, clientY);
      if (mode === "azimuth") {
        // The equator handle sits at x = C + R·sin(azimuth); invert that.
        const azimuth = (Math.asin(clamp((x - CENTER) / RADIUS, -1, 1)) * 180) / Math.PI;
        onPose({ azimuth: clamp(Math.round(azimuth), -AZIMUTH_LIMIT, AZIMUTH_LIMIT) });
      } else if (mode === "elevation") {
        // Invert the projection's y at the current azimuth, taking the small-
        // angle liberty cos(e) ≈ 1 in the tilt-correction term.
        const sinE =
          ((CENTER - y) / RADIUS + Math.cos(rad(pose.azimuth)) * SIN_T) / COS_T;
        const elevation = (Math.asin(clamp(sinE, -1, 1)) * 180) / Math.PI;
        onPose({
          elevation: clamp(Math.round(elevation), -ELEVATION_LIMIT, ELEVATION_LIMIT),
        });
      } else {
        // Free orbit: horizontal drag walks the equator, vertical the meridian.
        const gain = 90 / RADIUS;
        onPose({
          azimuth: clamp(
            Math.round(pose.azimuth + dx * gain),
            -AZIMUTH_LIMIT,
            AZIMUTH_LIMIT,
          ),
          elevation: clamp(
            Math.round(pose.elevation - dy * gain),
            -ELEVATION_LIMIT,
            ELEVATION_LIMIT,
          ),
        });
      }
    },
    [onPose, pose.azimuth, pose.elevation, toStage],
  );

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      const handle = (e.target as HTMLElement).closest?.("[data-handle]");
      const mode = (handle?.getAttribute("data-handle") as DragMode | null) ?? "orbit";
      if (mode === "orbit") {
        // Free orbit only starts on the sphere itself, not the corners.
        const { x, y } = toStage(e.clientX, e.clientY);
        if (Math.hypot(x - CENTER, y - CENTER) > RADIUS * 1.12) return;
      }
      drag.current = { mode, lastX: e.clientX, lastY: e.clientY };
      stage.current?.setPointerCapture(e.pointerId);
      // A press on a handle is already a statement of intent — apply it, so a
      // click (no move) on the ring also repositions.
      if (mode !== "orbit") applyPointer(mode, e.clientX, e.clientY, 0, 0);
    },
    [applyPointer, toStage],
  );

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      const scale = stage.current
        ? STAGE / stage.current.getBoundingClientRect().width
        : 1;
      const dx = (e.clientX - drag.current.lastX) * scale;
      const dy = (e.clientY - drag.current.lastY) * scale;
      drag.current.lastX = e.clientX;
      drag.current.lastY = e.clientY;
      applyPointer(drag.current.mode, e.clientX, e.clientY, dx, dy);
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
  const cameraHandle = project(pose.azimuth, pose.elevation);
  const northPole = project(0, 90);
  const southPole = project(0, -90);
  /** % coordinates so the handles track the stage at any rendered size. */
  const pct = (v: number) => `${(v / STAGE) * 100}%`;

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
        <g stroke="#1f211c" fill="none" strokeWidth="0.75">
          {GRID.map((ring, i) => (
            <g key={i}>
              <path d={ring.back} opacity="0.05" />
              <path d={ring.front} opacity="0.13" />
            </g>
          ))}
        </g>
        {/* The two live wires: the equator the rotation handle rides, and the
            meridian that swings with it carrying the camera. */}
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
      </svg>

      {/* The take, held flat at the sphere's centre — the handles say where
          the camera is; tilting the picture too read as confusing. Only zoom
          echoes into it, as a gentle scale. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        className="pointer-events-none absolute top-1/2 left-1/2 border border-[#1f211c]/15 object-cover shadow-[0_14px_30px_-14px_rgba(31,33,28,0.45)]"
        style={{
          width: "44%",
          aspectRatio: "1",
          transform: `translate(-50%, -50%) scale(${1 + pose.zoom * 0.0028})`,
        }}
      />

      {/* Rotation handle, on the equator. */}
      <button
        type="button"
        data-handle="azimuth"
        aria-label="Camera rotation"
        className="absolute z-10 grid size-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center border border-[#1f211c]/45 bg-white shadow-[0_4px_10px_-4px_rgba(31,33,28,0.5)]"
        style={{ left: pct(azimuthHandle.x), top: pct(azimuthHandle.y) }}
      >
        <span className="size-1 bg-[#1f211c]" />
      </button>

      {/* The camera itself, riding the meridian. */}
      <button
        type="button"
        data-handle="elevation"
        aria-label="Camera elevation"
        className="absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize place-items-center bg-[#1f211c] text-[#f7f4ee] shadow-[0_6px_14px_-6px_rgba(31,33,28,0.7)]"
        style={{ left: pct(cameraHandle.x), top: pct(cameraHandle.y) }}
      >
        <CameraIcon className="size-3.5" weight="fill" />
      </button>
    </div>
  );
}

// --- slider row -------------------------------------------------------------

export function PoseSlider({
  label,
  hint,
  readout,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  readout: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-[#8a8271]" title={hint}>
          {label}
        </span>
        <span className="bg-[#1f211c]/6 px-1.5 py-0.5 text-[10.5px] font-medium text-[#4c4a41] tabular-nums">
          {readout}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={1}
        value={[value]}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        aria-label={label}
        className="[&_[data-slot=slider-thumb]]:border-[#1f211c]/45 [&_[data-slot=slider-track]]:bg-[#1f211c]/15"
      />
    </div>
  );
}

// --- the panel --------------------------------------------------------------

export function CameraAnglesPanel({
  imageUrl,
  busy,
  onGenerate,
}: {
  /** The take being re-framed — shown at the sphere's centre. */
  imageUrl: string;
  /** True while this node is already generating; Generate holds until done. */
  busy: boolean;
  /** Receives the pose already translated into model params. */
  onGenerate: (params: Record<string, unknown>) => void;
}) {
  const [pose, setPose] = React.useState<CameraPose>(NEUTRAL_POSE);
  const patchPose = React.useCallback(
    (patch: Partial<CameraPose>) => setPose((current) => ({ ...current, ...patch })),
    [],
  );
  const neutral = poseIsNeutral(pose);

  return (
    // Sized by its content — the aside's section opens to whatever this needs.
    <div className="flex flex-col">
      <div className="relative">
        <OrbitStage imageUrl={imageUrl} pose={pose} onPose={patchPose} />
        <button
          type="button"
          onClick={() => setPose(NEUTRAL_POSE)}
          disabled={neutral}
          className={cn(
            "absolute right-1.5 bottom-1.5 flex items-center gap-1 bg-[#faf8f4]/85 px-1.5 py-1 text-[10.5px] font-semibold text-[#8a8271] transition-all duration-150",
            neutral ? "opacity-0" : "opacity-100 hover:text-[#1f211c]",
          )}
        >
          <ArrowCounterClockwiseIcon className="size-3" />
          Reset
        </button>
      </div>

      <p className="mt-3 text-[10px] font-semibold tracking-[0.06em] text-[#a09a88] uppercase">
        Parameters
      </p>

      <div className="mt-3 flex flex-col gap-4">
        <PoseSlider
          label="Rotation (left / right)"
          hint="Orbit the camera around the subject"
          readout={azimuthLabel(pose.azimuth)}
          min={-AZIMUTH_LIMIT}
          max={AZIMUTH_LIMIT}
          value={Math.round(pose.azimuth)}
          onChange={(azimuth) => patchPose({ azimuth })}
        />
        <PoseSlider
          label="Elevation (down / up)"
          hint="Raise or lower the camera — snaps to bird's-eye, level, or worm's-eye"
          readout={TILT_LABEL[tiltOf(pose.elevation)]}
          min={-ELEVATION_LIMIT}
          max={ELEVATION_LIMIT}
          value={Math.round(pose.elevation)}
          onChange={(elevation) => patchPose({ elevation })}
        />
        <PoseSlider
          label="Zoom"
          hint="Push the camera toward a close-up"
          readout={zoomLabel(pose.zoom)}
          min={0}
          max={100}
          value={Math.round(pose.zoom)}
          onChange={(zoom) => patchPose({ zoom })}
        />

        <label className="flex cursor-pointer items-center justify-between gap-2">
          <span
            className="text-[11px] text-[#8a8271]"
            title="Switch to a wide-angle lens"
          >
            Wide-angle lens
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={pose.wideAngle}
            aria-label="Wide-angle lens"
            onClick={() => patchPose({ wideAngle: !pose.wideAngle })}
            className={cn(
              "grid h-4 w-7 shrink-0 grid-cols-2 border transition-colors duration-150",
              pose.wideAngle
                ? "border-[#1f211c] bg-[#1f211c]"
                : "border-[#1f211c]/25 bg-[#1f211c]/6",
            )}
          >
            <span
              className={cn(
                "m-[2px] bg-white transition-transform duration-150",
                pose.wideAngle && "translate-x-3",
              )}
            />
          </button>
        </label>
      </div>

      <div className="pt-5">
        <p className="mb-2 text-[10.5px] text-[#a09a88]">{poseSentence(pose)}</p>
        <button
          type="button"
          disabled={busy || neutral}
          onClick={() => onGenerate(poseParams(pose))}
          className="flex h-9 w-full items-center justify-center gap-2 bg-primary text-[13px] font-semibold text-primary-foreground shadow-[0_10px_24px_-8px_oklch(0.75_0.16_85_/_0.9),inset_0_1px_0_rgba(255,255,255,0.5)] transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 disabled:hover:brightness-100"
        >
          <CameraIcon className="size-4" weight="fill" />
          {busy ? "Generating…" : "Generate"}
        </button>
      </div>
    </div>
  );
}
