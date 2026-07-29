"use client";

import * as React from "react";

import { ModelViewer } from "./model-viewer";

/**
 * The inline 3D preview for a node's run well (and the library drawer): an
 * auto-rotating turntable, deliberately inert. `pointer-events-none` is what
 * keeps React Flow's drag handling out of the fight — orbiting lives in the
 * expand modal.
 */
export function ModelWellPreview({
  url,
  onReady,
  onError,
}: {
  url: string;
  onReady?: () => void;
  onError?: () => void;
}) {
  return (
    <div className="pointer-events-none h-full w-full">
      <ModelViewer url={url} interactive={false} onReady={onReady} onError={onError} />
    </div>
  );
}
