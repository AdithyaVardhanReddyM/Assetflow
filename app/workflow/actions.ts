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

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { workflows } from "@/db/schema";
import { fetchCatalog, findModel } from "@/lib/studio/catalog";
import {
  type Graph,
  type GraphNode,
  EMPTY_GRAPH,
  newId,
  parseGraph,
} from "@/lib/studio/graph";
import {
  NODE_BLUEPRINTS,
  NODE_SIZE,
  blueprintData,
  isCreateTool,
} from "@/lib/studio/node-ui";
import { requireTenant } from "@/lib/studio/tenant";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const MAX_NAME = 120;

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

    revalidatePath("/workflow");
    return {
      ok: true,
      data: { id: row.id, name: row.name, updatedAt: row.updatedAt.toISOString() },
    };
  } catch {
    return { ok: false, error: "Could not create the workflow." };
  }
}

/**
 * What the home screen asks for when it opens a canvas: a row to navigate to,
 * optionally with the node the user's click already implied.
 *
 * The seed node is built here rather than carried to `/workflow/[id]` as
 * client state, because the row is the handoff — the canvas route loads the
 * document it finds and needs to know nothing about how it got there. A
 * reload, a shared link and a back-button return all land on the same canvas.
 */
export type WorkflowSeed = {
  /** A toolbar tool, or the prompt bar's modality. Anything else seeds nothing. */
  tool?: string;
  prompt?: string;
  /** The model the prompt bar settled on; re-resolved against the catalog here. */
  model?: { provider: string; id: string };
  params?: Record<string, unknown>;
  /** Falls back to the opening words of the prompt, then "Untitled workflow". */
  name?: string;
};

/** First few words of the prompt, so a canvas born from one isn't "Untitled". */
function nameFromPrompt(prompt: string | undefined): string | undefined {
  const text = prompt?.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  const opening = text.split(" ").slice(0, 7).join(" ");
  return opening.length > 60 ? `${opening.slice(0, 59)}…` : opening;
}

async function seedGraph(seed: WorkflowSeed): Promise<Graph> {
  if (!seed.tool || !isCreateTool(seed.tool)) return EMPTY_GRAPH;

  const blueprint = NODE_BLUEPRINTS[seed.tool];
  const catalog = await fetchCatalog();
  const size = NODE_SIZE[blueprint.kind];

  const node: GraphNode = {
    id: newId(),
    kind: blueprint.kind,
    // Centred on the origin: the canvas fits the view to the document on open,
    // so what matters is that the node is *somewhere*, not where.
    position: { x: -Math.round(size.width / 2), y: -Math.round(size.height / 2) },
    data: blueprintData(catalog, blueprint, {
      prompt: seed.prompt?.trim() || undefined,
      // A model id off the wire is untrusted; only one the catalog actually
      // has may seed a node, and `blueprintData` picks the default otherwise.
      model: seed.model
        ? findModel(catalog, seed.model.provider, seed.model.id)
        : undefined,
      params: seed.params,
    }),
  };

  return { ...EMPTY_GRAPH, nodes: [node] };
}

/**
 * Creates a canvas and reports where it lives, for the home screen to navigate
 * to. Every way into the studio — a prompt, a toolbar tool, a template, "start
 * from blank" — comes through here, so every canvas has a URL from its first
 * frame.
 */
export async function startWorkflow(
  seed: WorkflowSeed = {},
): Promise<ActionResult<{ id: string }>> {
  const who = await requireTenant();
  if (!who) return { ok: false, error: "You are not signed in." };

  let graph: Graph;
  try {
    graph = await seedGraph(seed);
  } catch {
    // The catalog lives behind FastAPI; an unreachable one is not a reason to
    // refuse the canvas, only the node it would have been seeded with.
    graph = EMPTY_GRAPH;
  }

  try {
    const [row] = await db
      .insert(workflows)
      .values({
        tenantId: who.tenantId,
        ownerUserId: who.userId,
        name: cleanName(seed.name ?? nameFromPrompt(seed.prompt)),
        graph,
      })
      .returning({ id: workflows.id });

    revalidatePath("/workflow");
    return { ok: true, data: { id: row.id } };
  } catch {
    return { ok: false, error: "Could not start a new workflow." };
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
    revalidatePath("/workflow");
    return { ok: true, data: null };
  } catch {
    return { ok: false, error: "Could not delete the workflow." };
  }
}
