"use client";

/**
 * The public reading room for a stamped file: drop media made with Asset
 * Flow and read the history it carries. No account, no auth — this page is
 * for whoever *received* the file, which is the whole point of stamping.
 *
 * Same paper, ink, and lineage graph as the studio's provenance drawer,
 * deliberately: a recipient clicking through from a shared file lands in the
 * room the file was made in, not on a marketing page. The graph here is a
 * sibling of the drawer's LineagePanel, rebuilt over the inspect payload —
 * hops in rows by depth, threads measured off the real tiles, gold into the
 * file's own step, dashed where the story crossed runs.
 */

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowUUpLeftIcon,
  FileDashedIcon,
  FileTextIcon,
  FingerprintIcon,
  SealCheckIcon,
  SealQuestionIcon,
  SparkleIcon,
  UploadSimpleIcon,
  WaveformIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { DOT_COLOR, DOT_GAP } from "@/lib/studio/node-ui";
import {
  inspectFile,
  type InspectHop,
  type InspectReport,
} from "@/lib/studio/inspect-client";

const MAX_BYTES = 512 * 1024 * 1024;

type Phase =
  | { state: "idle" }
  | { state: "reading" }
  | { state: "failed" }
  | { state: "done"; report: InspectReport; file: File; objectUrl: string };

