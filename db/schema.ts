// Drizzle schema — the single source of truth for the database.
//
// The FastAPI backend (backend/app/db/models.py) mirrors these tables with
// SQLAlchemy but runs NO migrations of its own: two migration tools pointed at
// one database is a genuine hazard. Schema changes go here, then
// `pnpm db:generate && pnpm db:migrate`.
//
// Not `db:push`: it introspects the live database first, and drizzle-kit 0.31
// crashes doing so against this one. Postgres reports every NOT NULL as a CHECK
// constraint in information_schema, and push's reader assumes each such row has
// a definition to parse. `migrate` replays the generated SQL and never looks.
//
// backend/app/db/verify.py reflects the live schema at startup and fails loudly
// if the mirror has drifted.
//
// Column names derive automatically from `casing: "snake_case"`, so `tenantId`
// becomes `tenant_id` without spelling it out.
//
// Division of responsibility: B2 is the system of record for artifacts and
// provenance manifests. These tables are a queryable index over it — pointers,
// so we can paginate and join without S3 round-trips. Dropping this database
// loses convenience, not provenance.

import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "canceled",
  "interrupted",
]);

export const stepStatus = pgEnum("step_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
]);

export const assetKind = pgEnum("asset_kind", ["upload", "generated"]);

export const enrichmentStatus = pgEnum("enrichment_status", [
  "pending",
  "done",
  "failed",
]);

export const chatStatus = pgEnum("chat_status", ["open", "closed"]);

/** Postgres `tsvector`, which drizzle-orm has no built-in column type for. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
};

/** A saved canvas. `graph` is the node/edge document the compiler consumes. */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: text().notNull(),
    ownerUserId: text().notNull(),
    name: text().notNull(),
    description: text(),
    graph: jsonb().notNull().default({ version: 1, nodes: [], edges: [] }),
    thumbnailAssetId: uuid(),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("workflows_tenant_updated_idx").on(t.tenantId, t.updatedAt)],
).enableRLS();

/**
 * Canvas annotations — the human layer laid over a document the compiler reads.
 *
 * Deliberately *not* nodes inside `workflows.graph`: that shape is mirrored
 * field for field by `backend/app/graph/schema.py` and handed to the planner,
 * so a comment living there would be a node kind the compiler has to learn to
 * ignore, in two languages. Beside the graph instead, the executable document
 * never changes and a comment can never fail a validation it has no part in.
 *
 * Threads are one level deep. `parentId` carries no foreign key, matching
 * `runs.parentRunId`: the rows are in the same table, and the cascade that
 * matters is already on `workflowId`.
 */
export const workflowComments = pgTable(
  "workflow_comments",
  {
    id: uuid().primaryKey().defaultRandom(),
    workflowId: uuid()
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    tenantId: text().notNull(),
    /** Null on a pin; the pin's id on a reply. */
    parentId: uuid(),

    authorUserId: text().notNull(),
    /** Denormalised: rendering a thread should not need a round trip to Clerk. */
    authorName: text().notNull(),

    /** Flow coordinates — a pin has to stay on what it points at through pan
     *  and zoom, so these are canvas space, never screen space. Replies
     *  inherit their pin's position and ignore their own. */
    x: doublePrecision().notNull().default(0),
    y: doublePrecision().notNull().default(0),

    body: text().notNull(),

    resolvedAt: timestamp({ withTimezone: true }),
    resolvedBy: text(),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("workflow_comments_workflow_idx").on(t.workflowId, t.createdAt),
    index("workflow_comments_parent_idx").on(t.parentId),
  ],
).enableRLS();

/**
 * The workflow-builder agent's conversation, one thread per canvas (the unique
 * index). Next.js owns these two tables entirely — the FastAPI mirror ignores
 * them, which is safe because verify.py is one-directional (extra tables in the
 * database are expected, missing ones are the failure).
 *
 * `proposal` is the live bookkeeping for a placed-but-undecided graph:
 * `{ toolCallId, nodeIds, status } | null`. It lives here rather than in node
 * `data` because the backend silently drops undeclared keys from `wire` on any
 * round trip.
 */
export const workflowChats = pgTable(
  "workflow_chats",
  {
    id: uuid().primaryKey().defaultRandom(),
    workflowId: uuid()
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    tenantId: text().notNull(),
    ownerUserId: text().notNull(),
    /** Accept/Run close the thread; a later agent prompt reopens it. */
    status: chatStatus().notNull().default("open"),
    proposal: jsonb(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workflow_chats_workflow_idx").on(t.workflowId),
    index("workflow_chats_tenant_idx").on(t.tenantId, t.updatedAt),
  ],
).enableRLS();

/**
 * AI SDK UIMessages, parts stored verbatim. The id is the client-generated
 * UIMessage id — a natural upsert key, which makes persistence idempotent
 * across the route's onFinish and the client's explicit flushes. Tool parts
 * keep their state/input/output, so answered questionnaires and placed
 * proposals rehydrate after a reload without replaying the model.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text().primaryKey(),
    chatId: uuid()
      .notNull()
      .references(() => workflowChats.id, { onDelete: "cascade" }),
    tenantId: text().notNull(),
    role: text().notNull(),
    parts: jsonb().notNull(),
    /** Off-wire context: `{ assetIds?: string[], taggedNodeIds?: string[] }`. */
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_chat_idx").on(t.chatId, t.createdAt)],
).enableRLS();

