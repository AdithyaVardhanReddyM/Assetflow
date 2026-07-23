"use server";

/**
 * Canvas comments.
 *
 * Separate from `actions.ts` because these are not the document: saving a
 * canvas and leaving a note on one have different lifetimes, different
 * permissions, and no reason to contend for the same debounce.
 *
 * Same rule as everywhere else — a Server Function is reachable by direct POST,
 * so every one of these re-derives the caller and scopes by tenant rather than
 * trusting an id from the client.
 */

import { currentUser } from "@clerk/nextjs/server";
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { workflowComments } from "@/db/schema";
import { requireTenant } from "@/lib/studio/tenant";
import type { ActionResult } from "./actions";

/** One comment as the canvas renders it — a pin, or a reply under one. */
export type CanvasComment = {
  id: string;
  parentId: string | null;
  authorUserId: string;
  authorName: string;
  x: number;
  y: number;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
};

const MAX_BODY = 2000;

function cleanBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const body = raw.trim();
  if (!body) return null;
  return body.slice(0, MAX_BODY);
}

/** Flow space is unbounded but not infinite; refuse values that cannot be drawn. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toCanvas(row: typeof workflowComments.$inferSelect): CanvasComment {
  return {
    id: row.id,
    parentId: row.parentId,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    x: row.x,
    y: row.y,
    body: row.body,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Confirms the workflow is the caller's before anything touches its comments.
 * A comment inherits the canvas's tenant, so this is the only place ownership
 * needs deciding.
 */
async function ownedWorkflow(workflowId: string, tenantId: string) {
  return db.query.workflows.findFirst({
    where: (w, { and: A, eq: E, isNull: N }) =>
      A(E(w.id, workflowId), E(w.tenantId, tenantId), N(w.deletedAt)),
    columns: { id: true },
  });
}

export async function listComments(
  workflowId: string,
): Promise<ActionResult<CanvasComment[]>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  try {
    const rows = await db
      .select()
      .from(workflowComments)
      .where(
        and(
          eq(workflowComments.workflowId, workflowId),
          eq(workflowComments.tenantId, who.tenantId),
          isNull(workflowComments.deletedAt),
        ),
      )
      .orderBy(asc(workflowComments.createdAt));

    return { ok: true, data: rows.map(toCanvas) };
  } catch {
    return { ok: false, error: "Could not load comments." };
  }
}

export async function addComment(input: {
  workflowId: string;
  /** Omitted on a reply, which takes its position from the pin it answers. */
  x?: number;
  y?: number;
  parentId?: string | null;
  body: string;
}): Promise<ActionResult<CanvasComment>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  const body = cleanBody(input.body);
  if (!body) return { ok: false, error: "A comment needs something in it." };

  try {
    const workflow = await ownedWorkflow(input.workflowId, who.tenantId);
    if (!workflow) return { ok: false, error: "That workflow was not found." };

    let x = 0;
    let y = 0;
    if (input.parentId) {
      // A reply lands on its pin, so the thread cannot be split across the
      // canvas by a client that sends its own coordinates.
      const parent = await db.query.workflowComments.findFirst({
        where: (c, { and: A, eq: E, isNull: N }) =>
          A(
            E(c.id, input.parentId!),
            E(c.workflowId, input.workflowId),
            E(c.tenantId, who.tenantId),
            N(c.deletedAt),
          ),
        columns: { x: true, y: true, parentId: true },
      });
      if (!parent) return { ok: false, error: "That thread was not found." };
      // One level deep: replying to a reply attaches to the same pin.
      if (parent.parentId) return { ok: false, error: "That thread was not found." };
      x = parent.x;
      y = parent.y;
    } else {
      const px = finite(input.x);
      const py = finite(input.y);
      if (px === null || py === null) {
        return { ok: false, error: "That comment could not be placed." };
      }
      x = px;
      y = py;
    }

    const user = await currentUser();
    const [row] = await db
      .insert(workflowComments)
      .values({
        workflowId: input.workflowId,
        tenantId: who.tenantId,
        parentId: input.parentId ?? null,
        authorUserId: who.userId,
        authorName:
          user?.firstName ??
          user?.username ??
          user?.emailAddresses[0]?.emailAddress ??
          "Someone",
        x,
        y,
        body,
      })
      .returning();

    return { ok: true, data: toCanvas(row) };
  } catch {
    return { ok: false, error: "Could not post that comment." };
  }
}

/**
 * Resolving is a shared act, not an owned one: whoever reads the note and acts
 * on it is usually not whoever left it, and requiring the author to come back
 * and tick it off is how comment threads rot.
 */
export async function resolveComment(
  id: string,
  resolved: boolean,
): Promise<ActionResult<{ resolvedAt: string | null }>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  try {
    const resolvedAt = resolved ? new Date() : null;
    const rows = await db
      .update(workflowComments)
      .set({
        resolvedAt,
        resolvedBy: resolved ? who.userId : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowComments.id, id),
          eq(workflowComments.tenantId, who.tenantId),
          isNull(workflowComments.parentId),
          isNull(workflowComments.deletedAt),
        ),
      )
      .returning({ resolvedAt: workflowComments.resolvedAt });

    if (!rows.length) return { ok: false, error: "That comment was not found." };
    return {
      ok: true,
      data: { resolvedAt: rows[0].resolvedAt?.toISOString() ?? null },
    };
  } catch {
    return { ok: false, error: "Could not update that comment." };
  }
}

export async function moveComment(
  id: string,
  x: number,
  y: number,
): Promise<ActionResult<null>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  const px = finite(x);
  const py = finite(y);
  if (px === null || py === null) {
    return { ok: false, error: "That comment could not be placed." };
  }

  try {
    // Replies carry the pin's position, so moving the pin moves the thread.
    const rows = await db
      .update(workflowComments)
      .set({ x: px, y: py, updatedAt: new Date() })
      .where(
        and(
          eq(workflowComments.id, id),
          eq(workflowComments.tenantId, who.tenantId),
          isNull(workflowComments.parentId),
          isNull(workflowComments.deletedAt),
        ),
      )
      .returning({ id: workflowComments.id });

    if (!rows.length) return { ok: false, error: "That comment was not found." };

    await db
      .update(workflowComments)
      .set({ x: px, y: py })
      .where(
        and(
          eq(workflowComments.parentId, id),
          eq(workflowComments.tenantId, who.tenantId),
        ),
      );

    return { ok: true, data: null };
  } catch {
    return { ok: false, error: "Could not move that comment." };
  }
}

/** Deleting is author-only — unlike resolving, it destroys what someone said. */
export async function deleteComment(id: string): Promise<ActionResult<null>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  try {
    const rows = await db
      .update(workflowComments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(workflowComments.id, id),
          eq(workflowComments.tenantId, who.tenantId),
          eq(workflowComments.authorUserId, who.userId),
          isNull(workflowComments.deletedAt),
        ),
      )
      .returning({ id: workflowComments.id });

    if (!rows.length) {
      return { ok: false, error: "You can only delete your own comments." };
    }

    // A pin takes its replies with it; a thread with no question left is noise.
    await db
      .update(workflowComments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(workflowComments.parentId, id),
          eq(workflowComments.tenantId, who.tenantId),
          isNull(workflowComments.deletedAt),
        ),
      );

    return { ok: true, data: null };
  } catch {
    return { ok: false, error: "Could not delete that comment." };
  }
}
