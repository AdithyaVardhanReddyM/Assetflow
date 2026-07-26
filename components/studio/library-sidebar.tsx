"use client";

/**
 * The library, docked beside a canvas.
 *
 * Shows what this workflow did *not* make — the filter is the point, since the
 * canvas already holds its own output. Two ways out of the panel:
 *
 * - **Drag** an asset onto the canvas: it lands as an upload node pointing at
 *   the row that is already in B2. No bytes move.
 * - **Reconstruct**: rebuild the graph that produced it, chased back through
 *   every take edit and every run boundary, and drop that onto the canvas
 *   instead. Only generated media has one — an upload is where history starts.
 *
 * Search and filtering run over the fetched window in memory, matching the full
 * library page: this is one tenant's media, not an unbounded feed.
 */

import * as React from "react";
import Link from "next/link";
import {
  ArrowSquareOutIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import type { AssetPreview, Modality } from "@/lib/studio/graph";
import { ASSET_DRAG_TYPE } from "@/lib/studio/node-ui";
import type { LibraryAsset, LibrarySearch } from "@/lib/studio/library-client";
import { LinkPendingIcon } from "./link-pending-icon";

const MODALITIES = ["all", "image", "video", "audio", "text"] as const;
type ModalityFilter = (typeof MODALITIES)[number];

export type LibrarySidebarProps = {
  open: boolean;
  onClose: () => void;
  assets: LibraryAsset[] | null;
  /** Null assets plus this false means the fetch failed rather than is pending. */
  loading: boolean;
  onRetry: () => void;
  /** Rebuild the chain behind this asset onto the canvas. */
  onReconstruct: (asset: LibraryAsset) => void;
  /** Which asset is mid-reconstruction, so its button can say so. */
  reconstructing: string | null;
  /**
   * Hybrid search over the enrichment index, already scoped by the shell to
   * exclude this workflow's own output. Null falls the panel back to its
   * in-memory filename filter — same box, just less clever about it.
   */
  onSearch: (query: string, modality: string) => Promise<LibrarySearch | null>;
};

/** What a drag carries: enough to render the node without a round trip. */
function dragPayload(asset: LibraryAsset): AssetPreview {
  return {
    id: asset.id,
    // Presigned and short-lived. The node re-signs through `refreshMedia` when
    // it expires, so handing over a stale one is recoverable.
    url: asset.previewUrl ?? "",
    mediaType: asset.mediaType,
    modality: (["image", "video", "audio", "text"].includes(asset.modality)
      ? asset.modality
      : "image") as Modality,
    filename: asset.filename,
    width: asset.width,
    height: asset.height,
  };
}

export function LibrarySidebar({
  open,
  onClose,
  assets,
  loading,
  onRetry,
  onReconstruct,
  reconstructing,
  onSearch,
}: LibrarySidebarProps) {
  const [query, setQuery] = React.useState("");
  const [modality, setModality] = React.useState<ModalityFilter>("all");

  /** Server results for the current query; null means "use the local filter". */
  const [found, setFound] = React.useState<LibrarySearch | null>(null);
  const [searching, setSearching] = React.useState(false);
  /** Stale-response guard — onSearch has no abort, so answers are sequenced. */
  const searchSeq = React.useRef(0);

  React.useEffect(() => {
    const q = query.trim();
    const seq = ++searchSeq.current;
    // No reset on empty/closed: `searchRows` and the spinner gate on the
    // query, so whatever state lingers here is never rendered.
    if (!q || !open) return;
    const timer = setTimeout(async () => {
      setSearching(true);
      const results = await onSearch(q, modality);
      if (searchSeq.current !== seq) return;
      setFound(results);
      setSearching(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, modality, open, onSearch]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (assets ?? []).filter((a) => {
      if (modality !== "all" && a.modality !== modality) return false;
      if (!needle) return true;
      return (
        (a.filename ?? "").toLowerCase().includes(needle) ||
        a.modality.includes(needle) ||
        a.mediaType.includes(needle)
      );
    });
  }, [assets, query, modality]);

  /**
   * One list for a 380px panel: best matches first, a thin divider, then the
   * keyword hits. Deduped against the shelf’s own rows only via the server —
   * the two sections never overlap by construction.
   */
  const searchRows = React.useMemo(() => {
    if (!found || !query.trim()) return null;
    return { semantic: found.semantic, keyword: found.keyword };
  }, [found, query]);

  // Escape closes the panel, but only when it is not being typed into — the
  // canvas binds the same key to leaving the workflow entirely.
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  return (
    <aside
      aria-label="Asset library"
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "fixed top-0 right-0 z-50 flex h-full w-[380px] max-w-[92vw] flex-col border-l border-[#1f211c]/10 bg-[#f7f4ee] shadow-[-24px_0_60px_-30px_rgba(31,33,28,0.4)]",
        "transition-transform duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-[#1f211c]/8 px-5 pt-5 pb-4">
        <div>
          <span className="text-[10px] font-semibold tracking-[0.22em] text-[#8a8271] uppercase">
            Library
          </span>
          <h2 className="mt-1.5 text-[17px] leading-tight font-medium tracking-[-0.01em]">
            From <span className="font-serif italic">elsewhere</span>
          </h2>
          <p className="mt-1 text-[12px] leading-5 text-[#8a8271]">
            Media this workflow didn&rsquo;t make. Drag one in, or rebuild the
            graph behind it.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close library"
          className="grid size-7 shrink-0 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c]"
        >
          <XIcon className="size-4" />
        </button>
      </header>

      <div className="border-b border-[#1f211c]/8 px-5 py-3">
        <label className="flex h-8 items-center gap-2 border border-[#1f211c]/14 bg-white px-2.5 transition-colors focus-within:border-[#1f211c]/40">
          {searching && query.trim() ? (
            <Spinner className="size-3.5 shrink-0 text-[#8a8271]" />
          ) : (
            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-[#8a8271]" />
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full bg-transparent text-[12.5px] font-medium outline-none placeholder:text-[#8a8271]/70"
          />
        </label>
        <div className="mt-2.5 flex items-center gap-0.5">
          {MODALITIES.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setModality(id)}
              className={cn(
                "h-7 px-2 text-[11.5px] font-semibold capitalize transition-colors duration-150",
                modality === id
                  ? "bg-[#1f211c] text-[#f7f4ee]"
                  : "text-[#4c4a41] hover:bg-[#1f211c]/6 hover:text-[#1f211c]",
              )}
            >
              {id}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && (
          <div className="flex items-center gap-2 py-8 text-[12.5px] text-[#8a8271]">
            <Spinner className="size-4" />
            Reading the shelf…
          </div>
        )}

        {!loading && assets === null && (
          <div className="py-8 text-center">
            <WarningCircleIcon className="mx-auto size-5 text-[#c1803f]" />
            <p className="mt-2 text-[12.5px] text-[#4c4a41]">
              The library couldn&rsquo;t be reached.
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 h-8 border border-[#1f211c]/14 bg-white px-3 text-[12.5px] font-semibold text-[#4c4a41] transition-colors hover:border-[#1f211c]/32 hover:text-[#1f211c]"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && assets !== null && searchRows && (
          <>
            {searchRows.semantic.length === 0 && searchRows.keyword.length === 0 && (
              <p className="py-8 text-center text-[12.5px] leading-6 text-[#8a8271]">
                Nothing answers to &ldquo;{query.trim()}&rdquo;.
              </p>
            )}
            <div className="flex flex-col gap-3">
              {searchRows.semantic.length > 0 && (
                <SectionRule label="Best matches" />
              )}
              {searchRows.semantic.map((asset) => (
                <LibraryRow
                  key={asset.id}
                  asset={asset}
                  busy={reconstructing === asset.id}
                  onReconstruct={() => onReconstruct(asset)}
                />
              ))}
              {searchRows.keyword.length > 0 && (
                <SectionRule label="Also mentions" />
              )}
              {searchRows.keyword.map((asset) => (
                <LibraryRow
                  key={asset.id}
                  asset={asset}
                  busy={reconstructing === asset.id}
                  onReconstruct={() => onReconstruct(asset)}
                />
              ))}
            </div>
          </>
        )}

        {!loading && assets !== null && !searchRows && visible.length === 0 && (
          <p className="py-8 text-center text-[12.5px] leading-6 text-[#8a8271]">
            {assets.length === 0
              ? "Nothing here yet. Media from your other workflows will show up in this panel."
              : "Nothing matches."}
          </p>
        )}

        {!searchRows && (
          <div className="flex flex-col gap-3">
            {visible.map((asset) => (
              <LibraryRow
                key={asset.id}
                asset={asset}
                busy={reconstructing === asset.id}
                onReconstruct={() => onReconstruct(asset)}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-[#1f211c]/8 px-5 py-3">
        <Link
          href="/assets"
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#4c4a41] transition-colors hover:text-[#1f211c]"
        >
          <LinkPendingIcon icon={<ArrowSquareOutIcon className="size-3.5" />} />
          Open the full library
        </Link>
      </footer>
    </aside>
  );
}

/** The thin divider naming a search band inside the panel's single column. */
function SectionRule({ label }: { label: string }) {
  return (
    <div className="mt-1 flex items-center gap-2 first:mt-0">
      <span className="text-[10px] font-semibold tracking-[0.18em] text-[#8a8271] uppercase">
        {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-[#1f211c]/14 to-transparent" />
    </div>
  );
}

function LibraryRow({
  asset,
  busy,
  onReconstruct,
}: {
  asset: LibraryAsset;
  busy: boolean;
  onReconstruct: () => void;
}) {
  // Only generated media has a graph behind it. An upload is where a chain
  // begins, so offering to rebuild one would promise something that cannot
  // exist.
  const rebuildable = asset.kind === "generated" && Boolean(asset.runId);

  return (
    <div className="border border-[#1f211c]/10 bg-white transition-colors hover:border-[#1f211c]/24">
      <div
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(
            ASSET_DRAG_TYPE,
            JSON.stringify(dragPayload(asset)),
          );
          event.dataTransfer.effectAllowed = "copy";
        }}
        className="cursor-grab active:cursor-grabbing"
        title="Drag onto the canvas"
      >
        <Thumb asset={asset} />
        <div className="px-3 py-2">
          <p className="truncate text-[12.5px] font-semibold text-[#1f211c]">
            {asset.filename ?? `${asset.modality} asset`}
          </p>
          <p className="mt-0.5 text-[11px] text-[#8a8271]">
            {asset.kind === "generated" ? "Generated" : "Uploaded"}
            {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
          </p>
        </div>
      </div>

      {rebuildable && (
        <button
          type="button"
          onClick={onReconstruct}
          disabled={busy}
          className="flex w-full items-center gap-2 border-t border-[#1f211c]/10 px-3 py-2 text-[12px] font-semibold text-[#4c4a41] transition-colors hover:bg-[#1f211c]/5 hover:text-[#1f211c] disabled:pointer-events-none disabled:opacity-60"
        >
          {busy ? (
            <Spinner className="size-3.5" />
          ) : (
            <GitBranchIcon className="size-3.5" />
          )}
          {busy ? "Rebuilding…" : "Reconstruct"}
        </button>
      )}
    </div>
  );
}

function Thumb({ asset }: { asset: LibraryAsset }) {
  const ratio =
    asset.width && asset.height
      ? { aspectRatio: `${asset.width} / ${asset.height}` }
      : { aspectRatio: "16 / 9" };

  if (!asset.previewUrl) {
    return (
      <div
        style={ratio}
        className="grid w-full place-items-center bg-[#1f211c]/5 text-[11px] text-[#8a8271]"
      >
        No preview
      </div>
    );
  }
  if (asset.modality === "image") {
    return (
      // Plain <img>: the src is a short-lived presigned B2 URL, which the
      // next/image optimizer would both cache and choke on.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={asset.previewUrl}
        alt={asset.filename ?? ""}
        draggable={false}
        style={ratio}
        className="block w-full bg-[#1f211c]/5 object-cover"
      />
    );
  }
  if (asset.modality === "video") {
    return (
      <video
        src={asset.previewUrl}
        muted
        playsInline
        preload="metadata"
        style={ratio}
        className="block w-full bg-[#1f211c]"
      />
    );
  }
  return (
    <div
      style={{ aspectRatio: "16 / 6" }}
      className="grid w-full place-items-center bg-[#1f211c]/5 text-[11px] font-semibold text-[#8a8271] capitalize"
    >
      {asset.modality}
    </div>
  );
}
