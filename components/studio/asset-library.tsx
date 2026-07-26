"use client";

/**
 * The asset library — every piece of media the tenant has generated or
 * uploaded, across all workflows.
 *
 * Reads come straight from FastAPI on the client (the list needs auth headers
 * and mints short-lived presigned preview URLs, so the server can't cache it
 * for us). Search, filters, and sorting run over the fetched window in memory:
 * this is one person's shelf, not a feed.
 *
 * Deleting removes the index row only — the bytes and the provenance manifest
 * stay in B2, so a run manifest that references the artifact keeps resolving.
 */

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { UserButton, useAuth } from "@clerk/nextjs";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CheckIcon,
  CopyIcon,
  DatabaseIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  ImageSquareIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  SealCheckIcon,
  SealWarningIcon,
  SparkleIcon,
  TrashSimpleIcon,
  UploadSimpleIcon,
  VideoCameraIcon,
  WarningCircleIcon,
  WaveformIcon,
  XIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DOT_COLOR, DOT_GAP } from "@/lib/studio/node-ui";
import { downloadResult } from "@/lib/studio/runs-client";
import { uploadAsset } from "@/lib/studio/assets-client";
import {
  deleteLibraryAsset,
  fetchLibrary,
  fetchProvenance,
  fetchRunManifest,
  renameLibraryAsset,
  searchLibrary,
  type AssetProvenance,
  type LibraryAsset,
  type LibrarySearch,
  type LineageChain,
  type LineageHop,
  type RunManifestRecord,
} from "@/lib/studio/library-client";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { LinkPendingIcon } from "./link-pending-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

// --- vocabulary -----------------------------------------------------------

type ModalityFilter = "all" | "image" | "video" | "audio" | "text";
type KindFilter = "all" | "generated" | "upload";
type SortOrder = "newest" | "oldest" | "largest" | "name";

const MODALITY_TABS: { id: ModalityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "text", label: "Text" },
];

const KIND_LABELS: Record<KindFilter, string> = {
  all: "All sources",
  generated: "Generated",
  upload: "Uploads",
};

const SORT_LABELS: Record<SortOrder, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  largest: "Largest first",
  name: "By name",
};

const MODALITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  image: ImageSquareIcon,
  video: VideoCameraIcon,
  audio: WaveformIcon,
  text: FileTextIcon,
};

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "video/mp4": ".mp4",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "text/plain": ".txt",
};

// --- little formatters ----------------------------------------------------

