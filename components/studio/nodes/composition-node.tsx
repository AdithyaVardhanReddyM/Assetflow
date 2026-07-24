"use client";

/**
 * The composition node — a picture track and a stack of audio tracks, laid out
 * on a shared timeline.
 *
 * The node is a small edit suite rather than a summary. Connecting a source to
 * a track puts a *clip* on it, which the user drags to place in time; several
 * sources can sit on one track, which is why every track's port is `multi`.
 * Each track also has a fader and a mute, and all of it renders for real — see
 * `TrackCompositor` in `backend/app/engine/compositor.py`.
 *
 * Two things here are load-bearing:
 *
 * - **Clips follow edges.** `useClipSync` reconciles the stored clips against
 *   what is actually connected, so a new edge appends a clip and a removed edge
 *   takes its clip away. Positions survive because a clip is keyed by its
 *   source node, never by index.
 * - **Ports are placed per row.** A track's connector has to sit level with the
 *   track it fills, which no evenly-spaced `PortRail` can do.
 */

import * as React from "react";
import {
  type NodeProps,
  useNodeConnections,
  useNodesData,
  useUpdateNodeInternals,
} from "@xyflow/react";
import {
  CaretDownIcon,
  CopyIcon,
  DownloadSimpleIcon,
  LightningIcon,
  PlayIcon,
  PlusIcon,
  SpeakerSimpleHighIcon,
  SpeakerSimpleSlashIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  type CatalogModel,
  type PortSpec,
  findModel,
  visiblePorts,
} from "@/lib/studio/catalog";
import {
  type Clip,
  type CompositeTrack,
  type StudioNode,
  DEFAULT_TIMELINE_SEC,
  MAX_AUDIO_TRACKS,
  MAX_CLIPS_PER_TRACK,
  MAX_TIMELINE_SEC,
  VIDEO_TRACK_ID,
  compositeTimeline,
  compositeTracks,
  compositeVideoTrack,
  newTrack,
  trackPortId,
} from "@/lib/studio/graph";
import { accentFor } from "@/lib/studio/node-ui";
import { useStudio } from "../studio-context";
import { CompositionIcon, MusicGenIcon, VideoGenIcon } from "../asset-icons";
import { LanePort, OutputPort } from "./ports";
import { ROLE_ICON, ROLE_LABEL } from "./roles";
import { RunBeam, RunWell, isRunBusy } from "./run-well";
import {
  BarButton,
  FloatingBar,
  MoreMenu,
  NodeCard,
  NodeHeader,
  menuItem,
  menuSurface,
} from "./node-chrome";
import {
  DetailChip,
  ExpandButton,
  ExpandDetails,
  NodeExpandModal,
} from "./expand-modal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Matches the generate node's 16:9 card, so a composition previews at the
 *  same size as the video that feeds it. */
const NODE_WIDTH = 572;
const WELL_HEIGHT = Math.round((NODE_WIDTH * 9) / 16);
const TRACK_HEIGHT = 40;
const RULER_HEIGHT = 20;
/**
 * The fader column, held out of the timeline so every track aligns. Wide
 * enough for the bar to read as a level rather than as a control that failed
 * to lay out — a 20px slider with a thumb on it looks like a checkbox.
 */
const CONTROLS_WIDTH = 140;
/** The level bar, in pixels. */
const FADER_WIDTH = 62;
/** The fader's top end: unity is 1, and +6dB of headroom is 2. */
const MAX_GAIN = 2;
/** What an unknown-length source is drawn as until something says otherwise. */
const ASSUMED_CLIP_SEC = 5;
/** Ruler steps, coarsest that still gives a readable number of ticks. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];

type SourceInfo = {
  label: string;
  accent: string;
  Icon: React.ComponentType<{ className?: string }>;
  durationSec: number;
};

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * How long a source runs.
 *
 * A generation's length is whatever its `duration` parameter says, and failing
 * that whatever the catalog expects of the model — the same numbers the
 * compiler uses to estimate a run. An upload has no duration on the canvas
 * (the assets table does not carry one), so it falls back to a nominal width
 * and the real length is settled at render time.
 */
function sourceDuration(
  wire: Record<string, unknown>,
  model: CatalogModel | undefined,
): number {
  const params = (wire.params ?? {}) as Record<string, unknown>;
  const declared = params.duration ?? params.duration_seconds;
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
    return declared;
  }
  return model?.expected_duration_sec ?? ASSUMED_CLIP_SEC;
}

