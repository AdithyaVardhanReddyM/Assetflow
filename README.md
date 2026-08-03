<p align="center">
  <img src="public/assetflow_full_logo_light.svg" alt="AssetFlow" width="420" />
</p>

<p align="center"><b>Where ideas flow into assets.</b><br />
A node-based canvas for building generative media workflows across many providers,
where every asset remembers exactly how it was made.</p>

---

## What is AssetFlow?

AssetFlow is a visual workflow studio for generative media. You drop nodes on a
canvas (text, image, video, music, speech, SFX, lipsync, 3D, LLM, upload,
composition), wire them together, and run the whole graph. One brief can flow
through an LLM, into an image model, into a video model, get scored with music,
and end as a composited MP4. Swapping providers is a dropdown, not a rewrite.

- **Model-aware canvas.** Ports adapt to the selected model: a video model that
  accepts a start frame shows a start-frame port, a lipsync model shows avatar and
  speech ports. Runs stream live over SSE, nodes keep a carousel of takes, and
  fallback models auto-retry a failed generation elsewhere.
- **Agent mode.** Describe what you want and a workflow-builder agent asks one
  round of quick questions, then proposes a full graph on the canvas. It only knows
  models that are actually configured, so it never proposes something that can't run.
- **Editing, not just generating.** A multi-track composition node (video bed plus
  audio lanes with faders) renders through ffmpeg. Captions are transcribed with
  ElevenLabs Scribe and burned in with styling. Magic Text decomposes a poster into
  an editable text layer so you can retype the actual text inside an AI image. An
  Edit Studio adds camera-angle and relighting edits to any take, and 3D
  generations get a real orbit viewer.
- **Provenance, end to end.** Every run writes a hash-verified manifest to
  Backblaze B2. Any asset can show its full lineage graph across runs, be
  **reconstructed** back into the exact canvas graph that made it, or **remixed**:
  the agent takes the reconstructed chain and reworks it for a new brief. Exports
  can be **stamped** with their derivation chain written into the file's own
  metadata (PNG/JPEG/WebP/MP4/MP3), and anyone can verify a stamped file on the
  public `/inspect` page with no account. If a platform stripped the metadata, a
  sha256 match against the library takes over.
- **AI search.** Every asset is auto-enriched in the background (vision captions,
  tags, OCR, palette; keyframe analysis for video) and embedded into one vector
  space, so you can search images, video, and audio together by meaning or keyword.

## How it's built

One monorepo, two services:

```
asset-flow/
  app/, components/, lib/   Next.js 16 frontend: React Flow canvas, agent chat,
                            library, public /inspect verifier
  db/, drizzle/             Drizzle ORM owns the Postgres schema and migrations
  backend/                  FastAPI service: graph compiler, GenBlaze engine,
                            provider catalog, job queue, provenance
  public/                   Logos and node icons
```

The backend is split along two deliberate boundaries:

- **`backend/app/graph/` is pure.** No I/O, no SDK imports. The same compiler
  turns a canvas graph into an execution plan for both validation (inline canvas
  errors) and run planning. The agent, quick chains, and hand-drawn canvas all
  produce the same graph spec and pass through the same validator, so the three
  front doors can't drift.
- **`backend/app/engine/` is the only package that imports GenBlaze.** Mock mode
  is one branch in one file, and a missing provider package degrades to a catalog
  status instead of an import error at startup.

Runs execute on a Postgres-backed queue (the `runs` table is the queue: workers
claim with `FOR UPDATE SKIP LOCKED` and hold leases, so a killed worker's jobs are
picked up again). Progress events append to `run_events` with a monotonic sequence
number and stream to the canvas over SSE, with replay on reconnect. Auth is Clerk
on both sides, and errors are RFC 9457 `application/problem+json`.

## How we use GenBlaze

