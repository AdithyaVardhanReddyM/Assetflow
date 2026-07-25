"use client";

/**
 * What a node's preview well shows once a run has touched it.
 *
 * Rendered by the generate and composition nodes in place of their empty-state
 * placeholder. Returns null when the node has no run state, so callers keep
 * their own placeholder markup for the untouched case.
 *
 * Every busy state — queued, running, waiting on the result — is one voice: a
 * shimmering "Generating" (the surrounding card carries a border beam, wired
 * in the node components via `isRunBusy`). When the provider volunteers more —
 * a queue status, or a real 0..1 progress (Runway reports one) — the shimmer
 * takes its wording and a slim bar grows beneath it; providers that report
 * nothing keep the plain shimmer. No spinners either way.
 */

import * as React from "react";
import { WarningIcon } from "@phosphor-icons/react";
import { BorderBeam } from "border-beam";

import { ShimmeringText } from "@/components/ui/shimmering-text";
import { WaveformPlayer } from "@/components/studio/waveform-player";
import type { NodeRunState } from "@/lib/studio/graph";

/**
 * The prompt bar's border beam, wrapped around a node's preview card while it
 * generates. Same preset and the same `.beam-colour-only` palette override —
 * the two surfaces must read as one system, not two shimmers.
 */
export function RunBeam({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <BorderBeam
      size="md"
      colorVariant="sunset"
      theme="light"
      borderRadius={0}
      brightness={1.05}
      saturation={1.15}
      hueRange={10}
      duration={4}
      className="beam-colour-only"
      style={
        {
          "--beam-stroke-opacity": 8.4,
          "--beam-inner-opacity": 3.4,
          "--beam-bloom-opacity": 0,
        } as React.CSSProperties
      }
    >
      {children}
    </BorderBeam>
  );
}

/**
 * The shimmer a node wears while the canvas is still fetching what it already
 * holds. Deliberately the same voice as "Generating" — from the outside both
 * are "this node is busy becoming what it is", and a second idiom for waiting
 * would only ask the eye to learn one more thing.
 */
export function LoadingWell({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex w-full flex-col items-center px-8">
      <ShimmeringText
        text={label}
        className="text-[13px] font-medium tracking-[0.02em]"
      />
    </div>
  );
}

/** True while the node should wear the border beam and shimmer. */
export function isRunBusy(run: NodeRunState | undefined): boolean {
  if (!run) return false;
  if (run.status === "pending" || run.status === "running") return true;
  // Succeeded but the displayable result hasn't landed yet.
  return run.status === "succeeded" && !run.output?.url && !run.output?.text;
}

/** Reports a fresh presigned URL for an asset; false when it could not get one. */
export type StaleMediaHandler = (assetId: string) => Promise<boolean>;

/** Consecutive re-signings a single take gets before the well gives up. */
const MAX_RESIGNS = 2;
/** How long the shimmer waits on a silent media element before uncovering it. */
const LOAD_PATIENCE_MS = 8000;

/**
 * The media itself, with the two states a bare `<img src>` cannot express.
 *
 * *Loading*: bytes take a moment, and an empty well in the meantime reads as a
 * node with nothing in it. The shimmer sits over the element until it decodes.
 *
 * *Stale*: preview URLs are presigned for an hour and the graph stores none of
 * them, so a canvas left open outlives its own links and the browser reports
 * the expiry as a bare load error. One fresh signature is fetched before the
 * take is called unloadable — this is the case a page refresh used to fix.
 */
