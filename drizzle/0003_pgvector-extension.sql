-- pgvector, for asset_enrichment.embedding (added in the next migration).
-- Supabase ships the extension; this only enables it for our database.
CREATE EXTENSION IF NOT EXISTS vector;
