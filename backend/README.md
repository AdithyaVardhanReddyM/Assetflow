# asset-flow backend

FastAPI service that compiles a canvas graph into a [GenBlaze](https://github.com/backblaze-labs/genblaze)
pipeline, executes it across media providers, and persists the output plus its
provenance manifest to Backblaze B2.

GenBlaze is Python-only, which is why this is a separate service rather than
Next.js route handlers — generation cannot be driven from Node.

## Quick start (no credentials needed)

```bash
cd backend
uv sync --all-groups
cp .env.example .env          # defaults are mock providers + local storage

uv run uvicorn app.main:create_app --factory --reload --port 8000
uv run python -m app.scripts.demo    # in another terminal
```

The demo seeds a workflow, enqueues a run, tails the live SSE stream, and prints
the result. It needs no API keys and no bucket: mock providers generate, and
local storage writes real playable files under `.data/media`.

Only `DATABASE_URL` is required — it is read from the repo-root `.env`, shared
with the Next.js app.

```
readiness  db=True storage=local genblaze=mock providers_ready=['mock']
1. validate    valid=True  steps=['gen_video','gen_audio'] concurrency=2 eta=5.0s
3. enqueue run run_id=8fb6c94d… status=queued
4. stream progress
    3  node.started     gen_video    mock-video/mock-video-v1
    9  node.completed   gen_video    1 asset(s)  video/mp4
   11  run.completed                 status=succeeded assets=2
5. final state  status=succeeded duration=25.2s
```

## Architecture

```
app/
  graph/      PURE — no GenBlaze, no DB, no I/O. Canvas graph → ExecutionPlan.
  engine/     The ONLY package that imports genblaze_*.
  catalog/    Declarative provider/model YAML + availability resolution.
  workers/    Postgres-backed queue, asyncio supervisor, run executor.
  routers/    HTTP surface.
  db/         SQLAlchemy mirror of ../db/schema.ts (no migrations here).
```

Two boundaries carry the design:

**`graph/` is pure.** The compiler is the riskiest logic in the backend, so it
has no dependencies to mock — its 35-case suite runs in under a tenth of a
second and needed no credentials to write.

**`engine/` is the sole GenBlaze import site.** Mock mode is one branch in one
file; a missing provider extra degrades to a catalog status rather than an
`ImportError` at startup; and an SDK change has a four-file blast radius.

### Canvas → GenBlaze

| Canvas | GenBlaze |
|---|---|
| generate node | `.step(provider, model=, prompt=, modality=, params=)` |
| edge | `input_from=[step_index]` |
| upload node | `external_inputs=[Asset]` (ingested via `Pipeline.ingest`) |
| Combine A/V node | `FFmpegCompositor` + `step_type=MIX` + `input_from=[i, j]` |
| per-node progress | `astream()` → typed `StreamEvent`s |

Steps are ordered by a topological sort tie-broken on `(position.y, position.x,
id)`. That is deliberate: step indices then match the visual reading order of
the canvas, and the ordering is stable across re-saves, which keeps the manifest
hash — and therefore GenBlaze's step cache — stable.

`chain=False` always. Canvas edges are explicit; implicit chaining would wire
steps together in ways the user did not draw.

### Storage

**B2 is the system of record for artifacts and provenance; Postgres is a
queryable index over it.** The canonical truth for any asset is its hash-verified
manifest in the bucket. Postgres stores denormalized pointers so we can paginate
and join without S3 round-trips. Dropping the database loses convenience, not
provenance — lineage rebuilds from B2 via `read_manifest_for_asset()`.

The bucket is private. Manifests and the database store **durable** URLs; short-
lived presigned URLs are minted per request at `GET /v1/assets/{id}/content`.
A presigned URL is never persisted — it embeds the access key id and would break
canonical-hash stability.

### Job execution

The `runs` table *is* the queue — a run is the job, which halves the state
machine. Workers claim with `FOR UPDATE SKIP LOCKED` and hold a lease; a startup
sweep requeues anything a dead worker abandoned, so killing the worker mid-run
and restarting resumes it. Not `BackgroundTasks` (a deploy silently loses
in-flight 5-minute jobs) and not Redis/Celery (a second datastore and deploy
target for fan-out we do not use).

Cancellation works only because execution goes through `astream()`/`arun()`;
the synchronous `stream()` would leave a worker thread polling after cancel.

### Progress streaming

Events are appended to `run_events` with a monotonic `seq`, in the same
transaction as the step-state update. The SSE endpoint replays `seq > after_seq`
then tails by polling. Through the table rather than an in-memory bus because
the worker may be a different process — and because Supabase's transaction
pooler does not support `LISTEN/NOTIFY`. Reconnect, exactly-once-per-seq
delivery, and full replay all fall out of that.

## Database

Drizzle owns the schema (`../db/schema.ts`); this service mirrors it in
SQLAlchemy and runs **no** migrations. Two migration tools against one database
is a real hazard. `app/db/verify.py` reflects the live schema at startup and
logs loudly if the mirror has drifted.

```bash
pnpm db:generate && pnpm db:migrate   # from the repo root
```

## Testing

```bash
uv run pytest -q          # 57 tests, no credentials, no database
uv run ruff check app tests
```

`tests/unit/test_graph_compile.py` is the highest-value file here — cycles,
fan-in, modality mismatch, param validation, and deterministic ordering.
`test_event_map.py` pins the GenBlaze quirks documented in
[docs/sdk-findings.md](docs/sdk-findings.md).

## Gotchas worth knowing

Verified the hard way; details in [docs/sdk-findings.md](docs/sdk-findings.md).

- **`on_submit=` does not exist** despite appearing in GenBlaze's docs. Upstream
  job ids are captured from `request_id` on progress events instead.
- **Mock providers live in `genblaze_core.mocks`**, not `.testing` (that module
  imports pytest).
- **`step.progress` carries no `step_index`**, so node identity is learned at
  `step.started` and applied to later events for the same step.
- **Assets are excluded from event serialization** — they must be read off the
  live in-process object or they never reach the browser.
- **SSE frames are CRLF-delimited.** Splitting on `"\n\n"` silently never
  matches; normalize `\r\n` first. The canvas's reader must do this too.
- **Never use `EventSource`** on the frontend: it cannot set an `Authorization`
  header, and Clerk session tokens are short-lived. Use `fetch` +
  `ReadableStream`. Never put a token in a query string.
- **Enum columns in raw SQL need `CAST(:x AS run_status)`**, never `:x::t` —
  `::` collides with SQLAlchemy `text()`'s own `:param` syntax.
- **B2 sends no CORS headers**, so `<img>`/`<video>` work through the presign
  redirect but a cross-origin `fetch()` does not.

## Endpoints

| | |
|---|---|
| `GET /healthz`, `/readyz` | liveness; db + storage + per-provider status + ffmpeg |
| `GET /v1/catalog/{providers,models,node-types}` | server-driven canvas palette |
| `POST /v1/workflows/validate` | compile without persisting → inline canvas errors |
| `POST GET PATCH DELETE /v1/workflows` | graph CRUD |
| `POST /v1/runs` | enqueue (honours `Idempotency-Key`) |
| `GET /v1/runs/{id}/events` | **SSE** progress stream |
| `GET /v1/runs/{id}/events/history` | polling fallback + replay |
| `POST /v1/runs/{id}/{cancel,retry}` | cancel; re-run with lineage |
| `GET /v1/runs/{id}/manifest` | canonical manifest re-read from B2 |
| `GET /v1/assets/{id}/{provenance,content}` | lineage; presigned redirect |

Errors are RFC 9457 `application/problem+json`. Raw exception reprs never reach
a client.

## Enabling real providers

```bash
uv sync --extra providers        # installs the adapter packages
# add the relevant keys to .env, then:
GENBLAZE_MODE=live
```

Unconfigured providers stay listed in the catalog with a `status` and a reason
("Set GEMINI_API_KEY to enable Google"), so the palette shows what the product
supports rather than hiding it.