function formatBytes(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatDuration(sec: number | null): string | null {
  if (!sec || sec <= 0) return null;
  const whole = Math.round(sec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const sec = Math.max(0, (Date.now() - then) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function displayName(asset: LibraryAsset): string {
  if (asset.filename) return asset.filename;
  const label = asset.kind === "generated" ? "Generated" : "Uploaded";
  return `${label} ${asset.modality}`;
}

function downloadFilename(asset: LibraryAsset): string {
  const ext = EXT_BY_MEDIA_TYPE[asset.mediaType] ?? "";
  if (asset.filename) {
    return asset.filename.includes(".") ? asset.filename : `${asset.filename}${ext}`;
  }
  return `assetflow-${asset.modality}-${asset.id.slice(0, 8)}${ext}`;
}

// --- the page -------------------------------------------------------------

type LoadState = "loading" | "ready" | "offline";

export function AssetLibrary() {
  const { getToken, userId, isLoaded: authLoaded } = useAuth();

  const [state, setState] = React.useState<LoadState>("loading");
  const [assets, setAssets] = React.useState<LibraryAsset[]>([]);

  const [query, setQuery] = React.useState("");
  const [modality, setModality] = React.useState<ModalityFilter>("all");
  const [kind, setKind] = React.useState<KindFilter>("all");
  const [sort, setSort] = React.useState<SortOrder>("newest");

  const [pendingDelete, setPendingDelete] = React.useState<LibraryAsset | null>(null);
  /** Optimistically hidden rows — ids only, so the server list stays authoritative. */
  const [deletedIds, setDeletedIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);

  /** The asset whose dossier is open in the drawer. */
  const [inspecting, setInspecting] = React.useState<LibraryAsset | null>(null);
  /**
   * Fetched dossiers, kept per asset id — lineage rows never change once a run
   * has finished, so reopening a card should not refetch.
   */
  const [dossiers, setDossiers] = React.useState<
    Record<string, AssetProvenance | "loading" | "error">
  >({});

  const authFor = React.useCallback(
    async () => ({
      token: await getToken().catch(() => null),
      userId: userId ?? null,
    }),
    [getToken, userId],
  );

  /**
   * One fetch per mount, gated on Clerk being loaded *before* the latch — a
   * pre-auth request carries no identity, resolves the wrong tenant, and the
   * latch would swallow the retry (the exact bug the canvas hit).
   */
  const fetched = React.useRef(false);
  const load = React.useCallback(async () => {
    setState("loading");
    const rows = await fetchLibrary(await authFor());
    if (rows === null) {
      setState("offline");
      return;
    }
    setAssets(rows);
    setDeletedIds(new Set());
    setState("ready");
  }, [authFor]);

  React.useEffect(() => {
    if (!authLoaded || fetched.current) return;
    fetched.current = true;
    void load();
  }, [authLoaded, load]);

  // --- server search ------------------------------------------------------

  /**
   * Hybrid results for the current query, or null when the query is empty or
   * the search failed. Failure falls back to the in-memory filter below — a
   * degraded shelf beats an error wall, and the two are the same gesture.
   */
  const [results, setResults] = React.useState<LibrarySearch | null>(null);
  const [searching, setSearching] = React.useState(false);
  const searchAbort = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    searchAbort.current?.abort();
    // An empty query needs no reset here: everything downstream (the results
    // memo, the spinner) gates on the query itself, so stale state is inert.
    if (!q) return;
    const controller = new AbortController();
    searchAbort.current = controller;
    const timer = setTimeout(async () => {
      setSearching(true);
      const found = await searchLibrary(q, await authFor(), {
        modality,
        kind,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResults(found);
      setSearching(false);
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, modality, kind, authFor]);

  // --- uploads ------------------------------------------------------------

  const uploadInput = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(0);

  const onFilesChosen = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (!files.length) return;
      setUploading((n) => n + files.length);
      const auth = await authFor();
      for (const file of files) {
        const stored = await uploadAsset(file, auth);
        setUploading((n) => n - 1);
        if (!stored) {
          toast.error(`Couldn't upload ${file.name}.`);
          continue;
        }
        // Synthesized from the upload response so the card appears now; the
        // next full load replaces it with the server's own row. Enrichment
        // (caption, tags) runs in the background and shows up via search.
        const row: LibraryAsset = {
          id: stored.id,
          kind: "upload",
          previewUrl: stored.url,
          mediaType: stored.mediaType,
          modality: stored.modality,
          sizeBytes: file.size,
          width: stored.width,
          height: stored.height,
          durationSec: null,
          runId: null,
          filename: stored.filename,
          sha256: null,
          createdAt: new Date().toISOString(),
        };
        setAssets((current) =>
          current.some((a) => a.id === row.id) ? current : [row, ...current],
        );
      }
    },
    [authFor],
  );

  // --- filtering pipeline -------------------------------------------------

  const living = React.useMemo(
    () => assets.filter((a) => !deletedIds.has(a.id)),
    [assets, deletedIds],
  );

  const counts = React.useMemo(() => {
    const by: Record<string, number> = { all: living.length };
    for (const a of living) by[a.modality] = (by[a.modality] ?? 0) + 1;
    return by;
  }, [living]);

  const totalBytes = React.useMemo(
    () => living.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0),
    [living],
  );

  /** Distinct runs behind the shelf — uploads have no run and don't count. */
  const runCount = React.useMemo(
    () => new Set(living.map((a) => a.runId).filter(Boolean)).size,
    [living],
  );

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const out = living.filter((a) => {
      if (modality !== "all" && a.modality !== modality) return false;
      if (kind !== "all" && a.kind !== kind) return false;
      if (!needle) return true;
      return (
        (a.filename ?? "").toLowerCase().includes(needle) ||
        a.modality.includes(needle) ||
        a.mediaType.toLowerCase().includes(needle) ||
        a.kind.includes(needle)
      );
    });
    const time = (a: LibraryAsset) => (a.createdAt ? Date.parse(a.createdAt) : 0);
    switch (sort) {
      case "newest":
        return out.sort((a, b) => time(b) - time(a));
      case "oldest":
        return out.sort((a, b) => time(a) - time(b));
      case "largest":
        return out.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
      case "name":
        return out.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    }
  }, [living, query, modality, kind, sort]);

  const filtersActive = query.trim() !== "" || modality !== "all" || kind !== "all";

  /**
   * Server results with deletions applied. Null falls the page back to the
   * in-memory filter above — the same search box, just less clever about it.
   */
  const liveResults = React.useMemo(() => {
    if (!results || !query.trim()) return null;
    const alive = (rows: LibraryAsset[]) => rows.filter((a) => !deletedIds.has(a.id));
    return { semantic: alive(results.semantic), keyword: alive(results.keyword) };
  }, [results, query, deletedIds]);

  // --- actions ------------------------------------------------------------

  const confirmDelete = React.useCallback(async () => {
    const asset = pendingDelete;
    if (!asset) return;

    // Hide it now — a dialog closing onto a card that is still there reads as
    // a failure even when the request is merely slow.
    setDeletedIds((current) => new Set(current).add(asset.id));
    setPendingDelete(null);

    const ok = await deleteLibraryAsset(asset.id, await authFor());
    if (!ok) {
      setDeletedIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
      toast.error("Couldn't remove that from the library.");
      return;
    }
    toast.success("Removed from your library.");
  }, [pendingDelete, authFor]);

  const download = React.useCallback(
    async (asset: LibraryAsset) => {
      if (downloadingId) return;
      setDownloadingId(asset.id);
      try {
        const saved = await downloadResult(
          { assetId: asset.id },
          downloadFilename(asset),
          await authFor(),
        );
        if (!saved) toast.error("Couldn't download that file.");
      } finally {
        setDownloadingId(null);
      }
    },
    [downloadingId, authFor],
  );

  /**
   * Rename, applied everywhere the row is held — the shelf, the search
   * sections, and the open drawer — before the request lands. A failure puts
   * the old name back rather than leaving two truths on screen.
   */
  const rename = React.useCallback(
    async (asset: LibraryAsset, next: string) => {
      const trimmed = next.trim();
      if (trimmed === (asset.filename ?? "")) return;

      const apply = (filename: string | null) => {
        setAssets((current) =>
          current.map((a) => (a.id === asset.id ? { ...a, filename } : a)),
        );
        setResults((current) =>
          current
            ? {
                semantic: current.semantic.map((a) =>
                  a.id === asset.id ? { ...a, filename } : a,
                ),
                keyword: current.keyword.map((a) =>
                  a.id === asset.id ? { ...a, filename } : a,
                ),
              }
            : current,
        );
        setInspecting((current) =>
          current && current.id === asset.id
            ? { ...current, filename }
            : current,
        );
      };

      apply(trimmed || null);
      const saved = await renameLibraryAsset(
        asset.id,
        trimmed,
        await authFor(),
      );
      if (!saved) {
        apply(asset.filename);
        toast.error("Couldn't rename that.");
      }
    },
    [authFor],
  );

  const loadDossier = React.useCallback(
    async (asset: LibraryAsset) => {
      setDossiers((current) => ({ ...current, [asset.id]: "loading" }));
      const dossier = await fetchProvenance(asset.id, await authFor());
      setDossiers((current) => ({
        ...current,
        [asset.id]: dossier ?? "error",
      }));
    },
    [authFor],
  );

  const inspect = React.useCallback(
    (asset: LibraryAsset) => {
      setInspecting(asset);
      const known = dossiers[asset.id];
      if (!known || known === "error") void loadDossier(asset);
    },
    [dossiers, loadDossier],
  );

  // --- render -------------------------------------------------------------

  return (
    <TooltipProvider>
      {/* The room holds still — masthead and rail are furniture, only the shelf
          moves. Same fixed frame the home screen uses. */}
      <div className="fixed inset-0 flex flex-col overflow-hidden bg-[#f7f4ee] text-[#1f211c]">
        {/* Same dots as the canvas — the library is a room in the same house,
            held back a little because there's small type over them here and
            nothing to drag around. */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-55"
          style={{
            backgroundImage: `radial-gradient(${DOT_COLOR} 1px, transparent 1px)`,
            backgroundSize: `${DOT_GAP}px ${DOT_GAP}px`,
          }}
        />
        {/* Chrome — logo home, workflows + avatar right, matching the home screen. */}
        <div className="fixed top-5 left-5 z-40 animate-[studio-drift-in_0.7s_cubic-bezier(0.32,0.72,0,1)_both]">
          <Link href="/workflow" aria-label="Back to workflows">
            <Image
              src="/assetflow_full_logo.svg"
              alt="Asset Flow"
              width={166}
              height={23}
              priority
            />
          </Link>
        </div>
        <div className="fixed top-4 right-4 z-40 flex items-center gap-2 animate-[studio-drift-in_0.7s_cubic-bezier(0.32,0.72,0,1)_both]">
          <Link
            href="/workflow"
            className="flex h-10 items-center gap-2 border border-[#1f211c]/8 bg-white/88 px-3.5 text-[13px] font-semibold text-[#4c4a41] shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md transition-colors hover:text-[#1f211c]"
          >
            <LinkPendingIcon icon={<ArrowLeftIcon className="size-4" />} />
            Workflows
          </Link>
          <div className="grid size-10 place-items-center rounded-full border border-[#1f211c]/8 bg-white/88 shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md">
            <UserButton appearance={{ elements: { userButtonAvatarBox: "size-7" } }} />
          </div>
        </div>

        {/* Head — no plate, no tray, no seam. Type and controls sit straight on
            the page in the same column as the cards below, and the only thing
            holding them together is alignment. */}
        <div className="relative z-20 shrink-0 pt-[74px] pb-6">
          <div className="mx-auto w-full max-w-[1440px] px-6 sm:px-10">
            {/* Masthead — a shelf label and its inventory. */}
            <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5 animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_both]">
              <div className="min-w-0">
                <h1 className="text-[clamp(1.75rem,3vw,2.125rem)] leading-none font-medium tracking-[-0.025em]">
                  Library
                </h1>
                <p className="mt-2.5 max-w-[52ch] text-[13px] leading-5 text-[#6d6759]">
                  Generated and uploaded media from every workflow, with
                  provenance attached.
                </p>
              </div>

              {/* Inventory. Held even while the shelf loads, so the figures
                  arrive in place instead of shoving the masthead sideways. */}
              <dl className="flex items-end gap-7 sm:gap-9">
                <Stat
                  value={living.length.toLocaleString()}
                  label={living.length === 1 ? "piece" : "pieces"}
                  pending={state !== "ready"}
                />
                <Stat
                  value={formatBytes(totalBytes) ?? "0 KB"}
                  label="stored"
                  pending={state !== "ready"}
                />
                <Stat
                  value={runCount.toLocaleString()}
                  label={runCount === 1 ? "run" : "runs"}
                  pending={state !== "ready"}
                />
              </dl>
            </header>

            {/* Control rail */}
            <div
              className="mt-5 animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_80ms_both]"
              style={{ transitionTimingFunction: EASE }}
            >
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2.5">
                {/* Search. The field states its own trick: every piece is
                    embedded when it lands, so this reads content, not filenames.
                    Saying so is the difference between a search box people type
                    one word into and one they describe a shot to. It carries the
                    primary border — the one control on the rail worth marking
                    out, and the same amber the Meaning tag is set in. */}
                <label className="flex h-9 min-w-[240px] flex-1 basis-[320px] items-center gap-2.5 border border-primary bg-white pr-1 pl-3 transition-colors focus-within:border-[#b08a2e]">
                  {searching && query.trim() ? (
                    <Spinner className="size-4 shrink-0 text-[#8a8271]" />
                  ) : (
                    <MagnifyingGlassIcon className="size-4 shrink-0 text-[#8a8271]" />
                  )}
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Describe what you're looking for…"
                    className="w-full bg-transparent text-[13px] font-medium outline-none placeholder:text-[#8a8271]/80"
                  />
                  {query.trim() ? (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className="grid size-7 shrink-0 place-items-center text-[#8a8271] transition-colors hover:text-[#1f211c]"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="How search works"
                            className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[9.5px] font-semibold tracking-[0.14em] text-[#a58c46] uppercase transition-colors hover:bg-[#b08a2e]/10 hover:text-[#8a6f20]"
                          >
                            <SparkleIcon
                              className="size-3 text-[#b08a2e]"
                              weight="fill"
                            />
                            Meaning
                          </button>
                        }
                      />
                      <TooltipContent
                        side="bottom"
                        sideOffset={8}
                        className="max-w-[290px] bg-[#1f211c] text-left text-[11.5px] leading-[1.45] text-[#f7f4ee]"
                      >
                        Everything here is described and embedded on arrival, so
                        you can search for what&rsquo;s in a piece —
                        &ldquo;waves at dusk&rdquo; finds the shot called
                        IMG_0421. Word matches are listed underneath,
                        separately.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </label>

                {/* Modality tabs. Counts hold their slot while the shelf loads,
                    so the group doesn't grow under the cursor. */}
                <div className="flex h-9 items-center border border-[#1f211c]/12 bg-white/70">
                  {MODALITY_TABS.map((tab) => {
                    const active = modality === tab.id;
                    const count =
                      counts[tab.id === "all" ? "all" : tab.id] ?? 0;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setModality(tab.id)}
                        aria-pressed={active}
                        className={cn(
                          "flex h-full items-center gap-1.5 px-3 text-[13px] font-semibold transition-colors duration-150",
                          active
                            ? "bg-[#1f211c] text-[#f7f4ee]"
                            : "text-[#4c4a41] hover:bg-[#1f211c]/6 hover:text-[#1f211c]",
                        )}
                      >
                        {tab.label}
                        <span
                          className={cn(
                            "text-[10.5px] tabular-nums transition-opacity duration-300",
                            active ? "text-[#f7f4ee]/55" : "text-[#8a8271]",
                            state === "ready" ? "opacity-100" : "opacity-0",
                          )}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* What the filters left standing, and the way back out. Lives
                    next to the tabs that caused it rather than floating above
                    the grid, where it read as a stray line of type. */}
                {filtersActive && (
                  <div className="flex items-center gap-2 pl-0.5">
                    {!liveResults && (
                      <span className="text-[12px] text-[#8a8271] tabular-nums">
                        {visible.length} of {living.length}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setModality("all");
                        setKind("all");
                      }}
                      className="flex h-7 items-center gap-1 px-1.5 text-[12px] font-semibold text-[#8a8271] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
                    >
                      <XIcon className="size-3" />
                      Reset
                    </button>
                  </div>
                )}

                {/* Right cluster: one action, then the quiet adjustments. The
                    menus give up their borders so Upload is the only thing over
                    here that looks pressable at a glance. */}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => uploadInput.current?.click()}
                    disabled={uploading > 0}
                    className="mr-1 flex h-9 items-center gap-2 border border-[#1f211c]/22 bg-white px-3.5 text-[13px] font-semibold text-[#1f211c] transition-colors hover:border-[#1f211c]/45 disabled:pointer-events-none disabled:opacity-60"
                  >
                    {uploading > 0 ? (
                      <Spinner className="size-3.5 text-[#8a8271]" />
                    ) : (
                      <UploadSimpleIcon className="size-3.5 text-[#8a8271]" />
                    )}
                    {uploading > 0 ? "Uploading…" : "Upload"}
                  </button>
                  <input
                    ref={uploadInput}
                    type="file"
                    accept="image/*,video/*,audio/*"
                    multiple
                    hidden
                    onChange={(e) => void onFilesChosen(e)}
                  />
                  <RailMenu
                    label={KIND_LABELS[kind]}
                    active={kind !== "all"}
                  options={(["all", "generated", "upload"] as const).map((id) => ({
                    id,
                    label: KIND_LABELS[id],
                  }))}
                    value={kind}
                    onSelect={setKind}
                  />
                  <RailMenu
                    label={SORT_LABELS[sort]}
                    active={sort !== "newest"}
                  options={(["newest", "oldest", "largest", "name"] as const).map((id) => ({
                      id,
                      label: SORT_LABELS[id],
                    }))}
                    value={sort}
                    onSelect={setSort}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Shelf — the only thing that moves. */}
        <div className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-[1440px] px-6 pt-3 pb-20 sm:px-10">
            {state === "loading" && <LoadingShelf />}

            {state === "offline" && (
              <EmptyRoom
                icon={<WarningCircleIcon className="size-5 text-[#c1803f]" />}
                title="The library couldn't be reached"
                body="The backend isn't answering. Your media is safe — try again in a moment."
                action={
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="flex h-9 items-center gap-2 border border-[#1f211c]/14 bg-white px-4 text-[13px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
                  >
                    Try again
                  </button>
                }
              />
            )}

            {state === "ready" && living.length === 0 && (
              <EmptyRoom
                title="Nothing on the shelf yet"
                body="Media you generate or upload on any canvas lands here automatically."
                action={
                  <Link
                    href="/workflow"
                    className="flex h-9 items-center gap-2 border border-[#1f211c]/14 bg-white px-4 text-[13px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
                  >
                    <LinkPendingIcon icon={<SparkleIcon className="size-4" />} />
                    Go make something
                  </Link>
                }
              />
            )}

            {/* Hybrid search results — two claims, two sections. */}
            {state === "ready" &&
              liveResults &&
              (liveResults.semantic.length === 0 && liveResults.keyword.length === 0 ? (
                <EmptyRoom
                  title="No matches"
                  body={`Nothing in your library answers to “${query.trim()}”.`}
                  action={
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className="flex h-9 items-center border border-[#1f211c]/14 bg-white px-4 text-[13px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
                    >
                      Clear search
                    </button>
                  }
                />
              ) : (
                <div className="flex flex-col gap-10">
                  {liveResults.semantic.length > 0 && (
                    <ResultSection
                      label="Best matches"
                      hint="ranked by meaning"
                      assets={liveResults.semantic}
                      downloadingId={downloadingId}
                      onDownload={(a) => void download(a)}
                      onDelete={setPendingDelete}
                      onInspect={inspect}
                    />
                  )}
                  {liveResults.keyword.length > 0 && (
                    <ResultSection
                      label="Also mentions"
                      hint="matched your words"
                      assets={liveResults.keyword}
                      downloadingId={downloadingId}
                      onDownload={(a) => void download(a)}
                      onDelete={setPendingDelete}
                      onInspect={inspect}
                    />
                  )}
                </div>
              ))}

            {state === "ready" && !liveResults && living.length > 0 && visible.length === 0 && (
              <EmptyRoom
                title="No matches"
                body={
                  query.trim()
                    ? `Nothing here answers to “${query.trim()}”.`
                    : "Nothing matches these filters."
                }
                action={
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setModality("all");
                      setKind("all");
                    }}
                    className="flex h-9 items-center border border-[#1f211c]/14 bg-white px-4 text-[13px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
                  >
                    Clear filters
                  </button>
                }
              />
            )}

            {state === "ready" && !liveResults && visible.length > 0 && (
              <>
                {/* The count that used to sit here now rides the rail, beside
                    the filters that produced it. */}
                <div className="columns-1 gap-5 sm:columns-2 lg:columns-3 xl:columns-4">
                  {visible.map((asset, index) => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      index={index}
                      downloading={downloadingId === asset.id}
                      onDownload={() => void download(asset)}
                      onDelete={() => setPendingDelete(asset)}
                      onInspect={() => inspect(asset)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <ProvenanceDrawer
          asset={inspecting}
          dossier={inspecting ? (dossiers[inspecting.id] ?? "loading") : "loading"}
          downloading={inspecting !== null && downloadingId === inspecting.id}
          onClose={() => setInspecting(null)}
          onRetry={() => inspecting && void loadDossier(inspecting)}
          onDownload={() => inspecting && void download(inspecting)}
          onRename={(next) => inspecting && void rename(inspecting, next)}
          onDelete={() => {
            if (!inspecting) return;
            setPendingDelete(inspecting);
            setInspecting(null);
          }}
          onInspect={inspect}
          getAuth={authFor}
        />

        <AlertDialog
          open={pendingDelete !== null}
          onOpenChange={(next) => {
            if (!next) setPendingDelete(null);
          }}
        >
          <AlertDialogContent className="border border-[#1f211c]/10 bg-white text-[#1f211c] shadow-[0_28px_70px_-20px_rgba(31,33,28,0.4)] ring-0">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[15px] font-semibold">
                Remove “{pendingDelete ? displayName(pendingDelete) : ""}” from your library?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[12px] leading-5 text-[#8a8271]">
                It comes off the shelf everywhere. The stored file and its
                provenance manifest stay intact in storage.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirmDelete}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

// --- masthead inventory ---------------------------------------------------

/**
 * One reading off the shelf. Term sits under the figure, so scan the numbers.
 * While the shelf loads the figure is an em dash at the same size — the block
 * keeps its shape and the numbers arrive by fading, not by shoving.
 */
function Stat({
  value,
  label,
  pending,
}: {
  value: string;
  label: string;
  pending?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <dd
        className={cn(
          "order-1 text-[19px] leading-none font-medium tracking-[-0.01em] tabular-nums transition-[opacity,color] duration-500",
          pending && "text-[#8a8271]/45",
        )}
      >
        {pending ? "—" : value}
      </dd>
      <dt className="order-2 mt-1.5 text-[9.5px] font-semibold tracking-[0.18em] text-[#8a8271] uppercase">
        {label}
      </dt>
    </div>
  );
}

// --- rail menus -----------------------------------------------------------

function RailMenu<T extends string>({
  label,
  active,
  options,
  value,
  onSelect,
}: {
  label: string;
  active: boolean;
  options: { id: T; label: string }[];
  value: T;
  onSelect: (id: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex h-9 items-center gap-1.5 px-2.5 text-[13px] transition-colors data-[popup-open]:bg-[#1f211c]/8 data-[popup-open]:text-[#1f211c]",
          active
            ? "font-semibold text-[#1f211c] hover:bg-[#1f211c]/6"
            : "font-medium text-[#6d6759] hover:bg-[#1f211c]/6 hover:text-[#1f211c]",
        )}
      >
        {label}
        <CaretDownIcon className="size-3.5 text-[#8a8271]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-[168px] rounded-none border border-[#1f211c]/12 bg-white p-1 text-[#1f211c] shadow-[0_20px_50px_-16px_rgba(31,33,28,0.3)]"
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            onClick={() => onSelect(option.id)}
            className="flex items-center justify-between rounded-none px-2.5 py-1.5 text-[13px] font-medium"
          >
            {option.label}
            {option.id === value && <CheckIcon className="size-3.5 text-[#8a8271]" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- search sections --------------------------------------------------------

/** One band of search results: overline, rule, and the same masonry of cards. */
function ResultSection({
  label,
  hint,
  assets,
  downloadingId,
  onDownload,
  onDelete,
  onInspect,
}: {
  label: string;
  hint: string;
  assets: LibraryAsset[];
  downloadingId: string | null;
  onDownload: (asset: LibraryAsset) => void;
  onDelete: (asset: LibraryAsset) => void;
  onInspect: (asset: LibraryAsset) => void;
}) {
  return (
    <section>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[11px] font-semibold tracking-[0.22em] text-[#4c4a41] uppercase">
          {label}
        </h2>
        <span aria-hidden className="h-px w-16 self-center bg-gradient-to-r from-[#1f211c]/18 to-transparent" />
        <span className="text-[11.5px] text-[#8a8271]">
          {hint} · {assets.length}
        </span>
      </div>
      <div className="columns-1 gap-5 sm:columns-2 lg:columns-3 xl:columns-4">
        {assets.map((asset, index) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            index={index}
            downloading={downloadingId === asset.id}
            onDownload={() => onDownload(asset)}
            onDelete={() => onDelete(asset)}
            onInspect={() => onInspect(asset)}
          />
        ))}
      </div>
    </section>
  );
}

// --- cards ----------------------------------------------------------------

function AssetCard({
  asset,
  index,
  downloading,
  onDownload,
  onDelete,
  onInspect,
}: {
  asset: LibraryAsset;
  index: number;
  downloading: boolean;
  onDownload: () => void;
  onDelete: () => void;
  onInspect: () => void;
}) {
  const Icon = MODALITY_ICONS[asset.modality] ?? FileTextIcon;
  const meta = [
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
    formatDuration(asset.durationSec),
    formatBytes(asset.sizeBytes),
    formatWhen(asset.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      onClick={onInspect}
      className="group relative mb-5 cursor-pointer break-inside-avoid border border-[#1f211c]/8 bg-white shadow-[0_1px_2px_rgba(31,33,28,0.05)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[#1f211c]/24 hover:shadow-[0_18px_44px_-16px_rgba(31,33,28,0.28)] animate-[studio-rise_0.6s_cubic-bezier(0.32,0.72,0,1)_both]"
      style={{ animationDelay: `${Math.min(index * 35, 420)}ms` }}
    >
      <CardMedia asset={asset} />

      {/* Actions surface on hover (and on keyboard focus). */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          aria-label="Download"
          onClick={(e) => {
            e.stopPropagation();
            onDownload();
          }}
          className="grid size-8 place-items-center bg-[#1f211c]/85 text-[#f7f4ee] backdrop-blur-sm transition-colors hover:bg-[#1f211c]"
        >
          {downloading ? (
            <Spinner className="size-4" />
          ) : (
            <DownloadSimpleIcon className="size-4" />
          )}
        </button>
        <button
          type="button"
          aria-label="Remove from library"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="grid size-8 place-items-center bg-[#1f211c]/85 text-[#f7f4ee] backdrop-blur-sm transition-colors hover:bg-[#a33d2f]"
        >
          <TrashSimpleIcon className="size-4" />
        </button>
      </div>

      <footer className="flex items-center gap-2.5 border-t border-[#1f211c]/8 px-3 py-2.5">
        <Icon className="size-[22px] shrink-0 text-[#4c4a41]" />
        <div className="min-w-0">
          <p className="truncate text-[13px] leading-tight font-medium">{displayName(asset)}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] leading-tight text-[#8a8271] tabular-nums">
            {asset.kind === "generated" ? (
              <DatabaseIcon className="size-3 shrink-0" />
            ) : (
              <UploadSimpleIcon className="size-3 shrink-0" />
            )}
            {meta || (asset.kind === "generated" ? "Generated" : "Uploaded")}
          </p>
        </div>
      </footer>
    </article>
  );
}

function CardMedia({ asset }: { asset: LibraryAsset }) {
  if (!asset.previewUrl) return <TextPlate asset={asset} />;

  switch (asset.modality) {
    case "image":
      return (
        // Plain <img>: the src is a short-lived presigned B2 URL, which the
        // next/image optimizer would both cache and choke on.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.previewUrl}
          alt={displayName(asset)}
          loading="lazy"
          className="block w-full bg-[#eceadf]"
          style={
            asset.width && asset.height
              ? { aspectRatio: `${asset.width} / ${asset.height}` }
              : undefined
          }
        />
      );
    case "video":
      return <VideoPlate asset={asset} />;
    case "audio":
      return <AudioPlate asset={asset} />;
    default:
      return <TextPlate asset={asset} />;
  }
}

/** Hover-to-preview video with a duration tag; no chrome until you ask. */
function VideoPlate({ asset }: { asset: LibraryAsset }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const duration = formatDuration(asset.durationSec);

  return (
    <div
      className="relative"
      onMouseEnter={() => void ref.current?.play().catch(() => {})}
      onMouseLeave={() => {
        ref.current?.pause();
        if (ref.current) ref.current.currentTime = 0;
      }}
    >
      <video
        ref={ref}
        src={asset.previewUrl ?? undefined}
        muted
        loop
        playsInline
        preload="metadata"
        className="block w-full bg-[#1f211c]"
        style={
          asset.width && asset.height
            ? { aspectRatio: `${asset.width} / ${asset.height}` }
            : { aspectRatio: "16 / 9" }
        }
      />
      {duration && (
        <span className="absolute bottom-2 left-2 bg-[#1f211c]/80 px-1.5 py-0.5 text-[11px] font-semibold text-[#f7f4ee] tabular-nums backdrop-blur-sm">
          {duration}
        </span>
      )}
    </div>
  );
}

/**
 * Audio gets a plate of its own — sharp bars standing in for a waveform,
 * deterministic per asset so the shelf doesn't shimmer on re-render.
 */
function AudioPlate({ asset }: { asset: LibraryAsset }) {
  const ref = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  const bars = React.useMemo(() => {
    // A tiny xorshift seeded from the id: stable heights, no Math.random.
    let seed = 0;
    for (const ch of asset.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const heights: number[] = [];
    for (let i = 0; i < 40; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      heights.push(0.22 + (seed % 1000) / 1290);
    }
    return heights;
  }, [asset.id]);

  // Stop propagation on both: the card behind this plate opens the provenance
  // drawer on click, and pressing play is not a request to see the dossier.
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const el = ref.current;
    if (!el || !Number.isFinite(el.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - rect.left) / rect.width) * el.duration;
  };

  return (
    <div className="flex items-center gap-3 bg-[#f2efe6] px-3 py-5">
      <audio
        ref={ref}
        src={asset.previewUrl ?? undefined}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setProgress(0)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setProgress(el.duration ? el.currentTime / el.duration : 0);
        }}
      />
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={toggle}
        className="grid size-9 shrink-0 place-items-center bg-[#1f211c] text-[#f7f4ee] transition-colors hover:bg-[#1f211c]/85"
      >
        {playing ? (
          <PauseIcon weight="fill" className="size-4" />
        ) : (
          <PlayIcon weight="fill" className="size-4" />
        )}
      </button>
      <div
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        onClick={seek}
        className="flex h-10 flex-1 cursor-pointer items-center gap-[2px]"
      >
        {bars.map((height, i) => (
          <span
            key={i}
            className={cn(
              "w-full flex-1 transition-colors duration-150",
              i / bars.length <= progress && progress > 0
                ? "bg-[#1f211c]"
                : "bg-[#1f211c]/18",
            )}
            style={{ height: `${Math.round(height * 40)}px` }}
          />
        ))}
      </div>
    </div>
  );
}

function TextPlate({ asset }: { asset: LibraryAsset }) {
  return (
    <div className="flex items-baseline justify-between bg-[#f2efe6] px-4 py-7">
      <span className="font-serif text-3xl leading-none text-[#8a8271] italic">Aa</span>
      <span className="text-[11px] font-semibold tracking-[0.16em] text-[#8a8271] uppercase">
        {asset.mediaType.split("/")[1] ?? "file"}
      </span>
    </div>
  );
}

// --- the provenance drawer ------------------------------------------------

function copyText(label: string, value: string) {
  navigator.clipboard
    .writeText(value)
    .then(() => toast.success(`${label} copied.`))
    .catch(() => toast.error(`Couldn't copy the ${label.toLowerCase()}.`));
}

function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function formatWhenFull(iso: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return new Date(then).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatParamValue(value: unknown): string {
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

type MixTrack = {
  id?: string;
  kind?: string;
  gain?: number;
  clips?: { label?: string; start_sec?: number }[];
};

/**
 * The composition node has no prompt — its whole story lives in params.edit
 * as a timeline. Unpack it so the drawer reads as "what was mixed" instead
 * of a truncated JSON blob.
 */
function readMixTimeline(lineage: AssetProvenance["lineage"]): {
  timelineSec: number | null;
  tracks: MixTrack[];
} | null {
  if (lineage?.provider !== "__ffmpeg__") return null;
  const edit = lineage.params?.edit;
  if (!edit || typeof edit !== "object") return null;
  const { timeline_sec, tracks } = edit as {
    timeline_sec?: unknown;
    tracks?: unknown;
  };
  return {
    timelineSec: typeof timeline_sec === "number" ? timeline_sec : null,
    tracks: Array.isArray(tracks) ? (tracks as MixTrack[]) : [],
  };
}

function describeMixTrack(track: MixTrack): string {
  const clips = track.clips ?? [];
  const parts = [`${clips.length} clip${clips.length === 1 ? "" : "s"}`];
  if (typeof track.gain === "number" && track.gain !== 1) {
    parts.push(`gain ${track.gain}`);
  }
  return parts.join(" · ");
}

/**
 * The dossier: where a file came from, spelled out as a chain of custody.
 * Prompt in serif — the human's voice — then the model, the run, and the
 * cryptographic receipts, each a link on one vertical rail.
 */
function ProvenanceDrawer({
  asset,
  dossier,
  downloading,
  onClose,
  onRetry,
  onDownload,
  onRename,
  onDelete,
  onInspect,
  getAuth,
}: {
  asset: LibraryAsset | null;
  dossier: AssetProvenance | "loading" | "error";
  downloading: boolean;
  onClose: () => void;
  onRetry: () => void;
  onDownload: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Hop the drawer to another asset in the lineage chain. */
  onInspect: (asset: LibraryAsset) => void;
  getAuth: () => Promise<{ token: string | null; userId: string | null }>;
}) {
  return (
    <Sheet open={asset !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full overflow-y-auto rounded-none border-l border-[#1f211c]/12 bg-[#f7f4ee] p-0 text-[#1f211c] shadow-[-24px_0_60px_-32px_rgba(31,33,28,0.35)] data-[side=right]:sm:max-w-[440px]"
      >
        {asset && (
          <>
            {/* Masthead — the overline alone. The rule that used to trail off
                beside it added nothing but a smudge at this width. */}
            <div className="flex items-center justify-between border-b border-[#1f211c]/8 px-5 py-4">
              <span className="text-[11px] font-semibold tracking-[0.22em] text-[#8a8271] uppercase">
                Provenance
              </span>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="grid size-7 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
              >
                <XIcon className="size-4" />
              </button>
            </div>

            <DrawerMedia asset={asset} />

            <div className="border-b border-[#1f211c]/8 px-5 py-4">
              <RenameableTitle
                key={asset.id}
                asset={asset}
                onRename={onRename}
              />
              <p className="mt-1 text-[11.5px] text-[#8a8271] tabular-nums">
                {[
                  asset.kind === "generated" ? "Generated" : "Uploaded",
                  asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
                  formatDuration(asset.durationSec),
                  formatBytes(asset.sizeBytes),
                  formatWhenFull(asset.createdAt),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>

              {/* Enrichment rides on search rows; a browse row simply has none. */}
              {asset.caption && (
                <p className="mt-2 font-serif text-[13px] leading-6 text-[#4c4a41] italic">
                  {asset.caption}
                </p>
              )}
              {(asset.tags?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {asset.tags!.slice(0, 8).map((tag) => (
                    <span
                      key={tag}
                      className="border border-[#1f211c]/10 bg-white px-1.5 py-0.5 text-[10.5px] font-semibold text-[#8a8271]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={onDownload}
                  className="flex h-9 items-center gap-2 bg-[#1f211c] px-3.5 text-[12.5px] font-semibold text-[#f7f4ee] transition-colors hover:bg-[#1f211c]/88"
                >
                  {downloading ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <DownloadSimpleIcon className="size-3.5" />
                  )}
                  Download
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  className="flex h-9 items-center gap-2 border border-[#1f211c]/14 bg-white px-3.5 text-[12.5px] font-semibold text-[#4c4a41] transition-colors hover:border-[#a33d2f]/50 hover:text-[#a33d2f]"
                >
                  <TrashSimpleIcon className="size-3.5" />
                  Remove
                </button>
              </div>
            </div>

            <div className="px-5 py-5">
              {dossier === "loading" && <DossierSkeleton />}

              {dossier === "error" && (
                <div className="text-[12.5px] leading-6 text-[#8a8271]">
                  Couldn&rsquo;t load the provenance record.{" "}
                  <button
                    type="button"
                    onClick={onRetry}
                    className="font-semibold text-[#4c4a41] underline underline-offset-2 hover:text-[#1f211c]"
                  >
                    Try again
                  </button>
                </div>
              )}

              {typeof dossier === "object" && (
                <Dossier
                  asset={asset}
                  dossier={dossier}
                  onInspect={onInspect}
                  getAuth={getAuth}
                />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The name, editable in place. Only the library's label moves — the manifest
 * keeps whatever the file was called when the run sealed it, which is the
 * whole point of a sealed record.
 */
function RenameableTitle({
  asset,
  onRename,
}: {
  asset: LibraryAsset;
  onRename: (name: string) => void;
}) {
  // Keyed by asset id at the call site, so hopping the drawer to another file
  // starts a fresh title rather than carrying a half-typed name over.
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  const commit = () => {
    setEditing(false);
    onRename(draft);
  };

  if (editing) {
    return (
      <div>
        <SheetTitle className="sr-only">{displayName(asset)}</SheetTitle>
        <input
          ref={(el) => el?.select()}
          autoFocus
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-9 w-full border border-[#1f211c]/25 bg-white px-2.5 text-[15px] font-medium outline-none focus:border-[#1f211c]/55"
        />
        <p className="mt-1 text-[10.5px] text-[#8a8271]">
          Enter to save · Esc to cancel · the sealed record keeps its own name
        </p>
      </div>
    );
  }

  return (
    <div className="group/name flex items-start gap-1.5">
      <SheetTitle className="min-w-0 font-sans text-[15px] leading-snug font-medium tracking-normal text-[#1f211c]">
        {displayName(asset)}
      </SheetTitle>
      <button
        type="button"
        aria-label="Rename"
        title="Rename"
        onClick={() => {
          setDraft(asset.filename ?? displayName(asset));
          setEditing(true);
        }}
        className="mt-px grid size-6 shrink-0 place-items-center text-[#8a8271] opacity-0 transition-[opacity,color] group-hover/name:opacity-100 hover:bg-[#1f211c]/6 hover:text-[#1f211c] focus-visible:opacity-100"
      >
        <PencilSimpleIcon className="size-3.5" />
      </button>
    </div>
  );
}

function DrawerMedia({ asset }: { asset: LibraryAsset }) {
  if (!asset.previewUrl) return null;
  switch (asset.modality) {
    case "image":
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.previewUrl}
          alt={displayName(asset)}
          className="block max-h-[320px] w-full border-b border-[#1f211c]/8 bg-[#eceadf] object-contain"
        />
      );
    case "video":
      return (
        <video
          src={asset.previewUrl}
          controls
          playsInline
          preload="metadata"
          className="block max-h-[320px] w-full border-b border-[#1f211c]/8 bg-[#1f211c]"
        />
      );
    case "audio":
      return (
        <div className="border-b border-[#1f211c]/8">
          <AudioPlate asset={asset} />
        </div>
      );
    default:
      return (
        <div className="border-b border-[#1f211c]/8">
          <TextPlate asset={asset} />
        </div>
      );
  }
}

/** One link on the custody rail. */
function CustodySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="relative pl-6">
      <span
        aria-hidden
        className="absolute top-[3px] -left-[5.5px] size-2.5 border border-[#f7f4ee] bg-[#1f211c]"
      />
      <h3 className="text-[10px] font-semibold tracking-[0.2em] text-[#8a8271] uppercase">
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </li>
  );
}

function DossierRow({
  label,
  value,
  mono,
  copy,
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** Full text handed to the clipboard — display may be truncated. */
  copy?: string;
  href?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] text-[#8a8271]">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {href ? (
          <Link
            href={href}
            className={cn(
              "truncate text-[12px] font-medium underline decoration-[#1f211c]/25 underline-offset-2 hover:decoration-[#1f211c]",
              mono && "font-mono text-[11px]",
            )}
          >
            {value}
          </Link>
        ) : (
          <span
            title={copy ?? value}
            className={cn(
              "truncate text-[12px] font-medium",
              mono && "font-mono text-[11px] tracking-tight",
            )}
          >
            {value}
          </span>
        )}
        {copy && (
          <button
            type="button"
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={() => copyText(label, copy)}
            className="grid size-6 shrink-0 place-items-center text-[#8a8271] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
          >
            <CopyIcon className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}

function Dossier({
  asset,
  dossier,
  onInspect,
  getAuth,
}: {
  asset: LibraryAsset;
  dossier: AssetProvenance;
  onInspect: (asset: LibraryAsset) => void;
  getAuth: () => Promise<{ token: string | null; userId: string | null }>;
}) {
  const lineage = dossier.lineage;
  const chain = dossier.chain;
  const manifestUri = lineage?.manifestUri ?? dossier.manifestUri;
  const mix = readMixTimeline(lineage);
  const [recordOpen, setRecordOpen] = React.useState(false);
  const params = lineage?.params
    ? Object.entries(lineage.params).filter(
        ([k, v]) => v !== null && v !== "" && !(mix && k === "edit"),
      )
    : [];

  return (
    <>
      <ol className="space-y-7 border-l border-[#1f211c]/14">
        {/* The human's part — serif, like every human voice on the canvas. */}
        {lineage?.prompt && (
          <CustodySection title="Prompt">
            <p className="font-serif text-[15px] leading-6 text-[#1f211c] italic">
              &ldquo;{lineage.prompt}&rdquo;
            </p>
          </CustodySection>
        )}

        {mix && lineage && (
          <CustodySection title="Composition">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-semibold">Timeline mix</span>
              <span className="text-[10.5px] font-semibold tracking-[0.14em] text-[#8a8271] uppercase">
                ffmpeg
              </span>
            </p>
            <div className="mt-2 divide-y divide-[#1f211c]/5 border-y border-[#1f211c]/8">
              {formatDuration(mix.timelineSec) && (
                <DossierRow
                  label="Timeline"
                  value={formatDuration(mix.timelineSec)!}
                  copy={JSON.stringify(lineage.params?.edit)}
                />
              )}
              {mix.tracks.map((track, i) => {
                const clipLabels = (track.clips ?? [])
                  .map((clip) => clip.label)
                  .filter(Boolean)
                  .join(", ");
                return (
                  <DossierRow
                    key={track.id ?? i}
                    label={track.kind ?? "track"}
                    value={describeMixTrack(track)}
                    copy={clipLabels || undefined}
                  />
                );
              })}
            </div>
          </CustodySection>
        )}

        {!mix && lineage && (lineage.model || params.length > 0) && (
          <CustodySection title="Model">
            {lineage.model && (
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13px] font-semibold">{lineage.model}</span>
                {lineage.provider && (
                  <span className="text-[10.5px] font-semibold tracking-[0.14em] text-[#8a8271] uppercase">
                    {lineage.provider}
                  </span>
                )}
              </p>
            )}
            {params.length > 0 && (
              <div className="mt-2 divide-y divide-[#1f211c]/5 border-y border-[#1f211c]/8">
                {params.map(([key, value]) => (
                  <DossierRow
                    key={key}
                    label={key}
                    value={formatParamValue(value)}
                    copy={
                      typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)
                    }
                  />
                ))}
              </div>
            )}
            {lineage.costUsd !== null && lineage.costUsd > 0 && (
              <p className="mt-2 text-[11.5px] text-[#8a8271] tabular-nums">
                ${lineage.costUsd.toFixed(4)} to generate
              </p>
            )}
          </CustodySection>
        )}

        {/* The derivation, drawn: sources at the top, this file at the bottom.
            Every hop with a file behind it is a door to that file's dossier. */}
        {chain && chain.hops.length > 1 && (
          <CustodySection title="Lineage">
            <LineagePanel
              chain={chain}
              currentId={asset.id}
              title={displayName(asset)}
              workflowId={lineage?.workflowId ?? null}
              onInspect={onInspect}
            />
          </CustodySection>
        )}

        {lineage && (
          <CustodySection title="Run">
            <div className="divide-y divide-[#1f211c]/5">
              <DossierRow
                label="Run"
                value={lineage.runId.slice(0, 8)}
                mono
                copy={lineage.runId}
              />
              {lineage.nodeId && (
                <DossierRow label="Node" value={lineage.nodeId} mono />
              )}
              {lineage.parentRunId && (
                <DossierRow
                  label="Continues"
                  value={lineage.parentRunId.slice(0, 8)}
                  mono
                  copy={lineage.parentRunId}
                />
              )}
            </div>
            {lineage.workflowId && (
              <Link
                href={`/workflow/${lineage.workflowId}`}
                className="mt-2.5 inline-flex h-8 items-center gap-1.5 border border-[#1f211c]/14 bg-white px-3 text-[12px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
              >
                <ArrowSquareOutIcon className="size-3.5" />
                Open the canvas it came from
              </Link>
            )}
          </CustodySection>
        )}

        {asset.kind === "generated" && !lineage && (
          <CustodySection title="Run">
            <p className="text-[12.5px] leading-6 text-[#8a8271]">
              The run behind this file is no longer indexed here. Its manifest
              in storage still holds the full record.
            </p>
          </CustodySection>
        )}

        {asset.kind === "upload" && (
          <CustodySection title="Origin">
            <p className="text-[12.5px] leading-6 text-[#4c4a41]">
              Uploaded by you
              {formatWhenFull(asset.createdAt)
                ? ` on ${formatWhenFull(asset.createdAt)}`
                : ""}
              .
            </p>
          </CustodySection>
        )}

        {(asset.sha256 || lineage?.manifestHash || manifestUri) && (
          <CustodySection title="Integrity">
            {lineage?.manifestVerified === true && (
              <p className="flex items-center gap-1.5 pb-2 text-[12px] font-semibold text-[#3d6b35]">
                <SealCheckIcon weight="fill" className="size-4" />
                Verified — matches the sealed record in storage
              </p>
            )}
            {lineage?.manifestVerified === false && (
              <p className="flex items-center gap-1.5 pb-2 text-[12px] font-semibold text-[#a33d2f]">
                <SealWarningIcon weight="fill" className="size-4" />
                Hash mismatch against the record in storage
              </p>
            )}
            <div className="divide-y divide-[#1f211c]/5 border-t border-[#1f211c]/8">
              {asset.sha256 && (
                <DossierRow
                  label="SHA-256"
                  value={shortHash(asset.sha256)}
                  mono
                  copy={asset.sha256}
                />
              )}
              {lineage?.manifestHash && (
                <DossierRow
                  label="Record hash"
                  value={shortHash(lineage.manifestHash)}
                  mono
                  copy={lineage.manifestHash}
                />
              )}
            </div>
            {lineage?.runId && manifestUri && (
              <>
                <button
                  type="button"
                  onClick={() => setRecordOpen(true)}
                  className="mt-2.5 inline-flex h-8 items-center gap-1.5 border border-[#1f211c]/14 bg-white px-3 text-[12px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
                >
                  <SealCheckIcon className="size-3.5" />
                  Open the sealed record
                </button>
                {recordOpen && (
                  <RecordDialog
                    runId={lineage.runId}
                    onOpenChange={setRecordOpen}
                    getAuth={getAuth}
                  />
                )}
              </>
            )}
          </CustodySection>
        )}
      </ol>

      <p className="mt-7 border-t border-[#1f211c]/8 pt-4 font-serif text-[13px] leading-6 text-[#8a8271] italic">
        The canonical record lives beside the file in storage — this page could
        vanish and the trail would still hold.
      </p>
    </>
  );
}

/**
 * Lineage in the drawer: a miniature of the graph that made the file, on its
 * own plate of canvas dots, with the room to read it one click away.
 */
function LineagePanel({
  chain,
  currentId,
  title,
  workflowId,
  onInspect,
}: {
  chain: LineageChain;
  currentId: string;
  /** The asset's display name, for the dialog's own heading. */
  title: string;
  workflowId: string | null;
  onInspect: (asset: LibraryAsset) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const sources = chain.hops.filter((hop) =>
    hop.kind.startsWith("input."),
  ).length;
  const steps = chain.hops.length - sources;

  return (
    <div>
      <div className="relative border border-[#1f211c]/10 bg-white">
        {/* The same dots as the canvas this graph ran on, tightened — it is a
            miniature of that room, not a diagram of it. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage: `radial-gradient(${DOT_COLOR} 1px, transparent 1px)`,
            backgroundSize: "13px 13px",
          }}
        />
        <button
          type="button"
          aria-label="Expand the lineage graph"
          title="Expand"
          onClick={() => setOpen(true)}
          className="absolute top-1.5 right-1.5 z-10 grid size-7 place-items-center border border-[#1f211c]/10 bg-white/85 text-[#4c4a41] backdrop-blur-sm transition-colors hover:border-[#1f211c]/30 hover:text-[#1f211c]"
        >
          <ArrowsOutSimpleIcon className="size-3.5" />
        </button>
        <div className="relative p-3">
          <LineageGraph
            chain={chain}
            currentId={currentId}
            scale="mini"
            onInspect={onInspect}
          />
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-[11px] text-[#8a8271] tabular-nums">
          {steps} {steps === 1 ? "step" : "steps"} · {sources}{" "}
          {sources === 1 ? "source" : "sources"}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-7 items-center gap-1.5 border border-[#1f211c]/14 bg-white px-2.5 text-[11.5px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
        >
          <ArrowsOutSimpleIcon className="size-3.5" />
          Expand
        </button>
      </div>

      {open && (
        <LineageDialog
          chain={chain}
          currentId={currentId}
          title={title}
          workflowId={workflowId}
          onOpenChange={setOpen}
          onInspect={(asset) => {
            setOpen(false);
            onInspect(asset);
          }}
        />
      )}
    </div>
  );
}

/** The same graph, given the room to be read. */
function LineageDialog({
  chain,
  currentId,
  title,
  workflowId,
  onOpenChange,
  onInspect,
}: {
  chain: LineageChain;
  currentId: string;
  title: string;
  workflowId: string | null;
  onOpenChange: (open: boolean) => void;
  onInspect: (asset: LibraryAsset) => void;
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-none border border-[#1f211c]/14 bg-[#f7f4ee] p-0 text-[#1f211c] sm:max-w-[min(960px,94vw)]">
        <div className="shrink-0 border-b border-[#1f211c]/8 px-5 py-4 pr-12">
          <DialogTitle className="font-sans text-[15px] font-medium tracking-normal">
            How &ldquo;{title}&rdquo; was made
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] leading-5 text-[#8a8271]">
            Drawn from the graph snapshot the run actually executed — sources at
            the top, this file at the bottom. Any piece with a file behind it
            opens its own trail.
          </DialogDescription>
        </div>

        <div
          className="relative min-h-0 flex-1 overflow-auto px-6 py-8"
          style={{
            backgroundImage: `radial-gradient(${DOT_COLOR} 1px, transparent 1px)`,
            backgroundSize: `${DOT_GAP}px ${DOT_GAP}px`,
          }}
        >
          <LineageGraph
            chain={chain}
            currentId={currentId}
            scale="full"
            onInspect={onInspect}
          />
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[#1f211c]/8 px-5 py-3">
          <p className="flex items-center gap-1.5 text-[11px] text-[#8a8271]">
            <span aria-hidden className="inline-block h-px w-5 bg-[#b08a2e]" />
            leads to this file
          </p>
          {workflowId && (
            <Link
              href={`/workflow/${workflowId}`}
              className="flex h-8 items-center gap-1.5 border border-[#1f211c]/14 bg-white px-3 text-[12px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
            >
              <ArrowSquareOutIcon className="size-3.5" />
              Open that workflow
            </Link>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type GraphScale = "mini" | "full";

/**
 * The derivation as the graph it was: hops in rows by distance from this file,
 * sources at the top, joined by the run snapshot's own edges.
 *
 * The threads are drawn from measured tiles rather than assumed from the
 * layout — rows are laid out by flexbox and a hand-placed line would start
 * lying the first time a level holds three nodes instead of one.
 */
function LineageGraph({
  chain,
  currentId,
  scale,
  onInspect,
}: {
  chain: LineageChain;
  currentId: string;
  scale: GraphScale;
  onInspect: (asset: LibraryAsset) => void;
}) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const tiles = React.useRef(new Map<string, HTMLElement>());
  const [threads, setThreads] = React.useState<
    { key: string; d: string; lit: boolean }[]
  >([]);

  const levels = React.useMemo(() => {
    const byDepth = new Map<number, LineageHop[]>();
    for (const hop of chain.hops) {
      byDepth.set(hop.depth, [...(byDepth.get(hop.depth) ?? []), hop]);
    }
    return [...byDepth.entries()].sort((a, b) => b[0] - a[0]).map(([, hops]) => hops);
  }, [chain]);

  /** The node that produced the file in the drawer — its inbound threads run gold. */
  const outputNode = React.useMemo(
    () => chain.hops.find((hop) => hop.depth === 0)?.nodeId ?? null,
    [chain],
  );

  const measure = React.useCallback(() => {
    const root = wrap.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const drawn: { key: string; d: string; lit: boolean }[] = [];
    for (const edge of chain.edges) {
      const from = tiles.current.get(edge.source);
      const to = tiles.current.get(edge.target);
      if (!from || !to) continue;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const x1 = a.left - base.left + a.width / 2;
      const y1 = a.bottom - base.top;
      const x2 = b.left - base.left + b.width / 2;
      const y2 = b.top - base.top;
      // Sideways or upward edges would draw over the tiles; the rows already
      // say what order things happened in.
      if (y2 <= y1) continue;
      const bend = Math.max(10, Math.min(30, (y2 - y1) * 0.55));
      drawn.push({
        key: `${edge.source}->${edge.target}`,
        d: `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`,
        lit: edge.target === outputNode,
      });
    }
    setThreads(drawn);
  }, [chain, outputNode]);

  React.useLayoutEffect(() => {
    measure();
    const root = wrap.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure, scale]);

  return (
    // Rows never wrap: a wrapped level is no longer a level. Wide graphs scroll
    // sideways in the drawer and open properly in the dialog.
    <div className="overflow-x-auto">
      <div
        ref={wrap}
        className={cn(
          "relative mx-auto flex min-w-max flex-col items-center",
          scale === "mini" ? "gap-6" : "gap-11",
        )}
      >
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
              stroke={
                thread.lit ? "rgba(176,138,46,0.8)" : "rgba(31,33,28,0.24)"
              }
            />
          ))}
        </svg>

        {levels.map((hops, i) => (
          <div
            key={hops[0]?.depth ?? i}
            className={cn(
              "relative flex items-stretch justify-center",
              scale === "mini" ? "gap-3" : "gap-6",
            )}
          >
            {hops.map((hop) => (
              <HopNode
                key={hop.nodeId}
                hop={hop}
                currentId={currentId}
                scale={scale}
                onInspect={onInspect}
                register={(el) => {
                  if (el) tiles.current.set(hop.nodeId, el);
                  else tiles.current.delete(hop.nodeId);
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function hopLabel(hop: LineageHop): { name: string; detail: string } {
  switch (hop.kind) {
    case "input.text":
      return { name: hop.title ?? "Prompt", detail: "written on the canvas" };
    case "input.upload":
      return {
        name: hop.assets[0]?.filename ?? hop.title ?? "Upload",
        detail: "uploaded file",
      };
    case "transform.composite":
      return { name: "Timeline mix", detail: "ffmpeg" };
    default:
      return {
        name: hop.model ?? hop.title ?? hop.nodeId,
        detail: hop.provider ?? "generated",
      };
  }
}

function HopThumb({ hop, scale }: { hop: LineageHop; scale: GraphScale }) {
  const asset = hop.assets[0];
  const box = cn(
    "shrink-0 border border-[#1f211c]/10",
    scale === "mini" ? "size-10" : "size-12",
  );

  if (asset?.previewUrl && asset.modality === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={asset.previewUrl}
        alt=""
        className={cn(box, "bg-[#eceadf] object-cover")}
      />
    );
  }
  if (asset?.previewUrl && asset.modality === "video") {
    return (
      <video
        src={asset.previewUrl}
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
      : asset?.modality === "audio"
        ? WaveformIcon
        : asset?.modality === "text"
          ? FileTextIcon
          : hop.kind === "input.upload"
            ? UploadSimpleIcon
            : SparkleIcon;
  return (
    <span
      className={cn(box, "grid place-items-center bg-[#eceadf] text-[#8a8271]")}
    >
      <Icon className={scale === "mini" ? "size-4" : "size-5"} />
    </span>
  );
}

/** Where a hop sits in the story, in three words or fewer. */
function hopStanding(hop: LineageHop): string {
  if (hop.depth === 0) return "this file";
  return hop.kind.startsWith("input.") ? "source" : "step";
}

/** One node of the graph. The file it produced, if we still hold it, is a door. */
function HopNode({
  hop,
  currentId,
  scale,
  register,
  onInspect,
}: {
  hop: LineageHop;
  currentId: string;
  scale: GraphScale;
  /** Handed to the graph so it can measure this tile and thread the edges. */
  register: (el: HTMLElement | null) => void;
  onInspect: (asset: LibraryAsset) => void;
}) {
  const asset = hop.assets[0] ?? null;
  const target = asset && asset.id !== currentId ? asset : null;
  const { name, detail } = hopLabel(hop);
  const snippet = hop.kind === "input.text" ? (hop.text ?? "").trim() : "";
  const current = hop.depth === 0;

  const frame = cn(
    "relative border bg-white transition-[border-color,box-shadow]",
    current
      ? "border-[#b08a2e]/55 shadow-[0_0_0_3px_rgba(176,138,46,0.11)]"
      : "border-[#1f211c]/12",
    target
      ? "cursor-pointer hover:border-[#1f211c]/45 hover:shadow-[0_10px_26px_-14px_rgba(31,33,28,0.4)]"
      : "cursor-default",
  );

  if (scale === "mini") {
    return (
      <button
        ref={register}
        type="button"
        disabled={!target}
        onClick={() => target && onInspect(target)}
        title={
          target
            ? `${name} — follow this file's own trail`
            : `${name} · ${snippet || detail}`
        }
        className={cn(frame, "flex w-[96px] flex-col items-center gap-1.5 p-2")}
      >
        <HopThumb hop={hop} scale="mini" />
        <span className="line-clamp-2 text-center text-[10px] leading-tight font-semibold text-[#1f211c]">
          {name}
        </span>
        <span
          className={cn(
            "text-[8.5px] font-semibold tracking-[0.14em] uppercase",
            current ? "text-[#b08a2e]" : "text-[#a9a294]",
          )}
        >
          {hopStanding(hop)}
        </span>
      </button>
    );
  }

  return (
    <button
      ref={register}
      type="button"
      disabled={!target}
      onClick={() => target && onInspect(target)}
      title={target ? "Follow this file's own trail" : undefined}
      className={cn(frame, "flex w-[212px] flex-col gap-2.5 p-3 text-left")}
    >
      <span className="flex items-center gap-2.5">
        <HopThumb hop={hop} scale="full" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] leading-tight font-semibold text-[#1f211c]">
            {name}
          </span>
          <span className="mt-1 block truncate text-[10px] font-semibold tracking-[0.14em] text-[#8a8271] uppercase">
            {detail}
          </span>
        </span>
      </span>

      {snippet && (
        <span className="line-clamp-3 font-serif text-[11.5px] leading-5 text-[#8a8271] italic">
          &ldquo;{snippet}&rdquo;
        </span>
      )}

      <span className="flex items-baseline justify-between gap-2 border-t border-[#1f211c]/6 pt-2 text-[10px] font-semibold tracking-[0.14em] uppercase">
        <span className={current ? "text-[#b08a2e]" : "text-[#a9a294]"}>
          {hopStanding(hop)}
        </span>
        {hop.assets.length > 1 && (
          <span className="text-[#8a8271] tabular-nums">
            +{hop.assets.length - 1} more
          </span>
        )}
      </span>
    </button>
  );
}

type ManifestStep = {
  provider?: string;
  model?: string;
  step_type?: string;
  prompt?: string | null;
  cost_usd?: number | null;
  metadata?: { node_id?: string };
};

/**
 * The sealed record itself: re-read from B2 on open and re-hashed, so the
 * badge in here is a live claim about the bucket — not an echo of our rows.
 */
function RecordDialog({
  runId,
  onOpenChange,
  getAuth,
}: {
  runId: string;
  onOpenChange: (open: boolean) => void;
  getAuth: () => Promise<{ token: string | null; userId: string | null }>;
}) {
  // Mounted only while open, so every opening starts a fresh read — the
  // dialog's claim is about the bucket *now*, and a cache would unmake it.
  const [record, setRecord] = React.useState<
    RunManifestRecord | "loading" | "error"
  >("loading");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fetched = await fetchRunManifest(runId, await getAuth());
      if (!cancelled) setRecord(fetched ?? "error");
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, getAuth]);

  const steps: ManifestStep[] =
    typeof record === "object"
      ? ((record.manifest as { run?: { steps?: ManifestStep[] } }).run?.steps ?? [])
      : [];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto rounded-none border border-[#1f211c]/14 bg-[#f7f4ee] p-0 text-[#1f211c] sm:max-w-[520px]">
        <div className="border-b border-[#1f211c]/8 px-5 py-4">
          <DialogTitle className="font-sans text-[15px] font-medium tracking-normal">
            The sealed record
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] leading-5 text-[#8a8271]">
            Re-read from storage just now — not echoed from the database — and
            its hash recomputed against the bytes that came back.
          </DialogDescription>
        </div>

        <div className="px-5 py-4">
          {record === "loading" && (
            <div className="flex items-center gap-2 py-6 text-[12.5px] text-[#8a8271]">
              <Spinner className="size-4" /> Reading the record out of storage…
            </div>
          )}

          {record === "error" && (
            <p className="py-4 text-[12.5px] leading-6 text-[#8a8271]">
              The record isn&rsquo;t reachable right now. Manifests are written
              when runs execute against Backblaze B2.
            </p>
          )}

          {typeof record === "object" && (
            <>
              {record.verifiedNow === true && (
                <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#3d6b35]">
                  <SealCheckIcon weight="fill" className="size-4" />
                  Intact — the record in the bucket still matches its hash
                </p>
              )}
              {record.verifiedNow === false && (
                <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#a33d2f]">
                  <SealWarningIcon weight="fill" className="size-4" />
                  The record no longer matches its recorded hash
                </p>
              )}
              {record.verifiedNow === null && (
                <p className="text-[12.5px] font-semibold text-[#8a8271]">
                  The record was read back, but could not be re-verified.
                </p>
              )}

              <div className="mt-3 divide-y divide-[#1f211c]/5 border-y border-[#1f211c]/8">
                {record.canonicalHash && (
                  <DossierRow
                    label="Canonical hash"
                    value={shortHash(record.canonicalHash)}
                    mono
                    copy={record.canonicalHash}
                  />
                )}
                {record.manifestUri && (
                  <DossierRow
                    label="Location"
                    value={record.manifestUri}
                    mono
                    copy={record.manifestUri}
                  />
                )}
              </div>

              {steps.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-[10px] font-semibold tracking-[0.2em] text-[#8a8271] uppercase">
                    Steps on record
                  </h3>
                  <ol className="mt-2 space-y-2">
                    {steps.map((step, i) => (
                      <li
                        key={step.metadata?.node_id ?? i}
                        className="border border-[#1f211c]/10 bg-white px-3 py-2"
                      >
                        <p className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[12px] font-semibold">
                            {step.model ?? step.step_type ?? "step"}
                          </span>
                          {step.provider && (
                            <span className="text-[10px] font-semibold tracking-[0.14em] text-[#8a8271] uppercase">
                              {step.provider.replace(/_/g, "") || step.provider}
                            </span>
                          )}
                        </p>
                        {step.prompt && (
                          <p className="mt-0.5 line-clamp-2 font-serif text-[11.5px] leading-4 text-[#8a8271] italic">
                            &ldquo;{step.prompt}&rdquo;
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <details className="mt-4 group">
                <summary className="cursor-pointer text-[11px] font-semibold tracking-[0.14em] text-[#8a8271] uppercase transition-colors hover:text-[#1f211c]">
                  Raw record
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto border border-[#1f211c]/10 bg-white p-3 font-mono text-[10.5px] leading-4 text-[#4c4a41]">
                  {JSON.stringify(record.manifest, null, 2)}
                </pre>
              </details>

              <p className="mt-4 border-t border-[#1f211c]/8 pt-3 font-serif text-[12px] leading-5 text-[#8a8271] italic">
                This document lives beside the media in Backblaze B2. Delete
                every row in our database and it would still tell the whole
                story.
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DossierSkeleton() {
  return (
    <div className="animate-pulse space-y-7 border-l border-[#1f211c]/10">
      {[3, 2, 3].map((rows, section) => (
        <div key={section} className="relative pl-6">
          <span
            aria-hidden
            className="absolute top-[3px] -left-[5.5px] size-2.5 bg-[#1f211c]/15"
          />
          <div className="h-2 w-16 bg-[#1f211c]/8" />
          <div className="mt-3 space-y-2">
            {Array.from({ length: rows }, (_, i) => (
              <div
                key={i}
                className="h-2.5 bg-[#1f211c]/5"
                style={{ width: `${88 - i * 22}%` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- shelf states ---------------------------------------------------------

const SKELETON_HEIGHTS = [180, 240, 150, 300, 210, 170, 260, 190];

function LoadingShelf() {
  return (
    <div className="columns-1 gap-5 sm:columns-2 lg:columns-3 xl:columns-4">
      {SKELETON_HEIGHTS.map((height, i) => (
        <div
          key={i}
          className="mb-5 break-inside-avoid animate-pulse border border-[#1f211c]/6 bg-white"
          style={{ animationDelay: `${i * 100}ms` }}
        >
          <div className="bg-[#eceadf]" style={{ height }} />
          <div className="space-y-1.5 px-3 py-3">
            <div className="h-2.5 w-2/3 bg-[#1f211c]/8" />
            <div className="h-2 w-1/3 bg-[#1f211c]/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyRoom({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center py-24 text-center animate-[studio-rise_0.6s_cubic-bezier(0.32,0.72,0,1)_both]">
      {icon && <div className="mb-3">{icon}</div>}
      <h2 className="text-xl font-medium tracking-[-0.01em]">
        <span className="font-serif italic">{title}</span>
      </h2>
      <p className="mt-2 max-w-sm text-[13px] leading-6 text-[#8a8271]">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
