# GenBlaze SDK findings

Verified empirically against `genblaze==0.4.3` / `genblaze-core==0.3.6` /
`genblaze-s3==0.3.5` on 2026-07-22. Several of these contradict the published
docs — trust this file, and re-verify after any SDK bump.

## Contradicts the docs

**`on_submit=` does not exist.** `docs/features/queue-integration.md` shows
`.run(on_submit=checkpoint)` as the crash-recovery hook. It is not a parameter
of `run()`, `arun()`, or `astream()`, and `run`/`arun` accept no `**kwargs`, so
passing it raises `TypeError`.

*Consequence:* checkpoint upstream job ids from the `request_id` field carried on
`step.progress` / `step.completed` / `step.failed` instead. Same value, available
from the first progress tick rather than immediately after submit.

**Mock providers live in `genblaze_core.mocks`.** Not `genblaze_core.testing`
(that module imports `pytest` and raises `ModuleNotFoundError` in a normal
install), and not re-exported at the `genblaze_core` top level.

```python
from genblaze_core.mocks import MockProvider, MockVideoProvider, MockAudioProvider
```

`MockProvider(*, name, assets, latency, should_fail, error_code, error_message,
cost_usd)` — `latency` and `should_fail` make failure and slow-path testing easy.

## Event stream

`astream(*, heartbeats=True, **run_kwargs)` forwards kwargs to `arun()`, so
`sink=`, `max_concurrency=`, `pipeline_timeout=`, `fail_fast=` all work.

**`step` and `result` are excluded from serialization.** Confirmed: the
`step.completed` wire payload has no `step` key. The attribute *is* populated on
the live Python object, so the worker reads `event.step.assets` and synthesizes
its own asset frame.

**Wire fields per event** (what survives `model_dump()`):

| Event | Has `step_index` | Has `step_id` | Notable |
|---|---|---|---|
| `pipeline.started` | — | — | `total_steps` |
| `step.started` | yes | yes | `expected_duration_sec` |
| `step.progress` | **no** | yes | `progress_pct`, `preview_url`, `request_id`, `is_heartbeat` |
| `step.completed` | yes | yes | `step_status`, `request_id` |
| `step.failed` | yes | yes | `error` (**not** `message`) |
| `pipeline.completed` / `.failed` | — | — | `manifest_hash`, `run_status` |

**`step.progress` has no `step_index`.** Node identity therefore cannot be
resolved from a progress event alone. The runner learns `step_id -> node_id` at
`step.started` (which has both `step_index` and `step_id`, and the plan maps
index to node) and applies that map to every later event for the same step.

`node_id` itself round-trips through `.step(metadata={"node_id": ...})` and is
readable at `step.completed` via `event.step.metadata["node_id"]`.

## Assets, manifests, cost

- `Asset`: `url`, `media_type`, `sha256`, `size_bytes` (may be `None` without a sink).
- `Step`: includes `step_index`, `status`, `assets`, `cost_usd`, `error_code`,
  `retries`, `params`, `metadata`. `metadata["upstream_id"]` holds the provider
  job id (`"sync"` for mocks).
- **`cost_usd` is `None`** — the SDK ships zero pricing as of 0.3.0. Any cost
  display requires registering rates on a forked `ModelRegistry`.
- `manifest.manifest_uri` is `None` without a sink.
- **`manifest.verify()` can return `True` without a sink** if assets already
  declare a `sha256` (mocks do). It is not a proxy for "bytes were durably
  stored", so report `verified: null` in local mode rather than echoing it.

## Storage

`ObjectStorageSink(backend, *, prefix="genblaze",
key_strategy=CONTENT_ADDRESSABLE, parquet_sink, max_upload_workers=4,
manifest_lock, pipelined_transfer=False, eager_transfer=False,
asset_url_policy=URLPolicy.AUTO, strict_manifest_reads)`

- Defaults are `prefix="genblaze"` and `CONTENT_ADDRESSABLE` — pass
  `KeyStrategy.HIERARCHICAL` explicitly for a tenant-browsable layout.
- **`eager_transfer=True`** is the lever for getting assets into B2 during the
  run rather than at `write_run`. Worth enabling so mid-run previews point at
  durable URLs; re-measure when B2 credentials exist.
