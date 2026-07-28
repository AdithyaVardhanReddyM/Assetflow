"use client";

/**
 * The studio's edit-type selector — a rotary knob in the page's top-left.
 *
 * A scalloped gear sits half off the panel's left edge and turns as the
 * selection changes; beside it the edit types ride a vertical carousel, the
 * active one large and centered with its neighbours dimmed above and below.
 * The amber pill between them is fixed — the indicator the gear turns past.
 */

import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

export type EditKind = "camera" | "relight" | "text";

export const EDIT_KINDS: { id: EditKind; label: string }[] = [
  { id: "camera", label: "Camera Angles" },
  { id: "relight", label: "Relight" },
  { id: "text", label: "Magic Text" },
];

/**
 * One notch of gear turn per step through the list — exactly the rivet
 * spacing, so each step carries the next rivet hole onto the indicator and
 * the turn reads as mechanical rather than arbitrary.
 */
const STEP_DEG = 40;
/** Row height of the label carousel; three rows are visible. */
const ROW = 38;

/**
 * The gear's outline: a circle whose radius breathes with nine scallops.
 * Sampled once — the path never changes, only its rotation.
 */
function scallopPath(R: number, amp: number, lobes: number): string {
  const points: string[] = [];
  for (let deg = 0; deg <= 360; deg += 3) {
    const t = (deg * Math.PI) / 180;
    const r = R + amp * Math.cos(lobes * t);
    const x = (r * Math.cos(t)).toFixed(2);
    const y = (r * Math.sin(t)).toFixed(2);
    points.push(`${deg === 0 ? "M" : "L"}${x} ${y}`);
  }
  return `${points.join(" ")}Z`;
}

/**
 * Sized to overrun the row it sits in: the gear reads as the edge of a big
 * dial only if it is clipped top and bottom. Staying inside the row would
 * make it a small cog parked in the corner.
 *
 * Seven scallops against nine rivets, deliberately: a lobe count that
 * divided the 40° step would map the silhouette onto itself on every turn,
 * and the gear would sit there looking like it had never moved.
 */
const GEAR_PATH = scallopPath(78, 5, 7);
/** Where the rivet ring sits — the indicator is pinned to this same radius. */
const RIVET_RADIUS = 57;
/**
 * One rivet hole per scallop, the first at 0° — dead level with the
 * indicator. Every rotation is a whole number of these, so a hole is always
 * the thing sitting under the indicator, never the gap between two.
 */
const RIVETS = Array.from({ length: 9 }, (_, i) => {
  const t = ((i * 40) * Math.PI) / 180;
  return { x: RIVET_RADIUS * Math.cos(t), y: RIVET_RADIUS * Math.sin(t) };
});

/** The gear's centre, relative to the panel's left edge. */
const GEAR_LEFT = -83;
const GEAR_BOX = 176;
const GEAR_CENTER_X = GEAR_LEFT + GEAR_BOX / 2;

export function EditKnob({
  active,
  onSelect,
}: {
  active: EditKind;
  onSelect: (kind: EditKind) => void;
}) {
  const index = EDIT_KINDS.findIndex((k) => k.id === active);

  return (
    <div className="relative h-[128px] overflow-hidden border-b border-[#1f211c]/10 bg-[#faf8f4]">
      {/* The gear, half off the edge. Turns one notch per step.
          Placement sits on the wrapper and rotation on the svg, deliberately:
          Tailwind's translate utilities compile to the `translate` property,
          which composes with an inline `transform` rather than replacing it —
          both on one element moved the gear up twice. */}
      <div
        className="pointer-events-none absolute top-1/2 -translate-y-1/2"
        style={{ left: GEAR_LEFT, width: GEAR_BOX, height: GEAR_BOX }}
      >
        <svg
          viewBox="-88 -88 176 176"
          aria-hidden
          className="size-full transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
          style={{ transform: `rotate(${index * -STEP_DEG}deg)` }}
        >
          <path
            d={GEAR_PATH}
            fill="white"
            stroke="rgba(31,33,28,0.25)"
            strokeWidth="1.5"
          />
          {RIVETS.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r="4"
              fill="none"
              stroke="rgba(31,33,28,0.22)"
              strokeWidth="1.25"
            />
          ))}
          <circle
            r="33"
            fill="none"
            stroke="rgba(31,33,28,0.14)"
            strokeWidth="1"
          />
        </svg>
      </div>

      {/* The fixed indicator the gear turns past. Placed off the rivet ring
          rather than by eye, so it lands on the hole the turn brings level
          with it — the two are concentric by construction. Taller than that
          hole (9.25px across the stroke) so it seats into it rather than
          letting its outline show through, and lit, the way the reference
          lights its own. */}
      <span
        className="absolute top-1/2 h-[11px] w-[22px] -translate-y-1/2 bg-primary shadow-[0_0_8px_1px_oklch(0.852_0.199_91.936_/_0.8),0_0_22px_7px_oklch(0.852_0.199_91.936_/_0.45)]"
        style={{ left: GEAR_CENTER_X + RIVET_RADIUS - 11 }}
      />

      {/* The label carousel — the whole column slides so the active row sits
          on the indicator; each row dresses by its distance from the centre. */}
      <div className="absolute inset-y-0 right-9 left-[96px]">
        <div
          className="absolute inset-x-0 top-1/2 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
          style={{ transform: `translateY(${-ROW / 2 - index * ROW}px)` }}
        >
          {EDIT_KINDS.map((kind, i) => {
            const isActive = i === index;
            return (
              <button
                key={kind.id}
                type="button"
                onClick={() => onSelect(kind.id)}
                aria-pressed={isActive}
                className={cn(
                  "flex w-full items-center text-left transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]",
                  isActive
                    ? "font-heading text-[19px] font-semibold tracking-[-0.01em] text-[#1f211c]"
                    : "text-[13px] text-[#a09a88] hover:text-[#4c4a41]",
                )}
                style={{ height: ROW }}
              >
                <span className="truncate">{kind.label}</span>
              </button>
            );
          })}
        </div>
        {/* Fades so the neighbours read as around-the-dial, not a list. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-[#faf8f4] to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[#faf8f4] to-transparent" />
      </div>

      {/* Step to the next tool — the discoverable way to "turn" the knob. */}
      <button
        type="button"
        aria-label="Next edit tool"
        onClick={() => onSelect(EDIT_KINDS[(index + 1) % EDIT_KINDS.length].id)}
        className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center border border-[#1f211c]/10 bg-white text-[#8a8271] transition-colors duration-150 hover:border-[#1f211c]/30 hover:text-[#1f211c]"
      >
        <CaretDownIcon className="size-3.5" />
      </button>
    </div>
  );
}
