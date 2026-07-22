"use client";

import { UserButton } from "@clerk/nextjs";
import {
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  CornersOutIcon,
  FolderSimpleIcon,
  MinusIcon,
  PlusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type SaveState = "saved" | "saving" | "error";

const island =
  "flex h-10 items-center gap-0.5 border border-[#1f211c]/8 bg-white/88 px-1.5 shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md";

const iconBtn =
  "grid size-7 place-items-center text-[#4c4a41] transition-colors hover:bg-[#1f211c]/6 hover:text-[#1f211c] disabled:pointer-events-none disabled:opacity-35";

function BarTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent
        side="bottom"
        sideOffset={10}
        className="bg-[#1f211c] text-[#f7f4ee]"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function TopBar({
  visible,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitView,
  saveState,
}: {
  visible: boolean;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFitView: () => void;
  saveState: SaveState;
}) {
  return (
    <div className="fixed top-4 right-4 z-40 flex items-center gap-2">
      <div
        className={cn(
          "flex items-center gap-2 transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          visible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-14 opacity-0",
        )}
        aria-hidden={!visible}
      >
        <div className={island}>
          <BarTooltip label="Zoom out">
            <button type="button" aria-label="Zoom out" className={iconBtn} onClick={onZoomOut}>
              <MinusIcon className="size-3.5" />
            </button>
          </BarTooltip>
          <BarTooltip label="Reset zoom">
            <button
              type="button"
              onClick={onZoomReset}
              aria-label="Reset zoom"
              className="w-11 py-1 text-center text-xs font-semibold text-[#1f211c] tabular-nums transition-colors hover:bg-[#1f211c]/6"
            >
              {Math.round(zoom * 100)}%
            </button>
          </BarTooltip>
          <BarTooltip label="Zoom in">
            <button type="button" aria-label="Zoom in" className={iconBtn} onClick={onZoomIn}>
              <PlusIcon className="size-3.5" />
            </button>
          </BarTooltip>
          <BarTooltip label="Fit to view">
            <button type="button" aria-label="Fit to view" className={iconBtn} onClick={onFitView}>
              <CornersOutIcon className="size-3.5" />
            </button>
          </BarTooltip>
        </div>

        <div className={island}>
          <BarTooltip label="Undo">
            <button type="button" aria-label="Undo" className={iconBtn} disabled>
              <ArrowUUpLeftIcon className="size-4" />
            </button>
          </BarTooltip>
          <BarTooltip label="Redo">
            <button type="button" aria-label="Redo" className={iconBtn} disabled>
              <ArrowUUpRightIcon className="size-4" />
            </button>
          </BarTooltip>
        </div>

        <div className={island}>
          <BarTooltip
            label={
              saveState === "saving"
                ? "Saving…"
                : saveState === "error"
                  ? "Couldn't save — your work is still on the canvas"
                  : "All changes saved"
            }
          >
            <span className="grid size-7 place-items-center" role="status">
              {saveState === "saving" ? (
                <CircleNotchIcon className="size-4 animate-spin text-[#8a8271]" />
              ) : saveState === "error" ? (
                <WarningCircleIcon weight="fill" className="size-4 text-[#c1803f]" />
              ) : (
                <CheckCircleIcon weight="fill" className="size-4 text-[#5d9468]" />
              )}
            </span>
          </BarTooltip>
          <BarTooltip label="Assets">
            <button type="button" aria-label="Assets" className={iconBtn}>
              <FolderSimpleIcon className="size-4" />
            </button>
          </BarTooltip>
        </div>
      </div>

      <div className="grid size-10 place-items-center rounded-full border border-[#1f211c]/8 bg-white/88 shadow-[0_14px_36px_-12px_rgba(31,33,28,0.22)] backdrop-blur-md">
        <UserButton
          appearance={{
            elements: { userButtonAvatarBox: "size-7" },
          }}
        />
      </div>
    </div>
  );
}