/**
 * A run is also the job queue row — a run *is* the job, which halves the state
 * machine. Workers claim with `FOR UPDATE SKIP LOCKED` and hold a lease.
 *
 * `graphSnapshot` and `planSnapshot` make a run reproducible and let the worker
 * map GenBlaze step indices back to canvas node ids without recompiling.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: text().notNull(),
    ownerUserId: text().notNull(),
    workflowId: uuid().references(() => workflows.id, { onDelete: "set null" }),
    idempotencyKey: text(),

    graphSnapshot: jsonb().notNull(),
    planSnapshot: jsonb().notNull(),

    genblazeRunId: text(),
    parentRunId: uuid(),

    status: runStatus().notNull().default("queued"),
    error: text(),
    errorCode: text(),

    // Provenance — the manifest in B2 is the canonical record; these are pointers.
    manifestUri: text(),
    manifestHash: text(),
    /** null when not applicable (e.g. local storage mode, where a passing
     *  verify() would not actually mean "durably stored"). */
    manifestVerified: text(),
    b2Prefix: text(),

    totalCostUsd: doublePrecision(),
    durationSec: real(),

    // queue bookkeeping
    claimedBy: text(),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    attempt: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    cancelRequested: timestamp({ withTimezone: true }),

    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("runs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("runs_status_created_idx").on(t.status, t.createdAt),
    index("runs_workflow_idx").on(t.workflowId),
    // Partial: many rows legitimately have no idempotency key, and NULLs would
    // otherwise not collide anyway — being explicit documents the intent.
    uniqueIndex("runs_idempotency_idx")
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
).enableRLS();

/** One row per canvas node that became a GenBlaze step. */
export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text().notNull(),
    stepIndex: integer().notNull(),
    genblazeStepId: text(),

    provider: text().notNull(),
    model: text().notNull(),
    modality: text().notNull(),
    stepType: text().notNull().default("generate"),
    status: stepStatus().notNull().default("pending"),

    prompt: text(),
    params: jsonb().notNull().default({}),

    /** Upstream provider job id (Replicate prediction, Runway task, ...).
     *  GenBlaze exposes no `on_submit` hook despite what its docs show, so this
     *  is captured from the `request_id` on progress/completed/failed events. */
    upstreamId: text(),

    progressPct: real(),
    previewUrl: text(),
    elapsedSec: real(),
    costUsd: doublePrecision(),

    error: text(),
    errorCode: text(),
    retries: integer().notNull().default(0),

    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("run_steps_run_node_idx").on(t.runId, t.nodeId)],
).enableRLS();

/**
 * Append-only event log. This is the SSE source, the audit trail, and the replay
 * buffer all at once. Consumers read `seq > afterSeq`, which gives
 * reconnect-with-Last-Event-ID and exactly-once-per-seq delivery for free.
 *
 * Events go through the table rather than an in-memory bus because the worker
 * may be a different process from the API — and because Supabase's transaction
 * pooler does not support LISTEN/NOTIFY.
 */
export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    runId: uuid()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().notNull(),
    nodeId: text(),
    payload: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("run_events_run_seq_idx").on(t.runId, t.seq)],
).enableRLS();

/** Uploads and generated media. `sha256` mirrors B2 content-addressing. */
export const assets = pgTable(
  "assets",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: text().notNull(),
    kind: assetKind().notNull(),

    genblazeAssetId: text(),
    runId: uuid().references(() => runs.id, { onDelete: "set null" }),
    nodeId: text(),

    b2Key: text(),
    /** Durable, credential-free URL. Never a presigned one — those embed the
     *  key id and would break canonical-hash stability. Presigning happens at
     *  serve time in GET /v1/assets/{id}/content. */
    url: text().notNull(),
    mediaType: text().notNull(),
    modality: text().notNull(),
    sha256: text(),
    sizeBytes: integer(),

    width: integer(),
    height: integer(),
    durationSec: real(),

    manifestUri: text(),
    filename: text(),
    metadata: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("assets_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("assets_run_idx").on(t.runId),
    index("assets_tenant_sha_idx").on(t.tenantId, t.sha256),
    // Dedup applies to UPLOADS ONLY, and the partial predicate is the whole
    // point: re-uploading the same file should be a no-op, but two runs that
    // generate identical bytes are two distinct artifacts, each with its own
    // provenance manifest and lineage. Constraining generated assets here would
    // make the second run fail on insert rather than record its own history.
    uniqueIndex("assets_tenant_sha_upload_idx")
      .on(t.tenantId, t.sha256)
      .where(sql`${t.kind} = 'upload' and ${t.sha256} is not null`),
  ],
).enableRLS();

