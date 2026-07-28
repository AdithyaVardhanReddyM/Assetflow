"use client";

/**
 * Captions — the expand modal's caption tool for video takes.
 *
 * Three exports, wired the same way in the generate node and the composition
 * node: `useCaptions` owns the flow (transcribe → style → place → burn),
 * `CaptionsSection` is the aside panel, and `CaptionStage` takes over the
 * modal's media pane with the video plus a live, draggable caption overlay.
 *
 * The overlay is CSS painting the same fonts, fractions, and colors the
 * ffmpeg/libass burn uses (`lib/studio/captions.ts` mirrors the backend's
 * style table), so scrubbing the video with a style selected is an honest
 * preview of the file that comes back.
 */

import * as React from "react";
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  PencilSimpleIcon,
  SubtitlesSlashIcon,
  SubtitlesIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  activeWordAt,
  buildCues,
  CAPTION_ACCENT,
  CAPTION_INK,
  CAPTION_STYLES,
  captionStyle,
  cueAt,
  DEFAULT_PLACEMENT,
  MAX_CAPTION_SCALE,
  MIN_CAPTION_SCALE,
  type CaptionCue,
  type CaptionPlacement,
  type CaptionStyleSpec,
  type CaptionWord,
  type Transcript,
} from "@/lib/studio/captions";
import { useStudio } from "../studio-context";

// --- state ----------------------------------------------------------------

export type CaptionsPhase =
  | "idle"
  | "transcribing"
  | "nospeech"
  | "error"
  | "ready"
  | "burning";

export type CaptionsState = {
  phase: CaptionsPhase;
  error: string | null;
  transcript: Transcript | null;
  styleId: string;
  setStyleId: (id: string) => void;
  placement: CaptionPlacement;
  setPlacement: React.Dispatch<React.SetStateAction<CaptionPlacement>>;
  cues: CaptionCue[];
  /** Fix one transcribed word in place — timestamps stay. */
  editWord: (index: number, text: string) => void;
  start: () => void;
  apply: () => void;
  /** The stage reports the video's true pixel size here on load. */
  onVideoDims: (w: number, h: number) => void;
  /** True while the modal's media pane should be the caption editor. */
  stageActive: boolean;
};

/**
 * The caption flow for one displayed take. `takeKey` identifies the take the
 * modal is showing (asset id, or the output URL when no id is known) — when
 * it changes, the flow resets; transcripts are cached per key so reopening a
 * take never re-bills Scribe. `assetId` may be null: the shell resolves the
 * node's latest result in that case (the composition node's render carries no
 * asset id on the client).
 */
