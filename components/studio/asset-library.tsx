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
  CaretDownIcon,
  CheckIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  ImageSquareIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  SparkleIcon,
  TrashSimpleIcon,
  UploadSimpleIcon,
  VideoCameraIcon,
  WarningCircleIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DOT_COLOR, DOT_GAP } from "@/lib/studio/node-ui";
import { downloadResult } from "@/lib/studio/runs-client";
import {
  deleteLibraryAsset,
  fetchLibrary,
  type LibraryAsset,
} from "@/lib/studio/library-client";
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

  // --- render -------------------------------------------------------------

  return (
    <TooltipProvider>
      <div className="relative min-h-dvh bg-[#f7f4ee] text-[#1f211c]">
        {/* Same dots as the canvas — the library is a room in the same house. */}
        <div
          aria-hidden
          className="fixed inset-0"
          style={{
            backgroundImage: `radial-gradient(${DOT_COLOR} 1px, transparent 1px)`,
            backgroundSize: `${DOT_GAP}px ${DOT_GAP}px`,
          }}
        />
        {/* Warm bloom behind the masthead. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0"
          style={{
            background:
              "radial-gradient(640px 420px at 30% 8%, oklch(0.852 0.199 91.936 / 0.14), transparent 70%)",
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
            <ArrowLeftIcon className="size-4" />
            Workflows
          </Link>
          <div className="grid size-10 place-items-center rounded-full border border-[#1f211c]/8 bg-white/88 shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md">
            <UserButton appearance={{ elements: { userButtonAvatarBox: "size-7" } }} />
          </div>
        </div>

        <div className="relative z-10 mx-auto max-w-[1440px] px-6 pt-28 pb-24 sm:px-10">
          {/* Masthead */}
          <header className="animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_both]">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-semibold tracking-[0.22em] text-[#8a8271] uppercase">
                Library
              </span>
              <span aria-hidden className="h-px w-24 bg-gradient-to-r from-[#1f211c]/18 to-transparent" />
            </div>
            <h1 className="mt-3 text-[clamp(2rem,4vw,3rem)] leading-[1.05] font-medium tracking-[-0.02em]">
              Everything you&rsquo;ve <span className="font-serif italic">made</span>
            </h1>
            <p className="mt-3 max-w-xl text-[13.5px] leading-6 text-[#8a8271]">
              Every image, video, and sound across your workflows — each with its
              provenance intact.
              {state === "ready" && living.length > 0 && (
                <span className="text-[#4c4a41]">
                  {" "}
                  {living.length} {living.length === 1 ? "piece" : "pieces"}
                  {formatBytes(totalBytes) ? ` · ${formatBytes(totalBytes)}` : ""}.
                </span>
              )}
            </p>
          </header>

          {/* Control rail — sticky so a long shelf stays sortable. */}
          <div
            className="sticky top-0 z-30 -mx-6 mt-8 border-y border-[#1f211c]/8 bg-[#f7f4ee]/86 px-6 py-3 backdrop-blur-md sm:-mx-10 sm:px-10 animate-[studio-rise_0.7s_cubic-bezier(0.32,0.72,0,1)_80ms_both]"
            style={{ transitionTimingFunction: EASE }}
          >
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              {/* Search */}
              <label className="flex h-9 w-full max-w-[280px] items-center gap-2 border border-[#1f211c]/14 bg-white px-3 transition-colors focus-within:border-[#1f211c]/40">
                <MagnifyingGlassIcon className="size-4 shrink-0 text-[#8a8271]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search your library…"
                  className="w-full bg-transparent text-[13px] font-medium outline-none placeholder:text-[#8a8271]/70"
                />
              </label>

              {/* Modality tabs */}
              <div className="flex items-center">
                {MODALITY_TABS.map((tab) => {
                  const active = modality === tab.id;
                  const count = counts[tab.id === "all" ? "all" : tab.id] ?? 0;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setModality(tab.id)}
                      className={cn(
                        "flex h-9 items-center gap-1.5 px-3 text-[13px] font-semibold transition-colors duration-150",
                        active
                          ? "bg-[#1f211c] text-[#f7f4ee]"
                          : "text-[#4c4a41] hover:bg-[#1f211c]/6 hover:text-[#1f211c]",
                      )}
                    >
                      {tab.label}
                      {state === "ready" && (
                        <span
                          className={cn(
                            "text-[11px] tabular-nums",
                            active ? "text-[#f7f4ee]/60" : "text-[#8a8271]",
                          )}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="ml-auto flex items-center gap-2">
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

          {/* Shelf */}
          <div className="mt-8">
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
                    <SparkleIcon className="size-4" />
                    Go make something
                  </Link>
                }
              />
            )}

            {state === "ready" && living.length > 0 && visible.length === 0 && (
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

            {state === "ready" && visible.length > 0 && (
              <>
                {filtersActive && (
                  <p className="mb-4 text-[12px] text-[#8a8271] tabular-nums">
                    {visible.length} of {living.length}
                  </p>
                )}
                <div className="columns-1 gap-5 sm:columns-2 lg:columns-3 xl:columns-4">
                  {visible.map((asset, index) => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      index={index}
                      downloading={downloadingId === asset.id}
                      onDownload={() => void download(asset)}
                      onDelete={() => setPendingDelete(asset)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

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
          "flex h-9 items-center gap-1.5 border px-3 text-[13px] font-semibold transition-colors",
          active
            ? "border-[#1f211c]/32 bg-white text-[#1f211c]"
            : "border-[#1f211c]/14 bg-white text-[#4c4a41] hover:border-[#1f211c]/32 hover:text-[#1f211c]",
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

// --- cards ----------------------------------------------------------------

function AssetCard({
  asset,
  index,
  downloading,
  onDownload,
  onDelete,
}: {
  asset: LibraryAsset;
  index: number;
  downloading: boolean;
  onDownload: () => void;
  onDelete: () => void;
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
      className="group relative mb-5 break-inside-avoid border border-[#1f211c]/8 bg-white shadow-[0_1px_2px_rgba(31,33,28,0.05)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[#1f211c]/24 hover:shadow-[0_18px_44px_-16px_rgba(31,33,28,0.28)] animate-[studio-rise_0.6s_cubic-bezier(0.32,0.72,0,1)_both]"
      style={{ animationDelay: `${Math.min(index * 35, 420)}ms` }}
    >
      <CardMedia asset={asset} />

      {/* Actions surface on hover (and on keyboard focus). */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          aria-label="Download"
          onClick={onDownload}
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
          onClick={onDelete}
          className="grid size-8 place-items-center bg-[#1f211c]/85 text-[#f7f4ee] backdrop-blur-sm transition-colors hover:bg-[#a33d2f]"
        >
          <TrashSimpleIcon className="size-4" />
        </button>
      </div>

      <footer className="flex items-center gap-2.5 border-t border-[#1f211c]/8 px-3 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center bg-[#1f211c]/5 text-[#4c4a41]">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] leading-tight font-medium">{displayName(asset)}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] leading-tight text-[#8a8271] tabular-nums">
            {asset.kind === "generated" ? (
              <SparkleIcon className="size-3 shrink-0" />
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

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
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
