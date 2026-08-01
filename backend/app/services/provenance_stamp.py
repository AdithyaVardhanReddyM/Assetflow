"""Provenance that travels inside the file itself.

The library's lineage panel answers "how was this made?" for people with an
account. The moment a file leaves — downloaded, sent over Discord, handed to a
client — that answer used to stay behind. Stamping writes a compact copy of the
derivation into the media's own metadata, so the file carries its history to
whoever receives it; the public /v1/inspect endpoint reads it back out.

Every embed here is lossless on the pixels/samples:

- PNG gains an ``iTXt`` chunk in the standard XMP slot (``XML:com.adobe.xmp``).
- JPEG gains a standard XMP APP1 segment after any JFIF/EXIF segments.
- WebP gains an ``XMP `` RIFF chunk (decoders skip unknown chunks by contract);
  when a VP8X header exists its XMP flag is set too.
- MP4/MP3 are remuxed by ffmpeg with ``-c copy`` and a format tag.

The stamped copy is a *different file* from the library asset — its bytes (and
so its sha256) change. That is inherent: the original stays canonical in
storage, and the export is the original plus its own story. Inspect therefore
matches stripped copies by the *original* hash only when the bytes are
untouched; a stamped file is matched by the record it carries.

The payload is a claim, not a proof — metadata is editable by anyone with a hex
editor. The canonical, hash-verified record stays in B2; the payload names the
asset and run so inspect can prefer the live record whenever it still exists.
"""

from __future__ import annotations

import json
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path
from typing import Any

import httpx

from app.config import Settings, StorageMode
from app.db.models import Asset, Run, RunStep
from app.errors import AppError, NotFound
from app.logging import get_logger
from app.services.lineage import build_chain

log = get_logger(__name__)


class StampFailed(AppError):
    status, code, title = 422, "stamp_failed", "Could not stamp the file"


#: Media types the stamp knows how to write. Everything else (wav has no
#: custom-tag slot ffmpeg preserves, text needs none) downloads plain.
STAMPABLE = {"image/png", "image/jpeg", "image/webp", "video/mp4", "audio/mpeg"}

#: A JPEG APP1 segment tops out at 65533 bytes including the XMP header, and
#: one ceiling for every format keeps the payload predictable. Payloads are
#: shrunk (shorter prompts, then fewer hops) until they fit under this.
_PAYLOAD_CEILING = 60_000

_XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"
_MARK_OPEN = "<af:provenance>"
_MARK_CLOSE = "</af:provenance>"
#: The ffmpeg-format tag key. Lowercase on purpose: mp4 keeps it verbatim under
#: ``use_metadata_tags`` and id3v2 folds it into a TXXX description.
TAG_KEY = "assetflow_provenance"

_FFMPEG_TIMEOUT_SEC = 120


# --- the payload ------------------------------------------------------------


