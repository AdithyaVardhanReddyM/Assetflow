/**
 * The agent's standing orders, assembled per request: the static behavior
 * contract, a digest of the model catalog (so it proposes only models that
 * exist, with ports and params they actually have), and a digest of the
 * canvas (so [node:...] tags resolve to something it can reason about).
 */

import type { Catalog, CatalogModel } from "../catalog";
import type { Graph, GraphNode } from "../graph";
import type { GenerateNodeData, UploadNodeData } from "../graph";
import { NODE_BLUEPRINTS } from "../node-ui";
import type { AgentAttachment, RemixSource } from "./spec";

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
- threed: a 3D model (GLB) from its prompt, or from ONE image wired to
  image_ref (the prompt is ignored then — the API takes one or the other).
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

/**
 * The wire graph's node, named as the spec tool the agent would use to place
 * it — the reverse of what `compileGraphSpec` resolves. Null for kinds the
 * spec cannot express (`output`), which the digest simply omits.
 */
function toolForNode(node: GraphNode, catalog: Catalog): string | null {
  if (node.kind === "input.upload") return "upload";
  if (node.kind === "input.text") return "text";
  if (node.kind === "transform.composite") return "composition";
  if (node.kind !== "generate") return null;
  const data = node.data as unknown as GenerateNodeData;
  if (data.preset === "character_sheet") return "character";
  const model = catalog.models.find((m) => m.id === data.model);
  const role = model?.role ?? undefined;
  const modality = model?.modality ?? data.modality;
  for (const [tool, blueprint] of Object.entries(NODE_BLUEPRINTS)) {
    if (blueprint.kind !== "generate" || blueprint.preset) continue;
    if (blueprint.modality === modality && blueprint.role === role) return tool;
  }
  // A model the catalog no longer carries: fall back on the plain tool for
  // the stored modality so the chain stays expressible.
  return { image: "image", video: "video", audio: "music", text: "llm", "3d": "threed" }[
    modality
  ] ?? null;
}

/** `src_1`-style local ids, valid for the spec's id regex and easy to echo. */
function localIds(nodes: GraphNode[]): Map<string, string> {
  return new Map(nodes.map((n, i) => [n.id, `src_${i + 1}`]));
}

/**
 * The source chain behind a remix, rendered spec-style — the same vocabulary
 * the agent proposes in, so mirroring it back is copying, not translation.
 * Prompts are included in full: rewriting them is the whole job.
 */
export function remixDigest(
  remix: RemixSource,
  graph: Graph,
  catalog: Catalog,
): string {
  const ids = localIds(graph.nodes);
  const lines: string[] = [];
  for (const node of graph.nodes) {
    const tool = toolForNode(node, catalog);
    if (!tool) continue;
    const bits = [`id ${ids.get(node.id)}`, `tool ${tool}`];
    if (node.kind === "generate") {
      const data = node.data as unknown as GenerateNodeData;
      bits.push(`model ${data.model}`);
      if (data.params && Object.keys(data.params).length) {
        bits.push(`params ${JSON.stringify(data.params)}`);
      }
      if (data.title) bits.push(`title "${data.title}"`);
      if (data.prompt) bits.push(`prompt "${data.prompt}"`);
    } else if (node.kind === "input.upload") {
      const data = node.data as unknown as UploadNodeData;
      const source = remix.sourceAssets.find((a) => a.assetId === data.asset_id);
      bits.push(`asset_id ${data.asset_id ?? "missing"}`);
      if (source) {
        bits.push(`${source.modality} (${source.mediaType})`);
        if (source.filename) bits.push(`"${source.filename}"`);
      }
    } else if (node.kind === "input.text") {
      const text = String((node.data as { text?: unknown }).text ?? "");
      bits.push(`prompt "${text}"`);
    }
    lines.push(`- ${bits.join(" · ")}`);
  }

  const edges = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => {
      const port = e.target_handle.startsWith("audio_") ? "audio" : e.target_handle;
      return `- ${ids.get(e.source)} → ${ids.get(e.target)} (port: ${port})`;
    });

  const name = remix.filename ? `"${remix.filename}"` : "the selected asset";
  return [
    `## Remix (overrides the general flow)`,
    `The user is REMIXING ${name}. The graph below is the exact chain that`,
    `generated it. Your job: re-propose that chain, changed only as far as the`,
    `user's request demands.`,
    ``,
    `Source nodes:`,
    ...lines,
    `Source edges:`,
    ...(edges.length ? edges : ["- (none)"]),
    ``,
    `Remix rules:`,
    `- Call propose_graph with the FULL chain: same structure, same models,`,
    `  same params, verbatim — unless the user's request requires otherwise.`,
    `  Never ask about aspect ratio; inherit it from the source params.`,
    `- Rewrite generation prompts only as far as the remix demands; keep the`,
    `  craft and specificity of the originals.`,
    `- Reuse the source upload nodes by their asset_id. If the user attached a`,
    `  new file, it REPLACES the source input it supersedes — wire it to the`,
    `  same port, and drop the input it replaces. Use ask_user only when the`,
    `  choice of which input it replaces is genuinely ambiguous.`,
  ].join("\n");
}

export function buildSystemPrompt(input: {
  catalog: Catalog;
  graph: Graph;
  attachments: AgentAttachment[];
  /** Present when the thread is remixing an asset; null graph = chain lost. */
  remix?: { source: RemixSource; graph: Graph | null } | null;
}): string {
  return [
    RULES,
    catalogDigest(input.catalog),
    graphDigest(input.graph),
    attachmentsDigest(input.attachments),
    input.remix
      ? input.remix.graph
        ? remixDigest(input.remix.source, input.remix.graph, input.catalog)
        : "## Remix\nThe user asked to remix an asset, but its source chain " +
          "could not be loaded. Say so, and build the closest graph you can " +
          "from their description instead."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
