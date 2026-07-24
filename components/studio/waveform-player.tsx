"use client";

/**
 * The player every audio result gets — speech, music and sound effects alike.
 *
 * A browser's default `<audio controls>` is a grey slab that looks nothing like
 * the rest of the canvas and says nothing about the sound. This is a play
 * button and a waveform: the played portion is inked, the rest sits light, and
 * clicking anywhere in the bars seeks there.
 *
 * ## Where the bars come from
 *
 * Real peaks when we can get them: `fetch` the bytes, decode with WebAudio, and
 * take the RMS of each bucket. That works for provider CDN URLs (mid-run
 * results) and for local storage mode.
 *
 * It does *not* work for a finished run's B2 URL — the bucket is private and
 * B2 sends no CORS headers, so `fetch` is refused (the same constraint that
 * makes `downloadResult` proxy through the API). Rather than show nothing,
 * those fall back to a synthetic waveform seeded by the URL: stable across
 * renders and shaped like audio, but decorative — it is not that file's
 * amplitude. Real peaks for stored assets want a server-side peaks route,
 * which is a bigger change than this component.
 */

import * as React from "react";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

// Tuned for the node card's width: enough bars to read as a waveform, few
// enough that each one still gets a visible sliver after the gaps.
const BAR_COUNT = 48;
/** Bars never render at zero — a silent stretch should read as quiet, not absent. */
const MIN_BAR = 0.08;

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG — same URL, same waveform, every render. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A plausible waveform for a URL we cannot read.
 *
 * Two slow envelopes times a jittery per-bar value: enough variation to read as
 * sound rather than a bar chart, without the uniform look of raw noise.
 */
function syntheticPeaks(seed: string, count: number): number[] {
  const random = mulberry32(hashString(seed));
  const phase = random() * Math.PI * 2;
  const swell = 0.6 + random() * 0.8;
  return Array.from({ length: count }, (_, i) => {
    const t = i / count;
    const envelope =
      0.55 + 0.45 * Math.sin(phase + t * Math.PI * 2 * swell) * Math.sin(t * Math.PI);
    const jitter = 0.45 + random() * 0.55;
    return Math.min(1, Math.max(MIN_BAR, envelope * jitter));
  });
}

/** RMS per bucket across the decoded channel, normalised to the loudest one. */
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
  if (loudest <= 0) return peaks.map(() => MIN_BAR);
  return peaks.map((p) => Math.max(MIN_BAR, p / loudest));
}

/**
 * Peaks for `url` — synthetic immediately, upgraded in place if the bytes turn
 * out to be readable. Starting synthetic rather than empty keeps the player
 * from flashing a blank strip on every mount.
 */
function useWaveform(url: string | null): number[] {
  const [peaks, setPeaks] = React.useState<number[]>(() =>
    syntheticPeaks(url ?? "", BAR_COUNT),
  );

  // Swap back to synthetic the moment the URL changes, during render rather
  // than in an effect — otherwise the previous result's bars linger for a
  // frame, and a real decode that lands late could overwrite the new ones.
  const [seenUrl, setSeenUrl] = React.useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setPeaks(syntheticPeaks(url ?? "", BAR_COUNT));
  }

  React.useEffect(() => {
    if (!url) return;

    let cancelled = false;
    let context: AudioContext | null = null;

    void (async () => {
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
        if (!cancelled) setPeaks(decodedPeaks(decoded, BAR_COUNT));
      } catch {
        // CORS-blocked (B2), offline, or not decodable — the synthetic bars
        // already on screen stand in.
      } finally {
        void context?.close().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return peaks;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function WaveformPlayer({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const peaks = useWaveform(url);
  const [playing, setPlaying] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [duration, setDuration] = React.useState(0);

  // A re-run swaps the URL under a mounted player; reset transport state with
  // it so the new clip does not inherit the old one's elapsed time.
  const [seenUrl, setSeenUrl] = React.useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setPlaying(false);
    setElapsed(0);
    setDuration(0);
  }

  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

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
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
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
        className="flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-[2px] outline-none"
      >
        {peaks.map((peak, i) => {
          const played = i / peaks.length < progress;
          return (
            <span
              key={i}
              style={{ height: `${Math.round(peak * 100)}%` }}
              className={cn(
                "min-h-[2px] w-full min-w-[1.5px] flex-1 rounded-full transition-colors",
                played ? "bg-[#1f211c]" : "bg-[#1f211c]/22",
              )}
            />
          );
        })}
      </div>

      <span className="shrink-0 text-[11px] tabular-nums text-[#a09a88]">
        {formatTime(duration > 0 ? duration - elapsed : 0)}
      </span>
    </div>
  );
}
