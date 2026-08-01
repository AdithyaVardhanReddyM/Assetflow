/**
 * The workflow-builder agent's brain: Gemini Flash over GMI Cloud, streaming
 * UIMessages back to the sidebar. All three tools are client-executed — the
 * canvas is in the browser, so placing, editing and questioning all happen
 * there and the stream simply stops at each tool call.
 *
 * Auth, ownership and body checks all run BEFORE streaming starts: once the
 * first chunk is out the status line is fixed, so an error after that point
 * could only be delivered in-band.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { auth } from "@clerk/nextjs/server";
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
  type RemixSource,
  AskUserSchema,
  GraphSpecSchema,
  UpdateNodeSchema,
} from "@/lib/studio/agent/spec";
import { buildSystemPrompt } from "@/lib/studio/agent/system-prompt";
import { fetchAssetPreviews } from "@/lib/studio/assets-client";
import { fetchCatalog } from "@/lib/studio/catalog";
import { fetchReconstruction } from "@/lib/studio/library-client";
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

/** The remix this thread is about, if any — the newest declaration wins. */
function collectRemix(messages: UIMessage[]): RemixSource | null {
  let found: RemixSource | null = null;
  for (const message of messages) {
    const meta = message.metadata as { remix?: RemixSource } | undefined;
    if (meta?.remix?.assetId) found = meta.remix;
  }
  return found;
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
  const remixSource = collectRemix(messages);

  // Fresh presigned URLs for everything the model should look at. Uses the
  // caller's own Clerk token so FastAPI resolves the same tenant either way.
  // Degrades rather than dies: a failure here means the model converses
  // without seeing the media — worse answers beat a blank sidebar.
  let urls: Record<string, { url: string; mediaType: string }> = {};
  let remix: { source: RemixSource; graph: Graph | null } | null = null;
  if (attachments.length || remixSource) {
    try {
      const { getToken } = await auth();
      const token = await getToken().catch(() => null);
      if (attachments.length) {
        const previews = await fetchAssetPreviews(
          attachments.map((a) => a.assetId),
          { token, userId: who.userId },
        );
        urls = Object.fromEntries(
          Object.entries(previews).map(([id, p]) => [id, { url: p.url, mediaType: p.mediaType }]),
        );
      }
      if (remixSource) {
        // Re-walked per request rather than stored on the message: the walk is
        // a handful of indexed reads, and the digest stays true to the runs
        // even if the transcript is reopened days later.
        const rebuilt = await fetchReconstruction(remixSource.assetId, {
          token,
          userId: who.userId,
        });
        remix = { source: remixSource, graph: rebuilt.ok ? rebuilt.data.graph : null };
      }
    } catch (error) {
      console.error("[agent/chat] media resolution failed", error);
    }
  }

  const gmi = createOpenAICompatible({
    name: "gmi",
    apiKey: process.env.GMI_API_KEY,
    baseURL: "https://api.gmi-serving.com/v1",
  });

  const result = streamText({
    // Low reasoning effort: Gemini 3.6 Flash reasons by default, and unbounded
    // thinking adds seconds of dead air before the first visible token. Output
    // tokens stay uncapped — a capped budget is how reasoning models return
    // empty content (see the Kimi node's history).
    model: gmi.chatModel(AGENT_MODEL),
    providerOptions: { gmi: { reasoningEffort: "low" } },
    system: buildSystemPrompt({ catalog, graph, attachments, remix }),
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
      // Unmasked on purpose: the default hides every stream failure behind
      // "An error occurred", which reached users as a silently blank sidebar.
      // The message lands in the client's onError toast; the console line is
      // the server-side record of what actually broke.
      onError: (error) => {
        console.error("[agent/chat] stream error", error);
        return error instanceof Error ? error.message : String(error);
      },
      onEnd: async ({ messages: merged }) => {
        try {
          await upsertMessages(who.tenantId, chat.id, merged);
        } catch (error) {
          // The client flushes the same transcript on its next action; a
          // failed write here loses nothing durable — but say so, silence
          // here has already cost a debugging session.
          console.error("[agent/chat] transcript write failed", error);
        }
      },
    }),
  });
}