/**
 * Derived, searchable metadata — one row per asset, filled by a background
 * pass after the asset lands (vision caption/tags/OCR for visual media, the
 * generation prompt for everything born from one).
 *
 * A table of its own rather than columns on `assets`: enrichment is async and
 * retryable, so it needs a status the hot row shouldn't carry, and the vector
 * column drags in an extension dependency that the core table shouldn't have.
 *
 * `searchDoc` is the assembled text (caption + tags + OCR + prompt +
 * filename) written by the service; both search representations derive from
 * it — `searchText` is generated *in the database* so the tsvector can never
 * drift from the document, and `embedding` is Jina's read of the same text.
 * The same JSON also lands beside the object in B2 (`sidecarKey`): the bucket
 * holds the metadata of record, this table is the queryable index over it.
 */
export const assetEnrichment = pgTable(
  "asset_enrichment",
  {
    assetId: uuid()
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    tenantId: text().notNull(),
    status: enrichmentStatus().notNull().default("pending"),

    caption: text(),
    /** String array. */
    tags: jsonb().notNull().default([]),
    /** Text read out of the pixels — what makes brand assets findable. */
    ocrText: text(),
    /** Dominant colors as hex strings. */
    palette: jsonb().notNull().default([]),
    /** Denormalized from the producing run step at enrich time. */
    prompt: text(),

    searchDoc: text(),
    searchText: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(search_doc, ''))`,
    ),
    /** jina-embeddings-v3 of `searchDoc`; null when no key was configured. */
    embedding: vector({ dimensions: 1024 }),

    /** Which vision model produced the caption — provenance for the metadata. */
    model: text(),
    /** B2 key of the enrichment JSON written beside the asset's object. */
    sidecarKey: text(),
    error: text(),
    ...timestamps,
  },
  (t) => [
    index("asset_enrichment_tenant_status_idx").on(t.tenantId, t.status),
    index("asset_enrichment_search_idx").using("gin", t.searchText),
    index("asset_enrichment_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
).enableRLS();

// --- relations ------------------------------------------------------------

export const workflowsRelations = relations(workflows, ({ many }) => ({
  runs: many(runs),
  comments: many(workflowComments),
  chats: many(workflowChats),
}));

export const workflowChatsRelations = relations(workflowChats, ({ one, many }) => ({
  workflow: one(workflows, {
    fields: [workflowChats.workflowId],
    references: [workflows.id],
  }),
  messages: many(chatMessages),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  chat: one(workflowChats, {
    fields: [chatMessages.chatId],
    references: [workflowChats.id],
  }),
}));

export const workflowCommentsRelations = relations(workflowComments, ({ one }) => ({
  workflow: one(workflows, {
    fields: [workflowComments.workflowId],
    references: [workflows.id],
  }),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  workflow: one(workflows, {
    fields: [runs.workflowId],
    references: [workflows.id],
  }),
  steps: many(runSteps),
  events: many(runEvents),
  assets: many(assets),
}));

export const runStepsRelations = relations(runSteps, ({ one }) => ({
  run: one(runs, { fields: [runSteps.runId], references: [runs.id] }),
}));

export const runEventsRelations = relations(runEvents, ({ one }) => ({
  run: one(runs, { fields: [runEvents.runId], references: [runs.id] }),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  run: one(runs, { fields: [assets.runId], references: [runs.id] }),
  enrichment: one(assetEnrichment, {
    fields: [assets.id],
    references: [assetEnrichment.assetId],
  }),
}));

export const assetEnrichmentRelations = relations(assetEnrichment, ({ one }) => ({
  asset: one(assets, {
    fields: [assetEnrichment.assetId],
    references: [assets.id],
  }),
}));

// --- inferred types -------------------------------------------------------

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowComment = typeof workflowComments.$inferSelect;
export type NewWorkflowComment = typeof workflowComments.$inferInsert;
export type WorkflowChat = typeof workflowChats.$inferSelect;
export type NewWorkflowChat = typeof workflowChats.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunStep = typeof runSteps.$inferSelect;
export type NewRunStep = typeof runSteps.$inferInsert;
export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;
export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type AssetEnrichment = typeof assetEnrichment.$inferSelect;
export type NewAssetEnrichment = typeof assetEnrichment.$inferInsert;
