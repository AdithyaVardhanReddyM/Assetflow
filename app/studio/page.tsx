import { currentUser } from "@clerk/nextjs/server";

import { StudioShell } from "@/components/studio/studio-shell";
import type { WorkflowCard } from "@/components/studio/workflow-cards";
import { fetchCatalog } from "@/lib/studio/catalog";

export const metadata = { title: "Studio · Asset Flow" };

export default async function StudioPage() {
  const user = await currentUser();

  // The palette is public and independent of the user, so it loads alongside
  // the recents query rather than after it.
  const [catalog, cards] = await Promise.all([fetchCatalog(), loadRecents(user?.id)]);

  return (
    <StudioShell
      firstName={user?.firstName ?? "there"}
      workflows={cards}
      catalog={catalog}
    />
  );
}

async function loadRecents(userId: string | undefined): Promise<WorkflowCard[]> {
  if (!userId) return [];
  try {
    const { db } = await import("@/db");
    const rows = await db.query.workflows.findMany({
      where: (w, { and, eq, isNull }) =>
        and(eq(w.ownerUserId, userId), isNull(w.deletedAt)),
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
    // Database unreachable (e.g. local dev without DATABASE_URL) — the studio
    // still opens with templates instead of recents.
    return [];
  }
}
