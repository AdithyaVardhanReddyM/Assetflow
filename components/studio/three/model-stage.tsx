"use client";

import * as React from "react";
import { CubeTransparentIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";

import { ModelViewer } from "./model-viewer";

/**
 * The expand modal's media pane for a 3D take: full-pane orbit viewer with
 * turntable and wireframe toggles. Buttons sit bottom-right, styled like the
 * modal's close button (which keeps the top-right corner).
 */
export function ModelStage({ url }: { url: string }) {
  const [autoRotate, setAutoRotate] = React.useState(true);
  const [wireframe, setWireframe] = React.useState(false);

  return (
    <div className="relative h-full w-full">
      <ModelViewer
        url={url}
        interactive
        autoRotate={autoRotate}
        wireframe={wireframe}
      />
      <div className="absolute right-4 bottom-4 flex gap-2">
        <StageToggle
          label={autoRotate ? "Pause turntable" : "Resume turntable"}
          active={autoRotate}
          onClick={() => setAutoRotate((v) => !v)}
        >
          {autoRotate ? (
            <PauseIcon className="size-4" weight="bold" />
          ) : (
            <PlayIcon className="size-4" weight="bold" />
          )}
        </StageToggle>
        <StageToggle
          label={wireframe ? "Hide wireframe" : "Show wireframe"}
          active={wireframe}
          onClick={() => setWireframe((v) => !v)}
        >
          <CubeTransparentIcon className="size-4" weight="bold" />
        </StageToggle>
      </div>
    </div>
  );
}

function StageToggle({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        "grid size-9 place-items-center shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)] " +
        "transition-all duration-150 hover:scale-105 " +
        (active ? "bg-white text-[#1f211c]" : "bg-[#2a2c24] text-[#d8d5c8]")
      }
    >
      {children}
    </button>
  );
}
