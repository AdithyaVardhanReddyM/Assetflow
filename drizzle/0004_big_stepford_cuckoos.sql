CREATE TYPE "public"."enrichment_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "asset_enrichment" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"status" "enrichment_status" DEFAULT 'pending' NOT NULL,
	"caption" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ocr_text" text,
	"palette" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt" text,
	"search_doc" text,
	"search_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_doc, ''))) STORED,
	"embedding" vector(1024),
	"model" text,
	"sidecar_key" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_enrichment" ADD CONSTRAINT "asset_enrichment_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_enrichment_tenant_status_idx" ON "asset_enrichment" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "asset_enrichment_search_idx" ON "asset_enrichment" USING gin ("search_text");--> statement-breakpoint
CREATE INDEX "asset_enrichment_embedding_idx" ON "asset_enrichment" USING hnsw ("embedding" vector_cosine_ops);