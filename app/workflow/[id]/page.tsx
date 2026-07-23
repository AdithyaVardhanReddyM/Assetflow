import Link from "next/link";
import { notFound } from "next/navigation";

import { StudioShell } from "@/components/studio/studio-shell";
import type { ToolId } from "@/components/studio/toolbar";
import { db } from "@/db";
import { fetchCatalog } from "@/lib/studio/catalog";
import { parseGraph } from "@/lib/studio/graph";
import { requireTenant } from "@/lib/studio/tenant";
import { listComments } from "../comments";

export const metadata = { title: "Canvas · Asset Flow" };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pointer tools survive the trip from the home screen as a query param, since
 * they are a canvas *mode* and leave no trace in the document. A create tool
 * needs no param — it arrives as the node already seeded into the graph.
 */
const POINTER_TOOLS = new Set(["move", "hand", "comment"]);

export default async function WorkflowCanvasPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tool?: string | string[] }>;
}) {
  const { id } = await params;
  // Postgres rejects a malformed uuid as a syntax error rather than an empty
  // result, so the shape is checked before the row is ever looked for.
  if (!UUID.test(id)) notFound();

  const who = await requireTenant();
  if (!who) notFound();

  const [catalog, row, comments, query] = await Promise.all([
    fetchCatalog(),
    db.query.workflows.findFirst({
      // Missing and not-yours resolve identically, matching the server
      // functions and the backend's `_get_owned`: a distinct "forbidden" would
      // confirm the id exists.
      where: (w, { and, eq, isNull }) =>
        and(eq(w.id, id), eq(w.tenantId, who.tenantId), isNull(w.deletedAt)),
      columns: { id: true, name: true, graph: true },
    }),
    // Tenant-scoped in its own right, so a mismatched id yields an empty
    // thread list rather than someone else's notes.
    listComments(id),
    searchParams,
  ]);
  if (!row) notFound();

  const graph = parseGraph(row.graph);
  // Deliberately not a fallback to the empty graph: the canvas autosaves what
  // it holds, so opening an unreadable document on a blank one would overwrite
  // it within a second.
  if (!graph) return <Unopenable name={row.name} />;

  const tool = Array.isArray(query.tool) ? query.tool[0] : query.tool;

  return (
    <StudioShell
      workflowId={row.id}
      initialName={row.name}
      initialGraph={graph}
      initialComments={comments.ok ? comments.data : []}
      catalog={catalog}
      initialTool={tool && POINTER_TOOLS.has(tool) ? (tool as ToolId) : "move"}
    />
  );
}

function Unopenable({ name }: { name: string }) {
  return (
    <div className="fixed inset-0 grid place-items-center bg-[#f7f4ee] px-6 text-[#1f211c]">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-medium tracking-[-0.01em]">
          “{name}” can’t be opened
        </h1>
        <p className="mt-3 text-[13px] leading-6 text-[#8a8271]">
          It was saved in a format this version of the canvas doesn’t
          understand. Nothing has been changed — the document is still on
          record exactly as it was.
        </p>
        <Link
          href="/workflow"
          className="mt-6 inline-flex h-10 items-center border border-[#1f211c]/20 px-5 text-[13px] font-semibold transition-colors hover:border-[#1f211c]/45 hover:bg-white/70"
        >
          Back to workflows
        </Link>
      </div>
    </div>
  );
}