- Methods: `write_run`, `put_asset(s)`, `read_manifest`,
  `read_manifest_for_asset`, `manifest_key_for`, `manifest_url_for`, `close`.

`S3StorageBackend.for_backblaze(bucket=None, *, region=None, key_id=None,
app_key=None, public_url_base=None, auto_lifecycle=False, preflight=True)`
— env fallbacks `B2_BUCKET` / `B2_REGION` / `B2_KEY_ID` / `B2_APP_KEY`.

For the private-bucket + presign-on-demand design: `get_durable_url(key)` for
anything persisted, `presigned_get_url(key, ...)` at serve time, and
`key_from_url(url)` to map a stored durable URL back to a key.

## Sink asset transfer (verified against a live B2 bucket)

`ObjectStorageSink` **fetches every asset in order to hash it**, then refuses to
upload a manifest it could not verify:

```
SinkError: Run <id>: 2/2 asset transfer(s) failed; manifest was not uploaded
```

That is the provenance guarantee working, not a bug — but it means **the stock
`genblaze_core.mocks` providers cannot be used with a sink**, because they return
unreachable `https://mock.test/...` URLs. `app/engine/mock_providers.py` exists
for this: sample-backed mocks whose assets the sink can really transfer, so mock
mode behaves identically with and without B2.

Accepted source forms are `file://` and `https://`. Local paths are guarded:

```
Access denied: local file path /… is outside allowed directories.
Files must be under temp or output_dir.
```

So a `file://` source must sit under the system temp dir or a provider's
`output_dir` — a deliberate defence against a provider coaxing the sink into
reading arbitrary local files. We stage bundled samples into
`$TMPDIR/assetflow-samples/` for exactly this reason.

**`Run.run_id` is not our database id.** The sink keys objects by GenBlaze's own
run id: `{prefix}/runs/{tenant}/{date}/{genblaze_run_id}/…`. Our `runs` row has
its own UUID, so `runs.genblaze_run_id` is what links the two — do not try to
locate a manifest in B2 using the database id.

Verified end to end against a live private bucket: assets land at
`assetflow/runs/{tenant}/{date}/{run_id}/assets/{asset_id}.mp4`, `manifest.json`
sits alongside, `sha256` is computed from the transferred bytes, and
`Manifest.verify()` returns `True`.

## Adjacent gotchas (not GenBlaze, but found alongside it)

**SSE frames are CRLF-delimited.** `sse_starlette` emits
`id: 1\r\nevent: x\r\ndata: {...}\r\n\r\n`. A reader that splits on `"\n\n"`
matches nothing — `\r\n\r\n` contains no `\n\n` substring — so the buffer grows
forever and no event is ever dispatched, with no error. Normalize `\r\n` to
`\n` before splitting. The canvas's reader must do this too.

**Enum columns in raw SQL need `CAST(:x AS run_status)`.** The Postgres cast
shorthand `:x::run_status` collides with SQLAlchemy `text()`'s own `:param`
syntax and fails at execution with a syntax error. Likewise, a `CASE` expression
assigned to an enum column needs an explicit `::run_status` on the *expression*
(no bind parameter involved there, so the shorthand is safe).

**A failed statement poisons the transaction.** If a run's failure is itself a
database error, every later statement — including the ones recording the failure
— is rejected with `InFailedSQLTransactionError`, stranding the run in `running`
until the lease sweep rescues it. Roll back before writing failure state.

## Enums

```
Modality:   image video audio text
StepType:   generate upscale transcode mix edit custom ingest import
StepStatus: pending submitted processing succeeded failed cancelled
RunStatus:  pending running completed failed cancelled
KeyStrategy: hierarchical content_addressable
URLPolicy:   auto public presigned
```

`Pipeline.ingest(assets, *, source, source_metadata=None, sink=None, name=None,
tenant_id=None, step_type=StepType.INGEST)` exists as documented — this is the
upload node, and it gives uploads a real provenance manifest.

`Pipeline(name, tenant_id, *, project_id, chain, structured_log,
max_concurrency, moderation, tracer, preflight)`.