export function useCaptions({
  nodeId,
  assetId,
  takeKey,
}: {
  nodeId: string;
  assetId: string | null;
  takeKey: string | null;
}): CaptionsState {
  const { transcribeTake, burnTakeCaptions } = useStudio();

  const [phase, setPhase] = React.useState<CaptionsPhase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [transcript, setTranscript] = React.useState<Transcript | null>(null);
  const [styleId, setStyleId] = React.useState(CAPTION_STYLES[0].id);
  const [placement, setPlacement] = React.useState(DEFAULT_PLACEMENT);
  const [dims, setDims] = React.useState<{ w: number; h: number } | null>(null);
  const cache = React.useRef(new Map<string, Transcript>());
  const [fontsReady, setFontsReady] = React.useState(false);

  // The measuring canvas must see the caption TTFs, or the first grouping
  // pass uses fallback metrics and the burn wraps differently.
  React.useEffect(() => {
    let alive = true;
    void Promise.all(
      CAPTION_STYLES.map((s) =>
        document.fonts.load(`${s.italic ? "italic " : ""}16px ${s.family}`),
      ),
    )
      .catch(() => null)
      .then(() => alive && setFontsReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // A different take on the well — start over (its cached transcript, if
  // any, comes back without a Scribe call). State-during-render, not an
  // effect, so the old take's words never paint over the new video.
  const [lastKey, setLastKey] = React.useState(takeKey);
  if (takeKey !== lastKey) {
    setLastKey(takeKey);
    setPhase("idle");
    setError(null);
    setTranscript(null);
    setPlacement(DEFAULT_PLACEMENT);
  }

  const start = React.useCallback(() => {
    if (!takeKey) return;
    const cached = cache.current.get(takeKey);
    if (cached) {
      setTranscript(cached);
      setPhase(cached.hasSpeech ? "ready" : "nospeech");
      return;
    }
    setPhase("transcribing");
    setError(null);
    void transcribeTake(nodeId, assetId).then((result) => {
      if (!result.ok) {
        setError(result.error);
        setPhase("error");
        return;
      }
      cache.current.set(takeKey, result.transcript);
      setTranscript(result.transcript);
      setPhase(result.transcript.hasSpeech ? "ready" : "nospeech");
    });
  }, [nodeId, assetId, takeKey, transcribeTake]);

  const style = captionStyle(styleId);
  const cues = React.useMemo(() => {
    if (!transcript?.hasSpeech || !dims || !fontsReady) return [];
    return buildCues(transcript.words, style, placement, dims.w, dims.h);
  }, [transcript, style, placement, dims, fontsReady]);

  const editWord = React.useCallback((index: number, text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setTranscript((current) => {
      if (!current) return current;
      const words = current.words.map((w, i) =>
        i === index ? { ...w, text: clean } : w,
      );
      return { ...current, words };
    });
  }, []);

  const apply = React.useCallback(() => {
    if (!cues.length) return;
    setPhase("burning");
    setError(null);
    void burnTakeCaptions(nodeId, assetId, {
      style: styleId,
      placement,
      cues,
    }).then((result) => {
      if (!result.ok) {
        setError(result.error);
        setPhase("ready");
        return;
      }
      // The burned video lands as the node's newest take — the modal's media
      // follows it, and `takeKey` changing resets this flow for the new file.
      setPhase("idle");
    });
  }, [nodeId, assetId, styleId, placement, cues, burnTakeCaptions]);

  const onVideoDims = React.useCallback((w: number, h: number) => {
    setDims((current) =>
      current?.w === w && current?.h === h ? current : { w, h },
    );
  }, []);

  return {
    phase,
    error,
    transcript,
    styleId,
    setStyleId,
    placement,
    setPlacement,
    cues,
    editWord,
    start,
    apply,
    onVideoDims,
    stageActive: phase === "ready" || phase === "burning",
  };
}

// --- caption text CSS -----------------------------------------------------

/** An 8-point text-shadow ring — the CSS stand-in for libass's outline. */
function outlineShadow(px: number, color = "#000"): string {
  if (px <= 0) return "";
  const r = Math.max(1, px);
  const points = [
    [r, 0], [-r, 0], [0, r], [0, -r],
    [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7],
    [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7],
  ];
  return points.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px 0 ${color}`).join(", ");
}

/**
 * The line-level CSS for a style, at a given rendered video height. `scale`
 * is the user's corner-handle multiplier — stroke and shadow ride along so a
 * grown caption doesn't thin out.
 */
function lineStyle(
  style: CaptionStyleSpec,
  videoH: number,
  scale = 1,
): React.CSSProperties {
  const fontPx = style.sizeFrac * scale * videoH;
  const shadows: string[] = [];
  const stroke = outlineShadow((style.strokeFrac ?? 0) * scale * videoH);
  if (stroke) shadows.push(stroke);
  if (style.shadow) {
    shadows.push(
      `0 ${(0.006 * scale * videoH).toFixed(1)}px ${(0.012 * scale * videoH).toFixed(1)}px rgba(0,0,0,0.6)`,
    );
  }
  return {
    fontFamily: style.family,
    fontStyle: style.italic ? "italic" : "normal",
    fontSize: `${fontPx}px`,
    lineHeight: 1.25,
    color: style.color,
    textTransform: style.uppercase ? "uppercase" : "none",
    textShadow: shadows.join(", ") || undefined,
    textAlign: "center",
  };
}

/** One caption line's words, the active one marked per the style. */
function CaptionLine({
  line,
  style,
  active,
}: {
  line: CaptionWord[];
  style: CaptionStyleSpec;
  active: CaptionWord | null;
}) {
  return (
    <span
      className={cn("block", style.boxed && "w-fit mx-auto px-[0.5em] py-[0.15em]")}
      style={style.boxed ? { background: "rgba(0,0,0,0.69)" } : undefined}
    >
      {line.map((word, i) => {
        const isActive = active === word && style.highlight !== "none";
        return (
          <React.Fragment key={`${i}-${word.start}`}>
            {i > 0 ? " " : null}
            <span
              className={cn(isActive && "inline-block")}
              style={
                isActive
                  ? style.highlight === "block"
                    ? {
                        background: CAPTION_ACCENT,
                        color: CAPTION_INK,
                        textShadow: "none",
                        padding: "0.02em 0.14em",
                        margin: "-0.02em -0.02em",
                      }
                    : { color: CAPTION_ACCENT }
                  : undefined
              }
            >
              {word.text}
            </span>
          </React.Fragment>
        );
      })}
    </span>
  );
}

// --- the stage ------------------------------------------------------------

/** Where the video's picture actually sits inside a contain-fit container. */
function contentRect(
  box: { width: number; height: number },
  video: { w: number; h: number },
) {
  const scale = Math.min(box.width / video.w, box.height / video.h);
  const w = video.w * scale;
  const h = video.h * scale;
  return { w, h, x: (box.width - w) / 2, y: (box.height - h) / 2 };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The modal's media pane while captions are being placed: the take playing
 * with its captions overlaid live. The caption box drags anywhere on the
 * picture (snapping to the horizontal center), and its side handles set the
 * width the grouping wraps to. All stored as fractions, so the same numbers
 * place the burn on landscape and vertical renders alike.
 */
export function CaptionStage({
  url,
  captions,
}: {
  url: string;
  captions: CaptionsState;
}) {
  const { cues, placement, setPlacement, onVideoDims } = captions;
  const style = captionStyle(captions.styleId);

  const container = React.useRef<HTMLDivElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [box, setBox] = React.useState<{ width: number; height: number } | null>(null);
  const [video, setVideo] = React.useState<{ w: number; h: number } | null>(null);
  const [time, setTime] = React.useState(0);
  const [paused, setPaused] = React.useState(true);
  const [drag, setDrag] = React.useState<
    null | "move" | "left" | "right" | "top" | "bottom"
  >(null);
  /** A height drag's anchor: pointer distance from box center at grab. */
  const scaleStart = React.useRef<{ dist: number; scale: number } | null>(null);

  React.useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The overlay follows playback per frame; timeupdate alone is too coarse
  // for word-level highlights.
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      const media = videoRef.current;
      if (media) setTime(media.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const rect = box && video ? contentRect(box, video) : null;
  // Playing, the overlay is an honest preview — captions come and go on the
  // burn's exact windows. Paused, picking a style must show something *now*:
  // fall back to the nearest cue, so the caption never has to be hunted for.
  const liveCue = cues.length ? cueAt(cues, time) : null;
  const cue =
    liveCue ??
    (paused && cues.length
      ? (cues.find((c) => c.start >= time) ?? cues[cues.length - 1])
      : null);
  const active = cue
    ? (activeWordAt(cue, time) ?? (paused ? (cue.lines[0]?.[0] ?? null) : null))
    : null;

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !rect) return;
    const bounds = container.current!.getBoundingClientRect();
    const px = (e.clientX - bounds.left - rect.x) / rect.w;
    const py = (e.clientY - bounds.top - rect.y) / rect.h;
    setPlacement((current) => {
      if (drag === "move") {
        const x = clamp(px, 0.08, 0.92);
        return {
          ...current,
          // Snap to the horizontal center — where captions almost always live.
          x: Math.abs(x - 0.5) < 0.03 ? 0.5 : x,
          y: clamp(py, 0.08, 0.94),
        };
      }
      if (drag === "top" || drag === "bottom") {
        // Height handles set the text size: the box grows with the pointer's
        // vertical distance from its center, from wherever it was grabbed —
        // same symmetric-about-center rule as the width handles.
        const start = scaleStart.current;
        if (!start) return current;
        const dist = Math.abs((py - current.y) * rect.h);
        return {
          ...current,
          scale: clamp(
            start.scale * (dist / Math.max(10, start.dist)),
            MIN_CAPTION_SCALE,
            MAX_CAPTION_SCALE,
          ),
        };
      }
      // Width handles resize symmetrically about the box center.
      const half = Math.abs(px - current.x);
      return { ...current, w: clamp(half * 2, 0.24, 0.96) };
    });
  };

  return (
    <div
      ref={container}
      className="absolute inset-0"
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      <video
        ref={videoRef}
        key={url}
        src={url}
        controls
        playsInline
        loop
        className="absolute inset-0 h-full w-full object-contain"
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onLoadedMetadata={(e) => {
          const media = e.currentTarget;
          if (media.videoWidth && media.videoHeight) {
            setVideo({ w: media.videoWidth, h: media.videoHeight });
            onVideoDims(media.videoWidth, media.videoHeight);
          }
        }}
      />

      {rect ? (
        <div
          className="pointer-events-none absolute"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          {/* Center guide, while the box is being placed. */}
          {drag === "move" && placement.x === 0.5 ? (
            <div className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 bg-primary/80" />
          ) : null}

          <div
            className={cn(
              "pointer-events-auto absolute select-none",
              drag ? "cursor-grabbing" : "cursor-grab",
            )}
            style={{
              left: `${placement.x * 100}%`,
              top: `${placement.y * 100}%`,
              width: `${placement.w * 100}%`,
              transform: "translate(-50%, -50%)",
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag("move");
            }}
          >
            {/* The box outline is editor chrome, never part of the preview —
                always on while placing, so the target is never hunted for.
                Primary with a white keyline, so it separates from dark and
                light footage alike. */}
            <div
              className={cn(
                "absolute -inset-2 border-2 border-primary shadow-[0_0_0_1px_rgba(255,255,255,0.85)] transition-opacity duration-150",
                drag ? "opacity-100" : "opacity-90",
              )}
            />
            {(["left", "right"] as const).map((side) => (
              <div
                key={side}
                role="presentation"
                className={cn(
                  "absolute top-1/2 z-10 h-8 w-2.5 -translate-y-1/2 cursor-ew-resize bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.85)]",
                  side === "left" ? "-left-3.5" : "-right-3.5",
                )}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  (e.currentTarget.parentElement as HTMLElement).setPointerCapture?.(
                    e.pointerId,
                  );
                  setDrag(side);
                }}
              />
            ))}

            {/* Top and bottom set the text size — pull away from the center
                to grow it. Double-click puts the style's own size back. */}
            {(["top", "bottom"] as const).map((side) => (
              <div
                key={side}
                role="presentation"
                title="Drag to resize the text · double-click to reset"
                className={cn(
                  "absolute left-1/2 z-10 h-2.5 w-8 -translate-x-1/2 cursor-ns-resize bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.85)]",
                  side === "top" ? "-top-3.5" : "-bottom-3.5",
                )}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  (e.currentTarget.parentElement as HTMLElement).setPointerCapture?.(
                    e.pointerId,
                  );
                  const bounds = container.current!.getBoundingClientRect();
                  scaleStart.current = {
                    dist: Math.abs(
                      e.clientY - bounds.top - rect.y - placement.y * rect.h,
                    ),
                    scale: placement.scale,
                  };
                  setDrag(side);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setPlacement((current) => ({ ...current, scale: 1 }));
                }}
              />
            ))}

            <div style={lineStyle(style, rect.h, placement.scale)}>
              {cue ? (
                cue.lines.map((line, i) => (
                  <CaptionLine key={i} line={line} style={style} active={active} />
                ))
              ) : (
                // Between cues the box must stay findable — a hairline pilot
                // text at low opacity, never burned.
                <span className="block text-center opacity-0">·</span>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- the aside panel ------------------------------------------------------

/**
 * A preset card — its dummy line rendered in the actual style over a dark
 * "footage" tile. Selection is unmistakable: the label bar goes primary with
 * a check, and the whole card takes the ink border — the same active-tool
 * yellow the rest of the canvas reserves for exactly this.
 */
function StyleCard({
  style,
  selected,
  onSelect,
}: {
  style: CaptionStyleSpec;
  selected: boolean;
  onSelect: () => void;
}) {
  // Cards are ~110px wide; scale each style as if that were a tiny video.
  const preview = lineStyle(style, 160);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group/card flex flex-col border text-left transition-colors duration-150",
        selected
          ? "border-[#1f211c]"
          : "border-[#1f211c]/12 hover:border-[#1f211c]/45",
      )}
    >
      <span className="grid h-14 w-full place-items-center overflow-hidden bg-[#15160f] px-1.5">
        <span style={preview} className="whitespace-nowrap">
          {style.highlight === "none" ? (
            style.dummy
          ) : (
            <>
              {style.dummy.split(" ").slice(0, -1).join(" ")}{" "}
              <span
                style={
                  style.highlight === "block"
                    ? {
                        background: CAPTION_ACCENT,
                        color: CAPTION_INK,
                        textShadow: "none",
                        padding: "0.02em 0.14em",
                      }
                    : { color: CAPTION_ACCENT }
                }
              >
                {style.dummy.split(" ").at(-1)}
              </span>
            </>
          )}
        </span>
      </span>
      <span
        className={cn(
          "flex items-center justify-between gap-1 border-t px-2 py-1.5 text-[10.5px] font-semibold transition-colors duration-150",
          selected
            ? "border-[#1f211c] bg-primary text-[#1f211c]"
            : "border-[#1f211c]/12 bg-white text-[#4c4a41] group-hover/card:text-[#1f211c]",
        )}
      >
        {style.label}
        {selected ? <CheckIcon className="size-3 shrink-0" weight="bold" /> : null}
      </span>
    </button>
  );
}

/** One transcript word — click to fix what Scribe misheard. */
function EditableWord({
  word,
  onCommit,
}: {
  word: CaptionWord;
  onCommit: (text: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(word.text);

  if (!editing) {
    return (
      <button
        type="button"
        title="Click to correct"
        onClick={() => {
          setDraft(word.text);
          setEditing(true);
        }}
        // The dotted underline is the affordance — every word wears it, so
        // the block reads as a row of editable tokens rather than prose.
        className="border-b border-dotted border-[#1f211c]/30 px-0.5 text-[12px] leading-5 text-[#4c4a41] transition-colors hover:border-solid hover:border-[#1f211c] hover:bg-primary/35 hover:text-[#1f211c]"
      >
        {word.text}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== word.text) onCommit(draft);
  };
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      size={Math.max(2, draft.length)}
      className="border border-[#1f211c]/40 bg-white px-0.5 text-[12px] leading-5 text-[#1f211c] outline-none"
    />
  );
}

/**
 * The Captions panel for a take that already IS a caption burn. Burned text
 * can't be restyled — the pixels are in the file — so the only offer is
 * removal, which deletes this generation and falls back to the take beneath
 * it. Re-captioning then starts fresh from the original (its transcript is
 * cached server-side, so no re-billing).
 */
export function CaptionedTakeSection({
  nodeId,
  assetId,
}: {
  nodeId: string;
  /** The burned take. Null while a mid-run URL has no asset row — disabled. */
  assetId: string | null;
}) {
  const { removeCaptions } = useStudio();
  const [removing, setRemoving] = React.useState(false);

  return (
    <div>
      <p className="text-[11.5px] leading-4 text-[#8a8271]">
        This take has captions burned into it. Removing them brings back the
        original video — restyle from there.
      </p>
      <button
        type="button"
        disabled={removing || !assetId}
        onClick={() => {
          if (!assetId) return;
          setRemoving(true);
          void removeCaptions(nodeId, assetId).then((ok) => {
            // On success this take disappears and the section swaps back to
            // the generate flow; only a failure leaves this button behind.
            if (!ok) setRemoving(false);
          });
        }}
        className={cn(
          "mt-3 flex h-9 w-full items-center justify-center gap-2 border text-[13px] font-semibold transition-all duration-150",
          removing
            ? "cursor-default border-[#1f211c]/15 text-[#a09a88]"
            : "border-[#a94848]/30 text-[#a94848] hover:border-[#a94848] hover:bg-[#a94848]/5 active:scale-[0.97]",
        )}
      >
        {removing ? (
          <span className="shimmer-text">Removing…</span>
        ) : (
          <>
            <SubtitlesSlashIcon className="size-4" weight="bold" />
            Remove captions
          </>
        )}
      </button>
    </div>
  );
}

/**
 * The captions panel for the expand modal's aside. Renders the whole flow:
 * the generate button, the transcribing shimmer, the style picker + editable
 * transcript once words are in hand, and the burn button.
 */
export function CaptionsSection({ captions }: { captions: CaptionsState }) {
  const { phase, error, transcript, styleId, setStyleId, editWord } = captions;

  if (phase === "idle" || phase === "transcribing") {
    return (
      <div>
        <p className="mb-3 text-[11.5px] leading-4 text-[#8a8271]">
          Transcribe the speech in this take, pick a caption style, and place
          it on the picture. The words come back with their exact timings.
        </p>
        {phase === "transcribing" ? (
          <p className="flex h-9 items-center text-[12.5px] font-semibold">
            <span className="shimmer-text">Listening for speech…</span>
          </p>
        ) : (
          <button
            type="button"
            onClick={captions.start}
            className="flex h-9 w-full items-center justify-center gap-2 bg-primary text-[13px] font-semibold text-primary-foreground transition-all duration-150 hover:brightness-[0.97] active:scale-[0.97]"
          >
            <SubtitlesIcon className="size-4" weight="bold" />
            Generate Captions
          </button>
        )}
      </div>
    );
  }

  if (phase === "nospeech" || phase === "error") {
    return (
      <div>
        <p className="text-[12px] leading-5 text-[#4c4a41]">
          {phase === "nospeech"
            ? "No speech in this take — nothing to caption. Sound effects and music don't count as words."
            : (error ?? "Transcription did not complete.")}
        </p>
        {phase === "error" ? (
          <button
            type="button"
            onClick={captions.start}
            className="mt-3 flex h-8 items-center gap-1.5 border border-[#1f211c]/15 px-2.5 text-[12px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/40 hover:text-[#1f211c]"
          >
            <ArrowCounterClockwiseIcon className="size-3.5" />
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  // ready | burning
  return (
    <div>
      <div className="grid grid-cols-2 gap-1.5">
        {CAPTION_STYLES.map((style) => (
          <StyleCard
            key={style.id}
            style={style}
            selected={style.id === styleId}
            onSelect={() => setStyleId(style.id)}
          />
        ))}
      </div>

      <p className="mt-3 text-[10.5px] leading-4 text-[#a09a88]">
        Drag the captions on the video to place them — the side handles set
        how wide the lines run, the top and bottom ones set the size.
      </p>

      {transcript ? (
        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold tracking-[0.06em] text-[#a09a88] uppercase">
              Transcript
            </p>
            <span className="flex items-center gap-1 text-[10px] text-[#a09a88]">
              <PencilSimpleIcon className="size-3" />
              Click a word to fix it
            </span>
          </div>
          <div className="thin-scrollbar mt-1.5 max-h-36 overflow-y-auto border-l-2 border-[#1f211c]/12 bg-[#faf8f4]/70 py-2 pr-2 pl-2.5">
            <div className="flex flex-wrap gap-x-1 gap-y-1.5">
              {transcript.words.map((word, i) => (
                <EditableWord
                  key={`${i}-${word.start}`}
                  word={word}
                  onCommit={(text) => editWord(i, text)}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        disabled={phase === "burning" || !captions.cues.length}
        onClick={captions.apply}
        className={cn(
          "mt-3 flex h-9 w-full items-center justify-center gap-2 text-[13px] font-semibold transition-all duration-150",
          phase === "burning"
            ? "cursor-default bg-[#1f211c] text-[#f7f4ee]"
            : "bg-primary text-primary-foreground hover:brightness-[0.97] active:scale-[0.97]",
        )}
      >
        {phase === "burning" ? (
          <span className="shimmer-text">Burning captions…</span>
        ) : (
          "Burn onto video"
        )}
      </button>
      {phase === "ready" && error ? (
        <p className="mt-2 text-[11px] leading-4 text-[#a94848]">{error}</p>
      ) : null}
    </div>
  );
}
