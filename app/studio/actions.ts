"use server";

/**
 * Workflow persistence for the canvas.
 *
 * These run in Next while generation stays in FastAPI: the split is "Next owns
 * the document, Python owns the run". The canvas therefore saves with nothing
 * but `DATABASE_URL` set, and never needs the backend process just to keep an
 * edit.
 *
 * Server Functions are reachable by direct POST, not only through the UI, so
 * every one of these re-derives the caller and scopes by tenant rather than
 * trusting an id from the client.
 */

import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { workflows } from "@/db/schema";
import { type Graph, parseGraph } from "@/lib/studio/graph";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const MAX_NAME = 120;

/**
 * Mirrors `tenant_for()` in `backend/app/auth/clerk.py` — one tenant per org,
 * else one per user. The two must agree exactly: it is the key both processes
 * scope every query by, and it is also the B2 object prefix.
 */
async function requireTenant() {
  const { userId, orgId } = await auth();
  if (!userId) return null;
  return { userId, tenantId: orgId ?? `user_${userId}` };
}

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return "Untitled workflow";
  return name.slice(0, MAX_NAME);
}

export async function createWorkflow(input: {
  name?: string;
  graph?: unknown;
}): Promise<ActionResult<{ id: string; name: string; updatedAt: string }>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  let graph: Graph | undefined;
  if (input.graph !== undefined) {
    const parsed = parseGraph(input.graph);
    if (!parsed) return { ok: false, error: "That canvas could not be saved." };
    graph = parsed;
  }

  try {
    const [row] = await db
      .insert(workflows)
      .values({
        tenantId: who.tenantId,
        ownerUserId: who.userId,
        name: cleanName(input.name),
        // Leaving `graph` undefined lets the column default apply, which keeps
        // the empty-graph shape defined in exactly one place (the schema).
        ...(graph ? { graph } : {}),
      })
      .returning({
        id: workflows.id,
        name: workflows.name,
        updatedAt: workflows.updatedAt,
      });

    revalidatePath("/studio");
    return {
      ok: true,
      data: { id: row.id, name: row.name, updatedAt: row.updatedAt.toISOString() },
    };
  } catch {
    return { ok: false, error: "Could not create the workflow." };
  }
}

export async function saveWorkflow(input: {
  id: string;
  name?: string;
  graph?: unknown;
}): Promise<ActionResult<{ updatedAt: string }>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = cleanName(input.name);
  if (input.graph !== undefined) {
    const parsed = parseGraph(input.graph);
    if (!parsed) return { ok: false, error: "That canvas could not be saved." };
    patch.graph = parsed;
  }
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to save." };

  // `updatedAt` only carries a default, not an on-update trigger, so the
  // recents list would never reorder if this were left off.
  patch.updatedAt = new Date();

  try {
    const rows = await db
      .update(workflows)
      .set(patch)
      .where(
        and(
          eq(workflows.id, input.id),
          eq(workflows.tenantId, who.tenantId),
          isNull(workflows.deletedAt),
        ),
      )
      .returning({ updatedAt: workflows.updatedAt });

    // Missing and not-yours read the same, matching the backend's `_get_owned`:
    // a distinct "forbidden" would confirm the id exists.
    if (!rows.length) return { ok: false, error: "That workflow was not found." };
    return { ok: true, data: { updatedAt: rows[0].updatedAt.toISOString() } };
  } catch {
    return { ok: false, error: "Could not save. Your last change is still on the canvas." };
  }
}

export async function deleteWorkflow(id: string): Promise<ActionResult<null>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  try {
    // Soft delete — runs reference workflows, and a hard delete would orphan
    // the provenance trail for media still in the user's library.
    const rows = await db
      .update(workflows)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(workflows.id, id),
          eq(workflows.tenantId, who.tenantId),
          isNull(workflows.deletedAt),
        ),
      )
      .returning({ id: workflows.id });

    if (!rows.length) return { ok: false, error: "That workflow was not found." };
    revalidatePath("/studio");
    return { ok: true, data: null };
  } catch {
    return { ok: false, error: "Could not delete the workflow." };
  }
}

/** Loads one canvas, tenant-scoped. Used when opening a card from the home screen. */
export async function loadWorkflow(
  id: string,
): Promise<ActionResult<{ id: string; name: string; graph: Graph }>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  try {
    const row = await db.query.workflows.findFirst({
      where: (w, { and: A, eq: E, isNull: N }) =>
        A(E(w.id, id), E(w.tenantId, who.tenantId), N(w.deletedAt)),
      columns: { id: true, name: true, graph: true },
    });
    if (!row) return { ok: false, error: "That workflow was not found." };

    const graph = parseGraph(row.graph);
    if (!graph) {
      return { ok: false, error: "This workflow was saved in a format we can't open." };
    }
    return { ok: true, data: { id: row.id, name: row.name, graph } };
  } catch {
    return { ok: false, error: "Could not open the workflow." };
  }
}
