/**
 * The non-conversational builders behind the Image and Video tabs.
 *
 * Both are thin authors of a GraphSpec handed to `compileGraphSpec`, so quick
 * mode and agent mode place graphs through one validator and one layout —
 * a port rule fixed there is fixed here for free.
 *
 * React-free and server-safe: the home page's seed path builds these inside a
 * server action, the canvas builds them client-side.
 */

import { type Catalog, type CatalogModel, aspectOptionFor } from "../catalog";
import { NODE_BLUEPRINTS, pickModel } from "../node-ui";
import { type CompileFailure, type CompiledSpec, compileGraphSpec } from "./compile-spec";
import type { AgentAttachment, GraphSpec } from "./spec";

/** The enhanced prompts the quick modes run on. Video's frame prompts follow
 *  what the chosen model accepts; unused ones simply stay null. */
export type QuickPrompts = {
  prompt: string;
  startFramePrompt?: string | null;
  endFramePrompt?: string | null;
};

export function buildQuickImageGraph(
  catalog: Catalog,
  model: CatalogModel,
  prompt: string,
  params: Record<string, unknown>,
  count: number,
  attachments: AgentAttachment[],
): CompiledSpec | CompileFailure {
  const takesRefs = model.accepts.some((a) => a.port === "image_ref");
  const refs = takesRefs ? attachments.filter((a) => a.modality === "image") : [];

  const spec: GraphSpec = {
    summary: `${count} image${count > 1 ? "s" : ""} from one prompt`,
    nodes: [
      { id: "brief", tool: "text", prompt },
      ...refs.map((a, i) => ({
        id: `ref_${i + 1}`,
        tool: "upload" as const,
        asset_id: a.assetId,
      })),
      ...Array.from({ length: count }, (_, i) => ({
        id: `image_${i + 1}`,
        tool: "image" as const,
        model: model.id,
        params,
      })),
    ],
    edges: Array.from({ length: count }, (_, i) => `image_${i + 1}`).flatMap((target) => [
      { from: "brief", to: target, port: "prompt" },
      ...refs.map((_, i) => ({ from: `ref_${i + 1}`, to: target, port: "image_ref" })),
    ]),
  };
  // Only the refs the model can take — the compiler insists every attachment
  // it is told about lands on the canvas, and a ref-blind model can take none.
  return compileGraphSpec(spec, catalog, refs);
}

export function buildQuickVideoGraph(
  catalog: Catalog,
  model: CatalogModel,
  prompts: QuickPrompts,
  params: Record<string, unknown>,
  attachments: AgentAttachment[],
): CompiledSpec | CompileFailure {
  const accepts = (port: string) => model.accepts.some((a) => a.port === port);
  const imageModel = pickModel(catalog, NODE_BLUEPRINTS.image);
  const takesRefs = accepts("image_ref");
  const refs = takesRefs ? attachments.filter((a) => a.modality === "image") : [];

  // Frame stills should already be the shape the video will be — otherwise the
  // video model letterboxes or crops its own start frame.
  const frameParams: Record<string, unknown> = {};
  const aspect = typeof params.aspect_ratio === "string" ? params.aspect_ratio : null;
  if (aspect && imageModel) {
    const option = aspectOptionFor(imageModel, aspect);
    if (option) frameParams.aspect_ratio = option;
  }

  const withFrames = Boolean(imageModel) && accepts("init_image") && prompts.startFramePrompt;
  const withEnd = withFrames && accepts("end_frame") && prompts.endFramePrompt;

  const spec: GraphSpec = {
    summary: "video chain from one prompt",
    nodes: [
      { id: "brief", tool: "text", prompt: prompts.prompt },
      ...(withFrames
        ? [
            { id: "start_text", tool: "text" as const, prompt: prompts.startFramePrompt! },
            {
              id: "start_frame",
              tool: "image" as const,
              title: "Start frame",
              model: imageModel!.id,
              params: frameParams,
            },
          ]
        : []),
      ...(withEnd
        ? [
            { id: "end_text", tool: "text" as const, prompt: prompts.endFramePrompt! },
            {
              id: "end_frame",
              tool: "image" as const,
              title: "End frame",
              model: imageModel!.id,
              params: frameParams,
            },
          ]
        : []),
      ...refs.map((a, i) => ({
        id: `ref_${i + 1}`,
        tool: "upload" as const,
        asset_id: a.assetId,
      })),
      { id: "video", tool: "video", model: model.id, params },
    ],
    edges: [
      { from: "brief", to: "video", port: "prompt" },
      ...(withFrames
        ? [
            { from: "start_text", to: "start_frame", port: "prompt" },
            { from: "start_frame", to: "video", port: "init_image" },
          ]
        : []),
      ...(withEnd
        ? [
            { from: "end_text", to: "end_frame", port: "prompt" },
            { from: "end_frame", to: "video", port: "end_frame" },
          ]
        : []),
      ...refs.map((_, i) => ({ from: `ref_${i + 1}`, to: "video", port: "image_ref" })),
    ],
  };
  return compileGraphSpec(spec, catalog, refs);
}
