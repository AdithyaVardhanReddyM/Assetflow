"""Diagnose a Backblaze B2 setup end to end.

    uv run python -m app.scripts.b2_doctor

Runs the same code paths the app uses — construct backend, write, read, presign,
delete — and turns each known B2 trap into a specific, actionable message rather
than a generic auth error. Safe to re-run: it only touches keys under
`<prefix>/_doctor/` and deletes them afterwards.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from typing import Any

import httpx

from app.config import get_settings

OK = "\033[32m✓\033[0m"
BAD = "\033[31m✗\033[0m"
WARN = "\033[33m!\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"

# Published B2 S3 regions, for the probe when a bucket answers 403 instead of
# redirecting to its real region.
KNOWN_REGIONS = ("us-west-000", "us-west-001", "us-west-002", "us-west-004",
                 "us-east-005", "eu-central-003")

_failures: list[str] = []
_warnings: list[str] = []


def ok(msg: str, detail: str = "") -> None:
    print(f"  {OK} {msg}" + (f"  {DIM}{detail}{RESET}" if detail else ""))


def bad(msg: str, hint: str = "") -> None:
    print(f"  {BAD} {msg}")
    if hint:
        print(f"      {DIM}→ {hint}{RESET}")
    _failures.append(msg)


def warn(msg: str, hint: str = "") -> None:
    print(f"  {WARN} {msg}")
    if hint:
        print(f"      {DIM}→ {hint}{RESET}")
    _warnings.append(msg)


def check_env() -> bool:
    print(f"\n{BOLD}1. credentials{RESET}")
    s = get_settings()
    missing = [
        name
        for name, value in (
            ("B2_KEY_ID", s.b2_key_id),
            ("B2_APP_KEY", s.b2_app_key),
            ("B2_BUCKET", s.b2_bucket),
        )
        if not value
    ]
    if missing:
        bad(
            f"missing: {', '.join(missing)}",
            "Add them to backend/.env — see .env.example.",
        )
        return False

    ok("B2_KEY_ID set", f"{s.b2_key_id[:6]}…{s.b2_key_id[-4:]} ({len(s.b2_key_id)} chars)")
    ok("B2_APP_KEY set", f"({len(s.b2_app_key)} chars)")
    ok("B2_BUCKET set", s.b2_bucket)
    ok("B2_REGION set", s.b2_region)

    # A master key's id is the 12-char account id. Master keys are rejected by
    # the S3-compatible API entirely, and the resulting error is opaque.
    if len(s.b2_key_id) <= 12:
        bad(
            "B2_KEY_ID looks like a master application key",
            "Master keys cannot be used with the S3-compatible API. Create a "
            "bucket-scoped key: Account → Application Keys → Add a New Application Key.",
        )
        return False

    if s.storage_mode.value != "b2":
        warn(
            f"STORAGE_MODE is '{s.storage_mode.value}', not 'b2'",
            "Credentials will be checked, but the app still writes locally. "
            "Set STORAGE_MODE=b2 in backend/.env when you're ready to switch.",
        )
    return True


def build_backend() -> Any | None:
    print(f"\n{BOLD}2. bucket + region{RESET}")
    s = get_settings()
    from genblaze_s3 import S3StorageBackend

    try:
        backend = S3StorageBackend.for_backblaze(
            s.b2_bucket,
            region=s.b2_region,
            key_id=s.b2_key_id,
            app_key=s.b2_app_key,
            # preflight issues one HeadBucket, so bad credentials or a wrong
            # region surface here rather than mid-upload.
            preflight=True,
        )
    except Exception as exc:  # noqa: BLE001 - the whole point is to explain it
        message = str(exc)
        detail = f"{type(exc).__name__}: {message}"

        if "lives in" in message or "region" in message.lower():
            bad("wrong region", f"{detail}\n      Set B2_REGION to the region named above.")
        elif "403" in message or "Forbidden" in message or "signature" in message.lower():
            bad(
                "authentication rejected",
                "Check the key id/secret, and that the key's capabilities include "
                "listBuckets, listFiles, readFiles, writeFiles, deleteFiles.\n"
                f"      {detail}",
            )
        elif "404" in message or "not exist" in message.lower():
            bad("bucket not found", f"Check B2_BUCKET spelling.\n      {detail}")
        else:
            bad("could not connect", detail)

        probe_regions()
        return None

    ok("connected", f"bucket={s.b2_bucket} region={s.b2_region}")
    return backend


def probe_regions() -> None:
    """Find which region actually answers for this bucket.

    B2 does not redirect cross-region — some regions return a bare 403 — so the
    region cannot be auto-detected from a failed request.
    """
    s = get_settings()
    if not (s.b2_bucket and s.b2_key_id and s.b2_app_key):
        return
    print(f"      {DIM}probing regions for '{s.b2_bucket}'…{RESET}")
    from genblaze_s3 import S3StorageBackend

    for region in KNOWN_REGIONS:
        if region == s.b2_region:
            continue
        try:
            S3StorageBackend.for_backblaze(
                s.b2_bucket, region=region, key_id=s.b2_key_id,
                app_key=s.b2_app_key, preflight=True,
            )
        except Exception:  # noqa: BLE001 - probing, failures are expected
            continue
        print(f"      {OK} bucket answers in {BOLD}{region}{RESET} — set B2_REGION={region}")
        return
    print(f"      {DIM}no other region answered; check the bucket name and key{RESET}")


def check_roundtrip(backend: Any) -> str | None:
    print(f"\n{BOLD}3. write / read / delete{RESET}")
    s = get_settings()
    key = f"{s.b2_prefix}/_doctor/{uuid.uuid4().hex}.txt"
    payload = b"asset-flow b2 doctor\n"

    try:
        backend.put(key, payload, content_type="text/plain")
        ok("write", key)
    except Exception as exc:  # noqa: BLE001
        bad("write failed", f"The key likely lacks writeFiles.\n      {type(exc).__name__}: {exc}")
        return None

    try:
        fetched = backend.get(key)
        if fetched != payload:
            bad("read returned different bytes")
        else:
            ok("read", f"{len(fetched)} bytes match")
    except Exception as exc:  # noqa: BLE001
        bad("read failed", f"The key likely lacks readFiles.\n      {type(exc).__name__}: {exc}")

    try:
        meta = backend.head(key)
        ctype = getattr(meta, "content_type", None)
        if ctype == "text/plain":
            ok("content-type preserved", ctype)
        else:
            # B2 serves whatever was recorded at upload; a wrong value breaks
            # inline <video> playback later.
            warn(f"content-type came back as {ctype!r}, expected 'text/plain'")
    except Exception as exc:  # noqa: BLE001
        warn(f"head failed: {type(exc).__name__}: {exc}")

    try:
        # ListPage exposes `entries`; a wrong attribute name here would silently
        # report a passing check against an empty list.
        entries = backend.list(prefix=f"{s.b2_prefix}/_doctor/", max_keys=5).entries
        if any(e.key == key for e in entries):
            ok("list", f"found the object among {len(entries)} entry(s)")
        else:
            warn(
                f"list returned {len(entries)} entry(s) but not the object just written",
                "Listing may be eventually consistent, or the key lacks listFiles.",
            )
    except Exception as exc:  # noqa: BLE001
        warn(
            f"list failed: {type(exc).__name__}: {exc}",
            "The key may lack listFiles. The app does not need it, but /readyz uses it.",
        )

    return key


def check_urls(backend: Any, key: str) -> None:
    print(f"\n{BOLD}4. URLs (private bucket + presign-on-demand){RESET}")

    try:
        durable = backend.get_durable_url(key)
        ok("durable URL", durable)
    except Exception as exc:  # noqa: BLE001
        bad(f"get_durable_url failed: {type(exc).__name__}: {exc}")
        return

    # Durable URLs are what we persist in manifests and the database. On a
    # private bucket they must NOT be publicly readable.
    try:
        response = httpx.get(durable, timeout=20.0, follow_redirects=True)
        if response.status_code == 200:
            warn(
                "the durable URL is publicly readable — this bucket is PUBLIC",
                "Anyone with the URL can read your generated media forever. "
                "Set the bucket to Private in the B2 console if that was not "
                "intended (the app presigns at serve time either way).",
            )
        else:
            ok("bucket is private", f"unauthenticated GET → HTTP {response.status_code}")
    except Exception as exc:  # noqa: BLE001
        warn(f"could not probe the durable URL: {type(exc).__name__}: {exc}")

    try:
        presigned = backend.presigned_get_url(key, expires_in=300)
    except Exception as exc:  # noqa: BLE001
        bad(f"presigned_get_url failed: {type(exc).__name__}: {exc}")
        return

    try:
        response = httpx.get(presigned, timeout=20.0, follow_redirects=True)
        if response.status_code == 200:
            ok("presigned URL fetches", f"HTTP 200, {len(response.content)} bytes")
        else:
            bad(
                f"presigned URL returned HTTP {response.status_code}",
                "Media playback in the browser depends on this working.",
            )
    except Exception as exc:  # noqa: BLE001
        bad(f"presigned fetch failed: {type(exc).__name__}: {exc}")

    # Round-tripping a stored URL back to a key is how GET /v1/assets/{id}/content
    # presigns something it only has a durable URL for.
    recovered = backend.key_from_url(durable)
    if recovered == key:
        ok("key_from_url round-trips")
    else:
        bad(f"key_from_url returned {recovered!r}, expected {key!r}")

    # CORS cannot be verified without a browser: B2 only emits
    # Access-Control-Allow-Origin when the request carries an Origin header it
    # is configured to accept.
    try:
        response = httpx.get(
            presigned, timeout=20.0, headers={"Origin": "http://localhost:3000"}
        )
        if response.headers.get("access-control-allow-origin"):
            ok("CORS configured for localhost:3000")
        else:
            warn(
                "no CORS header for http://localhost:3000",
                "Fine for <img>/<video>, which are not CORS-gated. Needed only if "
                "the browser fetch()es B2 directly, or for presigned direct upload.",
            )
    except Exception:  # noqa: BLE001 - informational only
        pass


def cleanup(backend: Any, key: str) -> None:
    print(f"\n{BOLD}5. cleanup{RESET}")
    try:
        backend.delete(key)
        ok("deleted the probe object")
    except Exception as exc:  # noqa: BLE001
        warn(
            f"delete failed: {type(exc).__name__}: {exc}",
            f"The key may lack deleteFiles. Remove {key} manually.",
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--keep", action="store_true", help="leave the probe object in the bucket"
    )
    args = parser.parse_args()

    print(f"{BOLD}Backblaze B2 doctor{RESET}")

    if not check_env():
        return summarize()

    backend = build_backend()
    if backend is None:
        return summarize()

    key = check_roundtrip(backend)
    if key:
        check_urls(backend, key)
        if not args.keep:
            cleanup(backend, key)

    return summarize()


def summarize() -> int:
    print()
    if _failures:
        print(f"{BAD} {len(_failures)} problem(s): {'; '.join(_failures)}")
        return 1
    if _warnings:
        print(f"{WARN} {len(_warnings)} warning(s) — B2 works, review the notes above.")
        return 0
    print(f"{OK} B2 is ready. Set STORAGE_MODE=b2 and re-run the demo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