export function InspectView() {
  const [phase, setPhase] = React.useState<Phase>({ state: "idle" });
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // One object URL per inspected file; revoked when replaced or unmounted.
  const urlRef = React.useRef<string | null>(null);
  React.useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const inspect = React.useCallback(async (file: File) => {
    if (file.size > MAX_BYTES) {
      setPhase({ state: "failed" });
      return;
    }
    setPhase({ state: "reading" });
    const report = await inspectFile(file);
    if (!report) {
      setPhase({ state: "failed" });
      return;
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const objectUrl = URL.createObjectURL(file);
    urlRef.current = objectUrl;
    setPhase({ state: "done", report, file, objectUrl });
  }, []);

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void inspect(file);
    },
    [inspect],
  );

  return (
    <div className="fixed inset-0 overflow-y-auto bg-[#f7f4ee] text-[#1f211c]">
      {/* The canvas's own dots — the file is coming home to be read. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.5]"
        style={{
          backgroundImage: `radial-gradient(${DOT_COLOR} 1px, transparent 1px)`,
          backgroundSize: `${DOT_GAP}px ${DOT_GAP}px`,
        }}
      />

      <div className="relative mx-auto w-full max-w-[680px] px-5 pt-12 pb-24">
        <header className="mb-10">
          <Link href="/" className="inline-block">
            <Image
              src="/assetflow_full_logo.svg"
              alt="Asset Flow"
              width={166}
              height={23}
              priority
            />
          </Link>
          <h1 className="mt-6 text-[26px] leading-tight font-medium">
            Provenance inspector
          </h1>
          <p className="mt-2 font-serif text-[16px] leading-7 text-[#4c4a41] italic">
            Files exported from Asset Flow carry their own history — every
            model, prompt, and edit that led to them, written into the file
            itself. Drop one here to read it. No account needed.
          </p>
        </header>

        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2.5 border border-dashed bg-white/70 px-6 text-center transition-all",
            phase.state === "done" ? "py-6" : "py-12",
            dragging
              ? "border-[#1f211c]/60 bg-white"
              : "border-[#1f211c]/25 hover:border-[#1f211c]/45",
          )}
        >
          {phase.state === "reading" ? (
            <>
              <Spinner className="size-5" />
              <p className="text-[13px] text-[#4c4a41]">Reading the file…</p>
            </>
          ) : (
            <>
              <UploadSimpleIcon className="size-5 text-[#8a8271]" />
              <p className="text-[13px] font-medium">
                {phase.state === "done"
                  ? "Drop another file"
                  : "Drop a file, or click to choose one"}
              </p>
              {phase.state !== "done" && (
                <p className="text-[11.5px] text-[#8a8271]">
                  PNG · JPEG · WebP · MP4 · MP3 — up to 512 MB
                </p>
              )}
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void inspect(file);
              e.target.value = "";
            }}
          />
        </div>

        {phase.state === "failed" && (
          <p className="mt-6 text-[13px] text-[#a33d2f]">
            Couldn&rsquo;t inspect that file — it may be too large, or the
            service is unreachable. Try again in a moment.
          </p>
        )}

        {phase.state === "done" && (
          <Report
            report={phase.report}
            file={phase.file}
            objectUrl={phase.objectUrl}
          />
        )}
      </div>
    </div>
  );
}

// --- the report -------------------------------------------------------------

function Report({
  report,
  file,
  objectUrl,
}: {
  report: InspectReport;
  file: File;
  objectUrl: string;
}) {
  // The file's own step tells the headline — cleaner than the raw provider
  // strings (a mux step reports itself as `__ffmpeg__`).
  const own = report.hops.find((hop) => hop.depth === 0) ?? null;
  const headline = own
    ? hopLabel(own)
    : report.model
      ? { name: report.model, detail: prettyProvider(report.provider) }
      : null;

  return (
    <section className="mt-10">
      <DroppedFile file={file} objectUrl={objectUrl} report={report} />
      <SourceBanner report={report} />

      {report.found && (
        <ol className="mt-8 space-y-8 border-l border-[#1f211c]/14">
          {report.prompt && (
            <ReportSection title="Prompt">
              <p className="font-serif text-[15px] leading-6 text-[#1f211c] italic">
                &ldquo;{report.prompt}&rdquo;
              </p>
            </ReportSection>
          )}

          {headline && (
            <ReportSection title="Made with">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13px] font-semibold">{headline.name}</span>
                {headline.detail && (
                  <span className="text-[10.5px] font-semibold tracking-[0.14em] text-[#8a8271] uppercase">
                    {headline.detail}
                  </span>
                )}
              </p>
            </ReportSection>
          )}

          {report.hops.length > 1 && (
            <ReportSection title="Lineage">
              <LineagePlate report={report} />
            </ReportSection>
          )}

          <ReportSection title="Integrity">
            <div className="divide-y divide-[#1f211c]/5 border-y border-[#1f211c]/8">
              <HashRow label="This file" value={report.sha256} />
              {report.originalSha256 && report.originalSha256 !== report.sha256 && (
                <HashRow label="Original" value={report.originalSha256} />
              )}
              {report.manifestHash && (
                <HashRow label="Record hash" value={report.manifestHash} />
              )}
            </div>
            {report.source === "fingerprint" ? (
              <p className="mt-2 text-[11.5px] leading-5 text-[#8a8271]">
                Byte-identical to the stored original.
              </p>
            ) : (
              report.originalSha256 &&
              report.originalSha256 !== report.sha256 && (
                <p className="mt-2 text-[11.5px] leading-5 text-[#8a8271]">
                  This copy&rsquo;s fingerprint differs from the original
                  because the provenance record itself was written into it.
                </p>
              )
            )}
          </ReportSection>
        </ol>
      )}

      <p className="mt-8 border-t border-[#1f211c]/8 pt-4 font-serif text-[13px] leading-6 text-[#8a8271] italic">
        {report.found
          ? "The canonical record lives beside the original in storage — this copy carries its story with it."
          : "Nothing to read — the trail lives in the file, and this file isn't carrying it."}
      </p>
    </section>
  );
}

function DroppedFile({
  file,
  objectUrl,
  report,
}: {
  file: File;
  objectUrl: string;
  report: InspectReport;
}) {
  const kind = file.type.split("/")[0];
  return (
    <div className="flex items-center gap-4 border border-[#1f211c]/10 bg-white p-3">
      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden bg-[#eceadf]">
        {kind === "image" ? (
          // Local preview of the very bytes dropped — nothing re-fetched.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={objectUrl} alt="" className="size-full object-cover" />
        ) : kind === "video" ? (
          <video src={objectUrl} muted className="size-full object-cover" />
        ) : kind === "audio" ? (
          <WaveformIcon className="size-6 text-[#8a8271]" />
        ) : (
          <FileDashedIcon className="size-6 text-[#8a8271]" />
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-[14px] font-medium">{file.name}</p>
        <p className="mt-0.5 text-[11.5px] text-[#8a8271] tabular-nums">
          {file.type || "unknown type"} · {formatBytes(report.sizeBytes)}
          {report.createdAt ? ` · made ${formatWhen(report.createdAt)}` : ""}
        </p>
      </div>
    </div>
  );
}

function SourceBanner({ report }: { report: InspectReport }) {
  const styles = {
    good: "border-[#3d6b35]/30 bg-[#3d6b35]/6 text-[#3d6b35]",
    warn: "border-[#8a6d1f]/30 bg-[#8a6d1f]/6 text-[#7a601c]",
    none: "border-[#a33d2f]/30 bg-[#a33d2f]/6 text-[#a33d2f]",
  };
  const banner = {
    embedded: {
      icon: SealCheckIcon,
      tone: styles.good,
      text: "Provenance read from the file's own metadata — and the original is still in the library.",
    },
    fingerprint: {
      icon: FingerprintIcon,
      tone: styles.good,
      text: "No embedded record, but the bytes match a library original exactly — history recovered by fingerprint.",
    },
    snapshot: {
      icon: ArrowUUpLeftIcon,
      tone: styles.warn,
      text: "Provenance read from the file's own metadata. The library no longer holds this asset — the file is the last copy of its own story.",
    },
    none: {
      icon: SealQuestionIcon,
      tone: styles.none,
      text: "No provenance found. The file carries no record, and no library original matches its fingerprint — if it passed through a platform that strips metadata, the trail ends here.",
    },
  }[report.source];

  const Icon = banner.icon;
  return (
    <p
      className={cn(
        "mt-3 flex items-start gap-2 border px-3 py-2.5 text-[12.5px] leading-5 font-medium",
        banner.tone,
      )}
    >
      <Icon weight="fill" className="mt-0.5 size-4 shrink-0" />
      <span>{banner.text}</span>
    </p>
  );
}

// --- the lineage graph ------------------------------------------------------

/** The graph on its own plate of tightened canvas dots, with the tally under
 *  it — a public sibling of the drawer's LineagePanel. */
function LineagePlate({ report }: { report: InspectReport }) {
  return (
    <div>
      <div className="relative border border-[#1f211c]/10 bg-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage: `radial-gradient(${DOT_COLOR} 1px, transparent 1px)`,
            backgroundSize: "13px 13px",
          }}
        />
        <div className="relative p-4">
          <LineageGraph report={report} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[#8a8271]">
        <p className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-px w-5 bg-[#b08a2e]" />
          leads to this file
        </p>
        {crossesRuns(report) && (
          <p className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-px w-5"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(to right, rgba(31,33,28,0.4) 0 6px, transparent 6px 10px)",
              }}
            />
            carried in from another run
          </p>
        )}
        <p className="tabular-nums">{tally(report)}</p>
      </div>
    </div>
  );
}

