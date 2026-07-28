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
import { type PortSpec, findModel, visiblePorts } from "@/lib/studio/catalog";
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
import { LoadingWell, RunBeam, RunWell, isRunBusy } from "./run-well";
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
  ExpandHeader,
  ExpandSectionLabel,
  NodeExpandModal,
  timeAgo,
} from "./expand-modal";
import {
  type CaptionsState,
  CaptionedTakeSection,
  CaptionsSection,
  CaptionStage,
  useCaptions,
} from "./captions";
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

/** "video/mp4" → "MP4", for the container chip. Null when nothing said. */
function outputFormat(mediaType: string | null | undefined): string | null {
  const subtype = mediaType?.split("/")[1]?.split(";")[0];
  return subtype ? subtype.toUpperCase() : null;
}

// --- real media lengths ----------------------------------------------------

/**
 * Measured durations of actual media, keyed by URL.
 *
 * A node's params say what was *asked for*; only the file that came back knows
 * what it actually lasts — a "5 second" music request routinely returns
 * shorter, and an upload declares nothing at all. So once a source has a
 * playable URL, its clip is sized from the media's own metadata. Module-level
 * because the same asset feeds every composition that references it.
 */
const measuredDurations = new Map<string, number>();
const probesInFlight = new Set<string>();
const probeSubscribers = new Set<() => void>();
let probeVersion = 0;

function probeDuration(url: string) {
  if (measuredDurations.has(url) || probesInFlight.has(url)) return;
  probesInFlight.add(url);
  // A <video> element reads audio metadata too, and metadata needs no CORS —
  // which matters because B2 presigned URLs cannot be fetch()ed.
  const el = document.createElement("video");
  el.preload = "metadata";
  const settle = () => {
    probesInFlight.delete(url);
    if (Number.isFinite(el.duration) && el.duration > 0) {
      measuredDurations.set(url, el.duration);
      probeVersion += 1;
      for (const notify of probeSubscribers) notify();
    }
    el.removeAttribute("src");
  };
  el.onloadedmetadata = settle;
  el.onerror = settle;
  el.src = url;
}

/** Re-renders the caller whenever any probe lands, and starts missing ones. */
function useMeasuredDurations(urls: (string | null)[]) {
  React.useSyncExternalStore(
    (notify) => {
      probeSubscribers.add(notify);
      return () => {
        probeSubscribers.delete(notify);
      };
    },
    () => probeVersion,
    () => 0,
  );
  const key = urls.filter(Boolean).join("\n");
  React.useEffect(() => {
    for (const url of key.split("\n")) if (url) probeDuration(url);
  }, [key]);
}

/** The URL of what a source most recently produced (or holds, for uploads). */
function sourceMediaUrl(source: { data: StudioNode["data"] } | undefined): string | null {
  if (!source) return null;
  const run = source.data.run;
  return (
    (run?.status === "succeeded" ? run.output?.url : null) ??
    source.data.history?.[0]?.url ??
    source.data.asset?.url ??
    null
  );
}

/**
 * How long a generation is *expected* to run, before its media exists to
 * measure: whatever its `duration` parameter says (tolerating the string a
 * chip may have stored). Deliberately NOT `expected_duration_sec` — that
 * catalog number is the model's wall-clock ETA for a run, not its output
 * length, and drawing it once made a speech clip twenty seconds wide.
 */