/** Pick a ruler step that yields roughly six to twelve ticks. */
function tickStep(timeline: number): number {
  return TICK_STEPS.find((s) => timeline / s <= 12) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

export function CompositionNode({ id, data, selected }: NodeProps<StudioNode>) {
  const {
    catalog,
    updateNode,
    disconnectPort,
    deleteNode,
    duplicateNode,
    runFrom,
    downloadNode,
  } = useStudio();

  const videoTrack = compositeVideoTrack(data.wire);
  const audioTracks = compositeTracks(data.wire);
  const tracks = React.useMemo(
    () => [videoTrack, ...audioTracks],
    [videoTrack, audioTracks],
  );

  const incoming = useNodeConnections({ handleType: "target" });
  /** Sources per handle, in connection order — one clip each. */
  const sourcesByHandle = React.useMemo(() => {
    const out = new Map<string, string[]>();
    for (const c of incoming) {
      if (!c.targetHandle) continue;
      out.set(c.targetHandle, [...(out.get(c.targetHandle) ?? []), c.source]);
    }
    return out;
  }, [incoming]);

  const sourceIds = React.useMemo(
    () => [...new Set(incoming.map((c) => c.source))],
    [incoming],
  );
  const sourceNodes = useNodesData<StudioNode>(sourceIds);

  const describe = React.useCallback(
    (sourceId: string): SourceInfo => {
      const source = sourceNodes.find((n) => n.id === sourceId);
      if (!source) {
        return { label: "Source", accent: "any", Icon: VideoGenIcon, durationSec: ASSUMED_CLIP_SEC };
      }
      if (source.data.kind === "input.upload") {
        const title = source.data.wire.title;
        return {
          label: typeof title === "string" && title ? title : "Upload",
          accent: source.data.asset?.modality ?? "any",
          Icon: source.data.asset?.modality === "audio" ? MusicGenIcon : VideoGenIcon,
          durationSec: ASSUMED_CLIP_SEC,
        };
      }
      if (source.data.kind === "transform.composite") {
        return {
          label: "Composition",
          accent: "video",
          Icon: CompositionIcon,
          durationSec: compositeTimeline(source.data.wire),
        };
      }
      const model = findModel(
        catalog,
        String(source.data.wire.provider ?? ""),
        String(source.data.wire.model ?? ""),
      );
      const role = model?.role ?? "";
      const title = source.data.wire.title;
      return {
        label:
          typeof title === "string" && title
            ? title
            : (ROLE_LABEL[role] ?? model?.label ?? "Generated"),
        accent: role || model?.modality || "any",
        Icon: ROLE_ICON[role] ?? VideoGenIcon,
        durationSec: sourceDuration(source.data.wire, model),
      };
    },
    [catalog, sourceNodes],
  );

  useClipSync({ id, tracks, sourcesByHandle, describe, updateNode });

  // The timeline is as long as the edit needs, never shorter than the default
  // ruler — so a clip dragged past the end grows the view rather than falling
  // off it.
  const contentEnd = Math.max(
    ...tracks.flatMap((t) =>
      t.clips.map((c) => c.start_sec + (c.duration_sec ?? ASSUMED_CLIP_SEC)),
    ),
    0,
  );
  const timeline = Math.min(
    MAX_TIMELINE_SEC,
    Math.max(DEFAULT_TIMELINE_SEC, compositeTimeline(data.wire), Math.ceil(contentEnd * 1.1)),
  );

  // Adding or removing a track changes which handles exist; React Flow caches
  // handle geometry per node and would keep drawing edges to the old positions.
  const updateNodeInternals = useUpdateNodeInternals();
  const trackKey = tracks.map((t) => t.id).join(",");
  React.useEffect(() => {
    updateNodeInternals(id);
  }, [id, trackKey, updateNodeInternals]);

  const ports = visiblePorts(catalog, "transform.composite", undefined, data.wire);
  const portFor = (trackId: string) => ports.find((p) => p.id === trackPortId(trackId));

  function patchTrack(trackId: string, patch: Partial<CompositeTrack>) {
    if (trackId === VIDEO_TRACK_ID) {
      updateNode(id, { video: { ...videoTrack, ...patch } });
      return;
    }
    updateNode(id, {
      tracks: audioTracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
    });
  }

  function moveClip(trackId: string, source: string, startSec: number) {
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return;
    patchTrack(trackId, {
      clips: track.clips.map((c) =>
        c.source === source ? { ...c, start_sec: Math.max(0, startSec) } : c,
      ),
    });
  }

  function addTrack() {
    if (audioTracks.length >= MAX_AUDIO_TRACKS) return;
    updateNode(id, { tracks: [...audioTracks, newTrack()] });
  }

  function removeTrack(trackId: string) {
    // Never leave the node with no audio track: a composition with nowhere to
    // put sound is not a state the compiler accepts, so it is not offered.
    if (audioTracks.length <= 1) return;
    // The track's handle goes with it, so its edges have to go too — an edge
    // onto a handle that no longer exists is an UNKNOWN_HANDLE on next compile.
    disconnectPort(id, trackPortId(trackId));
    updateNode(id, { tracks: audioTracks.filter((t) => t.id !== trackId) });
  }

  const clipCount = tracks.reduce((n, t) => n + t.clips.length, 0);

  const [expanded, setExpanded] = React.useState(false);
  // A settled render only — a busy or failed well has nothing to blow up.
  const expandMedia =
    !isRunBusy(data.run) && data.run?.status === "succeeded" && data.run.output?.url
      ? { url: data.run.output.url, isVideo: true }
      : null;

  return (
    <div style={{ width: NODE_WIDTH }}>
      <NodeHeader
        icon={CompositionIcon}
        label="Composition"
        right={`${clipCount} ${clipCount === 1 ? "clip" : "clips"} · ${formatTime(timeline)}`}
      />

      <NodeCard selected={selected}>
        <OutputPort modality="video" style={{ top: WELL_HEIGHT / 2 }} />

        {/* Preview well — the same 16:9 card a video node previews into.
            While rendering it wears the prompt bar's border beam. */}
        <RunBeam active={isRunBusy(data.run)}>
          <div
            className="group relative flex items-center justify-center overflow-hidden bg-[#faf8f4]"
            style={{ height: WELL_HEIGHT }}
          >
            <RunWell run={data.run} modality="video" />
            {expandMedia ? <ExpandButton onClick={() => setExpanded(true)} /> : null}
            {data.run ? null : (
              <div className="flex flex-col items-center gap-2.5 px-3 text-center">
                <span
                  className="grid size-10 place-items-center"
                  style={{
                    background: accentFor("video").soft,
                    color: accentFor("video").ink,
                  }}
                >
                  <CompositionIcon className="size-5" />
                </span>
                <p className="text-[11.5px] tracking-[0.01em] text-[#a09a88]">
                  Your composition will appear here
                </p>
              </div>
            )}
          </div>
        </RunBeam>

        <Ruler timeline={timeline} />

        {tracks.map((track, i) => (
          <TrackRow
            key={track.id}
            track={track}
            port={portFor(track.id)}
            connected={(sourcesByHandle.get(trackPortId(track.id)) ?? []).length > 0}
            timeline={timeline}
            describe={describe}
            isVideo={track.id === VIDEO_TRACK_ID}
            fallbackLabel={
              track.id === VIDEO_TRACK_ID ? "Video track" : track.label || `Track ${i}`
            }
            onMove={(source, start) => moveClip(track.id, source, start)}
            onGain={(gain) => patchTrack(track.id, { gain })}
            onMute={(muted) => patchTrack(track.id, { muted })}
            onRemove={
              track.id !== VIDEO_TRACK_ID && audioTracks.length > 1
                ? () => removeTrack(track.id)
                : undefined
            }
          />
        ))}

        <button
          type="button"
          onClick={addTrack}
          disabled={audioTracks.length >= MAX_AUDIO_TRACKS}
          className="nodrag flex w-full items-center gap-1.5 border-t border-[#1f211c]/8 px-4 py-2.5 text-[11px] font-medium text-[#8a8271] transition-colors hover:bg-[#f7f4ee] hover:text-[#1f211c] disabled:pointer-events-none disabled:opacity-40"
        >
          <PlusIcon className="size-3.5" weight="bold" />
          {audioTracks.length >= MAX_AUDIO_TRACKS
            ? `Maximum ${MAX_AUDIO_TRACKS} audio tracks`
            : "Add audio track"}
        </button>

        {/* Footer: what this node is, and how to run it. */}
        <div className="flex items-center justify-between gap-2 border-t border-[#1f211c]/8 px-2.5 py-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[#8a8271]">
            <CompositionIcon className="size-3.5 shrink-0" />
            <span className="truncate">Mixed to one MP4 with ffmpeg</span>
          </span>

          <div className="nodrag flex shrink-0 items-stretch">
            <button
              type="button"
              onClick={() => runFrom(id, "node")}
              className="flex h-7 items-center gap-1.5 bg-[#1f211c] px-2.5 text-[12px] font-semibold text-[#f7f4ee] transition-all duration-150 hover:brightness-125 active:scale-[0.97]"
            >
              <PlayIcon weight="fill" className="size-3" />
              Run
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Run options"
                    className="grid h-7 w-5 place-items-center border-l border-[#f7f4ee]/25 bg-[#1f211c] text-[#f7f4ee] transition-all duration-150 hover:brightness-125"
                  >
                    <CaretDownIcon className="size-2.5" weight="bold" />
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

      <div className="flex justify-center">
        <FloatingBar>
          <BarButton
            label="Download"
            icon={DownloadSimpleIcon}
            disabled={!data.run?.output}
            onClick={() => downloadNode(id)}
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

      {expandMedia ? (
        <NodeExpandModal open={expanded} onOpenChange={setExpanded} media={expandMedia}>
          <ExpandDetails
            heading="Composition"
            onDownload={() => downloadNode(id)}
            chips={
              <>
                <DetailChip>
                  {clipCount} {clipCount === 1 ? "clip" : "clips"}
                </DetailChip>
                <DetailChip>{formatTime(timeline)}</DetailChip>
              </>
            }
          />
        </NodeExpandModal>
      ) : null}
    </div>
  );
}

/**
 * Keeps the stored clips in step with what is actually wired up.
 *
 * A clip exists because an edge does, so this is where connecting a node puts a
 * clip on a track and disconnecting takes it off again. New clips land after
 * whatever is already on the track, which is what makes wiring two videos into
 * the picture track read as a cut rather than a pile-up at zero.
 */
function useClipSync({
  id,
  tracks,
  sourcesByHandle,
  describe,
  updateNode,
}: {
  id: string;
  tracks: CompositeTrack[];
  sourcesByHandle: Map<string, string[]>;
  describe: (sourceId: string) => SourceInfo;
  updateNode: (id: string, patch: Record<string, unknown>) => void;
}) {
  // `describe` changes identity on every render (it closes over node data), so
  // it is read through a ref — depending on it would resync on every frame.
  const describeRef = React.useRef(describe);
  React.useEffect(() => {
    describeRef.current = describe;
  });

  const signature = React.useMemo(
    () =>
      JSON.stringify([
        [...sourcesByHandle.entries()].sort(),
        tracks.map((t) => [t.id, t.clips.map((c) => c.source)]),
      ]),
    [sourcesByHandle, tracks],
  );

  React.useEffect(() => {
    let changed = false;
    const next = tracks.map((track) => {
      const connected = sourcesByHandle.get(trackPortId(track.id)) ?? [];
      // Drop clips whose edge is gone; a stored position for a source nobody
      // is feeding would otherwise resurrect it the moment it is reconnected.
      const kept = track.clips.filter((c) => connected.includes(c.source));
      const added: Clip[] = [];
      let end = Math.max(
        ...kept.map((c) => c.start_sec + (c.duration_sec ?? ASSUMED_CLIP_SEC)),
        0,
      );
      for (const source of connected) {
        if (kept.some((c) => c.source === source)) continue;
        if (kept.length + added.length >= MAX_CLIPS_PER_TRACK) break;
        const duration = describeRef.current(source).durationSec;
        added.push({ source, start_sec: end, duration_sec: duration });
        end += duration;
      }
      if (kept.length !== track.clips.length || added.length) changed = true;
      return { ...track, clips: [...kept, ...added] };
    });

    if (!changed) return;
    const [video, ...audio] = next;
    updateNode(id, { video, tracks: audio });
    // `signature` collapses the comparison this effect actually cares about —
    // which sources sit on which track — so it does not refire on a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, signature, updateNode]);
}

/** The time axis, aligned to the clip strip rather than to the whole card. */
function Ruler({ timeline }: { timeline: number }) {
  const step = tickStep(timeline);
  const ticks = React.useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= timeline + 0.001; t += step) out.push(t);
    return out;
  }, [timeline, step]);

  return (
    <div
      className="flex border-t border-[#1f211c]/8 bg-[#faf8f4]"
      style={{ height: RULER_HEIGHT }}
    >
      <div className="relative flex-1">
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute top-0 flex h-full items-center border-l border-[#1f211c]/10 pl-1 text-[9px] text-[#a09a88] tabular-nums first:border-l-0"
            style={{ left: `${(t / timeline) * 100}%` }}
          >
            {formatTime(t)}
          </span>
        ))}
      </div>
      <div style={{ width: CONTROLS_WIDTH }} className="shrink-0" />
    </div>
  );
}