def _clip(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def build_payload(
    session: Any, *, asset: Asset, tenant_id: str, prompt_limit: int = 400
) -> dict[str, Any]:
    """The derivation of `asset`, compact enough to live inside the file.

    No thumbnails and no presigned URLs — those rot in hours, and this record
    should still read in a year. Hops carry the ids and hashes instead, so a
    reader holding library access can look the files back up.
    """

    def compact(a: Asset) -> dict[str, Any]:
        return {"id": str(a.id), "sha256": a.sha256}

    payload: dict[str, Any] = {
        "assetflow": 1,
        "asset_id": str(asset.id),
        "sha256": asset.sha256,
        "media_type": asset.media_type,
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
        "chain": None,
        "step": None,
        "run": None,
    }

    if asset.run_id is None:
        return payload

    run = await session.get(Run, asset.run_id)
    if run is None or run.tenant_id != tenant_id:
        return payload

    payload["run"] = {
        "id": str(run.id),
        "manifest_hash": run.manifest_hash,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }

    if asset.node_id:
        from sqlalchemy import select

        step = (
            await session.execute(
                select(RunStep).where(
                    RunStep.run_id == asset.run_id, RunStep.node_id == asset.node_id
                )
            )
        ).scalar_one_or_none()
        if step is not None:
            payload["step"] = {
                "provider": step.provider,
                "model": step.model,
                "prompt": _clip(step.prompt, prompt_limit),
                "step_type": step.step_type,
            }

    chain = await build_chain(
        session, run=run, asset=asset, tenant_id=tenant_id, serialize=compact
    )
    if chain is not None:
        payload["chain"] = {
            "hops": [
                {
                    "id": hop["id"],
                    "kind": hop["kind"],
                    "depth": hop["depth"],
                    "title": hop["title"],
                    "text": _clip(hop["text"], prompt_limit),
                    "provider": hop["provider"],
                    "model": hop["model"],
                    "prompt": _clip(hop["prompt"], prompt_limit),
                    "step_type": hop["step_type"],
                    "asset": hop["assets"][0] if hop["assets"] else None,
                }
                for hop in chain["hops"]
            ],
            "edges": chain["edges"],
            "truncated": chain["truncated"],
        }
    return payload


def encode_payload(payload: dict[str, Any]) -> str:
    """Serialize under the JPEG segment ceiling, shedding detail before hops."""
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    if len(body.encode("utf-8")) <= _PAYLOAD_CEILING:
        return body

    slim = json.loads(body)
    chain = slim.get("chain") or {}
    for hop in chain.get("hops", []):
        hop["prompt"] = _clip(hop["prompt"], 120)
        hop["text"] = _clip(hop["text"], 120)
    body = json.dumps(slim, separators=(",", ":"), ensure_ascii=False)
    if len(body.encode("utf-8")) <= _PAYLOAD_CEILING:
        return body

    # A history this deep no longer fits in a JPEG segment; keep the newest
    # hops (lowest depth — the file's own end of the story) and say so.
    hops = sorted(chain.get("hops", []), key=lambda h: h["depth"])[:40]
    kept = {h["id"] for h in hops}
    chain["hops"] = hops
    chain["edges"] = [
        e for e in chain.get("edges", []) if e["source"] in kept and e["target"] in kept
    ]
    chain["truncated"] = True
    return json.dumps(slim, separators=(",", ":"), ensure_ascii=False)


# --- XMP wrapper ------------------------------------------------------------


def _xml_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _xml_unescape(text: str) -> str:
    return text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def _xmp_packet(payload_json: str) -> bytes:
    xml = (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:af="https://assetflow.app/ns/1.0/">'
        f"{_MARK_OPEN}{_xml_escape(payload_json)}{_MARK_CLOSE}"
        "</rdf:Description></rdf:RDF></x:xmpmeta>"
        '<?xpacket end="w"?>'
    )
    return xml.encode("utf-8")


def _from_marked_text(blob: bytes) -> dict[str, Any] | None:
    """The payload between our markers, wherever in the bytes it sits."""
    open_mark = _MARK_OPEN.encode()
    start = blob.find(open_mark)
    if start < 0:
        return None
    end = blob.find(_MARK_CLOSE.encode(), start)
    if end < 0:
        return None
    raw = blob[start + len(open_mark) : end].decode("utf-8", errors="replace")
    try:
        found = json.loads(_xml_unescape(raw))
    except ValueError:
        return None
    return found if isinstance(found, dict) and found.get("assetflow") else None


# --- image byte surgery -----------------------------------------------------

_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _stamp_png(data: bytes, xmp: bytes) -> bytes:
    if not data.startswith(_PNG_SIG):
        raise StampFailed("Not a PNG.")
    # The iTXt lands right after IHDR — inside the signature-checked stream,
    # before the pixel data every decoder actually reads.
    ihdr_len = struct.unpack(">I", data[8:12])[0]
    insert_at = 8 + 8 + ihdr_len + 4
    body = (
        b"XML:com.adobe.xmp\x00"  # keyword
        + b"\x00\x00"  # uncompressed, method 0
        + b"\x00\x00"  # empty language + translated keyword
        + xmp
    )
    chunk = (
        struct.pack(">I", len(body))
        + b"iTXt"
        + body
        + struct.pack(">I", zlib.crc32(b"iTXt" + body) & 0xFFFFFFFF)
    )
    return data[:insert_at] + chunk + data[insert_at:]


def _stamp_jpeg(data: bytes, xmp: bytes) -> bytes:
    if not data.startswith(b"\xff\xd8"):
        raise StampFailed("Not a JPEG.")
    segment_body = _XMP_HEADER + xmp
    if len(segment_body) + 2 > 65533:
        raise StampFailed("Provenance record too large for a JPEG segment.")
    # Standard XMP placement: after SOI and any JFIF/EXIF APP segments already
    # present, so viewers that expect APP0 first keep seeing it first.
    pos = 2
    while (
        pos + 4 <= len(data)
        and data[pos] == 0xFF
        and data[pos + 1] in (0xE0, 0xE1)
    ):
        pos += 2 + struct.unpack(">H", data[pos + 2 : pos + 4])[0]
    segment = b"\xff\xe1" + struct.pack(">H", len(segment_body) + 2) + segment_body
    return data[:pos] + segment + data[pos:]


def _stamp_webp(data: bytes, xmp: bytes) -> bytes:
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise StampFailed("Not a WebP.")
    chunk = b"XMP " + struct.pack("<I", len(xmp)) + xmp
    if len(xmp) % 2:
        chunk += b"\x00"  # RIFF chunks are word-aligned
    out = bytearray(data)
    # A decoder skips chunks it does not know, so appending is safe with or
    # without a VP8X header; when one exists, its XMP flag makes the chunk
    # visible to standard readers too.
    pos = 12
    while pos + 8 <= len(out):
        name = bytes(out[pos : pos + 4])
        size = struct.unpack("<I", out[pos + 4 : pos + 8])[0]
        if name == b"VP8X":
            out[pos + 8] |= 0x04
            break
        pos += 8 + size + (size % 2)
    out += chunk
    out[4:8] = struct.pack("<I", len(out) - 8)
    return bytes(out)


# --- ffmpeg remux for video/audio -------------------------------------------


def _ffmpeg() -> str:
    from genblaze_core.providers._ffmpeg_utils import resolve_ffmpeg

    return resolve_ffmpeg("ffmpeg")


def _stamp_remux(data: bytes, media_type: str, payload_json: str) -> bytes:
    suffix = ".mp4" if media_type == "video/mp4" else ".mp3"
    with tempfile.TemporaryDirectory(prefix="stamp-") as tmp:
        src = Path(tmp) / f"in{suffix}"
        dst = Path(tmp) / f"out{suffix}"
        src.write_bytes(data)
        cmd = [
            _ffmpeg(), "-nostdin", "-v", "error",
            "-i", str(src),
            "-map", "0", "-c", "copy",
        ]
        if media_type == "video/mp4":
            cmd += ["-movflags", "use_metadata_tags"]
        cmd += ["-metadata", f"{TAG_KEY}={payload_json}", str(dst)]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=_FFMPEG_TIMEOUT_SEC
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise StampFailed(f"ffmpeg could not run: {type(exc).__name__}") from exc
        if proc.returncode != 0 or not dst.is_file():
            raise StampFailed(f"ffmpeg failed: {(proc.stderr or '')[-300:]}")
        return dst.read_bytes()


def _probe_tags(path: Path) -> dict[str, Any] | None:
    probe = _ffmpeg().replace("ffmpeg", "ffprobe")
    try:
        out = subprocess.run(
            [
                probe, "-v", "error",
                "-show_entries", "format_tags",
                "-of", "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
        tags = json.loads(out).get("format", {}).get("tags", {})
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    for key, value in tags.items():
        # id3v2 readers report our TXXX frame under its description, and some
        # muxers fold case — match the key wherever it ends up.
        if TAG_KEY in key.lower() and isinstance(value, str):
            try:
                found = json.loads(value)
            except ValueError:
                continue
            if isinstance(found, dict) and found.get("assetflow"):
                return found
    return None


# --- the public face --------------------------------------------------------


def stampable(media_type: str | None) -> bool:
    return (media_type or "") in STAMPABLE


def stamp(data: bytes, media_type: str, payload: dict[str, Any]) -> bytes:
    """`data` with the provenance record written into its metadata."""
    body = encode_payload(payload)
    if media_type == "image/png":
        return _stamp_png(data, _xmp_packet(body))
    if media_type == "image/jpeg":
        return _stamp_jpeg(data, _xmp_packet(body))
    if media_type == "image/webp":
        return _stamp_webp(data, _xmp_packet(body))
    if media_type in ("video/mp4", "audio/mpeg"):
        return _stamp_remux(data, media_type, body)
    raise StampFailed(f"No provenance slot for {media_type}.")


def extract(path: Path, media_type: str | None) -> dict[str, Any] | None:
    """The embedded record, or None when the file carries none.

    Images are scanned for the marked XMP text; container formats are asked
    via ffprobe. When the declared type is missing or wrong the image scan
    still runs — it is a substring search, safe on any bytes.
    """
    kind = media_type or ""
    if kind.startswith(("video/", "audio/")):
        found = _probe_tags(path)
        if found is not None:
            return found
    try:
        blob = path.read_bytes()
    except OSError:
        return None
    return _from_marked_text(blob)


async def fetch_asset_bytes(asset: Asset, settings: Settings) -> bytes:
    """The stored original, whichever storage mode holds it."""
    if settings.storage_mode is StorageMode.B2:
        from app.engine.manifests import presign

        url = presign(asset.b2_key or asset.url, expires_in=3600)
        async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as client:
            resp = await client.get(url)
            if resp.status_code >= 400:
                raise NotFound("The asset's bytes are not reachable in storage.")
            return resp.content

    path = settings.local_media_dir / (asset.b2_key or "")
    if not path.is_file():
        raise NotFound("The asset's bytes are not reachable in storage.")
    return path.read_bytes()
