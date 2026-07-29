-- Supabase is only a Postgres host for this project. The app reaches it over
-- the direct connection as `postgres`, auth is Clerk, and nothing in either
-- half of the monorepo speaks to the Data API — there is no supabase client and
-- no anon key anywhere in the tree. PostgREST was serving all nine of these
-- tables anyway, to `anon` and `authenticated`, with full DML and no RLS. That
-- is what the Security Advisor's `rls_disabled_in_public` was reporting.
--
-- Two independent locks, because either one alone can be undone by accident:
-- RLS with no policies denies every role that cannot bypass it, and the revoke
-- below takes away the privileges it would be denying. `postgres` has BYPASSRLS
-- and owns the tables, so the backend, the workers and Drizzle are untouched.
--
-- The schema's USAGE is deliberately left alone. `anon` holds it through
-- PUBLIC, not directly, so revoking it from `anon` does nothing at all — and
-- revoking it from PUBLIC would reach every other role in the cluster. Table
-- privileges are the lock that actually closes; USAGE without them is a door
-- onto a wall.
--
-- Adopting a Supabase client later means undoing this deliberately: write
-- policies *before* granting anything back.
ALTER TABLE "asset_enrichment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_chats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Guarded on the roles existing: these are Supabase's, and this file also runs
-- against a plain Postgres in local mode, where revoking from them would abort
-- the migration.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) = 2 THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated;
    -- Supabase grants these two everything on every table `postgres` creates,
    -- so without this the next Drizzle migration re-opens the door.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON ROUTINES FROM anon, authenticated;
  END IF;
END $$;
