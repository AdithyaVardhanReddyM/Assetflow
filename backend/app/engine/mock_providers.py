"""Mock providers backed by real sample files.

GenBlaze's stock mocks return unreachable URLs like `https://mock.test/video.mp4`.
That is fine with no sink, but `ObjectStorageSink` fetches every asset in order
to hash it, so those URLs make a B2 run fail with `SinkError: asset transfers
failed` — the sink correctly refusing to write a manifest it cannot verify.

Pointing the mocks at `file://` URLs for the bundled samples (a source form the
sink supports) means mock mode behaves identically with and without B2: real
bytes get transferred, hashed, and covered by a verifiable provenance manifest.
That is what lets the whole B2 provenance story be demonstrated with zero
provider credentials.
"""

from __future__ import annotations

import shutil
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.engine.sinks import SAMPLES_DIR

_SAMPLES = {
    "video": ("sample.mp4", "video/mp4"),
    "image": ("sample.png", "image/png"),
    "audio": ("sample.mp3", "audio/mpeg"),
    "text": ("sample.txt", "text/plain"),
}


@lru_cache(maxsize=8)
def _staged(filename: str) -> Path:
    """Copy a bundled sample into temp, once per process.

    The sink refuses local sources outside temp or a provider's `output_dir`
    ("Access denied: local file path ... is outside allowed directories") — a
    deliberate guard against a provider coaxing it into reading arbitrary files.
    Staging into temp is what a real provider writing local output does anyway.
    """
    source = SAMPLES_DIR / filename
    if not source.exists():  # pragma: no cover - checked by tests
        raise FileNotFoundError(
            f"Missing sample media: {source}. Regenerate it with ffmpeg (see README)."
        )
    staged_dir = Path(tempfile.gettempdir()) / "assetflow-samples"
    staged_dir.mkdir(parents=True, exist_ok=True)
    staged = staged_dir / filename
    if not staged.exists() or staged.stat().st_size != source.stat().st_size:
        shutil.copyfile(source, staged)
    return staged


def _asset(modality: str) -> Any:
    from genblaze_core import Asset

    filename, media_type = _SAMPLES[modality]
    path = _staged(filename)
    # A text asset carries its words in `metadata["text"]` as well as in its
    # bytes: that is the field GenBlaze itself reads text out of (it screens it
    # for moderation), so a consumer never has to fetch and decode the file to
    # learn what an LLM step said.
    metadata = {"text": path.read_text(encoding="utf-8")} if modality == "text" else {}
    # No sha256 here on purpose — the sink computes it from the bytes it actually
    # transfers, which is what makes Manifest.verify() meaningful.
    return Asset(
        url=path.resolve().as_uri(),
        media_type=media_type,
        size_bytes=path.stat().st_size,
        metadata=metadata,
    )


def _provider(modality: str, **kwargs: Any) -> Any:
    from genblaze_core.mocks import MockProvider

    return MockProvider(
        name=f"mock-{modality}",
        assets=[_asset(modality)],
        cost_usd=0.0,
        **kwargs,
    )


def video_provider(**kwargs: Any) -> Any:
    return _provider("video", **kwargs)


def image_provider(**kwargs: Any) -> Any:
    return _provider("image", **kwargs)


def audio_provider(**kwargs: Any) -> Any:
    return _provider("audio", **kwargs)


def text_provider(**kwargs: Any) -> Any:
    """Stands in for an LLM. Returns a sample rewritten prompt, so the
    prompt-writer node demonstrates end to end with no credentials."""
    return _provider("text", **kwargs)
