"use client";

import dynamic from "next/dynamic";

/**
 * The only door to the three.js components. `ssr: false` (legal here — this
 * module is a client component) plus the dynamic import keep three and drei
 * out of the server render and the main bundle: they load the first time a
 * 3D take actually renders.
 */
export const DynamicModelWellPreview = dynamic(
  () => import("./model-well-preview").then((mod) => mod.ModelWellPreview),
  { ssr: false },
);

export const DynamicModelStage = dynamic(
  () => import("./model-stage").then((mod) => mod.ModelStage),
  { ssr: false },
);