function sourceDuration(wire: Record<string, unknown>): number {
  const params = (wire.params ?? {}) as Record<string, unknown>;
  const declared = Number(params.duration ?? params.duration_seconds ?? NaN);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return ASSUMED_CLIP_SEC;
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
    refreshMedia,
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

  // Measure every connected source's actual media, so clips are drawn — and
  // stored — at the length the file really has, not the length that was asked
  // for. Re-renders when a probe lands, which is what makes widths live.
  useMeasuredDurations(sourceNodes.map(sourceMediaUrl));

  const describe = React.useCallback(
    (sourceId: string): SourceInfo => {
      const source = sourceNodes.find((n) => n.id === sourceId);
      const measured = (() => {
        const url = sourceMediaUrl(source);
        return url ? measuredDurations.get(url) : undefined;
      })();
      if (!source) {
        return { label: "Source", accent: "any", Icon: VideoGenIcon, durationSec: ASSUMED_CLIP_SEC };
      }
      if (source.data.kind === "input.upload") {
        const title = source.data.wire.title;
        return {
          label: typeof title === "string" && title ? title : "Upload",
          accent: source.data.asset?.modality ?? "any",
          Icon: source.data.asset?.modality === "audio" ? MusicGenIcon : VideoGenIcon,
          durationSec: measured ?? ASSUMED_CLIP_SEC,
        };
      }
      if (source.data.kind === "transform.composite") {
        return {
          label: "Composition",
          accent: "video",
          Icon: CompositionIcon,
          durationSec: measured ?? compositeTimeline(source.data.wire),
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
        durationSec: measured ?? sourceDuration(source.data.wire),
      };
    },
    [catalog, sourceNodes],
  );

  // The live length of every connected source, for drawing and for keeping the
  // stored stamps honest — a clip's stored `duration_sec` is only the estimate
  // from the moment it was connected.
  const liveDurations = React.useMemo(
    () => new Map(sourceIds.map((sid) => [sid, describe(sid).durationSec])),
    [sourceIds, describe],
  );

  useClipSync({ id, tracks, sourcesByHandle, describe, durations: liveDurations, updateNode });

  // The timeline is as long as the edit needs, never shorter than the default
  // ruler — so a clip dragged past the end grows the view rather than falling
  // off it. Deliberately NOT the stored `timeline_sec`: nothing in the UI sets
  // it, so honoring it here would only pin old documents to the ruler length
  // they happened to be seeded with.
  const contentEnd = Math.max(
    ...tracks.flatMap((t) =>
      t.clips.map(
        (c) =>
          c.start_sec +
          (liveDurations.get(c.source) ?? c.duration_sec ?? ASSUMED_CLIP_SEC),
      ),
    ),
    0,
  );
  const timeline = Math.min(
    MAX_TIMELINE_SEC,
    Math.max(DEFAULT_TIMELINE_SEC, Math.ceil(contentEnd * 1.1)),
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

  /** Still fetching this node's last render — see the note on the generate node. */
  const loading = Boolean(data.hydrating) && !data.run;

  const [expanded, setExpanded] = React.useState(false);
  // A settled render only — a busy or failed well has nothing to blow up.
  const expandMedia =
    !isRunBusy(data.run) && data.run?.status === "succeeded" && data.run.output?.url
      ? { url: data.run.output.url, isVideo: true }
      : null;
  // Only the newest generation carries a timestamp, so date the render from it
  // — and only when it is the render on show, rather than stamping an older
  // mix with the time of a newer one.
  const newest = data.history?.[0];
  const renderedWhen =
    newest && newest.url && newest.url === data.run?.output?.url
      ? timeAgo(newest.createdAt)
      : null;

  // Captions on the rendered mix. The asset id is only known when the newest
  // generation is the render on show; otherwise the shell resolves the node's
  // latest stored result. A render that is itself a caption burn only offers
  // removal, and the hook stays inert for it.
  const newestOnShow = Boolean(newest?.url && newest.url === data.run?.output?.url);
  const captionedTake = Boolean(expandMedia && newestOnShow && newest?.captioned);
  const captions = useCaptions({
    nodeId: id,
    assetId: newestOnShow ? (newest?.assetId ?? null) : null,
    takeKey: !captionedTake ? (expandMedia?.url ?? null) : null,
  });

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
        <RunBeam active={isRunBusy(data.run) || loading}>
          <div
            className="group relative flex items-center justify-center overflow-hidden bg-[#faf8f4]"
            style={{ height: WELL_HEIGHT }}
          >
            <RunWell
              run={data.run}
              modality="video"
              assetId={data.history?.[0]?.assetId}
              onStale={(assetId) => refreshMedia(id, assetId)}
            />
            {expandMedia ? <ExpandButton onClick={() => setExpanded(true)} /> : null}
            {data.run ? null : loading ? (
              <LoadingWell />
            ) : (
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
        <NodeExpandModal
          open={expanded}
          onOpenChange={setExpanded}
          media={expandMedia}
          stage={
            captions.stageActive ? (
              <CaptionStage url={expandMedia.url} captions={captions} />
            ) : undefined
          }
        >
          <CompositionSheet
            tracks={tracks}
            describe={describe}
            durations={liveDurations}
            timeline={timeline}
            when={renderedWhen}
            format={outputFormat(data.run?.output?.mediaType)}
            onDownload={() => downloadNode(id)}
            captions={captions}
            captionedTake={
              captionedTake ? { nodeId: id, assetId: newest?.assetId ?? null } : null
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
  durations,
  updateNode,
}: {
  id: string;
  tracks: CompositeTrack[];
  sourcesByHandle: Map<string, string[]>;
  describe: (sourceId: string) => SourceInfo;
  /** Live length per source — measured media first, params second. */
  durations: Map<string, number>;
  updateNode: (id: string, patch: Record<string, unknown>) => void;
}) {
  // `describe` changes identity on every render (it closes over node data), so
  // it is read through a ref — depending on it would resync on every frame.
  const describeRef = React.useRef(describe);
  const durationsRef = React.useRef(durations);
  React.useEffect(() => {
    describeRef.current = describe;
    durationsRef.current = durations;
  });

  const signature = React.useMemo(
    () =>
      JSON.stringify([
        [...sourcesByHandle.entries()].sort(),
        tracks.map((t) => [t.id, t.clips.map((c) => [c.source, c.duration_sec])]),
        // Rounded, so a probe landing at 4.0000001 does not thrash the store.
        [...durations.entries()]
          .sort()
          .map(([s, d]) => [s, Math.round(d * 10) / 10]),
      ]),
    [sourcesByHandle, tracks, durations],
  );

  React.useEffect(() => {
    let changed = false;
    const next = tracks.map((track) => {
      const connected = sourcesByHandle.get(trackPortId(track.id)) ?? [];
      const kept = track.clips
        // Drop clips whose edge is gone; a stored position for a source nobody
        // is feeding would otherwise resurrect it the moment it is reconnected.
        .filter((c) => connected.includes(c.source))
        // Restamp lengths that drifted from the live number — a param edit or
        // a finished run changes how long the source really is, and the stored
        // stamp is what the compiler's timeline math reads.
        .map((c) => {
          const live = durationsRef.current.get(c.source);
          if (live == null || Math.abs(live - (c.duration_sec ?? 0)) < 0.05) return c;
          changed = true;
          return { ...c, duration_sec: Math.round(live * 10) / 10 };
        });
      const added: Clip[] = [];
      let end = Math.max(
        ...kept.map((c) => c.start_sec + (c.duration_sec ?? ASSUMED_CLIP_SEC)),
        0,
      );
      for (const source of connected) {
        if (kept.some((c) => c.source === source)) continue;
        if (kept.length + added.length >= MAX_CLIPS_PER_TRACK) break;
        const duration =
          durationsRef.current.get(source) ?? describeRef.current(source).durationSec;
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
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const target = event.currentTarget as HTMLElement;
    // Same shape as the clip drag: capture is best effort, the drag itself
    // rides window listeners so a refused capture cannot kill it.
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* drag works without capture */
    }
    setFromPointer(event.clientX);

    const move = (e: PointerEvent) => {
      if (e.pointerId === pointerId) setFromPointer(e.clientX);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
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
                "relative h-3 shrink-0 cursor-ew-resize touch-none bg-[#1f211c]/8 outline-none",
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
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = strip.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    // Screen pixels per second. The rect is already scaled by the canvas zoom
    // and so are pointer deltas, so the two cancel and no zoom factor is needed.
    const perSecond = rect.width / timeline;
    const grabOffset = event.clientX - (rect.left + clip.start_sec * perSecond);
    const pointerId = event.pointerId;
    const target = event.currentTarget as HTMLElement;
    // Best effort only. The drag rides window listeners below, so a capture
    // the browser refuses — or that React Flow's selection layer steals on the
    // same pane — cannot kill it; before this, a failed capture threw before
    // the move listeners ever attached and the clip simply would not drag.
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* drag works without capture */
    }

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
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
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const landed = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      // Committed after the preview is torn down, and outside any state
      // updater — this reaches all the way up to the canvas's node list.
      if (landed) onMove(landed.source, landed.start);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    // A cancelled gesture (a browser takeover, a lost capture) still has to
    // release, or the clip stays stuck to the pointer with no way to drop it.
    window.addEventListener("pointercancel", end);
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
          // Always the live number — the stored stamp is whatever was believed
          // at connect time, and the whole point of the strip is proportion.
          const duration = info.durationSec;
          return (
            <div
              key={clip.source}
              onPointerDown={(e) => startDrag(e, clip)}
              title={`${info.label} · ${formatTime(start)}`}
              className={cn(
                "absolute inset-y-1 flex cursor-grab touch-none items-center gap-1 overflow-hidden border px-1.5 active:cursor-grabbing",
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

/**
 * The expand modal's left column — the edit decision list for the render on
 * the right.
 *
 * A generate node can fill this space with its prompt; a composition has no
 * prompt, and the two chips it used to show left the column all but empty. What
 * it does have is an edit: which source landed on which track, where it starts,
 * how long it runs, and how loud. That is also the only place to *read* the mix
 * — the node's own strip draws proportion, not numbers.
 *
 * Read-only on purpose. The timeline on the node is where an edit is changed;
 * duplicating drag targets here would give the same clip two truths.
 */
function CompositionSheet({
  tracks,
  describe,
  durations,
  timeline,
  when,
  format,
  onDownload,
  captions,
  captionedTake,
}: {
  /** Picture track first, then the audio tracks — the node's own order. */
  tracks: CompositeTrack[];
  describe: (sourceId: string) => SourceInfo;
  /** Live measured lengths, keyed by source node — see `liveDurations`. */
  durations: Map<string, number>;
  timeline: number;
  /** How long ago this render finished, when it can be dated. */
  when: string | null;
  /** Container of the rendered file — "MP4". */
  format: string | null;
  onDownload: () => void;
  /** The caption flow for the rendered mix — state lives on the node. */
  captions: CaptionsState;
  /** Set when the render on show is a caption burn — the panel offers removal. */
  captionedTake: { nodeId: string; assetId: string | null } | null;
}) {
  const clipCount = tracks.reduce((n, t) => n + t.clips.length, 0);
  const audioCount = tracks.length - 1;
  const silent = tracks
    .slice(1)
    .every((t) => t.muted || t.gain === 0 || !t.clips.length);

  return (
    <div className="flex min-h-full flex-col">
      <ExpandHeader
        title="Composition"
        meta={[when, format].filter(Boolean).join(" · ") || null}
        onDownload={onDownload}
      />

      <div className="flex flex-wrap gap-1.5 px-5 pb-1">
        <DetailChip>
          {clipCount} {clipCount === 1 ? "clip" : "clips"}
        </DetailChip>
        <DetailChip>{formatTime(timeline)}</DetailChip>
        <DetailChip>
          {audioCount} audio {audioCount === 1 ? "track" : "tracks"}
        </DetailChip>
        {silent ? <DetailChip>No audible track</DetailChip> : null}
      </div>

      <ExpandSectionLabel>Captions</ExpandSectionLabel>
      <div className="px-5 pb-4">
        {captionedTake ? (
          <CaptionedTakeSection
            nodeId={captionedTake.nodeId}
            assetId={captionedTake.assetId}
          />
        ) : (
          <CaptionsSection captions={captions} />
        )}
      </div>

      <ExpandSectionLabel>Edit</ExpandSectionLabel>

      <div className="border-t border-[#1f211c]/10">
        {tracks.map((track, i) => (
          <SheetTrack
            key={track.id}
            track={track}
            isVideo={i === 0}
            name={i === 0 ? "Video track" : track.label || `Track ${i}`}
            describe={describe}
            durations={durations}
          />
        ))}
      </div>

      <p className="mt-auto px-5 py-4 text-[11px] leading-4 text-[#a09a88]">
        Mixed to one {format ?? "MP4"} with ffmpeg. Drag a clip on the node to move
        it in time.
      </p>
    </div>
  );
}

/** One track in the sheet: its level, then its clips in playing order. */
function SheetTrack({
  track,
  isVideo,
  name,
  describe,
  durations,
}: {
  track: CompositeTrack;
  isVideo: boolean;
  name: string;
  describe: (sourceId: string) => SourceInfo;
  durations: Map<string, number>;
}) {
  // Time order, not connection order — the column is read as a running order,
  // and the stored array is whatever sequence the edges arrived in.
  const clips = [...track.clips].sort((a, b) => a.start_sec - b.start_sec);
  const percent = Math.round(track.gain * 100);

  return (
    <div className="border-b border-[#1f211c]/10 px-5 py-3">
      <div className="flex items-center gap-2">
        {isVideo ? (
          <VideoGenIcon className="size-3.5 shrink-0 text-[#8a8271]" />
        ) : track.muted ? (
          <SpeakerSimpleSlashIcon
            className="size-3.5 shrink-0 text-[#a94848]"
            weight="fill"
          />
        ) : (
          <SpeakerSimpleHighIcon className="size-3.5 shrink-0 text-[#8a8271]" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[#1f211c]">
          {name}
        </span>
        {isVideo ? null : (
          <span
            className={cn(
              "shrink-0 text-[10px] tabular-nums",
              track.muted ? "text-[#a94848]" : "text-[#a09a88]",
            )}
          >
            {track.muted ? "muted" : `${percent}%`}
          </span>
        )}
      </div>

      {clips.length ? (
        <ul className="mt-2 space-y-1">
          {clips.map((clip) => {
            const info = describe(clip.source);
            const accent = accentFor(info.accent);
            // The live number, for the same reason the strip uses it: the
            // stored stamp is only what was believed at connect time.
            const duration =
              durations.get(clip.source) ?? clip.duration_sec ?? ASSUMED_CLIP_SEC;
            return (
              <li
                key={clip.source}
                className={cn("flex items-center gap-2", track.muted && "opacity-45")}
              >
                <span
                  className="grid size-5 shrink-0 place-items-center"
                  style={{ background: accent.soft, color: accent.ink }}
                >
                  <info.Icon className="size-3" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-[#4c4a41]">
                  {info.label}
                </span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-[#a09a88]">
                  {formatTime(clip.start_sec)}–{formatTime(clip.start_sec + duration)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1.5 text-[11px] text-[#c4bdab]">
          {isVideo ? "No video connected" : "Nothing connected"}
        </p>
      )}
    </div>
  );
}
