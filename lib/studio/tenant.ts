import "server-only";

import { auth } from "@clerk/nextjs/server";

export type Tenant = { userId: string; tenantId: string };

/**
 * Mirrors `tenant_for()` in `backend/app/auth/clerk.py` — one tenant per org,
 * else one per user. The two must agree exactly: it is the key both processes
 * scope every query by, and it is also the B2 object prefix.
 *
 * Lives here rather than beside the server functions that use it because a
 * `"use server"` module may only export actions, and the workflow pages need
 * the same derivation to scope their own reads.
 */
export async function requireTenant(): Promise<Tenant | null> {
  const { userId, orgId } = await auth();
  if (!userId) return null;
  return { userId, tenantId: orgId ?? `user_${userId}` };
}
