"use client";

/**
 * Canvas-wide services the node components need.
 *
 * Node components are rendered by React Flow, not by us, so they cannot be
 * handed props directly — everything they need beyond their own `data` arrives
 * through here.
 */

import * as React from "react";

import type { Catalog } from "@/lib/studio/catalog";
import type { AssetPreview } from "@/lib/studio/graph";

export type RunScope = "node" | "chain";

export type StudioContextValue = {
  catalog: Catalog;
  /** Upload previews, keyed by asset id and hydrated from the assets table. */
  assets: Record<string, AssetPreview>;
  /** Shallow-merge a patch into a node's wire data. */
  updateNode: (id: string, patch: Record<string, unknown>) => void;
  /**
   * Drop whatever is wired into one input handle.
   *
   * Needed by nodes whose handles come and go: deleting a composition lane has
   * to take its edge with it, or the graph keeps an edge pointing at a handle
   * that no longer exists and the compiler rejects the whole workflow.
   */
  disconnectPort: (id: string, handle: string) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  /** Attach (or replace) the file behind an upload node. */
  pickFileFor: (id: string) => void;
  /** "Run" vs "Run from here" — the latter walks the connected chain downstream. */
  runFrom: (id: string, scope: RunScope) => void;
};

const StudioContext = React.createContext<StudioContextValue | null>(null);

export function StudioProvider({
  value,
  children,
}: {
  value: StudioContextValue;
  children: React.ReactNode;
}) {
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioContextValue {
  const ctx = React.useContext(StudioContext);
  if (!ctx) throw new Error("useStudio must be used inside a StudioProvider");
  return ctx;
}
