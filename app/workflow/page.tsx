import { currentUser } from "@clerk/nextjs/server";

import { WorkflowHome } from "@/components/studio/workflow-home";
import type { WorkflowCard } from "@/components/studio/workflow-cards";
import { fetchCatalog } from "@/lib/studio/catalog";
import { requireTenant } from "@/lib/studio/tenant";

export const metadata = { title: "Workflows · Asset Flow" };

export default async function WorkflowHomePage() {
  // The palette is public and independent of the user, so it loads alongside
  // the recents query rather than after it.
  const [user, catalog, cards] = await Promise.all([
    currentUser(),
    fetchCatalog(),
    loadRecents(),
  ]);

  return (
    <WorkflowHome
      firstName={user?.firstName ?? "there"}
      workflows={cards}
      catalog={catalog}
    />
  );
}

async function loadRecents(): Promise<WorkflowCard[]> {
  const who = await requireTenant();
  if (!who) return [];
  try {
    const { db } = await import("@/db");
    // Scoped by tenant, matching every other read: keyed on the user instead,
    // switching orgs would list canvases that `/workflow/[id]` then refuses.
    const rows = await db.query.workflows.findMany({
      where: (w, { and, eq, isNull }) =>
        and(eq(w.tenantId, who.tenantId), isNull(w.deletedAt)),
      orderBy: (w, { desc }) => desc(w.updatedAt),
      limit: 12,
      columns: { id: true, name: true, updatedAt: true },
    });
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      updatedAt: w.updatedAt.toISOString(),
    }));
  } catch {
    // Database unreachable (e.g. local dev without DATABASE_URL) — the home
    // screen still opens with templates instead of recents.
    return [];
  }
}
