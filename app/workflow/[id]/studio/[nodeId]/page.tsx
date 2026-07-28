import { notFound, redirect } from "next/navigation";

import { EditStudio } from "@/components/studio/edit-studio/edit-studio";
import type { EditKind } from "@/components/studio/edit-studio/knob";
import { db } from "@/db";
import { parseGraph } from "@/lib/studio/graph";
import { requireTenant } from "@/lib/studio/tenant";

export const metadata = { title: "Studio · Asset Flow" };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The graph's own node-id grammar — see `buildTakeEditGraph`. */
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const EDIT_KINDS = new Set<string>(["camera", "relight", "text"]);

/**
 * The edit studio for one node's displayed take. The take arrives as the
 * `asset` query param — the canvas knows which generation was on show, the
 * document does not record it — and `edit` picks the tool the knob opens on.
 */
export default async function EditStudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; nodeId: string }>;
  searchParams: Promise<{ asset?: string | string[]; edit?: string | string[] }>;
}) {
  const [{ id, nodeId }, query] = await Promise.all([params, searchParams]);
  // Postgres rejects a malformed uuid as a syntax error rather than an empty
  // result, so the shape is checked before the row is ever looked for.
  if (!UUID.test(id) || !NODE_ID.test(nodeId)) notFound();

  const who = await requireTenant();
  if (!who) notFound();

  const row = await db.query.workflows.findFirst({
    // Missing and not-yours resolve identically — a distinct "forbidden"
    // would confirm the id exists.
    where: (w, { and, eq, isNull }) =>
      and(eq(w.id, id), eq(w.tenantId, who.tenantId), isNull(w.deletedAt)),
    columns: { id: true, name: true, graph: true },
  });
  if (!row) notFound();

  const graph = parseGraph(row.graph);
  const node = graph?.nodes.find((n) => n.id === nodeId);
  // Only a generate node has takes to edit; anything else has no business
  // here and goes back to the canvas rather than a dead end.
  if (!graph || !node || node.kind !== "generate") redirect(`/workflow/${id}`);

  const asset = Array.isArray(query.asset) ? query.asset[0] : query.asset;
  if (!asset || !UUID.test(asset)) redirect(`/workflow/${id}`);

  const edit = Array.isArray(query.edit) ? query.edit[0] : query.edit;
  const title = typeof node.data.title === "string" ? node.data.title : null;

  return (
    <EditStudio
      workflowId={row.id}
      workflowName={row.name}
      node={{ id: node.id, title, position: node.position }}
      assetId={asset}
      initialEdit={edit && EDIT_KINDS.has(edit) ? (edit as EditKind) : "camera"}
    />
  );
}