function MediaWell({
  url,
  mediaType,
  modality,
  assetId,
  onMediaSize,
  onStale,
}: {
  url: string;
  mediaType: string | null | undefined;
  modality: string;
  /** The asset behind this URL, when there is one to re-sign. */
  assetId?: string | null;
  onMediaSize?: (width: number, height: number) => void;
  onStale?: StaleMediaHandler;
}): React.ReactElement {
  const [phase, setPhase] = React.useState<"loading" | "ready" | "error">("loading");
  // Set during render rather than in an effect: a swapped URL — a re-signed
  // link, or another take picked from the carousel — must not show the previous
  // one's "ready" for a frame against bytes that have not arrived.
  const [seenUrl, setSeenUrl] = React.useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setPhase("loading");
  }

  /**
   * Signatures spent since the last successful load. A fresh link that fails
   * too means the asset itself is unreachable, not expired, and asking for
   * another would spin forever — so the budget is small, and refills only when
   * something actually renders.
   */
  const spent = React.useRef(0);

  const resign = React.useCallback(() => {
    if (!assetId || !onStale) {
      setPhase("error");
      return;
    }
    spent.current += 1;
    setPhase("loading");
    void onStale(assetId).then((renewed) => {
      // A renewed URL arrives as a prop and restarts this cycle on its own;
      // only a failure to renew is worth showing as an error.
      if (!renewed) setPhase("error");
    });
  }, [assetId, onStale]);

  const onError = React.useCallback(() => {
    if (spent.current >= MAX_RESIGNS) setPhase("error");
    else resign();
  }, [resign]);

  const ready = React.useCallback(() => {
    spent.current = 0;
    setPhase("ready");
  }, []);

  // A browser that decides not to fetch a video's metadata fires neither event,
  // and the shimmer would then sit over a clip that plays perfectly well. After
  // this long the cover comes off regardless — an unstyled wait is a far better
  // failure than a well that never opens.
  React.useEffect(() => {
    if (phase !== "loading") return;
    const timer = setTimeout(() => setPhase("ready"), LOAD_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [phase, url]);

  let media: React.ReactElement;
  if (modality === "video" || mediaType?.startsWith("video/")) {
    media = (
      <video
        key={url}
        src={url}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (el.videoWidth && el.videoHeight) onMediaSize?.(el.videoWidth, el.videoHeight);
          ready();
        }}
        onError={onError}
        className="nodrag block h-full w-full object-contain"
      />
    );
  } else if (modality === "audio" || mediaType?.startsWith("audio/")) {
    media = (
      <div className="flex w-full items-center px-4">
        {/* `assetId` is what buys real peaks — a stored clip's bytes are only
            readable server-side. */}
        <WaveformPlayer
          key={url}
          url={url}
          assetId={assetId}
          onReady={ready}
          onError={onError}
        />
      </div>
    );
  } else {
    media = (
      // Presigned B2 URLs on a private bucket — see the note in upload-node
      // on why the Next image optimizer is not usable here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={url}
        src={url}
        alt="Generated result"
        onLoad={(e) => {
          const el = e.currentTarget;
          if (el.naturalWidth && el.naturalHeight) onMediaSize?.(el.naturalWidth, el.naturalHeight);
          ready();
        }}
        onError={onError}
        className="block h-full w-full object-cover"
      />
    );
  }

  return (
    <>
      {media}
      {phase === "ready" ? null : (
        // Opaque, over the half-painted element: the well's own colour, so the
        // node reads as one surface waiting rather than a broken picture.
        <div className="absolute inset-0 grid place-items-center bg-[#faf8f4] px-4">
          {phase === "loading" ? (
            <LoadingWell />
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <WarningIcon weight="fill" className="size-5 text-[#a9743f]" />
              <p className="text-[11.5px] text-[#a9743f]">This take didn’t load.</p>
              {assetId && onStale ? (
                <button
                  type="button"
                  onClick={() => {
                    spent.current = 0;
                    resign();
                  }}
                  className="nodrag border border-[#1f211c]/20 px-2 py-0.5 text-[11px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/45 hover:bg-white/70"
                >
                  Try again
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function RunWell({
  run,
  modality,
  assetId,
  onMediaSize,
  onStale,
}: {
  run: NodeRunState | undefined;
  modality: string;
  /**
   * The asset row behind what the well is showing, when it has one. Lets an
   * expired preview link be re-signed in place instead of stranding the node.
   */
  assetId?: string | null;
  /**
   * Reports the displayed media's natural pixel size once it loads — the
   * fallback that lets the card take a result's true shape when the asset row
   * never recorded dimensions.
   */
  onMediaSize?: (width: number, height: number) => void;
  onStale?: StaleMediaHandler;
}): React.ReactElement | null {
  if (!run) return null;

  if (isRunBusy(run)) {
    const pct =
      run.status === "running" &&
      typeof run.progress === "number" &&
      run.progress > 0 &&
      run.progress < 1
        ? run.progress
        : null;
    return (
      <div className="flex w-full flex-col items-center gap-2.5 px-8">
        <ShimmeringText
          text={run.progressMessage || "Generating"}
          className="text-[13px] font-medium tracking-[0.02em]"
        />
        {pct !== null && (
          <div className="h-[3px] w-full max-w-36 overflow-hidden rounded-full bg-[#1f211c]/10">
            <div
              className="h-full rounded-full bg-[#1f211c]/45 transition-[width] duration-700 ease-out"
              style={{ width: `${Math.round(pct * 100)}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  if (run.status === "failed") {
    return (
      <div className="flex flex-col items-center gap-2 px-4 text-center">
        <WarningIcon weight="fill" className="size-5 text-[#a9743f]" />
        <p className="max-h-20 overflow-y-auto text-[11.5px] break-words text-[#a9743f]">
          {run.error ?? "Generation failed"}
        </p>
      </div>
    );
  }

  if (run.status === "skipped") {
    return (
      <p className="px-4 text-center text-[11.5px] text-[#a09a88]">
        Skipped — an upstream node failed
      </p>
    );
  }

  // Succeeded. An LLM's words render directly; media renders by its type.
  const output = run.output;
  if (output?.text || modality === "text") {
    return (
      <div className="nodrag nowheel thin-scrollbar h-full w-full overflow-y-auto p-3">
        <p className="text-[12.5px] leading-5 whitespace-pre-wrap text-[#1f211c]">
          {output?.text ?? "The model returned no text."}
        </p>
      </div>
    );
  }
  if (output?.url) {
    return (
      // Deliberately unkeyed: the media elements inside key on the URL, and the
      // wrapper has to outlive a re-signing or its attempt budget resets with
      // every new link it is handed.
      <MediaWell
        url={output.url}
        mediaType={output.mediaType}
        modality={modality}
        assetId={assetId}
        onMediaSize={onMediaSize}
        onStale={onStale}
      />
    );
  }
  return null;
}
