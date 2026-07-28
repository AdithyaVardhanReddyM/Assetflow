"use client";

/**
 * Magic Text — the edit studio's Text tool.
 *
 * Layerize breaks the displayed take into editable text blocks; the studio's
 * canvas becomes the editing stage (type straight onto the poster) while the
 * control panel lists the blocks with their controls. Saving composites the
 * base image and the edited type back into a PNG and registers it as the
 * node's newest generation.
 *
 * State lives in `useMagicText`, owned by the studio page, because the two
 * surfaces it drives — stage and panel — sit in different corners of the
 * screen. The layerize result is cached per source asset: every call bills.
 */

import * as React from "react";
import { ArrowCounterClockwiseIcon, StackIcon, TextTIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { ShimmeringText } from "@/components/ui/shimmering-text";
import {
  type LayerizeResult,
  type MagicTextBlock,
  compositeTextEdit,
  loadBlockFonts,
  loadFont,
} from "@/lib/studio/magic-text";

type Phase =
  | { name: "idle" }
  | { name: "layerizing" }
  | { name: "error"; message: string }
  | { name: "ready" };

export type MagicTextApi = {
  phase: Phase;
  /** Blocks with edits applied — null until a layerize has landed. */
  blocks: MagicTextBlock[] | null;
  result: LayerizeResult | null;
  selectedId: string | null;
  saving: boolean;
  dirty: boolean;
  /**
   * Bumps whenever block *text* is replaced from outside the DOM (reset, new
   * layerize). The stage's contentEditables are uncontrolled, so this is what
   * tells them to re-seed — style edits never bump it.
   */
  revision: number;
  layerize: () => void;
  select: (id: string | null) => void;
  setText: (id: string, text: string) => void;
  setColor: (id: string, color: string) => void;
  setFont: (id: string, candidateIndex: number) => void;
  /** Geometry and misc edits — transforms, font size, subject ordering. */
  patchBlock: (id: string, partial: Partial<MagicTextBlock>) => void;
  resetEdits: () => void;
  save: () => void;
};

/**
 * What a Magic Text host must provide — the studio page and the canvas wire
 * these differently (direct API calls vs the shell's state-advancing
 * handlers), so the hook takes them rather than reaching for a context.
 */
export type MagicTextServices = {
  layerizeAsset: (
    assetId: string,
  ) => Promise<{ ok: true; result: LayerizeResult } | { ok: false; error: string }>;
  fetchAssetBlob: (assetId: string) => Promise<Blob | null>;
  registerTextEdit: (
    nodeId: string,
    image: Blob,
    baseAssetId: string,
  ) => Promise<boolean>;
};

export function useMagicText({
  assetId,
  nodeId,
  services,
  onSaved,
}: {
  /** The displayed take being edited; null when the tool shouldn't offer. */
  assetId: string | null;
  nodeId: string;
  services: MagicTextServices;
  /** Called after the edit lands as the node's newest generation. */
  onSaved: () => void;
}): MagicTextApi {
  const { layerizeAsset, fetchAssetBlob, registerTextEdit } = services;

  const [phase, setPhase] = React.useState<Phase>({ name: "idle" });
  const [result, setResult] = React.useState<LayerizeResult | null>(null);
  const [blocks, setBlocks] = React.useState<MagicTextBlock[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  /** Which source asset the current result decomposes — the cache key. */
  const resultFor = React.useRef<string | null>(null);
  const busy = React.useRef(false);

  // A new take invalidates the decomposition — different pixels, different
  // text. The cached result stays only while the asset it came from shows.
  React.useEffect(() => {
    if (resultFor.current && resultFor.current !== assetId) {
      resultFor.current = null;
      setResult(null);
      setBlocks(null);
      setSelectedId(null);
      setPhase({ name: "idle" });
    }
  }, [assetId]);

  const layerize = React.useCallback(() => {
    if (!assetId || busy.current) return;
    busy.current = true;
    setPhase({ name: "layerizing" });
    void (async () => {
      try {
        const answer = await layerizeAsset(assetId);
        if (!answer.ok) {
          setPhase({ name: "error", message: answer.error });
          return;
        }
        // Fonts first, so the stage never flashes fallback type.
        await loadBlockFonts(answer.result.blocks);
        resultFor.current = assetId;
        setResult(answer.result);
        setBlocks(answer.result.blocks);
        setSelectedId(null);
        setRevision((r) => r + 1);
        setPhase({ name: "ready" });
      } finally {
        busy.current = false;
      }
    })();
  }, [assetId, layerizeAsset]);

  const patch = React.useCallback(
    (id: string, updater: (block: MagicTextBlock) => MagicTextBlock) => {
      setBlocks((current) =>
        current ? current.map((b) => (b.id === id ? updater(b) : b)) : current,
      );
    },
    [],
  );

  const setText = React.useCallback(
    (id: string, text: string) => patch(id, (b) => ({ ...b, text })),
    [patch],
  );
  const setColor = React.useCallback(
    (id: string, color: string) => patch(id, (b) => ({ ...b, color })),
    [patch],
  );
  const setFont = React.useCallback(
    (id: string, candidateIndex: number) => {
      patch(id, (b) => {
        const font = b.candidates[candidateIndex];
        if (!font) return b;
        void loadFont(font);
        return { ...b, font };
      });
    },
    [patch],
  );

  const patchBlock = React.useCallback(
    (id: string, partial: Partial<MagicTextBlock>) =>
      patch(id, (b) => ({ ...b, ...partial })),
    [patch],
  );

  const resetEdits = React.useCallback(() => {
    setBlocks(result ? result.blocks : null);
    setRevision((r) => r + 1);
  }, [result]);

  const dirty = React.useMemo(() => {
    if (!result || !blocks) return false;
    return blocks.some((b, i) => {
      const o = result.blocks[i];
      return (
        b.text !== o.text ||
        b.color !== o.color ||
        b.font !== o.font ||
        b.x !== o.x ||
        b.y !== o.y ||
        b.width !== o.width ||
        b.height !== o.height ||
        b.fontSize !== o.fontSize ||
        b.angle !== o.angle ||
        b.aboveSubject !== o.aboveSubject
      );
    });
  }, [blocks, result]);

  const save = React.useCallback(() => {
    if (!result || !blocks || saving) return;
    setSaving(true);
    void (async () => {
      /** Whether the edit reached `onSaved` — see the release below. */
      let handedOff = false;
      try {
        const baseBlob = await fetchAssetBlob(result.baseAssetId);
        if (!baseBlob) {
          toast.error("Could not load the base image for compositing.");
          return;
        }
        // The cutout is part of what the editor showed — exporting without it
        // would silently change the picture, so its failure fails the save.
        let cutoutBlob: Blob | null = null;
        if (result.cutout) {
          cutoutBlob = await fetchAssetBlob(result.cutout.assetId);
          if (!cutoutBlob) {
            toast.error("Could not load the subject layer — try again.");
            return;
          }
        }
        const composited = await compositeTextEdit(baseBlob, result, blocks, cutoutBlob);
        if (!composited) {
          toast.error("Compositing the edit failed.");
          return;
        }
        const ok = await registerTextEdit(nodeId, composited, result.baseAssetId);
        if (!ok) {
          toast.error("The edit could not be saved.");
          return;
        }
        handedOff = true;
        onSaved();
      } finally {
        // Only a save that failed releases the button. A successful one hands
        // off to the host, which leaves for the canvas — and the navigation
        // outlives this callback, so releasing would flash the button back to
        // "Save to node" on a screen that is already on its way out.
        if (!handedOff) setSaving(false);
      }
    })();
  }, [blocks, fetchAssetBlob, nodeId, onSaved, registerTextEdit, result, saving]);

  return {
    phase,
    blocks,
    result,
    selectedId,
    saving,
    dirty,
    revision,
    layerize,
    select: setSelectedId,
    setText,
    setColor,
    setFont,
    patchBlock,
    resetEdits,
    save,
  };
}

// --- stage -----------------------------------------------------------------

/**
 * One block on the stage. Uncontrolled contentEditable: React re-renders the
 * *styles* as controls change, but the text node belongs to the DOM — writing
 * state back into children would reset the caret on every keystroke.
 */
function StageBlock({
  block,
  selected,
  onSelect,
  onTextChange,
}: {
  block: MagicTextBlock;
  selected: boolean;
  onSelect: () => void;
  onTextChange: (text: string) => void;
}) {
  const el = React.useRef<HTMLDivElement>(null);
  // Seed the DOM once per block identity; edits flow out, never back in.
  React.useEffect(() => {
    if (el.current && el.current.textContent !== block.text) {
      el.current.textContent = block.text;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id]);

  return (
    <div
      ref={el}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label={`Text layer: ${block.text.slice(0, 30)}`}
      onFocus={onSelect}
      onPointerDown={onSelect}
      onInput={(e) => onTextChange((e.target as HTMLElement).innerText)}
      className={cn(
        "absolute cursor-text overflow-visible outline-none transition-shadow duration-150",
        selected
          ? "shadow-[0_0_0_1.5px_rgba(255,255,255,0.95),0_0_0_3px_rgba(31,33,28,0.85)]"
          : "hover:shadow-[0_0_0_1.5px_rgba(255,255,255,0.55)]",
      )}
      style={{
        left: block.x,
        top: block.y,
        width: block.width,
        minHeight: block.height,
        transform: block.angle ? `rotate(${block.angle}deg)` : undefined,
        fontFamily: `"${block.font.family}", sans-serif`,
        fontWeight: block.font.weight,
        fontStyle: block.font.italic ? "italic" : undefined,
        fontSize: block.fontSize,
        lineHeight: block.lineHeight,
        color: block.color,
        textAlign: block.alignment,
        textTransform: block.allCaps ? "uppercase" : undefined,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    />
  );
}

/**
 * The selected block's transform chrome: edges drag to move, corners scale
 * about the centre (font size follows), and the lollipop above rotates with
 * snapping near the compass points. Rendered inside the scaled stage, so
 * every handle counter-scales to keep a constant screen size.
 *
 * Handles work from a snapshot of the block taken at pointer-down — absolute
 * math against the start state, never incremental, so precision cannot drift
 * across a drag.
 */
function TransformFrame({
  block,
  scale,
  toSpace,
  onPatch,
}: {
  block: MagicTextBlock;
  scale: number;
  /** Client coords → block coordinate space (the stage owns the rect). */
  toSpace: (clientX: number, clientY: number) => { x: number; y: number };
  onPatch: (partial: Partial<MagicTextBlock>) => void;
}) {
  const start = React.useRef<{
    role: "move" | "scale" | "rotate";
    pointer: { x: number; y: number };
    block: MagicTextBlock;
  } | null>(null);

  const beginDrag = (e: React.PointerEvent) => {
    const role = (e.currentTarget as HTMLElement).dataset.role as
      | "move"
      | "scale"
      | "rotate"
      | undefined;
    if (!role) return;
    e.preventDefault();
    e.stopPropagation();
    start.current = { role, pointer: toSpace(e.clientX, e.clientY), block };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const p = toSpace(e.clientX, e.clientY);
    const b = s.block;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;

    if (s.role === "move") {
      onPatch({
        x: Math.round(b.x + (p.x - s.pointer.x)),
        y: Math.round(b.y + (p.y - s.pointer.y)),
      });
    } else if (s.role === "scale") {
      const from = Math.hypot(s.pointer.x - cx, s.pointer.y - cy);
      const to = Math.hypot(p.x - cx, p.y - cy);
      if (from < 1) return;
      // Centre-anchored scaling stays honest under rotation — the centre is
      // the one point the rotation never moves.
      let factor = to / from;
      factor = Math.max(factor, 4 / b.fontSize, 8 / b.width);
      onPatch({
        width: b.width * factor,
        height: b.height * factor,
        fontSize: b.fontSize * factor,
        x: cx - (b.width * factor) / 2,
        y: cy - (b.height * factor) / 2,
      });
    } else {
      const degrees = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
      const wrapped = ((degrees + 540) % 360) - 180;
      // Magnetic compass points: a poster's type is usually meant straight.
      const snapped = [-180, -90, 0, 90, 180].find(
        (mark) => Math.abs(wrapped - mark) < 4,
      );
      onPatch({ angle: snapped ?? Math.round(wrapped * 10) / 10 });
    }
  };

  const endDrag = () => {
    start.current = null;
  };

  /** Constant on-screen sizes, whatever the stage zoom. */
  const px = (n: number) => n / scale;
  const edge = px(8);
  const handle = px(11);

  const corners = [
    { left: 0, top: 0, cursor: "nwse-resize" },
    { left: block.width, top: 0, cursor: "nesw-resize" },
    { left: 0, top: block.height, cursor: "nesw-resize" },
    { left: block.width, top: block.height, cursor: "nwse-resize" },
  ];

  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: block.x,
        top: block.y,
        width: block.width,
        height: block.height,
        transform: block.angle ? `rotate(${block.angle}deg)` : undefined,
        outline: `${px(1.5)}px solid rgba(31,33,28,0.9)`,
        boxShadow: `0 0 0 ${px(3)}px rgba(255,255,255,0.75)`,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Edge strips — grab anywhere on the border to move. */}
      {[
        { left: 0, top: -edge, width: "100%", height: edge },
        { left: 0, top: "100%", width: "100%", height: edge },
        { left: -edge, top: 0, width: edge, height: "100%" },
        { left: "100%", top: 0, width: edge, height: "100%" },
      ].map((strip, i) => (
        <div
          key={i}
          data-role="move"
          onPointerDown={beginDrag}
          className="pointer-events-auto absolute"
          style={{ ...strip, cursor: "move", touchAction: "none" }}
        />
      ))}

      {/* Corner scale handles. */}
      {corners.map((corner, i) => (
        <div
          key={i}
          data-role="scale"
          onPointerDown={beginDrag}
          className="pointer-events-auto absolute border bg-white"
          style={{
            left: corner.left,
            top: corner.top,
            width: handle,
            height: handle,
            marginLeft: -handle / 2,
            marginTop: -handle / 2,
            borderColor: "rgba(31,33,28,0.9)",
            borderWidth: px(1.5),
            cursor: corner.cursor,
            touchAction: "none",
          }}
        />
      ))}

      {/* Rotate lollipop. */}
      <div
        className="absolute bg-[#1f211c]/60"
        style={{
          left: "50%",
          top: -px(26),
          width: px(1.5),
          height: px(18),
          marginLeft: -px(0.75),
        }}
      />
      <div
        data-role="rotate"
        onPointerDown={beginDrag}
        aria-label="Rotate"
        className="pointer-events-auto absolute border bg-white"
        style={{
          left: "50%",
          top: -px(32),
          width: handle,
          height: handle,
          marginLeft: -handle / 2,
          borderColor: "rgba(31,33,28,0.9)",
          borderWidth: px(1.5),
          cursor: "grab",
          touchAction: "none",
        }}
      />
    </div>
  );
}

/**
 * The editing surface that takes over the modal's media pane: the text-erased
 * base image at the block coordinate space's size, scaled as one unit to fit,
 * with a contentEditable div per block laid over it. With a subject cutout
 * the paint order becomes the occlusion sandwich — base, the blocks behind,
 * the subject, the blocks in front — and the export mirrors it exactly.
 */
export function MagicTextStage({
  result,
  blocks,
  revision,
  selectedId,
  onSelect,
  onTextChange,
  onPatchBlock,
}: {
  result: LayerizeResult;
  blocks: MagicTextBlock[];
  /** Re-keys the contentEditables when text state is replaced from outside. */
  revision: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onTextChange: (id: string, text: string) => void;
  onPatchBlock: (id: string, partial: Partial<MagicTextBlock>) => void;
}) {
  const frame = React.useRef<HTMLDivElement>(null);
  const stageEl = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0);

  // Fit the coordinate space into whatever the pane gives us; the wrapper is
  // laid out at natural size and scaled, so font metrics stay exact.
  React.useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setScale(
        Math.min(rect.width / result.space.w, rect.height / result.space.h),
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [result.space.w, result.space.h]);

  return (
    <div
      ref={frame}
      className="flex h-full w-full items-center justify-center overflow-hidden p-6"
      // Clicking the dark surround drops the selection.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
    >
      {scale > 0 ? (
        <div
          style={{
            width: result.space.w * scale,
            height: result.space.h * scale,
          }}
        >
          <div
            ref={stageEl}
            className="relative origin-top-left"
            style={{
              width: result.space.w,
              height: result.space.h,
              transform: `scale(${scale})`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={result.baseUrl}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full select-none"
            />
            {/* Behind the subject… */}
            {blocks
              .filter((b) => !b.aboveSubject)
              .map((block) => (
                <StageBlock
                  key={`${block.id}-${revision}`}
                  block={block}
                  selected={block.id === selectedId}
                  onSelect={() => onSelect(block.id)}
                  onTextChange={(text) => onTextChange(block.id, text)}
                />
              ))}
            {/* …the subject itself (clicks pass through to the type below)… */}
            {result.cutout ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={result.cutout.url}
                alt=""
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none"
              />
            ) : null}
            {/* …and the blocks pulled in front. */}
            {blocks
              .filter((b) => b.aboveSubject)
              .map((block) => (
                <StageBlock
                  key={`${block.id}-${revision}`}
                  block={block}
                  selected={block.id === selectedId}
                  onSelect={() => onSelect(block.id)}
                  onTextChange={(text) => onTextChange(block.id, text)}
                />
              ))}
            {(() => {
              const selected = blocks.find((b) => b.id === selectedId);
              return selected ? (
                <TransformFrame
                  block={selected}
                  scale={scale}
                  toSpace={(clientX, clientY) => {
                    const rect = stageEl.current?.getBoundingClientRect();
                    if (!rect) return { x: 0, y: 0 };
                    return {
                      x: (clientX - rect.left) / scale,
                      y: (clientY - rect.top) / scale,
                    };
                  }}
                  onPatch={(partial) => onPatchBlock(selected.id, partial)}
                />
              ) : null;
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- aside panel -----------------------------------------------------------

function BlockRow({
  block,
  selected,
  hasCutout,
  onSelect,
  onColor,
  onFont,
  onPatch,
}: {
  block: MagicTextBlock;
  selected: boolean;
  /** Whether a subject layer exists — without one there is no front/behind. */
  hasCutout: boolean;
  onSelect: () => void;
  onColor: (color: string) => void;
  onFont: (candidateIndex: number) => void;
  onPatch: (partial: Partial<MagicTextBlock>) => void;
}) {
  const label = block.text.replace(/\s+/g, " ").trim();
  return (
    <div
      className={cn(
        "border transition-colors duration-150",
        selected ? "border-[#1f211c]/45 bg-[#faf8f4]" : "border-[#1f211c]/10",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full flex-col gap-0.5 px-2.5 py-2 text-left"
      >
        <span
          className="truncate text-[12.5px] text-[#1f211c]"
          style={{
            fontFamily: `"${block.font.family}", sans-serif`,
            fontWeight: block.font.weight,
            textTransform: block.allCaps ? "uppercase" : undefined,
          }}
        >
          {label || "(empty)"}
        </span>
        <span className="text-[10px] text-[#a09a88]">
          {block.font.family} · {Math.round(block.fontSize)}px · {block.styleClass}
        </span>
      </button>

      {selected ? (
        <div className="flex flex-col gap-1.5 border-t border-[#1f211c]/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Font"
              value={block.candidates.indexOf(block.font)}
              onChange={(e) => onFont(Number(e.target.value))}
              className="h-7 min-w-0 flex-1 border border-[#1f211c]/14 bg-white px-1.5 text-[11px] text-[#1f211c] outline-none focus:border-[#1f211c]/35"
            >
              {block.candidates.map((candidate, i) => (
                <option key={`${candidate.source}-${i}`} value={i}>
                  {candidate.family} {candidate.weight}
                  {candidate.italic ? " italic" : ""}
                </option>
              ))}
            </select>
            <label
              className="relative grid size-7 shrink-0 cursor-pointer place-items-center border border-[#1f211c]/14"
              title="Text color"
            >
              <span className="size-4" style={{ background: block.color }} />
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(block.color) ? block.color : "#1f211c"}
                onChange={(e) => onColor(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Text color"
              />
            </label>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              aria-label="Font size"
              title="Font size (px)"
              min={4}
              max={500}
              value={Math.round(block.fontSize)}
              onChange={(e) => {
                const size = Number(e.target.value);
                if (Number.isFinite(size)) {
                  onPatch({ fontSize: Math.min(500, Math.max(4, size)) });
                }
              }}
              className="h-7 w-16 border border-[#1f211c]/14 bg-white px-1.5 text-[11px] text-[#1f211c] outline-none focus:border-[#1f211c]/35"
            />
            <span className="text-[10px] text-[#a09a88]">px</span>
            {hasCutout ? (
              <button
                type="button"
                onClick={() => onPatch({ aboveSubject: !block.aboveSubject })}
                title="Whether this text renders in front of the subject or tucks behind it"
                className="ml-auto flex h-7 items-center border border-[#1f211c]/14 px-2 text-[10.5px] font-medium text-[#4c4a41] transition-colors hover:border-[#1f211c]/35"
              >
                {block.aboveSubject ? "In front of subject" : "Behind subject"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function MagicTextPanel({ api }: { api: MagicTextApi }) {
  const { phase, blocks } = api;

  if (phase.name !== "ready" || !blocks) {
    return (
      <div className="flex flex-col">
        <div className="flex flex-col items-center gap-3 px-2 py-4 text-center">
          <span className="grid size-10 place-items-center bg-[#1f211c]/6 text-[#4c4a41]">
            <TextTIcon className="size-5" />
          </span>
          {phase.name === "layerizing" ? (
            <ShimmeringText
              text="Reading the type…"
              className="text-[12.5px] font-medium"
            />
          ) : (
            <>
              <p className="text-[12.5px] leading-5 text-[#4c4a41]">
                Turn the text in this image into editable layers — retype it,
                recolor it, keep the look.
              </p>
              {phase.name === "error" ? (
                <p className="text-[11px] leading-4 text-[#a9743f]">{phase.message}</p>
              ) : null}
              <button
                type="button"
                onClick={api.layerize}
                className="flex h-8 items-center gap-1.5 bg-[#1f211c] px-3 text-[12px] font-semibold text-[#f7f4ee] transition-all duration-150 hover:brightness-125 active:scale-[0.97]"
              >
                <StackIcon className="size-3.5" />
                {phase.name === "error" ? "Try again" : "Layerize"}
              </button>
              <p className="text-[10.5px] text-[#a09a88]">
                ~15 sec · works best on clean, straight text
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    // Sized by its content — the aside's section opens to whatever this needs.
    <div className="flex flex-col">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold tracking-[0.06em] text-[#a09a88] uppercase">
          Text layers
        </p>
        <button
          type="button"
          onClick={api.resetEdits}
          disabled={!api.dirty}
          className={cn(
            "flex items-center gap-1 text-[10.5px] font-semibold text-[#8a8271] transition-opacity duration-150 hover:text-[#1f211c]",
            api.dirty ? "opacity-100" : "opacity-0",
          )}
        >
          <ArrowCounterClockwiseIcon className="size-3" />
          Reset
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        {blocks.map((block) => (
          <BlockRow
            key={block.id}
            block={block}
            selected={block.id === api.selectedId}
            hasCutout={Boolean(api.result?.cutout)}
            onSelect={() => api.select(block.id)}
            onColor={(color) => api.setColor(block.id, color)}
            onFont={(i) => api.setFont(block.id, i)}
            onPatch={(partial) => api.patchBlock(block.id, partial)}
          />
        ))}
      </div>

      <p className="mt-3 text-[10.5px] leading-4 text-[#a09a88]">
        Click a layer on the image to retype it; drag its border to move, the
        corners to resize, the knob to rotate. Decorative or hidden type may
        stay part of the background.
      </p>

      <div className="pt-5">
        <button
          type="button"
          disabled={api.saving || !api.dirty}
          onClick={api.save}
          className="flex h-9 w-full items-center justify-center gap-2 bg-primary text-[13px] font-semibold text-primary-foreground transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 disabled:hover:brightness-100"
        >
          <TextTIcon className="size-4" weight="bold" />
          {api.saving ? "Saving…" : "Save to node"}
        </button>
      </div>
    </div>
  );
}