/**
 * A track's level, as a bar you drag.
 *
 * Not the shared `Slider`: at the width a track row can spare, its thumb is
 * wider than its track, and the result reads as a checkbox rather than as a
 * volume. A filled bar says "level" at any size, and dragging it — or clicking
 * a point on it — is the whole interaction, with no thumb to hunt for.
 *
 * The scale runs to +6dB, so unity sits halfway and is marked: without the tick
 * there is no way to find "unchanged" by eye.
 */
function Fader({
  gain,
  muted,
  label,
  onGain,
}: {
  gain: number;
  muted: boolean;
  label: string;
  onGain: (gain: number) => void;
}) {
  const bar = React.useRef<HTMLDivElement>(null);

  function setFromPointer(clientX: number) {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    // Snapped to 5%, which is the finest step worth having on a 62px bar.
    onGain(Math.round(ratio * MAX_GAIN * 20) / 20);
  }

  function startDrag(event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setFromPointer(event.clientX);

    const move = (e: PointerEvent) => setFromPointer(e.clientX);
    const end = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  const filled = Math.min(1, gain / MAX_GAIN);
  const percent = Math.round(gain * 100);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              ref={bar}
              role="slider"
              tabIndex={0}
              aria-label={`${label} volume`}
              aria-valuemin={0}
              aria-valuemax={MAX_GAIN * 100}
              aria-valuenow={percent}
              aria-valuetext={muted ? "Muted" : `${percent}%`}
              onPointerDown={startDrag}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                  e.preventDefault();
                  onGain(Math.max(0, Math.round((gain - 0.05) * 20) / 20));
                } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                  e.preventDefault();
                  onGain(Math.min(MAX_GAIN, Math.round((gain + 0.05) * 20) / 20));
                }
              }}
              style={{ width: FADER_WIDTH }}
              className={cn(
                "relative h-3 shrink-0 cursor-ew-resize bg-[#1f211c]/8 outline-none",
                "focus-visible:ring-1 focus-visible:ring-[#1f211c]/35",
                muted && "opacity-40",
              )}
            >
              <span
                className="absolute inset-y-0 left-0 bg-[#1f211c]/45"
                style={{ width: `${filled * 100}%` }}
              />
              {/* Unity, so "unchanged" is findable by eye. */}
              <span className="absolute inset-y-0 left-1/2 w-px bg-[#1f211c]/25" />
            </div>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="bg-[#1f211c] text-[#f7f4ee]">
          {muted ? "Muted" : `${percent}% — drag to change, 100% is unchanged`}
        </TooltipContent>
      </Tooltip>

      <span
        className={cn(
          "w-8 shrink-0 text-right text-[10px] tabular-nums",
          muted ? "text-[#a94848]" : "text-[#8a8271]",
        )}
      >
        {muted ? "muted" : `${percent}%`}
      </span>
    </>
  );
}

