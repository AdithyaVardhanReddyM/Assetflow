DROP INDEX "assets_tenant_sha_kind_idx";--> statement-breakpoint
CREATE INDEX "assets_tenant_sha_idx" ON "assets" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_sha_upload_idx" ON "assets" USING btree ("tenant_id","sha256") WHERE "assets"."kind" = 'upload' and "assets"."sha256" is not null;