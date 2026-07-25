"use client";

/**
 * The player every audio result gets — speech, music and sound effects alike.
 *
 * A browser's default `<audio controls>` is a grey slab that looks nothing like
 * the rest of the canvas and says nothing about the sound. This is a play
 * button and a real waveform: the played portion is inked, the rest sits light,
 * and clicking anywhere in the bars seeks there.
 *
 * ## The bars are the actual audio
 *
 * Two paths, both real amplitude — nothing here is decorative:
 *
 * - **Stored assets** (anything with an `assetId`) come from
 *   `GET /v1/assets/{id}/peaks`, which decodes the clip with ffmpeg server-side
 *   and returns an RMS envelope plus the true duration. That path exists
 *   because the B2 bucket is private and sends no CORS headers, so the browser
 *   cannot `fetch()` the bytes to decode them itself — the same constraint that
 *   makes `downloadResult` proxy through the API.
 * - **Mid-run outputs** with no asset row yet are decoded in the browser with
 *   WebAudio, straight off the provider CDN.
 *
 * Until one of those lands the bars sit flat and pale, which reads as "not
 * measured yet" rather than inventing a shape the audio does not have.
 *
 * ## Width tracks length
 *
 * A two-second effect and a two-minute track must not draw the same strip. Bars
 * are a fixed width and the count follows duration (`BARS_PER_SEC`), capped by
 * whatever the node's width allows — so short clips genuinely look short.
 */

import * as React from "react";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useAuth } from "@clerk/nextjs";

import { fetchAudioPeaks } from "@/lib/studio/assets-client";
import { cn } from "@/lib/utils";

/** Bar plus its gap, in px — the horizontal budget one bar occupies. */
const BAR_SLOT = 4;
/** How much waveform a second of audio earns. */
const BARS_PER_SEC = 5;
/** Below this a clip is too short to read as a waveform at all. */
const MIN_BARS = 10;
/** Bars never render at zero — a silent stretch should read as quiet, not absent. */
const MIN_BAR = 0.06;

type Envelope = { peaks: number[]; duration: number };

/** RMS per bucket across the decoded channel, normalised to the loudest. */
function decodedPeaks(buffer: AudioBuffer, count: number): number[] {
  const samples = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(samples.length / count));
  const peaks: number[] = [];
  let loudest = 0;
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    const start = i * per;
    const end = Math.min(start + per, samples.length);
    for (let j = start; j < end; j += 1) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    loudest = Math.max(loudest, rms);
    peaks.push(rms);
  }
  if (loudest <= 0) return peaks.map(() => 0);
  return peaks.map((p) => p / loudest);
}

/**
 * The clip's real envelope, server-side for stored assets and in-browser for
 * everything else. Null until one arrives.
 */