/** The run a hop executed in, straight out of its `runId:nodeId` identity. */
function runOf(hop: InspectHop): string {
  return hop.id.split(":")[0] ?? "";
}

function crossesRuns(report: InspectReport): boolean {
  return new Set(report.hops.map(runOf)).size > 1;
}

function tally(report: InspectReport): string {
  const sources = report.hops.filter((h) => h.kind.startsWith("input.")).length;
  const steps = report.hops.length - sources;
  const runs = new Set(report.hops.map(runOf)).size;
  const parts = [
    `${steps} ${steps === 1 ? "step" : "steps"}`,
    `${sources} ${sources === 1 ? "source" : "sources"}`,
  ];
  if (runs > 1) parts.push(`${runs} runs`);
  if (report.truncated) parts.push("history goes deeper");
  return parts.join(" · ");
}

/**
 * A tile's box in the graph's own coordinates, from layout rather than from
 * `getBoundingClientRect` — offsets are pre-transform and pre-scroll, so the
 * threads land where the tiles actually settle.
 */
function boxWithin(el: HTMLElement, root: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/**
 * The derivation as the graph it was: hops in rows by distance from the file,
 * sources at the top, joined by the run snapshots' own edges. Threads are
 * measured off the real tiles — a hand-placed line would start lying the
 * first time a level held three nodes instead of one.
 */
function LineageGraph({ report }: { report: InspectReport }) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const tiles = React.useRef(new Map<string, HTMLElement>());
  const [threads, setThreads] = React.useState<
    { key: string; d: string; lit: boolean; crossed: boolean }[]
  >([]);

  const levels = React.useMemo(() => {
    const byDepth = new Map<number, InspectHop[]>();
    for (const hop of report.hops) {
      byDepth.set(hop.depth, [...(byDepth.get(hop.depth) ?? []), hop]);
    }
    return [...byDepth.entries()].sort((a, b) => b[0] - a[0]).map(([, hops]) => hops);
  }, [report]);

  const byId = React.useMemo(
    () => new Map(report.hops.map((hop) => [hop.id, hop])),
    [report],
  );

  const outputHop = React.useMemo(
    () => report.hops.find((hop) => hop.depth === 0)?.id ?? null,
    [report],
  );

  const measure = React.useCallback(() => {
    const root = wrap.current;
    if (!root) return;
    const drawn: { key: string; d: string; lit: boolean; crossed: boolean }[] = [];
    for (const edge of report.edges) {
      const from = tiles.current.get(edge.source);
      const to = tiles.current.get(edge.target);
      if (!from || !to) continue;
      const a = boxWithin(from, root);
      const b = boxWithin(to, root);
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      // Sideways or upward edges would draw over the tiles; the rows already
      // say what order things happened in.
      if (y2 <= y1) continue;
      const bend = Math.max(10, Math.min(30, (y2 - y1) * 0.55));
      const src = byId.get(edge.source);
      const dst = byId.get(edge.target);
      drawn.push({
        key: `${edge.source}->${edge.target}`,
        d: `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`,
        lit: edge.target === outputHop,
        crossed: src !== undefined && dst !== undefined && runOf(src) !== runOf(dst),
      });
    }
    setThreads(drawn);
  }, [report, byId, outputHop]);

  React.useLayoutEffect(() => {
    measure();
    const root = wrap.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure]);

  return (
    // The whole graph fits the plate — no scrolling. Tiles in a crowded row
    // shrink to share the width (their text truncates) rather than pushing
    // the level sideways; the ResizeObserver re-threads the edges whenever
    // the shared widths settle differently.
    <div ref={wrap} className="relative flex w-full flex-col gap-9">
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        {threads.map((thread) => (
          <path
            key={thread.key}
            d={thread.d}
            fill="none"
            strokeWidth={thread.lit ? 1.5 : 1}
            strokeDasharray={thread.crossed ? "6 4" : undefined}
            stroke={thread.lit ? "rgba(176,138,46,0.8)" : "rgba(31,33,28,0.24)"}
          />
        ))}
      </svg>

      {levels.map((hops, i) => (
        <div
          key={hops[0]?.depth ?? i}
          className="relative flex w-full items-stretch justify-center gap-4"
        >
          {hops.map((hop) => (
            <HopTile
              key={hop.id}
              hop={hop}
              register={(el) => {
                if (el) tiles.current.set(hop.id, el);
                else tiles.current.delete(hop.id);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Providers name themselves for machines (`__ffmpeg__`); people get the
 *  same word without the underscores. */
function prettyProvider(provider: string | null): string {
  return (provider ?? "").replace(/_/g, " ").trim();
}

function hopLabel(hop: InspectHop): { name: string; detail: string } {
  switch (hop.kind) {
    case "input.text":
      return { name: hop.title ?? "Prompt", detail: "written on the canvas" };
    case "input.upload":
      return {
        name: hop.assetFilename ?? hop.title ?? "Upload",
        detail: "uploaded file",
      };
    case "transform.composite":
      return { name: "Timeline mix", detail: "ffmpeg" };
    default:
      return {
        name: hop.model ?? hop.title ?? "Step",
        detail: prettyProvider(hop.provider) || "generated",
      };
  }
}

function HopThumb({ hop }: { hop: InspectHop }) {
  const box = "size-11 shrink-0 border border-[#1f211c]/10";
  if (hop.previewUrl && hop.previewMediaType?.startsWith("image/")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={hop.previewUrl}
        alt=""
        className={cn(box, "bg-[#eceadf] object-cover")}
      />
    );
  }
  if (hop.previewUrl && hop.previewMediaType?.startsWith("video/")) {
    return (
      <video
        src={hop.previewUrl}
        muted
        playsInline
        preload="metadata"
        className={cn(box, "bg-[#1f211c] object-cover")}
      />
    );
  }
  const Icon =
    hop.kind === "input.text"
      ? FileTextIcon
      : hop.previewMediaType?.startsWith("audio/") ||
          hop.kind.includes("music") ||
          hop.kind.includes("speech") ||
          hop.kind.includes("audio")
        ? WaveformIcon
        : hop.kind === "input.upload"
          ? UploadSimpleIcon
          : SparkleIcon;
  return (
    <span className={cn(box, "grid place-items-center bg-[#eceadf] text-[#8a8271]")}>
      <Icon className="size-4.5" />
    </span>
  );
}

function hopStanding(hop: InspectHop): string {
  if (hop.depth === 0) return "this file";
  return hop.kind.startsWith("input.") ? "source" : "step";
}

/** One node of the graph. Read-only here — there is no drawer to hop to. */
function HopTile({
  hop,
  register,
}: {
  hop: InspectHop;
  /** Handed to the graph so it can measure this tile and thread the edges. */
  register: (el: HTMLElement | null) => void;
}) {
  const { name, detail } = hopLabel(hop);
  const voice = (hop.kind === "input.text" ? hop.text : hop.prompt)?.trim() ?? "";
  const current = hop.depth === 0;

  return (
    <div
      ref={register}
      className={cn(
        "flex min-w-0 max-w-[210px] flex-1 flex-col gap-2.5 border bg-white p-3 text-left",
        current
          ? "border-[#b08a2e]/55 shadow-[0_0_0_3px_rgba(176,138,46,0.11)]"
          : "border-[#1f211c]/12",
      )}
    >
      <span className="flex items-center gap-2.5">
        <HopThumb hop={hop} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] leading-tight font-semibold text-[#1f211c]">
            {name}
          </span>
          <span className="mt-1 block truncate text-[9.5px] font-semibold tracking-[0.14em] text-[#8a8271] uppercase">
            {detail}
          </span>
        </span>
      </span>

      {voice && (
        <span className="line-clamp-3 font-serif text-[11.5px] leading-5 text-[#8a8271] italic">
          &ldquo;{voice}&rdquo;
        </span>
      )}

      <span
        className={cn(
          "border-t border-[#1f211c]/6 pt-2 text-[9.5px] font-semibold tracking-[0.14em] uppercase",
          current ? "text-[#b08a2e]" : "text-[#a9a294]",
        )}
      >
        {hopStanding(hop)}
      </span>
    </div>
  );
}

// --- small pieces -----------------------------------------------------------

function ReportSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="pl-5">
      <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.18em] text-[#8a8271] uppercase">
        {title}
      </h3>
      {children}
    </li>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-[11px] font-semibold tracking-[0.1em] text-[#8a8271] uppercase">
        {label}
      </span>
      <span
        title={value}
        className="truncate font-mono text-[11.5px] text-[#1f211c] tabular-nums"
      >
        {value.slice(0, 10)}…{value.slice(-6)}
      </span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
