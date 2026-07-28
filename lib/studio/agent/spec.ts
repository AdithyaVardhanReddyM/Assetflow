/**
 * The contract between the workflow-builder agent and the canvas.
 *
 * The LLM never emits the wire format — real graphs carry UUIDs, pixel
 * positions and provider-resolved data the model has no business inventing.
 * It emits this spec instead: nodes named by toolbar tool with local slug ids,
 * edges by target port. `compileGraphSpec` turns it into a placeable Graph.
 *
 * Kept free of React and of anything server-only, so the schemas can back the
 * route handler's tool definitions and the client's rehydration alike.
 */

import { z } from "zod";

/** CreateToolId, restated for zod. `output` is not a toolbar tool. */
export const SPEC_TOOLS = [
  "image",
  "video",
  "lipsync",
  "music",
  "speech",
  "sfx",
  "character",
  "llm",
  "text",
  "composition",
  "upload",
] as const;

export const GraphSpecNodeSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_]{1,16}$/)
    .describe("Local id, e.g. 'hero_shot'. Edges reference these."),
  tool: z.enum(SPEC_TOOLS),
  title: z.string().max(60).optional().describe("Short human label for the node."),
  prompt: z
    .string()
    .max(4000)
    .optional()
    .describe("Generation prompt, or the content of a text node."),
  model: z
    .string()
    .optional()
    .describe("Catalog model id. Omit to use the tool's default model."),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Model params, e.g. {aspect_ratio: '9:16'}. Omit for defaults."),
  asset_id: z
    .string()
    .uuid()
    .optional()
    .describe("Only for tool='upload': the id of a user-attached asset."),
  duration_locked: z
    .boolean()
    .optional()
    .describe("Set true ONLY when the user explicitly asked for this duration."),
});

export const GraphSpecSchema = z.object({
  summary: z.string().max(200).describe("One sentence describing the graph."),
  nodes: z.array(GraphSpecNodeSchema).min(1).max(20),
  edges: z
    .array(
      z.object({
        from: z.string().describe("Source node's local id. Output is always 'out'."),
        to: z.string().describe("Target node's local id."),
        port: z
          .string()
          .describe(
            "Target port: prompt | init_image | end_frame | image_ref | speech | " +
              "source_audio | source_video | avatar; on a composition node: video | audio.",
          ),
      }),
    )
    .max(40),
});

export type GraphSpec = z.infer<typeof GraphSpecSchema>;
export type GraphSpecNode = z.infer<typeof GraphSpecNodeSchema>;

export const AskUserSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]{1,24}$/),
        question: z.string().max(200),
        options: z.array(z.string().max(80)).min(2).max(5),
        allow_other: z
          .boolean()
          .default(true)
          .describe("Whether to offer a free-text 'Other' answer."),
      }),
    )
    .min(1)
    .max(3),
});

export type AskUserInput = z.infer<typeof AskUserSchema>;

/**
 * Direct edit of a node already on the canvas — how "improve this prompt" on a
 * tagged node lands, without proposing a whole replacement graph.
 */
export const UpdateNodeSchema = z.object({
  node_id: z.string().describe("The canvas node id, from [node:...] in the message."),
  prompt: z.string().max(4000).optional(),
  title: z.string().max(60).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type UpdateNodeInput = z.infer<typeof UpdateNodeSchema>;

/** What the client reports back for an answered questionnaire. */
export type AskUserOutput = { answers: Record<string, string> };

/** What the client reports back after trying to place a proposal. */
export type ProposeGraphOutput =
  | { ok: true; placed: number }
  | { ok: false; errors: string[] };

/**
 * A user attachment as the agent pipeline sees it — enough to build an upload
 * node, gate modality checks, and let the route mint a fresh media URL.
 */
export type AgentAttachment = {
  assetId: string;
  mediaType: string;
  modality: string;
  filename: string | null;
};

/** Bookkeeping for a placed-but-undecided proposal, persisted on the chat row. */
export type ChatProposal = {
  toolCallId: string;
  nodeIds: string[];
  status: "placed" | "accepted" | "rejected" | "replaced";
};
