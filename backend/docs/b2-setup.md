# Backblaze B2 setup

Ten minutes in the B2 console, then one command to verify. Every step below has
to happen in your browser — account creation and key handling are yours, not
something to automate.

Verify at any point with:

```bash
cd backend && uv run python -m app.scripts.b2_doctor
```

It runs the same code paths the app uses and names the specific problem
(wrong region, master key, missing capability, public bucket) instead of
surfacing a generic auth error.

---

## 1. Account

Sign up at <https://www.backblaze.com/sign-up/cloud-storage>, verify the email,
and enable 2FA while you're there.

Free tier is 10 GB of storage with egress free up to 3× stored bytes/day —
ample for this project.

## 2. Create the bucket

**B2 Cloud Storage → Buckets → Create a Bucket.**

| Setting | Value | Why |
|---|---|---|
| Bucket name | `assetflow-media-<4 random chars>` | Globally unique across all of B2, so plain `assetflow-media` is likely taken. |
| Files in Bucket | **Private** | Generated media stays non-public; the API mints short-lived presigned URLs at serve time. |
| Default Encryption | Enable | Free, and one less question at judging. |
| Object Lock | **Enable** (optional) | ⚠️ **Cannot be turned on after creation.** You don't have to lock anything — enabling it just preserves the option to make provenance manifests tamper-evident later, which lands directly on the hackathon's B2 criterion. |

⚠️ If you use Object Lock, only ever apply **GOVERNANCE** mode. **COMPLIANCE**
means nobody can delete the object until retention expires — including you.

Object Lock forces versioning on, so pair it with the lifecycle rule in step 6
or old versions accumulate.

## 3. Note the region

Open the bucket and look at its **Endpoint**, e.g.
`s3.us-west-004.backblazeb2.com`. The middle segment is your region:
`us-west-004`.

⚠️ Get this right. B2 does **not** redirect cross-region requests — some
regions (notably `us-east-005`) answer a wrong-region request with a bare
`403`, so it looks like an auth failure rather than a region mismatch. If that
happens, `b2_doctor` probes the other regions and tells you which one the
bucket actually lives in.

## 4. Create an application key

**Account → Application Keys → Add a New Application Key.**

| Setting | Value |
|---|---|
| Name | `assetflow-backend` |
| Allow access to Bucket | **select your bucket only** — not "All" |
| Type of Access | Read and Write |
| Allow List All Bucket Names | ✅ (used by the readiness probe) |

⚠️ **Do not use the master application key.** B2's master key is rejected by the
S3-compatible API outright, and the failure is opaque. `b2_doctor` detects this
by key length and says so.

⚠️ **The secret is shown exactly once.** Copy both values before leaving the page.

## 5. Configure the backend

Add to `backend/.env` (already gitignored):

```bash
B2_KEY_ID=<keyID>
B2_APP_KEY=<applicationKey>
B2_BUCKET=assetflow-media-xxxx
B2_REGION=us-west-004        # must match step 3
B2_PREFIX=assetflow
```

Leave `STORAGE_MODE=local` for now — the doctor checks the credentials either
way, and you can switch once it passes.

```bash
uv run python -m app.scripts.b2_doctor
```

Expected:

```
1. credentials        ✓ B2_KEY_ID set  ✓ B2_APP_KEY set  ✓ B2_BUCKET set
2. bucket + region    ✓ connected
3. write/read/delete  ✓ write  ✓ read  ✓ content-type preserved  ✓ list
4. URLs               ✓ durable URL  ✓ bucket is private  ✓ presigned URL fetches
5. cleanup            ✓ deleted the probe object
✓ B2 is ready. Set STORAGE_MODE=b2 and re-run the demo.
```

## 6. Lifecycle rules (in the console, not in code)

**Bucket → Lifecycle Settings → Use custom rules.**

- Keep only the last version of a file: `daysFromHidingToDeleting = 1`
- Optional dev hygiene: delete files under `assetflow/_doctor/` and
  `assetflow/_test/` after 1 day.

Set this in the console rather than via `auto_lifecycle=True` in code: that flag
issues a bucket-wide configuration write, which a correctly-scoped
least-privilege key will be refused. Declaring lifecycle as bucket policy rather
than granting the app permission to rewrite it is also the better answer at
judging.

## 7. CORS (only if you need it)

Not required for playback — `<img>` and `<video>` are not CORS-gated, and the
API's presign redirect handles them. You need CORS only for browser
`fetch()` of B2 directly or presigned direct upload.

**Bucket → CORS Rules → Share everything in this bucket with all HTTPS origins**
is the quick option; for a scoped rule, allow origins
`http://localhost:3000` plus your deployed domain, operations `s3_get`,
`s3_head`, `s3_put`, and expose `etag`, `content-length`.

## 8. Switch the app over

```bash
# backend/.env
STORAGE_MODE=b2
```

Then:

```bash
uv run uvicorn app.main:create_app --factory --reload --port 8000
uv run python -m app.scripts.demo          # another terminal
uv run pytest -m b2 -v                     # the real-B2 suite
```

What changes versus local mode:

- Assets upload to `assetflow/runs/<tenant>/<date>/<run_id>/` — tenant isolation
  is visible in the bucket browser.
- A canonical **provenance manifest** is written alongside each run, and
  `GET /v1/runs/{id}/manifest` re-reads it *from B2* and re-verifies the hash.
- `manifest.verified` flips from `null` to `true`. It is `null` in local mode on
  purpose: `verify()` can pass on a provider-declared hash, which would be a
  misleading badge when nothing was durably stored.
- `GET /v1/assets/{id}/content` starts issuing presigned redirects instead of
  serving from disk.

## 9. Frontend

Add the bucket host to `next.config.ts` when the canvas starts rendering media:

```ts
images: {
  remotePatterns: [
    { protocol: "https", hostname: "<bucket>.s3.<region>.backblazeb2.com", pathname: "/**" },
  ],
}
```

Prefer plain `<img>` on the canvas — `next/image` routes every thumbnail through
the Next server, and a board with dozens of node previews will burn Vercel's
optimization quota during judging. Save `next/image` for the gallery.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `SinkError: N/N asset transfer(s) failed` | The provider returned a URL the sink cannot fetch. The sink hashes every asset and refuses to write an unverifiable manifest — that is the provenance guarantee working. Stock `genblaze_core.mocks` URLs (`https://mock.test/…`) always fail this way; use `app/engine/mock_providers.py`. |
| `Access denied: local file path … outside allowed directories` | A `file://` source must live under the system temp dir or a provider's `output_dir`. Stage it into temp. |
| Manifest 404s for a run id that clearly exists | You used our database run id. B2 keys objects by GenBlaze's run id — see `runs.genblaze_run_id`. |
| `403` on every operation | Wrong region (B2 does not redirect), or a master key. Run the doctor — it probes regions and checks key shape. |
| `NoCredentialsError` mid-upload | `B2_KEY_ID`/`B2_APP_KEY` not reaching the process. Values live in `backend/.env`, not the repo root. |
| Bucket not found | Name typo, or the key is scoped to a different bucket. |
| Video won't play inline | `Content-Type` recorded at upload was wrong (e.g. `application/octet-stream`). The doctor and `test_content_type_is_preserved` both check this. |
| `fetch()` on an asset URL fails, `<video>` works | Expected. B2 sends no CORS headers on the redirect target — see step 7. |
| Doctor warns "bucket is PUBLIC" | Files-in-Bucket is set to Public. Change it to Private unless that was deliberate. |
| `auto_lifecycle=True` raises | A bucket-scoped key can't rewrite bucket config. Use step 6 instead. |
