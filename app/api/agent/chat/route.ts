/**
 * The workflow-builder agent's brain: Gemini Flash over OpenRouter, streaming
 * UIMessages back to the sidebar. All three tools are client-executed — the
 * canvas is in the browser, so placing, editing and questioning all happen
 * there and the stream simply stops at each tool call.
 *
 * Auth, ownership and body checks all run BEFORE streaming starts: once the
 * first chunk is out the status line is fixed, so an error after that point
 * could only be delivered in-band.
 */

import { auth } from "@clerk/nextjs/server";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  type FileUIPart,
  type UIMessage,
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
} from "ai";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { workflows } from "@/db/schema";
import { ensureChat, upsertMessages } from "@/lib/studio/agent/chat-store";
import {
  type AgentAttachment,
  AskUserSchema,
  GraphSpecSchema,
  UpdateNodeSchema,
} from "@/lib/studio/agent/spec";
import { buildSystemPrompt } from "@/lib/studio/agent/system-prompt";
import { fetchAssetPreviews } from "@/lib/studio/assets-client";
import { fetchCatalog } from "@/lib/studio/catalog";
import { type Graph, EMPTY_GRAPH, parseGraph } from "@/lib/studio/graph";
import { requireTenant } from "@/lib/studio/tenant";

export const maxDuration = 60;

const AGENT_MODEL = process.env.AGENT_MODEL ?? "google/gemini-3.6-flash";

type ChatBody = {
  workflowId?: string;
  messages?: UIMessage[];
};

/** Every attachment mentioned across the transcript, newest declaration wins. */
function collectAttachments(messages: UIMessage[]): AgentAttachment[] {
  const seen = new Map<string, AgentAttachment>();
  for (const message of messages) {
    const meta = message.metadata as { attachments?: AgentAttachment[] } | undefined;
    for (const a of meta?.attachments ?? []) {
      if (a?.assetId) seen.set(a.assetId, a);
    }
  }
  return [...seen.values()];
}

/**
 * The model sees media through freshly minted presigned URLs — stored
 * messages only ever carry asset ids, because a persisted presigned URL is a
 * stale one by the next request. The copy keeps the file parts out of
 * `originalMessages`, so what lands back in the database stays URL-free.
 */
async function withMediaParts(
  messages: UIMessage[],
  urls: Record<string, { url: string; mediaType: string }>,
): Promise<UIMessage[]> {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const meta = message.metadata as { attachments?: AgentAttachment[] } | undefined;
    const files = (meta?.attachments ?? [])
      .map((a): FileUIPart | null => {
        const minted = urls[a.assetId];
        return minted
          ? { type: "file", mediaType: minted.mediaType, url: minted.url }
          : null;
      })
      .filter((p): p is FileUIPart => p !== null);
    if (!files.length) return message;
    return { ...message, parts: [...message.parts, ...files] };
  });
}

export async function POST(req: Request) {
  const who = await requireTenant();
  if (!who) return Response.json({ error: "Not signed in." }, { status: 401 });

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  const { workflowId, messages } = body;
  if (!workflowId || !Array.isArray(messages) || !messages.length) {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const workflow = await db.query.workflows.findFirst({
    columns: { id: true, graph: true },
    where: and(
      eq(workflows.id, workflowId),
      eq(workflows.tenantId, who.tenantId),
      isNull(workflows.deletedAt),
    ),
  });
  if (!workflow) return Response.json({ error: "Not found." }, { status: 404 });

  const chat = await ensureChat({
    tenantId: who.tenantId,
    userId: who.userId,
    workflowId,
  });

  const graph: Graph = parseGraph(workflow.graph) ?? EMPTY_GRAPH;
  const catalog = await fetchCatalog();
  const attachments = collectAttachments(messages);

  // Fresh presigned URLs for everything the model should look at. Uses the
  // caller's own Clerk token so FastAPI resolves the same tenant either way.
  let urls: Record<string, { url: string; mediaType: string }> = {};
  if (attachments.length) {
    const { getToken } = await auth();
    const token = await getToken().catch(() => null);
    const previews = await fetchAssetPreviews(
      attachments.map((a) => a.assetId),
      { token, userId: who.userId },
    );
    urls = Object.fromEntries(
      Object.entries(previews).map(([id, p]) => [id, { url: p.url, mediaType: p.mediaType }]),
    );
  }

  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

  const result = streamText({
    // Low reasoning effort: Gemini 3.6 Flash reasons by default, and unbounded
    // thinking adds seconds of dead air before the first visible token. Output
    // tokens stay uncapped — a capped budget is how reasoning models return
    // empty content (see the Kimi node's history).
    model: openrouter.chat(AGENT_MODEL, { reasoning: { effort: "low" } }),
    system: buildSystemPrompt({ catalog, graph, attachments }),
    messages: await convertToModelMessages(await withMediaParts(messages, urls)),
    tools: {
      // All client-side (no execute): the stream pauses at the call and the
      // sidebar answers via addToolOutput.
      ask_user: {
        description:
          "Ask the user up to 3 short multiple-choice questions to pin down the brief.",
        inputSchema: AskUserSchema,
      },
      propose_graph: {
        description:
          "Place a node graph on the user's canvas. Replaces any earlier proposal.",
        inputSchema: GraphSpecSchema,
      },
      update_node: {
        description: "Edit one existing canvas node (prompt, title or params).",
        inputSchema: UpdateNodeSchema,
      },
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      onEnd: async ({ messages: merged }) => {
        try {
          await upsertMessages(who.tenantId, chat.id, merged);
        } catch {
          // The client flushes the same transcript on its next action; a
          // failed write here loses nothing durable.
        }
      },
    }),
  });
}