function useEnvelope(url: string | null, assetId: string | null | undefined): Envelope | null {
  const { getToken, userId } = useAuth();
  const [envelope, setEnvelope] = React.useState<Envelope | null>(null);

  // Held in a ref and kept out of the effect's deps: Clerk hands back a fresh
  // `getToken` identity on every render, and depending on it would re-run the
  // decode forever (the same trap studio-shell notes around its own fetches).
  const authRef = React.useRef({ getToken, userId });
  React.useEffect(() => {
    authRef.current = { getToken, userId };
  });

  // Clear during render rather than in an effect, so a new take never shows the
  // previous clip's waveform for a frame.
  const [seenKey, setSeenKey] = React.useState(`${assetId}|${url}`);
  const key = `${assetId}|${url}`;
  if (key !== seenKey) {
    setSeenKey(key);
    setEnvelope(null);
  }

  React.useEffect(() => {
    if (!url) return;
    let cancelled = false;

    void (async () => {
      if (assetId) {
        const auth = authRef.current;
        const token = await auth.getToken().catch(() => null);
        const server = await fetchAudioPeaks(assetId, { token, userId: auth.userId ?? null });
        // Empty peaks means ffmpeg could not read it — fall through and let the
        // browser try, in case this one is CDN-hosted and readable.
        if (!cancelled && server?.peaks.length) {
          setEnvelope({ peaks: server.peaks, duration: server.durationSec });
          return;
        }
        if (cancelled) return;
      }

      let context: AudioContext | null = null;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const bytes = await res.arrayBuffer();
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctor) return;
        context = new Ctor();
        const decoded = await context.decodeAudioData(bytes);
        if (!cancelled) {
          setEnvelope({ peaks: decodedPeaks(decoded, 400), duration: decoded.duration });
        }
      } catch {
        // CORS-blocked, offline, or not decodable — the flat placeholder stands
        // in and the transport controls still work.
      } finally {
        void context?.close().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, assetId]);

  return envelope;
}

/** The rendered width, so bar count can be capped to what actually fits. */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      // Sub-pixel reflows would otherwise re-bucket the waveform constantly.
      setWidth((current) => (Math.abs(current - next) > 1 ? next : current));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** Average `peaks` down to `count` buckets — the server sends more than we draw. */
function resample(peaks: number[], count: number): number[] {
  if (!peaks.length || count <= 0) return [];
  if (peaks.length === count) return peaks;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * peaks.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / count));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += peaks[j];
    out.push(sum / (end - start));
  }
  return out;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function WaveformPlayer({
  url,
  assetId,
  className,
  onReady,
  onError,
}: {
  url: string;
  /**
   * The asset behind this URL, when there is one. Its presence is what buys a
   * real waveform for a stored result — see the note at the top of the file.
   */
  assetId?: string | null;
  className?: string;
  /** Fires once the clip's metadata lands — the well drops its shimmer on it. */
  onReady?: () => void;
  /** The URL would not play: expired signature, or a missing object. */
  onError?: () => void;
}) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const envelope = useEnvelope(url, assetId);
  const [barsRef, barsWidth] = useMeasuredWidth();
  const [playing, setPlaying] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [elementDuration, setElementDuration] = React.useState(0);

  // A re-run swaps the URL under a mounted player; reset transport state with
  // it so the new clip does not inherit the old one's elapsed time.
  const [seenUrl, setSeenUrl] = React.useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setPlaying(false);
    setElapsed(0);
    setElementDuration(0);
  }

  // ffprobe is more trustworthy than the element for a VBR mp3, but the element
  // is what actually seeks — so prefer the decoded figure for layout and fall
  // back to the element's before either has landed.
  const duration = envelope?.duration || elementDuration;
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  // What fits, versus what the clip has earned.
  const fits = barsWidth > 0 ? Math.floor(barsWidth / BAR_SLOT) : 0;
  const earned = duration > 0 ? Math.round(duration * BARS_PER_SEC) : MIN_BARS;
  const barCount = fits > 0 ? Math.max(MIN_BARS, Math.min(fits, earned)) : 0;

  const bars = React.useMemo(() => {
    if (barCount <= 0) return [];
    if (!envelope?.peaks.length) return Array.from({ length: barCount }, () => 0);
    return resample(envelope.peaks, barCount).map((p) => Math.max(MIN_BAR, p));
  }, [envelope, barCount]);

  const seekTo = (fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(1, fraction)) * audio.duration;
    setElapsed(audio.currentTime);
  };

  return (
    <div className={cn("nodrag flex w-full items-center gap-3", className)}>
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          setElementDuration(e.currentTarget.duration || 0);
          onReady?.();
        }}
        onError={() => onError?.()}
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onEnded={() => {
          setPlaying(false);
          setElapsed(0);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="hidden"
      />

      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (playing) audio.pause();
          else void audio.play().catch(() => setPlaying(false));
        }}
        className="grid size-9 shrink-0 place-items-center rounded-full bg-[#1f211c] text-[#f7f4ee] transition-transform hover:scale-105 active:scale-95"
      >
        {playing ? (
          <PauseIcon weight="fill" className="size-4" />
        ) : (
          <PlayIcon weight="fill" className="size-4 translate-x-[1px]" />
        )}
      </button>

      {/* The measured track. Bars are left-aligned inside it and only span the
          clip's own length, so a short effect draws a short waveform rather
          than a stretched one. */}
      <div ref={barsRef} className="flex h-10 min-w-0 flex-1 items-center">
        {/* Bars double as the scrubber — no separate track to hunt for. */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            seekTo((e.clientX - box.left) / box.width);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") seekTo(progress + 0.05);
            if (e.key === "ArrowLeft") seekTo(progress - 0.05);
          }}
          className="flex h-full cursor-pointer items-center gap-[2px] outline-none"
        >
          {bars.map((peak, i) => {
            const played = i / bars.length < progress;
            return (
              <span
                key={i}
                style={{ height: `${Math.max(4, Math.round(peak * 100))}%` }}
                className={cn(
                  "w-[2px] shrink-0 rounded-full transition-colors",
                  played ? "bg-[#1f211c]" : "bg-[#1f211c]/22",
                )}
              />
            );
          })}
        </div>
      </div>

      <span className="shrink-0 text-[11px] tabular-nums text-[#a09a88]">
        {formatTime(duration > 0 ? duration - elapsed : 0)}
      </span>
    </div>
  );
}
