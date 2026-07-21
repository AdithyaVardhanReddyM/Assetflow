CREATE TYPE "public"."asset_kind" AS ENUM('upload', 'generated');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'partial', 'failed', 'canceled', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"genblaze_asset_id" text,
	"run_id" uuid,
	"node_id" text,
	"b2_key" text,
	"url" text NOT NULL,
	"media_type" text NOT NULL,
	"modality" text NOT NULL,
	"sha256" text,
	"size_bytes" integer,
	"width" integer,
	"height" integer,
	"duration_sec" real,
	"manifest_uri" text,
	"filename" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"node_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"genblaze_step_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"modality" text NOT NULL,
	"step_type" text DEFAULT 'generate' NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"prompt" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"upstream_id" text,
	"progress_pct" real,
	"preview_url" text,
	"elapsed_sec" real,
	"cost_usd" double precision,
	"error" text,
	"error_code" text,
	"retries" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"workflow_id" uuid,
	"idempotency_key" text,
	"graph_snapshot" jsonb NOT NULL,
	"plan_snapshot" jsonb NOT NULL,
	"genblaze_run_id" text,
	"parent_run_id" uuid,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"error_code" text,
	"manifest_uri" text,
	"manifest_hash" text,
	"manifest_verified" text,
	"b2_prefix" text,
	"total_cost_usd" double precision,
	"duration_sec" real,
	"claimed_by" text,
	"lease_expires_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"cancel_requested" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"graph" jsonb DEFAULT '{"version":1,"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"thumbnail_asset_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_tenant_created_idx" ON "assets" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_run_idx" ON "assets" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_sha_kind_idx" ON "assets" USING btree ("tenant_id","sha256","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_node_idx" ON "run_steps" USING btree ("run_id","node_id");--> statement-breakpoint
CREATE INDEX "runs_tenant_created_idx" ON "runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_created_idx" ON "runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "runs_workflow_idx" ON "runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_idx" ON "runs" USING btree ("tenant_id","idempotency_key") WHERE "runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "workflows_tenant_updated_idx" ON "workflows" USING btree ("tenant_id","updated_at");