/** One track: its port, its clips on the timeline, and its fader. */
function TrackRow({
  track,
  port,
  connected,
  timeline,
  describe,
  isVideo,
  fallbackLabel,
  onMove,
  onGain,
  onMute,
  onRemove,
}: {
  track: CompositeTrack;
  port: PortSpec | undefined;
  connected: boolean;
  timeline: number;
  describe: (sourceId: string) => SourceInfo;
  isVideo: boolean;
  fallbackLabel: string;
  onMove: (source: string, startSec: number) => void;
  onGain: (gain: number) => void;
  onMute: (muted: boolean) => void;
  onRemove?: () => void;
}) {
  const strip = React.useRef<HTMLDivElement>(null);
  /**
   * The clip being dragged, and where it has got to.
   *
   * Held twice on purpose: the state drives the preview, and the ref is what
   * the release handler commits from. Reading the position out of a `setState`
   * updater instead would run `onMove` — and so the canvas's `setNodes` —
   * during render, which React reports as updating one component while
   * rendering another.
   */
  const [dragging, setDragging] = React.useState<{ source: string; start: number } | null>(
    null,
  );
  const dragRef = React.useRef<{ source: string; start: number } | null>(null);

  function startDrag(event: React.PointerEvent, clip: Clip) {
    event.preventDefault();
    event.stopPropagation();
    const rect = strip.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    // Screen pixels per second. The rect is already scaled by the canvas zoom
    // and so are pointer deltas, so the two cancel and no zoom factor is needed.
    const perSecond = rect.width / timeline;
    const grabOffset = event.clientX - (rect.left + clip.start_sec * perSecond);
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      const raw = (e.clientX - grabOffset - rect.left) / perSecond;
      // Snapped to a tenth: finer than anyone can aim at node scale, and it
      // keeps the stored number readable.
      const next = {
        source: clip.source,
        start: Math.max(0, Math.round(raw * 10) / 10),
      };
      dragRef.current = next;
      setDragging(next);
    };
    const end = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      const landed = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      // Committed after the preview is torn down, and outside any state
      // updater — this reaches all the way up to the canvas's node list.
      if (landed) onMove(landed.source, landed.start);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    // A cancelled gesture (a browser takeover, a lost capture) still has to
    // release, or the clip stays stuck to the pointer with no way to drop it.
    target.addEventListener("pointercancel", end);
  }

  return (
    <div
      className="relative flex border-t border-[#1f211c]/8"
      style={{ height: TRACK_HEIGHT }}
    >
      {port ? (
        <LanePort port={port} connected={connected} className="top-1/2 -translate-y-1/2" />
      ) : null}

      {/* The timeline strip. */}
      <div ref={strip} className="nodrag relative flex-1 overflow-hidden">
        {!track.clips.length ? (
          <span className="absolute inset-0 flex items-center px-3 text-[11px] text-[#c4bdab]">
            {isVideo ? "Connect a video" : "Connect audio"}
          </span>
        ) : null}

        {track.clips.map((clip) => {
          const info = describe(clip.source);
          const accent = accentFor(info.accent);
          const start =
            dragging?.source === clip.source ? dragging.start : clip.start_sec;
          const duration = clip.duration_sec ?? info.durationSec;
          return (
            <div
              key={clip.source}
              onPointerDown={(e) => startDrag(e, clip)}
              title={`${info.label} · ${formatTime(start)}`}
              className={cn(
                "absolute inset-y-1 flex cursor-grab items-center gap-1 overflow-hidden border px-1.5 active:cursor-grabbing",
                dragging?.source === clip.source
                  ? "border-[#1f211c]/45 shadow-[0_6px_16px_-6px_rgba(31,33,28,0.45)]"
                  : "border-[#1f211c]/12",
                track.muted && "opacity-45",
              )}
              style={{
                left: `${(start / timeline) * 100}%`,
                width: `${Math.max((duration / timeline) * 100, 3)}%`,
                background: accent.soft,
                color: accent.ink,
              }}
            >
              <info.Icon className="size-3 shrink-0" />
              <span className="truncate text-[10px] font-medium">{info.label}</span>
            </div>
          );
        })}
      </div>

      {/* Fader. Muting leaves it where it is — see `effective_gain` in schema.py. */}
      <div
        style={{ width: CONTROLS_WIDTH }}
        className="nodrag flex shrink-0 items-center gap-1.5 border-l border-[#1f211c]/8 px-2"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={track.muted ? "Unmute" : "Mute"}
                aria-pressed={track.muted}
                onClick={() => onMute(!track.muted)}
                className={cn(
                  "grid size-5 shrink-0 place-items-center transition-colors hover:bg-[#1f211c]/6",
                  track.muted ? "text-[#a94848]" : "text-[#8a8271] hover:text-[#1f211c]",
                )}
              >
                {track.muted ? (
                  <SpeakerSimpleSlashIcon className="size-3.5" weight="fill" />
                ) : (
                  <SpeakerSimpleHighIcon className="size-3.5" />
                )}
              </button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="bg-[#1f211c] text-[#f7f4ee]">
            {track.muted ? `Unmute ${fallbackLabel}` : `Mute ${fallbackLabel}`}
          </TooltipContent>
        </Tooltip>

        <Fader
          gain={track.gain}
          muted={track.muted}
          label={fallbackLabel}
          onGain={onGain}
        />

        {onRemove ? (
          <button
            type="button"
            aria-label="Remove track"
            onClick={onRemove}
            className="grid size-5 shrink-0 place-items-center text-[#a09a88] transition-colors hover:bg-[#cf7c7c]/12 hover:text-[#a94848]"
          >
            <XIcon className="size-3" weight="bold" />
          </button>
        ) : (
          // Keeps every row's controls on one vertical line, including the
          // picture track and the last remaining audio track.
          <span className="size-5 shrink-0" />
        )}
      </div>
    </div>
  );
}