[GenBlaze](https://github.com/backblaze-labs/genblaze) is the engine. It is the
only place in the codebase that talks to AI providers: the compiler turns a canvas
graph into GenBlaze pipeline steps, and GenBlaze handles provider adapters,
fallback models, typed streaming events, hash-bound provenance manifests, and the
B2 sink. Adding a provider is a YAML catalog entry plus a connector install, and
the canvas palette, agent, and provenance features pick it up automatically.

Specifics worth calling out:

- Canvas nodes map to `.step(provider, model=, prompt=, modality=, params=)`,
  edges to `input_from=[...]`, and uploads are ingested as external inputs. Steps
  are topologically sorted with a stable tie-break so step order matches the
  visual reading order of the canvas, which keeps manifest hashes (and GenBlaze's
  step cache) stable across re-saves.
- We run GenBlaze's `ObjectStorageSink` with hierarchical keys so the bucket stays
  browsable, and lazy transfer so users see results from the provider CDN while
  the archival upload to B2 finishes in the background.
- GenBlaze's stock compositor takes exactly one video and one audio, so we wrote
  our own ffmpeg provider for the multi-track composition node. It honors clip
  timing, per-track gain, and mutes while keeping every input on the provenance
  chain.
- Its chat connector (`genblaze_gmicloud`) also powers non-canvas features:
  vision enrichment for search and the workflow-builder agent.

Six providers, 30+ models, one pipeline: GMI Cloud (Seedance, Kling, Seedream,
lipsync, Hunyuan 3D, plus the agent and vision models), Replicate (Nano Banana,
GPT Image, Sora 2, Kimi K2.6, Qwen edit models, Ideogram Layerize), Runway
(Gen-4.5 and Recipes), Luma (Ray 3.2, Uni-1), ElevenLabs (speech, music, SFX,
Scribe), and Decart (Lucy video editing, try-on). A mock provider runs the entire
app credential-free with real playable sample media.

## How we use Backblaze B2

**B2 is the system of record; Postgres is just a rebuildable index over it.**
The canonical truth for any asset is its hash-verified manifest in the bucket.
Manifests, generated media, upload originals, enrichment metadata (JSON written
beside each object), caption sidecars, and Magic Text layers all live in B2, and
lineage can be rebuilt from the bucket alone if the database disappears.

The bucket is private. Manifests and database rows store only durable URLs, and
the API mints short-lived presigned URLs per request (a presigned URL embeds the
key id and expires, so persisting one would break manifest hash stability). The
manifest endpoint deliberately re-reads and re-verifies from B2 instead of echoing
its own database row: metadata inside a file is a claim, the hash-verified record
in immutable storage is the proof. That is what makes the stamped-export and
`/inspect` verification story honest.

## Setup

### Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io)
- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- A Postgres database (we use Supabase; any Postgres with pgvector works)
- ffmpeg on your PATH (for composition, captions, and waveforms)
- A [Clerk](https://clerk.com) application (free tier is fine)

### 1. Clone and install

```bash
git clone <this-repo> && cd asset-flow
pnpm install
cd backend && uv sync --all-groups && cd ..
```

### 2. Configure the frontend (repo root `.env`)

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/workflow
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/workflow
DATABASE_URL=postgresql://...
GMI_API_KEY=...        # powers agent mode; optional if you skip the agent
```

The backend reads `DATABASE_URL` and the Clerk keys from this same file, so they
are configured once. `NEXT_PUBLIC_API_URL` defaults to `http://localhost:8000`.

### 3. Create the database schema

Drizzle owns the schema; the backend mirrors it and runs no migrations of its own.

```bash
pnpm db:generate && pnpm db:migrate
```

### 4. Run the backend (no credentials needed)

```bash
cd backend
cp .env.example .env    # defaults: mock providers + local storage
uv run uvicorn app.main:create_app --factory --reload --port 8000
```

The defaults need no API keys and no bucket: mock providers generate, and local
storage writes real playable files under `backend/.data/media`. To sanity-check
end to end, `uv run python -m app.scripts.demo` in another terminal seeds a
workflow, runs it, and tails the live event stream.

### 5. Run the frontend

```bash
pnpm dev
```

Open <http://localhost:3000>, sign up through Clerk, and build a workflow.

### 6. Go live: B2 and real providers (optional)

Follow [backend/docs/b2-setup.md](backend/docs/b2-setup.md) to create a private
bucket and a bucket-scoped application key (about ten minutes), then in
`backend/.env`:

```bash
STORAGE_MODE=b2
B2_KEY_ID=...
B2_APP_KEY=...
B2_BUCKET=assetflow-media-xxxx
B2_REGION=...           # must match the bucket's real region
```

Verify the bucket wiring with `uv run python -m app.scripts.b2_doctor`, which
runs the app's own code paths and names the exact misconfiguration instead of a
generic auth error.

For real generation, install the provider adapters and add keys for whichever
providers you want (unconfigured ones stay in the catalog with a reason instead
of disappearing):

```bash
cd backend && uv sync --extra providers
```

Then set `GENBLAZE_MODE=live` in `backend/.env` along with any of `GMI_API_KEY`,
`REPLICATE_API_TOKEN`, `RUNWAYML_API_SECRET`, `LUMAAI_API_KEY`,
`ELEVENLABS_API_KEY`, or `DECART_API_KEY`. Two features piggyback on those keys:
the LLM node runs on `REPLICATE_API_TOKEN` (Kimi K2.6), and enrichment's vision
pass runs on `GMI_API_KEY`. Adding `JINA_API_KEY` enables vector search; without
it, search degrades gracefully to keyword-only. Every option, with what it does,
is documented inline in [backend/.env.example](backend/.env.example).

### Testing

```bash
cd backend
uv run pytest -q          # credential-free, no database needed
uv run ruff check app tests
```

More depth: [backend/README.md](backend/README.md) covers the compiler, queue,
and streaming design, and [backend/docs/sdk-findings.md](backend/docs/sdk-findings.md)
documents the GenBlaze quirks we verified the hard way.

## License

Licensed under the [Apache License 2.0](LICENSE).
