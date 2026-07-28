"use server";

/**
 * Agent-conversation persistence. Same division as `actions.ts`: Next owns the
 * chat entirely — FastAPI never reads these tables. Every action re-derives
 * the caller and scopes by tenant; ids off the wire are never trusted.
 */

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { workflows } from "@/db/schema";
import {
  type StoredChat,
  type StoredMessage,
  chatForWorkflow,
  ensureChat,
  messagesForChat,
  ownedChat,
  ownedWorkflowId,
  updateChat,
  upsertMessages,
} from "@/lib/studio/agent/chat-store";
import type { AgentAttachment, ChatProposal } from "@/lib/studio/agent/spec";
import { newId } from "@/lib/studio/graph";
import { requireTenant } from "@/lib/studio/tenant";

import type { ActionResult } from "./actions";

/** Mirrors `nameFromPrompt` in actions.ts — kept private there. */
function nameFromPrompt(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  if (!text) return "Untitled workflow";
  const opening = text.split(" ").slice(0, 7).join(" ");
  return opening.length > 60 ? `${opening.slice(0, 59)}…` : opening;
}

/**
 * The home screen's agent entry: a fresh empty canvas whose chat already holds
 * the user's first message. The row is the handoff — the canvas route finds an
 * open chat with an unanswered user message and starts the conversation, so a
 * reload or a shared link resumes instead of losing the prompt.
 */
export async function startAgentChat(input: {
  prompt: string;
  attachments?: AgentAttachment[];
}): Promise<ActionResult<{ workflowId: string }>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, error: "Say what you'd like to make first." };

  try {
    const [row] = await db
      .insert(workflows)
      .values({
        tenantId: who.tenantId,
        ownerUserId: who.userId,
        name: nameFromPrompt(prompt),
      })
      .returning({ id: workflows.id });

    const chat = await ensureChat({
      tenantId: who.tenantId,
      userId: who.userId,
      workflowId: row.id,
    });
    await upsertMessages(who.tenantId, chat.id, [
      {
        id: newId(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
        metadata: input.attachments?.length
          ? { attachments: input.attachments }
          : undefined,
      },
    ]);

    revalidatePath("/workflow");
    return { ok: true, data: { workflowId: row.id } };
  } catch {
    return { ok: false, error: "Could not start the agent." };
  }
}

export type LoadedChat = { chat: StoredChat; messages: StoredMessage[] };

/** The canvas page's read: the workflow's thread and transcript, if any. */
export async function loadChat(
  workflowId: string,
): Promise<ActionResult<LoadedChat | null>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  try {
    if (!(await ownedWorkflowId(who.tenantId, workflowId))) {
      return { ok: false, error: "That workflow was not found." };
    }
    const chat = await chatForWorkflow(who.tenantId, workflowId);
    if (!chat) return { ok: true, data: null };
    const messages = await messagesForChat(chat.id);
    return { ok: true, data: { chat, messages } };
  } catch {
    return { ok: false, error: "Could not load the conversation." };
  }
}

/**
 * The canvas entry: makes sure the workflow's thread exists (reopening a
 * closed one) and reports it, so the client can start posting to the route.
 */
export async function openChat(
  workflowId: string,
): Promise<ActionResult<LoadedChat>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  try {
    if (!(await ownedWorkflowId(who.tenantId, workflowId))) {
      return { ok: false, error: "That workflow was not found." };
    }
    const chat = await ensureChat({
      tenantId: who.tenantId,
      userId: who.userId,
      workflowId,
    });
    const messages = await messagesForChat(chat.id);
    return { ok: true, data: { chat, messages } };
  } catch {
    return { ok: false, error: "Could not open the conversation." };
  }
}

/**
 * Client-side flush for transcript states the route never sees — a Reject or
 * Accept updates a tool part's output without another LLM turn.
 */
export async function saveChatMessages(
  chatId: string,
  messages: StoredMessage[],
): Promise<ActionResult<null>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  try {
    const chat = await ownedChat(who.tenantId, chatId);
    if (!chat) return { ok: false, error: "That conversation was not found." };
    await upsertMessages(who.tenantId, chatId, messages);
    return { ok: true, data: null };
  } catch {
    return { ok: false, error: "Could not save the conversation." };
  }
}

export async function setChatStatus(
  chatId: string,
  status: "open" | "closed",
): Promise<ActionResult<null>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };
  try {
    const done = await updateChat(who.tenantId, chatId, { status });
    return done
      ? { ok: true, data: null }
      : { ok: false, error: "That conversation was not found." };
  } catch {
    return { ok: false, error: "Could not update the conversation." };
  }
}

export async function setChatProposal(
  chatId: string,
  proposal: ChatProposal | null,
): Promise<ActionResult<null>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };
  try {
    const done = await updateChat(who.tenantId, chatId, { proposal });
    return done
      ? { ok: true, data: null }
      : { ok: false, error: "That conversation was not found." };
  } catch {
    return { ok: false, error: "Could not update the conversation." };
  }
}
