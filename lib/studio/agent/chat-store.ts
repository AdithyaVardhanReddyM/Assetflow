import "server-only";

/**
 * Database access for agent conversations, shared between the server actions
 * in `app/workflow/chat-actions.ts` and the streaming route in
 * `app/api/agent/chat/route.ts`. A `"use server"` module may only export
 * actions, and the route is not one — hence this file, same reason
 * `lib/studio/tenant.ts` exists.
 *
 * Messages are AI SDK UIMessages stored parts-verbatim, keyed by their
 * client-generated id — upserts are therefore idempotent whether they come
 * from the route's onFinish or an explicit client flush, whichever lands
 * first.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { chatMessages, workflowChats, workflows } from "@/db/schema";
import type { ChatProposal } from "./spec";

export type StoredMessage = {
  id: string;
  role: string;
  parts: unknown;
  metadata?: unknown;
};

export type StoredChat = {
  id: string;
  workflowId: string;
  status: "open" | "closed";
  proposal: ChatProposal | null;
};

/** The tenant's workflow row id, or null — missing and not-yours read the same. */
export async function ownedWorkflowId(
  tenantId: string,
  workflowId: string,
): Promise<string | null> {
  const row = await db.query.workflows.findFirst({
    columns: { id: true },
    where: and(
      eq(workflows.id, workflowId),
      eq(workflows.tenantId, tenantId),
      isNull(workflows.deletedAt),
    ),
  });
  return row?.id ?? null;
}

/**
 * The workflow's one chat thread, created on first use and reopened on later
 * ones — the unique index on workflow_id makes the insert race-safe.
 */
export async function ensureChat(who: {
  tenantId: string;
  userId: string;
  workflowId: string;
}): Promise<StoredChat> {
  const [row] = await db
    .insert(workflowChats)
    .values({
      workflowId: who.workflowId,
      tenantId: who.tenantId,
      ownerUserId: who.userId,
      status: "open",
    })
    .onConflictDoUpdate({
      target: workflowChats.workflowId,
      set: { status: "open", updatedAt: new Date() },
    })
    .returning({
      id: workflowChats.id,
      workflowId: workflowChats.workflowId,
      status: workflowChats.status,
      proposal: workflowChats.proposal,
    });
  return { ...row, proposal: (row.proposal as ChatProposal | null) ?? null };
}

export async function chatForWorkflow(
  tenantId: string,
  workflowId: string,
): Promise<StoredChat | null> {
  const row = await db.query.workflowChats.findFirst({
    where: and(
      eq(workflowChats.workflowId, workflowId),
      eq(workflowChats.tenantId, tenantId),
    ),
  });
  if (!row) return null;
  return {
    id: row.id,
    workflowId: row.workflowId,
    status: row.status,
    proposal: (row.proposal as ChatProposal | null) ?? null,
  };
}

export async function ownedChat(
  tenantId: string,
  chatId: string,
): Promise<StoredChat | null> {
  const row = await db.query.workflowChats.findFirst({
    where: and(eq(workflowChats.id, chatId), eq(workflowChats.tenantId, tenantId)),
  });
  if (!row) return null;
  return {
    id: row.id,
    workflowId: row.workflowId,
    status: row.status,
    proposal: (row.proposal as ChatProposal | null) ?? null,
  };
}

export async function messagesForChat(chatId: string): Promise<StoredMessage[]> {
  const rows = await db.query.chatMessages.findMany({
    where: eq(chatMessages.chatId, chatId),
    orderBy: [asc(chatMessages.createdAt), asc(chatMessages.id)],
  });
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    parts: r.parts,
    metadata: r.metadata ?? undefined,
  }));
}

/**
 * Insert-or-refresh the whole visible transcript. `createdAt` is staggered per
 * batch index so messages written in one flush keep their conversational
 * order under the `(chat_id, created_at)` sort; on conflict only the payload
 * moves, so an already-placed message never re-orders.
 */
export async function upsertMessages(
  tenantId: string,
  chatId: string,
  messages: StoredMessage[],
): Promise<void> {
  if (!messages.length) return;
  const base = Date.now();
  await db
    .insert(chatMessages)
    .values(
      messages.map((m, i) => ({
        id: m.id,
        chatId,
        tenantId,
        role: m.role,
        parts: m.parts as object,
        metadata: (m.metadata as object | undefined) ?? null,
        createdAt: new Date(base + i),
      })),
    )
    .onConflictDoUpdate({
      target: chatMessages.id,
      set: {
        parts: sql`excluded.parts`,
        metadata: sql`excluded.metadata`,
      },
    });
}

export async function updateChat(
  tenantId: string,
  chatId: string,
  patch: { status?: "open" | "closed"; proposal?: ChatProposal | null },
): Promise<boolean> {
  const rows = await db
    .update(workflowChats)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(workflowChats.id, chatId), eq(workflowChats.tenantId, tenantId)))
    .returning({ id: workflowChats.id });
  return rows.length > 0;
}
