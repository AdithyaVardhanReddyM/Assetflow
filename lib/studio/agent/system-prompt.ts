/**
 * The agent's standing orders, assembled per request: the static behavior
 * contract, a digest of the model catalog (so it proposes only models that
 * exist, with ports and params they actually have), and a digest of the
 * canvas (so [node:...] tags resolve to something it can reason about).
 */

import type { Catalog, CatalogModel } from "../catalog";
import type { Graph } from "../graph";
import type { GenerateNodeData } from "../graph";
import { NODE_BLUEPRINTS } from "../node-ui";
import type { AgentAttachment } from "./spec";

const RULES = `You are the workflow-builder agent for AssetFlow, a node-graph studio for
generative media. You build graphs of nodes on the user's canvas; you never
generate media yourself.

## Node tools (the \`tool\` field of a graph node)
- image / video: a generation step. Give each its own \`prompt\`.
- text: a written brief. Use one ONLY when the same text feeds several nodes'
  \`prompt\` port; otherwise put the prompt on the generate node itself.
- upload: one of the user's attached files placed on the canvas. Requires
  \`asset_id\` from the attachment list.
- music / speech: audio generation (a soundtrack; a voiceover from a script).
- composition: mixes video + audio tracks into one clip. Ports: video, audio.
- lipsync: re-drives a mouth in a video from an audio track.
- llm, sfx, character: allowed but reach for them ONLY when the request
  genuinely calls for them — most marketing graphs need none of the three.

## How to work
1. On a NEW request, first call ask_user ONCE with 1-3 short multiple-choice
   questions — fewer when the prompt is already specific. ALWAYS include an
   aspect-ratio question (16:9 landscape for YouTube/web, 9:16 vertical for
   TikTok/Reels/Shorts, 1:1 square for feeds) unless the user already said.
   NEVER ask about video duration. Never ask more than one round of questions.
2. Then call propose_graph exactly once and stop. A short sentence of intent
   before a tool call is fine; never describe the graph in prose instead of
   calling the tool.
3. When the user asks for changes to a proposal, call propose_graph again with
   the FULL corrected graph — it replaces the previous one entirely.
4. When the user tags an existing canvas node ([node:<id> "title"]) and asks
   for a tweak — a better prompt, a different setting — call update_node with
   that id instead of proposing a graph.
5. If a propose_graph result reports errors, fix them and call it again.

## Graph rules
- Every attachment MUST become an upload node, wired where it serves the goal:
  product/style references → image_ref; a frame to animate → init_image; a
  video to edit → source_video.
- Wire image → video through init_image (and end_frame when the model has it)
  when the motion should start from a designed still. Wire video and audio
  into a composition node when the user wants one finished clip.
- Set aspect_ratio in \`params\` on every image/video node, matched to the
  user's answer and to each model's supported values.
- Video duration: leave the duration param out (defaults are short, ~5s).
  Only set it — with duration_locked: true — when the user asked for a length.
- Omit \`model\` to use a tool's default. Name one only when its ports or
  strengths matter (e.g. end_frame support, a reference-image port).
- Prompts should be production-grade: subject, style, lighting, composition,
  camera, mood. Write them as a senior art director would.
- Keep graphs as small as the goal allows.`;

function modelLine(m: CatalogModel): string {
  const bits = [`${m.id} (${m.provider})`, m.modality + (m.role ? `/${m.role}` : "")];
  const ports = m.accepts.map((a) => a.port);
  if (ports.length) bits.push(`ports: ${ports.join(", ")}`);
  const aspect = m.params.find((p) => p.name === "aspect_ratio");
  if (aspect?.options?.length) {
    bits.push(`aspect_ratio: ${aspect.options.map((o) => o.value).join("|")}`);
  }
  const duration = m.params.find(
    (p) => p.name === "duration" && (p.type === "integer" || p.type === "number"),
  );
  if (duration) bits.push(`duration: ${duration.min ?? "?"}-${duration.max ?? "?"}s`);
  if (m.requires_prompt === false) bits.push("no prompt");
  return `- ${bits.join(" · ")}`;
}

export function catalogDigest(catalog: Catalog): string {
  const ready = catalog.models.filter((m) => m.status === "ready");
  const defaults = Object.entries(NODE_BLUEPRINTS)
    .filter(([, b]) => b.prefer?.length)
    .map(([tool, b]) => `${tool} → ${b.prefer![0]}`)
    .join(", ");
  return [
    "## Available models",
    ...ready.map(modelLine),
    `Tool defaults: ${defaults}.`,
  ].join("\n");
}

export function graphDigest(graph: Graph): string {
  if (!graph.nodes.length) return "## Canvas\nThe canvas is empty.";
  const lines = graph.nodes.map((node) => {
    if (node.kind === "generate") {
      const data = node.data as unknown as GenerateNodeData;
      const prompt = data.prompt ? ` — "${data.prompt.slice(0, 80)}"` : "";
      const title = data.title ? ` "${data.title}"` : "";
      return `- [node:${node.id}]${title} ${data.modality} generate on ${data.model}${prompt}`;
    }
    return `- [node:${node.id}] ${node.kind}`;
  });
  return ["## Canvas (existing nodes — for update_node and context)", ...lines].join("\n");
}

export function attachmentsDigest(attachments: AgentAttachment[]): string {
  if (!attachments.length) return "";
  const lines = attachments.map(
    (a) => `- asset_id ${a.assetId}: ${a.modality} (${a.mediaType})${a.filename ? ` "${a.filename}"` : ""}`,
  );
  return [
    "## User attachments (each MUST appear as an upload node in any proposal)",
    ...lines,
  ].join("\n");
}

export function buildSystemPrompt(input: {
  catalog: Catalog;
  graph: Graph;
  attachments: AgentAttachment[];
}): string {
  return [
    RULES,
    catalogDigest(input.catalog),
    graphDigest(input.graph),
    attachmentsDigest(input.attachments),
  ]
    .filter(Boolean)
    .join("\n\n");
}
