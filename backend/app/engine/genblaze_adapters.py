"""In-repo GenBlaze adapters for models the stock connectors cannot express.

Everything builds on genblaze-core's registry machinery (specs, transformers,
input routing) rather than bypassing it. The shapes of the fixes:

- **Factories wrapping a stock provider with better specs** — Replicate
  (``replicate_provider``: reference-image *arrays* per slug, GPT Image 2's
  resolution folded into its pixel-size vocabulary, Sora 2's
  landscape/portrait words) and GMI Cloud (``gmicloud_image_provider``:
  Seedream's single ``size`` synthesized from aspect_ratio + resolution;
  ``gmicloud_video_provider``: Seedance frame/reference routing, Kling v3's
  required start image and string durations).
- **First-party providers for endpoints the stock adapters never call** —
  ``RunwayImageProvider`` (text_to_image), ``RunwayVideoProvider``
  (text_to_video *or* image_to_video, chosen by wiring), ``LumaAgentsProvider``
  (Luma's Agents API — Ray 3.2 / Uni-1 are not on the legacy Dream Machine
  API), and the Decart Lucy editors (``DecartLucyImageProvider`` /
  ``DecartLucyVideoProvider``: the thing being edited rides ``data``, a
  garment/style image rides ``reference_image``; genblaze_decart itself no
  longer imports against the pinned genblaze_core).

Only ``genblaze_core`` is imported at module level — it ships with the pinned
``genblaze`` dependency. The optional provider SDKs (``replicate``, ``runwayml``,
``decart``, ``genblaze_gmicloud``…) are imported lazily so this module can be
loaded, and its specs unit-tested, in a mock-only environment.
"""

from __future__ import annotations

import mimetypes
import os
import re
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse
from urllib.request import url2pathname

from genblaze_core.exceptions import ProviderError
from genblaze_core.models.asset import Asset, AudioMetadata
from genblaze_core.models.enums import Modality, ProviderErrorCode
from genblaze_core.models.step import Step
from genblaze_core.providers import (
    BaseProvider,
    DiscoverySupport,
    ModelFamily,
    ModelRegistry,
    ModelSpec,
    ProviderCapabilities,
    RetryPolicy,
    SyncProvider,
    route_images,
    validate_asset_url,
)
from genblaze_core.providers.retry import retry_after_from_response
from genblaze_core.providers.spec import StringSchema
from genblaze_core.runnable.config import RunnableConfig

def _read_asset_bytes(url: str) -> bytes:
    """Fetch an input asset — presigned https URL or a local file:// one.

    For providers whose upstream takes bytes rather than URLs (Decart, the
    ElevenLabs music upload). Callers must have SSRF-validated the URL first
    (``prepare_payload`` does).
    """
    parsed = urlparse(url)
    if parsed.scheme == "file":
        return Path(url2pathname(parsed.path)).read_bytes()
    import httpx

    resp = httpx.get(url, timeout=60.0, follow_redirects=True)
    resp.raise_for_status()
    return resp.content


# --- Replicate image models -------------------------------------------------

# Each slug's native reference-image key, verified against the model's OpenAPI
# schema on replicate.com (2026-07). Everything else passes through untouched —
# Replicate's fallback has no allowlist, and these specs deliberately add none.
_REPLICATE_IMAGE_SLOTS: dict[str, str] = {
    "google/nano-banana-pro": "image_input",
    "google/nano-banana-2": "image_input",
    "openai/gpt-image-1.5": "input_images",
    "openai/gpt-image-2": "input_images",
}


# GPT Image 2 has no resolution parameter of its own — its `aspect_ratio` enum
# mixes ratio words with exact pixel sizes ("2048x1152", "3840x2160", ...).
# The canvas offers ratio + resolution as two axes like every other image
# model; this table folds the pair back into the upstream vocabulary. Pairs
# with no pixel size of their own (there is no ~1K 16:9, no 2K 3:2, no 4K 1:1)
# fall back to the plain ratio word, which lets the model pick its base size.
_GPT_IMAGE_2_SIZES: dict[tuple[str, str], str] = {
    ("1:1", "1K"): "1024x1024",
    ("3:2", "1K"): "1536x1024",
    ("2:3", "1K"): "1024x1536",
    ("4:3", "1K"): "1536x1152",
    ("3:4", "1K"): "1152x1536",
    ("1:1", "2K"): "2048x2048",
    ("16:9", "2K"): "2048x1152",
    ("9:16", "2K"): "1152x2048",
    ("16:9", "4K"): "3840x2160",
    ("9:16", "4K"): "2160x3840",
}


def gpt_image_2_size_transform(params: dict[str, Any]) -> dict[str, Any]:
    """Fold the canvas's ``resolution`` into GPT Image 2's ``aspect_ratio``.

    ``resolution`` is always consumed — Replicate rejects unknown input keys,
    so leaking it upstream would 422 every call.
    """
    params = dict(params)
    resolution = params.pop("resolution", None)
    if resolution is None:
        return params
    ratio = params.get("aspect_ratio")
    mapped = _GPT_IMAGE_2_SIZES.get((str(ratio), str(resolution)))
    if mapped is not None:
        params["aspect_ratio"] = mapped
    return params


def replicate_image_specs() -> list[ModelSpec]:
    """Specs routing every incoming image into the slug's array parameter."""
    return [
        ModelSpec(
            model_id=slug,
            modality=Modality.IMAGE,
            input_mapping=route_images(array_slot=slot),
            param_transformer=(
                gpt_image_2_size_transform if slug == "openai/gpt-image-2" else None
            ),
        )
        for slug, slot in _REPLICATE_IMAGE_SLOTS.items()
    ]


# Sora speaks landscape/portrait where the canvas speaks ratio pairs — the
# pair is what lets the card preview its shape, so the fold happens here.
_SORA_ASPECTS = {"16:9": "landscape", "9:16": "portrait"}


def sora_aspect_transform(params: dict[str, Any]) -> dict[str, Any]:
    params = dict(params)
    ratio = params.get("aspect_ratio")
    if ratio in _SORA_ASPECTS:
        params["aspect_ratio"] = _SORA_ASPECTS[ratio]
    return params


def sora_2_spec() -> ModelSpec:
    return ModelSpec(
        model_id="openai/sora-2",
        modality=Modality.VIDEO,
        param_transformer=sora_aspect_transform,
        # A wired image becomes the literal first frame.
        input_mapping=route_images(slots=("input_reference",)),
    )


def _route_lipsync_media(inputs: Any) -> dict[str, Any]:
    """The wired video is the face to re-drive, the wired audio what drives it."""
    out: dict[str, Any] = {}
    videos = [a for a in inputs if (a.media_type or "").startswith("video/")]
    audios = [a for a in inputs if (a.media_type or "").startswith("audio/")]
    if videos:
        out["video"] = videos[0].url
    if audios:
        out["audio"] = audios[0].url
    return out


def pixverse_lipsync_spec() -> ModelSpec:
    """PixVerse lip sync — both media inputs are the whole interface.

    ``param_required`` is checked *after* input_mapping runs, so wired media
    satisfies it and a mis-wired node fails in-process, naming the missing
    slot, instead of 422ing upstream after an upload.
    """
    return ModelSpec(
        model_id="pixverse/lipsync",
        modality=Modality.VIDEO,
        param_required=frozenset({"video", "audio"}),
        input_mapping=_route_lipsync_media,
    )


def replicate_provider() -> Any:
    """Stock ReplicateProvider with our per-slug specs (images, Sora 2, PixVerse)."""
    from genblaze_replicate import ReplicateProvider

    registry = ReplicateProvider.create_registry()
    for spec in [*replicate_image_specs(), sora_2_spec(), pixverse_lipsync_spec()]:
        registry.register(spec)
    return ReplicateProvider(models=registry)


# --- GMI Cloud image models -------------------------------------------------

# (aspect_ratio, resolution) → the "WxH" Seedream 5 actually takes. Every value
# sits inside GMI's documented pixel budget (3,686,400-10,404,496 total px,
# W/H between 1:16 and 16:1) — a pair outside this table is a mistake we want
# loud, not a silently squarish image.
_SEEDREAM_SIZES: dict[tuple[str, str], str] = {
    ("1:1", "2K"): "2048x2048",
    ("16:9", "2K"): "2560x1440",
    ("9:16", "2K"): "1440x2560",
    ("4:3", "2K"): "2304x1728",
    ("3:4", "2K"): "1728x2304",
    ("3:2", "2K"): "2496x1664",
    ("2:3", "2K"): "1664x2496",
    ("21:9", "2K"): "2940x1260",
    ("1:1", "3K"): "3072x3072",
    ("16:9", "3K"): "3840x2160",
    ("9:16", "3K"): "2160x3840",
    ("4:3", "3K"): "3456x2592",
    ("3:4", "3K"): "2592x3456",
    ("3:2", "3K"): "3600x2400",
    ("2:3", "3K"): "2400x3600",
    ("21:9", "3K"): "4620x1980",
}


def seedream_size_transform(params: dict[str, Any]) -> dict[str, Any]:
    """Fold the canvas's ``aspect_ratio`` + ``resolution`` into GMI's ``size``.

    A caller-supplied ``size`` wins — the pair is only the bar's vocabulary.
    """
    params = dict(params)
    ratio = params.pop("aspect_ratio", None)
    resolution = params.pop("resolution", None)
    if "size" in params or (ratio is None and resolution is None):
        return params
    key = (str(ratio or "1:1"), str(resolution or "2K"))
    size = _SEEDREAM_SIZES.get(key)
    if size is None:
        raise ProviderError(
            f"Seedream 5 has no size for aspect_ratio={key[0]!r} at {key[1]!r}. "
            f"Supported ratios: {sorted({r for r, _ in _SEEDREAM_SIZES})}, "
            "resolutions: ['2K', '3K'].",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )
    params["size"] = size
    return params


def seedream5_specs() -> list[ModelSpec]:
    """Per-slug Seedream 5 specs: size transform + multi-reference routing."""
    return [
        ModelSpec(
            model_id=slug,
            modality=Modality.IMAGE,
            param_transformer=seedream_size_transform,
            # Seedream's `image` takes a URL or an array of up to 14 — send the
            # array so a second reference is not silently dropped.
            input_mapping=route_images(array_slot="image"),
            # Same request envelope the stock GMI registry declares.
            extras={"envelope_key": "payload"},
        )
        for slug in ("seedream-5.0-pro", "seedream-5.0-lite")
    ]


def gmicloud_image_provider() -> Any:
    """Stock GMICloudImageProvider, plus Seedream 5 specs.

    flux-kontext-pro needs no spec of its own: it lands on the stock fallback,
    which passes ``aspect_ratio`` / ``prompt_upsampling`` / ``output_format``
    through unchanged (no allowlist on GMI's image fallback).
    """
    from genblaze_gmicloud import GMICloudImageProvider

    registry = GMICloudImageProvider.create_registry()
    for spec in seedream5_specs():
        registry.register(spec)
    return GMICloudImageProvider(models=registry)


def gmi_video_specs() -> list[ModelSpec]:
    """Per-slug specs for GMI's current video lineup (2026-07 docs).

    Seedance takes the canvas's ``aspect_ratio`` as ``ratio``, its first frame
    as ``first_frame`` and further wired images as a ``reference_images``
    array. Kling v3 *requires* a start image (``image``), takes an optional
    ending guide (``image_tail``), and wants ``duration`` as a string.
    """
    envelope = {"envelope_key": "payload"}
    specs = [
        ModelSpec(
            model_id=slug,
            modality=Modality.VIDEO,
            param_aliases={"aspect_ratio": "ratio"},
            # Positional: first wired image anchors the clip, a second one
            # ends it, everything after rides as references (up to 9 upstream).
            input_mapping=route_images(
                slots=("first_frame", "last_frame"), array_slot="reference_images"
            ),
            extras=envelope,
        )
        for slug in ("seedance-2-0-260128", "seedance-2-0-fast-260128")
    ]
    specs.append(
        ModelSpec(
            model_id="kling-v3-image-to-video",
            modality=Modality.VIDEO,
            param_coercers={"duration": str},
            # Required *after* input_mapping runs, so a wired image satisfies
            # it and a bare node fails in-process instead of upstream.
            param_required=frozenset({"image"}),
            input_mapping=route_images(slots=("image", "image_tail")),
            extras=envelope,
        )
    )
    return specs


def gmicloud_video_provider() -> Any:
    """Stock GMICloudVideoProvider carrying the current lineup's specs."""
    from genblaze_gmicloud import GMICloudVideoProvider

    registry = GMICloudVideoProvider.create_registry()
    for spec in gmi_video_specs():
        registry.register(spec)
    return GMICloudVideoProvider(models=registry)


@lru_cache(maxsize=1)
def _kling_lipsync_cls():
    """Lazy subclass so this module imports without the gmicloud extra."""
    from genblaze_gmicloud import GMICloudVideoProvider

    class GMIKlingLipSyncProvider(GMICloudVideoProvider):  # type: ignore[misc]
        """Kling lip-sync on GMI — a two-step flow the stock submit can't do.

        Step 1 posts the wired video to ``kling-identify-face`` (synchronous:
        the faces come back in the submit response) to get a session and its
        ``face_data``. Step 2 submits ``kling-lip-sync`` with the first face
        and the wired audio as ``sound_file``. Polling and output extraction
        ride the stock GMI queue lifecycle.

        The identify-face payload's video field name is not in GMI's docs;
        ``video_url`` follows Kling's own API convention — if the first live
        call 400s, that field is the suspect.
        """

        name = "gmicloud-kling-lipsync"

        def submit(self, step: Step, config: RunnableConfig | None = None) -> Any:
            try:
                # SSRF-validates the wired URLs and resolves params.
                payload = self.prepare_payload(step)

                videos = [
                    a for a in step.inputs if (a.media_type or "").startswith("video/")
                ]
                audios = [
                    a for a in step.inputs if (a.media_type or "").startswith("audio/")
                ]
                if not videos:
                    raise ProviderError(
                        "Kling lip-sync needs the video whose face it syncs — "
                        "connect one to the node's source video input.",
                        error_code=ProviderErrorCode.INVALID_INPUT,
                    )
                if not audios:
                    raise ProviderError(
                        "Kling lip-sync needs a voice or music track — connect "
                        "one to the node's speech input.",
                        error_code=ProviderErrorCode.INVALID_INPUT,
                    )

                client = self._get_http_client()
                resp = client.post(
                    "/requests",
                    json={
                        "model": "kling-identify-face",
                        "payload": {"video_url": videos[0].url},
                    },
                )
                if resp.status_code >= 400:
                    raise ProviderError(
                        f"Kling face detection failed ({resp.status_code}): {resp.text}",
                        error_code=ProviderErrorCode.INVALID_INPUT,
                    )
                outcome = resp.json().get("outcome") or {}
                data = outcome.get("data") or outcome
                session_id = data.get("session_id")
                faces = data.get("face_data") or []
                if not session_id or not faces:
                    raise ProviderError(
                        "Kling found no face in the source video — lip-sync "
                        "needs a visible face to drive.",
                        error_code=ProviderErrorCode.INVALID_INPUT,
                    )

                face_choose = {
                    "face_id": faces[0].get("face_id"),
                    "sound_file": audios[0].url,
                    "sound_insert_time": 0,
                    "sound_volume": payload.get("sound_volume", 1),
                    "original_audio_volume": payload.get("original_audio_volume", 0),
                }
                return self._submit_request(
                    step.model,
                    {"session_id": session_id, "face_choose": [face_choose]},
                )
            except ProviderError:
                raise
            except Exception as exc:
                raise ProviderError(
                    f"Kling lip-sync submit failed: {exc}",
                    error_code=ProviderErrorCode.UNKNOWN,
                    retry_after=retry_after_from_response(exc),
                ) from exc

    return GMIKlingLipSyncProvider


def gmi_kling_lipsync_provider() -> Any:
    """Kling lip-sync — identify the face, then sync it to the wired audio."""
    return _kling_lipsync_cls()()


# --- Runway image -----------------------------------------------------------

# The full ratio enum from the SDK's text_to_image params (identical for
# gen4_image and gen4_image_turbo). Validated here so a bad value fails in-process
# with a readable message instead of a 400 after upload.
RUNWAY_IMAGE_RATIOS = frozenset(
    {
        "1024:1024",
        "1080:1080",
        "1168:880",
        "1360:768",
        "1440:1080",
        "1080:1440",
        "1808:768",
        "1920:1080",
        "1080:1920",
        "2112:912",
        "1280:720",
        "720:1280",
        "720:720",
        "960:720",
        "720:960",
        "1680:720",
    }
)

_MAX_RUNWAY_REFERENCES = 3


def _check_image_ratio(params: dict[str, Any]) -> None:
    ratio = params.get("ratio")
    if ratio is not None and ratio not in RUNWAY_IMAGE_RATIOS:
        raise ProviderError(
            f"Invalid ratio={ratio!r}. Must be one of {sorted(RUNWAY_IMAGE_RATIOS)}",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )


def _route_reference_images(inputs: Any) -> dict[str, Any]:
    """First three incoming images become Runway ``referenceImages`` entries."""
    images = [a for a in inputs if (a.media_type or "").startswith("image/")]
    if not images:
        return {}
    return {"reference_images": [{"uri": a.url} for a in images[:_MAX_RUNWAY_REFERENCES]]}


# Any gen<N>_image / gen<N>_image_turbo slug — same future-proofing bet the
# stock video family makes with ``gen\w+_turbo``.
_RUNWAY_IMAGE_FAMILY = ModelFamily(
    name="runway-gen-image",
    pattern=re.compile(r"^gen\w+_image(?:_turbo)?$"),
    spec_template=ModelSpec(
        model_id="*",
        modality=Modality.IMAGE,
        param_aliases={"aspect_ratio": "ratio"},
        param_constraints=(_check_image_ratio,),
        input_mapping=_route_reference_images,
    ),
    description="Runway Gen image family (gen4_image, gen4_image_turbo, future variants).",
    example_slugs=("gen4_image", "gen4_image_turbo"),
)


class RunwayImageProvider(BaseProvider):
    """Runway text-to-image (Gen-4 Image). Mirrors genblaze_runway's task flow.

    The stock RunwayProvider always submits through ``image_to_video.create``,
    so image slugs cannot ride it. Same auth (``RUNWAYML_API_SECRET``), same
    poll-the-task lifecycle, different endpoint: ``text_to_image.create``
    (runwayml SDK >= 3.1).
    """

    name = "runway-image"
    discovery_support = DiscoverySupport.NONE

    @classmethod
    def create_registry(cls) -> ModelRegistry:
        return ModelRegistry(
            provider_families=(_RUNWAY_IMAGE_FAMILY,),
            fallback=_RUNWAY_IMAGE_FAMILY.spec_template,
        )

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.IMAGE],
            supported_inputs=["text", "image"],
            accepts_chain_input=True,
            models=self._models.known(),
            output_formats=["image/jpeg", "image/png"],
        )

    def __init__(
        self,
        api_secret: str | None = None,
        poll_interval: float = 5.0,
        *,
        models: ModelRegistry | None = None,
        retry_policy: RetryPolicy | None = None,
        probe_cache_ttl: float | None = None,
        probe_cache_max_entries: int | None = None,
    ):
        super().__init__(
            models=models,
            retry_policy=retry_policy,
            probe_cache_ttl=probe_cache_ttl,
            probe_cache_max_entries=probe_cache_max_entries,
        )
        self.poll_interval = poll_interval
        self._api_secret = api_secret
        self._client: Any = None

    def _get_client(self):
        if self._client is None:
            try:
                from runwayml import RunwayML
            except ImportError as exc:
                raise ProviderError(
                    "runwayml package not installed. Run: pip install runwayml"
                ) from exc
            kwargs: dict = {}
            if self._api_secret:
                kwargs["api_key"] = self._api_secret
            self._client = RunwayML(**kwargs)
        return self._client

    def submit(self, step: Step, config: RunnableConfig | None = None) -> Any:
        try:
            payload = self.prepare_payload(step)

            request: dict = {
                "model": step.model,
                "prompt_text": payload.get("prompt", step.prompt or ""),
            }
            for key in ("ratio", "seed", "reference_images", "content_moderation"):
                if key in payload:
                    request[key] = payload[key]

            # Upstream rejects a turbo call without references anyway, but the
            # in-process message can say what to *wire*, which a 400 cannot.
            # Checked before the client exists so it fires even keyless.
            if step.model.endswith("_turbo") and not request.get("reference_images"):
                raise ProviderError(
                    f"{step.model} requires 1-{_MAX_RUNWAY_REFERENCES} reference images "
                    "— connect an image to the node's reference input.",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )

            task = self._get_client().text_to_image.create(**request)
            return task.id
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Runway image submit failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc

    def poll(self, prediction_id: Any, config: RunnableConfig | None = None) -> bool:
        client = self._get_client()
        try:
            task = client.tasks.retrieve(prediction_id)
            if task.status in ("SUCCEEDED", "FAILED"):
                self._cache_poll_result(prediction_id, task)
                return True
            return False
        except Exception as exc:
            raise ProviderError(
                f"Runway image poll failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc

    def fetch_output(self, prediction_id: Any, step: Step) -> Step:
        client = self._get_client()
        try:
            task = self._get_cached_poll_result(prediction_id)
            if task is None:
                task = client.tasks.retrieve(prediction_id)

            step.provider_payload = {
                "runway": {"task_id": task.id, "status": task.status}
            }

            if task.status == "FAILED":
                raise ProviderError(
                    str(getattr(task, "failure", None) or "Image generation failed"),
                    error_code=ProviderErrorCode.UNKNOWN,
                )

            output = getattr(task, "output", None) or []
            urls = [output] if isinstance(output, str) else [str(u) for u in output]
            if not urls:
                raise ProviderError("Runway task completed but no output URL found")

            for url in urls:
                validate_asset_url(url)
                mime, _ = mimetypes.guess_type(urlparse(url).path)
                if mime is None or not mime.startswith("image/"):
                    mime = "image/png"
                step.assets.append(Asset(url=url, media_type=mime))

            self._apply_registry_pricing(step)
            return step
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Runway image fetch_output failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc


# --- Runway video (Gen-4.5, Gemini Omni Flash) -------------------------------

# Per-model ratio surfaces from the Runway OpenAPI spec (2026-07). The
# image_to_video endpoint takes all six for gen4.5; pure text_to_video only
# the first two. gemini_omni_flash takes the first two on both endpoints.
_RUNWAY_T2V_RATIOS = frozenset({"1280:720", "720:1280"})
_RUNWAY_GEN45_I2V_RATIOS = _RUNWAY_T2V_RATIOS | frozenset(
    {"1104:832", "832:1104", "960:960", "1584:672"}
)

_RUNWAY_VIDEO_RATIOS: dict[str, frozenset[str]] = {
    "gen4.5": _RUNWAY_GEN45_I2V_RATIOS,
    "gen4_turbo": _RUNWAY_GEN45_I2V_RATIOS,
    "gemini_omni_flash": _RUNWAY_T2V_RATIOS,
}

# gen4_turbo exists only on image_to_video — no text path to fall back to.
_RUNWAY_I2V_ONLY = frozenset({"gen4_turbo"})

# Models with a video_to_video editing mode (video in, edited video out, with
# optional image references). Engaged when a video is wired.
_RUNWAY_V2V_CAPABLE = frozenset({"gemini_omni_flash"})


def _check_runway_video_ratio(params: dict[str, Any]) -> None:
    # Model-independent superset check; the per-endpoint narrowing (t2v only
    # takes the two HD ratios) happens in submit(), where the endpoint is known.
    ratio = params.get("ratio")
    if ratio is not None and ratio not in _RUNWAY_GEN45_I2V_RATIOS:
        raise ProviderError(
            f"Invalid ratio={ratio!r}. Must be one of {sorted(_RUNWAY_GEN45_I2V_RATIOS)}",
            error_code=ProviderErrorCode.INVALID_INPUT,
        )


_RUNWAY_VIDEO_FAMILY = ModelFamily(
    name="runway-video-hosted",
    # The Runway models we list plus the third-party ones Runway hosts —
    # the pattern deliberately does not guess at future slugs.
    pattern=re.compile(r"^(?:gen4\.5|gen4_turbo|gemini_omni_flash)$"),
    spec_template=ModelSpec(
        model_id="*",
        modality=Modality.VIDEO,
        param_aliases={"aspect_ratio": "ratio"},
        param_constraints=(_check_runway_video_ratio,),
        input_mapping=route_images(slots=("prompt_image",)),
    ),
    description="Runway-hosted video models with a text-to-video path.",
    example_slugs=("gen4.5", "gemini_omni_flash"),
)


class RunwayVideoProvider(BaseProvider):
    """Runway video for models the stock adapter cannot drive.

    genblaze_runway's RunwayProvider always calls ``image_to_video.create``,
    which requires a first-frame image — but gen4.5 and gemini_omni_flash also
    exist on ``text_to_video``. This provider picks the endpoint from the
    wiring: an incoming image means image_to_video, none means text_to_video.
    """

    name = "runway-video"
    discovery_support = DiscoverySupport.NONE

    @classmethod
    def create_registry(cls) -> ModelRegistry:
        return ModelRegistry(
            provider_families=(_RUNWAY_VIDEO_FAMILY,),
            fallback=_RUNWAY_VIDEO_FAMILY.spec_template,
        )

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.VIDEO],
            supported_inputs=["text", "image"],
            accepts_chain_input=True,
            models=self._models.known(),
            output_formats=["video/mp4"],
        )

    def __init__(
        self,
        api_secret: str | None = None,
        poll_interval: float = 5.0,
        *,
        models: ModelRegistry | None = None,
        retry_policy: RetryPolicy | None = None,
        probe_cache_ttl: float | None = None,
        probe_cache_max_entries: int | None = None,
    ):
        super().__init__(
            models=models,
            retry_policy=retry_policy,
            probe_cache_ttl=probe_cache_ttl,
            probe_cache_max_entries=probe_cache_max_entries,
        )
        self.poll_interval = poll_interval
        self._api_secret = api_secret
        self._client: Any = None

    def _get_client(self):
        if self._client is None:
            try:
                from runwayml import RunwayML
            except ImportError as exc:
                raise ProviderError(
                    "runwayml package not installed. Run: pip install runwayml"
                ) from exc
            kwargs: dict = {}
            if self._api_secret:
                kwargs["api_key"] = self._api_secret
            self._client = RunwayML(**kwargs)
        return self._client

    def build_request(self, step: Step) -> tuple[str, dict[str, Any]]:
        """Decide the endpoint and build its request — separated for tests.

        Returns ``(endpoint, request)`` where endpoint is one of
        ``video_to_video`` / ``image_to_video`` / ``text_to_video``. A wired
        video engages editing mode (v2v-capable models only); a wired image
        makes it image-to-video; nothing wired means pure text-to-video.
        """
        payload = self.prepare_payload(step)

        request: dict = {
            "model": step.model,
            "prompt_text": payload.get("prompt", step.prompt or ""),
        }

        # Editing mode: the wired video is what gets changed, wired images
        # ride along as references. Ratio/duration don't exist on this
        # endpoint — the output follows the input video.
        videos = [a for a in step.inputs if (a.media_type or "").startswith("video/")]
        if videos and step.model in _RUNWAY_V2V_CAPABLE:
            request["video_uri"] = videos[0].url
            images = [
                a for a in step.inputs if (a.media_type or "").startswith("image/")
            ]
            if images:
                request["references"] = [{"uri": a.url} for a in images]
            return "video_to_video", request

        for key in ("ratio", "seed", "duration"):
            if key in payload:
                request[key] = payload[key]
        if "duration" in request:
            request["duration"] = int(request["duration"])

        allowed = _RUNWAY_VIDEO_RATIOS.get(step.model, _RUNWAY_GEN45_I2V_RATIOS)
        ratio = request.get("ratio")
        if ratio is not None and ratio not in allowed:
            raise ProviderError(
                f"{step.model} does not take ratio={ratio!r}. "
                f"Supported: {sorted(allowed)}",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )

        if "prompt_image" in payload:
            request["prompt_image"] = payload["prompt_image"]
            return "image_to_video", request

        if step.model in _RUNWAY_I2V_ONLY:
            raise ProviderError(
                f"{step.model} is image-to-video only — connect an image to the "
                "node's start frame input.",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        # Pure text-to-video only speaks the two HD ratios, even for models
        # whose image path takes more.
        if ratio is not None and ratio not in _RUNWAY_T2V_RATIOS:
            raise ProviderError(
                f"ratio={ratio!r} needs a start image wired — text-to-video "
                f"supports {sorted(_RUNWAY_T2V_RATIOS)} only.",
                error_code=ProviderErrorCode.INVALID_INPUT,
            )
        return "text_to_video", request

    def submit(self, step: Step, config: RunnableConfig | None = None) -> Any:
        try:
            endpoint, request = self.build_request(step)
            client = self._get_client()
            task = getattr(client, endpoint).create(**request)
            return task.id
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Runway video submit failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc

    def poll(self, prediction_id: Any, config: RunnableConfig | None = None) -> bool:
        client = self._get_client()
        try:
            task = client.tasks.retrieve(prediction_id)
            if task.status in ("SUCCEEDED", "FAILED"):
                self._cache_poll_result(prediction_id, task)
                return True
            return False
        except Exception as exc:
            raise ProviderError(
                f"Runway video poll failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc

    def fetch_output(self, prediction_id: Any, step: Step) -> Step:
        client = self._get_client()
        try:
            task = self._get_cached_poll_result(prediction_id)
            if task is None:
                task = client.tasks.retrieve(prediction_id)

            step.provider_payload = {
                "runway": {"task_id": task.id, "status": task.status}
            }

            if task.status == "FAILED":
                raise ProviderError(
                    str(getattr(task, "failure", None) or "Video generation failed"),
                    error_code=ProviderErrorCode.UNKNOWN,
                )

            output = getattr(task, "output", None) or []
            urls = [output] if isinstance(output, str) else [str(u) for u in output]
            if not urls:
                raise ProviderError("Runway task completed but no output URL found")

            duration = int(step.params.get("duration", 5))
            for url in urls:
                validate_asset_url(url)
                asset = Asset(url=url, media_type="video/mp4")
                asset.duration = float(duration)
                step.assets.append(asset)

            self._apply_registry_pricing(step)
            return step
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Runway video fetch_output failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc


# --- Luma Agents API (Ray 3.2, Uni-1) ----------------------------------------

_LUMA_AGENTS_BASE_URL = "https://agents.lumalabs.ai/v1"
_LUMA_AGENTS_API_VERSION = "2026-04-01"

# Ray 3.2's per-clip video options live in a nested `video` object on the
# wire; the catalog keeps them flat like every other model, and submit()
# folds them in.
_LUMA_VIDEO_OPTION_KEYS = ("resolution", "duration", "loop", "hdr")


class LumaAgentsProvider(BaseProvider):
    """Luma's Agents API — Ray 3.2 (video) and Uni-1 (image).

    These models are not on the legacy Dream Machine API that genblaze_luma's
    adapter drives, and the ``lumaai`` SDK has no path to them — the Agents
    API is a separate product with its own base URL, key and version header.
    Plain httpx keeps this dependency-free: submit POSTs a generation, poll
    GETs it until ``completed``/``failed``.

    Auth: LUMA_AGENTS_API_KEY, falling back to LUMAAI_API_KEY for keys that
    are valid on both products.
    """

    name = "luma-agents"
    discovery_support = DiscoverySupport.NONE

    @classmethod
    def create_registry(cls) -> ModelRegistry:
        registry = ModelRegistry()
        registry.register(
            ModelSpec(
                model_id="ray-3.2",
                modality=Modality.VIDEO,
                # First wired image anchors the clip, a second one ends it.
                input_mapping=route_images(slots=("start_frame", "end_frame")),
            )
        )
        registry.register(
            ModelSpec(
                model_id="uni-1",
                modality=Modality.IMAGE,
                # Up to 9 references, all in one array.
                input_mapping=route_images(array_slot="image_ref"),
            )
        )
        return registry

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.VIDEO, Modality.IMAGE],
            supported_inputs=["text", "image"],
            accepts_chain_input=True,
            models=self._models.known(),
            output_formats=["video/mp4", "image/png", "image/jpeg"],
        )

    def __init__(
        self,
        api_key: str | None = None,
        poll_interval: float = 5.0,
        http_timeout: float = 60.0,
        *,
        models: ModelRegistry | None = None,
        retry_policy: RetryPolicy | None = None,
        probe_cache_ttl: float | None = None,
        probe_cache_max_entries: int | None = None,
    ):
        super().__init__(
            models=models,
            retry_policy=retry_policy,
            probe_cache_ttl=probe_cache_ttl,
            probe_cache_max_entries=probe_cache_max_entries,
        )
        self.poll_interval = poll_interval
        self._api_key = api_key
        self._http_timeout = http_timeout
        self._http: Any = None

    def _get_http(self):
        if self._http is None:
            import httpx

            key = (
                self._api_key
                or os.environ.get("LUMA_AGENTS_API_KEY")
                or os.environ.get("LUMAAI_API_KEY")
            )
            if not key:
                raise ProviderError(
                    "Set LUMA_AGENTS_API_KEY to use Luma's Agents API models."
                )
            self._http = httpx.Client(
                base_url=_LUMA_AGENTS_BASE_URL,
                headers={
                    "Authorization": f"Bearer {key}",
                    "X-API-Version": _LUMA_AGENTS_API_VERSION,
                },
                timeout=self._http_timeout,
            )
        return self._http

    def build_request_body(self, step: Step) -> dict[str, Any]:
        """The generation body — separated from submit() for testability."""
        payload = self.prepare_payload(step)

        body: dict[str, Any] = {
            "model": step.model,
            "type": "video" if step.modality == Modality.VIDEO else "image",
            "prompt": payload.get("prompt", step.prompt or ""),
        }
        if "aspect_ratio" in payload:
            body["aspect_ratio"] = payload["aspect_ratio"]

        if step.modality == Modality.VIDEO:
            video: dict[str, Any] = {}
            for key in _LUMA_VIDEO_OPTION_KEYS:
                if key in payload:
                    video[key] = payload[key]
            # The wire wants ImageRef objects, not bare URLs.
            for frame in ("start_frame", "end_frame"):
                if frame in payload:
                    video[frame] = {"url": payload[frame]}
            if video:
                body["video"] = video
        elif "image_ref" in payload:
            body["image_ref"] = [{"url": u} for u in payload["image_ref"]]

        for key in ("style", "output_format", "web_search"):
            if key in payload:
                body[key] = payload[key]
        return body

    def submit(self, step: Step, config: RunnableConfig | None = None) -> Any:
        try:
            body = self.build_request_body(step)
            resp = self._get_http().post("/generations", json=body)
            resp.raise_for_status()
            generation_id = resp.json().get("id")
            if not generation_id:
                raise ProviderError("Luma Agents API returned no generation id")
            return generation_id
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Luma Agents submit failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc

    def poll(self, prediction_id: Any, config: RunnableConfig | None = None) -> bool:
        try:
            resp = self._get_http().get(f"/generations/{prediction_id}")
            resp.raise_for_status()
            data = resp.json()
            if data.get("state") in ("completed", "failed"):
                self._cache_poll_result(prediction_id, data)
                return True
            return False
        except Exception as exc:
            raise ProviderError(
                f"Luma Agents poll failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc

    def fetch_output(self, prediction_id: Any, step: Step) -> Step:
        try:
            data = self._get_cached_poll_result(prediction_id)
            if data is None:
                resp = self._get_http().get(f"/generations/{prediction_id}")
                resp.raise_for_status()
                data = resp.json()

            step.provider_payload = {
                "luma_agents": {"generation_id": prediction_id, "state": data.get("state")}
            }

            if data.get("state") == "failed":
                raise ProviderError(
                    str(data.get("failure_reason") or "Luma generation failed"),
                    error_code=ProviderErrorCode.UNKNOWN,
                )

            assets = data.get("assets") or {}
            urls = [str(v) for v in assets.values() if isinstance(v, str)]
            if not urls:
                raise ProviderError("Luma generation completed but no asset URL found")

            for url in urls:
                validate_asset_url(url)
                mime, _ = mimetypes.guess_type(urlparse(url).path)
                if mime is None:
                    mime = (
                        "video/mp4" if step.modality == Modality.VIDEO else "image/png"
                    )
                step.assets.append(Asset(url=url, media_type=mime))

            self._apply_registry_pricing(step)
            return step
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Luma Agents fetch_output failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc


# --- Decart Lucy video editing ------------------------------------------------

_DECART_LUCY_EDIT_FAMILY = ModelFamily(
    name="decart-lucy-video-edit",
    pattern=re.compile(r"^lucy-(?!image)"),
    spec_template=ModelSpec(model_id="*", modality=Modality.VIDEO),
    description="Decart Lucy video editing (lucy-2.5, VTON, restyle…).",
    example_slugs=("lucy-2.5", "lucy-vton-3"),
)


class DecartLucyVideoProvider(BaseProvider):
    """Decart's Lucy video editors (lucy-2.5, lucy-vton-3) — first-party.

    Not built on genblaze_decart: that package fails to import against the
    pinned genblaze_core (its ``local_file_url`` helper is gone), and its
    submit path could not express these models anyway — Lucy edits take the
    video being changed as ``data`` and a garment/style image as
    ``reference_image``, routed here by media type, plus lucy-2.5's
    ``self_anchor`` toggle. Drives the ``decart`` SDK's queue API directly.
    """

    name = "decart-lucy-video"
    discovery_support = DiscoverySupport.NONE

    @classmethod
    def create_registry(cls) -> ModelRegistry:
        return ModelRegistry(provider_families=(_DECART_LUCY_EDIT_FAMILY,))

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.VIDEO],
            supported_inputs=["text", "video", "image"],
            accepts_chain_input=True,
            models=sorted(self._models.known()),
            output_formats=["video/mp4"],
        )

    def __init__(
        self,
        api_key: str | None = None,
        poll_interval: float = 5.0,
        output_dir: str | Path | None = None,
        *,
        models: ModelRegistry | None = None,
        retry_policy: RetryPolicy | None = None,
        probe_cache_ttl: float | None = None,
        probe_cache_max_entries: int | None = None,
    ):
        super().__init__(
            models=models,
            retry_policy=retry_policy,
            probe_cache_ttl=probe_cache_ttl,
            probe_cache_max_entries=probe_cache_max_entries,
        )
        self.poll_interval = poll_interval
        self._api_key = api_key
        self._output_dir = Path(output_dir) if output_dir else None
        self._client: Any = None

    def _get_client(self):
        if self._client is None:
            try:
                from decart import DecartClient
            except ImportError as exc:
                raise ProviderError(
                    "decart package not installed. Run: pip install decart"
                ) from exc
            kwargs: dict = {}
            if self._api_key:
                kwargs["api_key"] = self._api_key
            self._client = DecartClient(**kwargs)
        return self._client

    def submit(self, step: Step, config: RunnableConfig | None = None) -> Any:
        try:
            from decart import models as decart_models
            from genblaze_core._utils import _run_async

            # Wiring checks come before the client so a mis-wired node fails
            # the same way keyless or keyed.
            payload = self.prepare_payload(step)

            videos = [a for a in step.inputs if (a.media_type or "").startswith("video/")]
            images = [a for a in step.inputs if (a.media_type or "").startswith("image/")]
            if not videos:
                raise ProviderError(
                    f"{step.model} edits an existing video — connect one to the "
                    "node's source video input.",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )

            params: dict[str, Any] = {
                "model": decart_models.video(step.model),
                # Optional upstream (defaults to ""), so port-driven runs work.
                "prompt": payload.get("prompt", step.prompt or ""),
                # The decart SDK downloads URL inputs itself.
                "data": videos[0].url,
            }
            if images:
                params["reference_image"] = images[0].url
            for key in ("enhance_prompt", "self_anchor", "seed"):
                if key in payload:
                    params[key] = payload[key]
            if step.seed is not None:
                params.setdefault("seed", step.seed)

            job = _run_async(self._get_client().queue.submit(params))
            return job.job_id
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Decart video edit submit failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc

    def poll(self, prediction_id: Any, config: RunnableConfig | None = None) -> bool:
        try:
            from genblaze_core._utils import _run_async

            status = _run_async(self._get_client().queue.status(prediction_id))
            return status.status in ("completed", "failed")
        except Exception as exc:
            raise ProviderError(
                f"Decart video edit poll failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc

    def fetch_output(self, prediction_id: Any, step: Step) -> Step:
        try:
            from genblaze_core._utils import _run_async

            client = self._get_client()
            status = _run_async(client.queue.status(prediction_id))
            step.provider_payload = {
                "decart": {"job_id": prediction_id, "status": status.status}
            }
            if status.status == "failed":
                raise ProviderError(
                    "Decart video edit failed",
                    error_code=ProviderErrorCode.UNKNOWN,
                )

            data = _run_async(client.queue.result(prediction_id))
            if hasattr(data, "data"):
                data = data.data

            if self._output_dir:
                self._output_dir.mkdir(parents=True, exist_ok=True)
                out_path = self._output_dir / f"{step.step_id}.mp4"
            else:
                fd, tmp = tempfile.mkstemp(suffix=".mp4")
                os.close(fd)
                out_path = Path(tmp)
            out_path.write_bytes(data)

            step.assets.append(
                Asset(url=out_path.resolve().as_uri(), media_type="video/mp4")
            )
            self._apply_registry_pricing(step)
            return step
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Decart video edit fetch_output failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc


# --- Decart Lucy image editing ----------------------------------------------

_DECART_LUCY_EDIT_FAMILY = ModelFamily(
    name="decart-lucy-image-edit",
    pattern=re.compile(r"^lucy-image"),
    spec_template=ModelSpec(
        model_id="*",
        modality=Modality.IMAGE,
        param_schemas={"resolution": StringSchema(enum=frozenset({"480p", "720p"}))},
    ),
    description="Decart Lucy image editing (lucy-image-2 and successors).",
    example_slugs=("lucy-image-2",),
)


class DecartLucyImageProvider(SyncProvider):
    """Decart's lucy-image-2 — image *editing*, not text-to-image.

    The stock DecartImageProvider sends ``model`` and ``prompt`` only, but
    lucy-image-2's ``data`` (the image to edit) is required — through the stock
    adapter every call would 422. This one downloads the first incoming image
    as the edit source, an optional second as ``reference_image``, and forwards
    ``resolution`` / ``enhance_prompt``.
    """

    name = "decart-lucy-image"
    discovery_support = DiscoverySupport.NONE

    @classmethod
    def create_registry(cls) -> ModelRegistry:
        return ModelRegistry(provider_families=(_DECART_LUCY_EDIT_FAMILY,))

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.IMAGE],
            supported_inputs=["text", "image"],
            accepts_chain_input=True,
            models=sorted(self._models.known()),
            output_formats=["image/png"],
        )

    def __init__(
        self,
        api_key: str | None = None,
        output_dir: str | Path | None = None,
        *,
        models: ModelRegistry | None = None,
        retry_policy: RetryPolicy | None = None,
        probe_cache_ttl: float | None = None,
        probe_cache_max_entries: int | None = None,
    ):
        super().__init__(
            models=models,
            retry_policy=retry_policy,
            probe_cache_ttl=probe_cache_ttl,
            probe_cache_max_entries=probe_cache_max_entries,
        )
        self._api_key = api_key
        self._output_dir = Path(output_dir) if output_dir else None
        self._client: Any = None

    def _get_client(self):
        if self._client is None:
            try:
                from decart import DecartClient
            except ImportError as exc:
                raise ProviderError(
                    "decart package not installed. Run: pip install decart"
                ) from exc
            kwargs: dict = {}
            if self._api_key:
                kwargs["api_key"] = self._api_key
            self._client = DecartClient(**kwargs)
        return self._client

    def generate(self, step: Step, config: RunnableConfig | None = None) -> Step:
        client = self._get_client()
        try:
            from decart import models as decart_models
            from genblaze_core._utils import _run_async

            # SSRF-validates every step.inputs URL before we download any.
            payload = self.prepare_payload(step)

            images = [a for a in step.inputs if (a.media_type or "").startswith("image/")]
            if not images:
                raise ProviderError(
                    f"{step.model} edits an existing image — connect one to the "
                    "node's reference input.",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )

            params: dict[str, Any] = {
                "model": decart_models.image(step.model),
                "prompt": step.prompt or "",
                "data": _read_asset_bytes(images[0].url),
            }
            if len(images) > 1:
                params["reference_image"] = _read_asset_bytes(images[1].url)
            for key in ("resolution", "enhance_prompt", "seed"):
                if key in payload:
                    params[key] = payload[key]

            result = _run_async(client.process(params))
            data = getattr(result, "data", result)

            if self._output_dir:
                self._output_dir.mkdir(parents=True, exist_ok=True)
                out_path = self._output_dir / f"{step.step_id}.png"
            else:
                fd, tmp = tempfile.mkstemp(suffix=".png")
                os.close(fd)
                out_path = Path(tmp)

            out_path.write_bytes(data)
            step.assets.append(
                Asset(url=out_path.resolve().as_uri(), media_type="image/png")
            )

            self._apply_registry_pricing(step)
            return step
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"Decart image edit failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc


# --- ElevenLabs music + sound effects ----------------------------------------

# genblaze_elevenlabs covers TTS and a pre-`loop` snapshot of the SFX API,
# and has no music provider at all — these two fill the gaps, driving the
# same `elevenlabs` SDK the stock providers use.


def _elevenlabs_client(api_key: str | None) -> Any:
    """The SDK client, imported lazily like every optional provider dep."""
    try:
        from elevenlabs.client import ElevenLabs
    except ImportError as exc:
        raise ProviderError(
            "elevenlabs package not installed. Run: pip install elevenlabs"
        ) from exc
    kwargs: dict = {}
    if api_key:
        kwargs["api_key"] = api_key
    return ElevenLabs(**kwargs)


def _append_audio_asset(
    step: Step,
    audio_bytes: bytes,
    *,
    audio_type: str,
    output_dir: Path | None,
) -> None:
    """Write mp3 bytes under temp (or output_dir) and attach the asset.

    file:// under temp is the source form ObjectStorageSink accepts — the
    same rule the mock providers follow.
    """
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
        out_path = output_dir / f"{step.step_id}.mp3"
    else:
        fd, tmp = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        out_path = Path(tmp)
    out_path.write_bytes(audio_bytes)

    asset = Asset(url=f"file://{quote(str(out_path.resolve()))}", media_type="audio/mpeg")
    asset.metadata["audio_type"] = audio_type
    asset.size_bytes = len(audio_bytes)
    asset.audio = AudioMetadata(codec="mp3")
    from genblaze_core._utils import probe_audio_duration

    dur = probe_audio_duration(out_path)
    if dur is not None:
        asset.duration = dur
    step.assets.append(asset)


_ELEVEN_MUSIC_FAMILY = ModelFamily(
    name="elevenlabs-music",
    pattern=re.compile(r"^music_"),
    spec_template=ModelSpec(model_id="*", modality=Modality.AUDIO),
    description="ElevenLabs Music family (music_v1, music_v2).",
    example_slugs=("music_v2",),
)

# The API's own bounds for `music_length_ms`.
_MUSIC_LENGTH_BOUNDS_MS = (3_000, 600_000)


class ElevenLabsMusicProvider(SyncProvider):
    """ElevenLabs Music (music_v2) — prompt-driven, with a cover mode.

    No source wired: ``compose`` from the node's prompt, with optional lyrics
    folded into the prompt text (the API sings lyrics written there),
    ``force_instrumental`` set when the node's Vocals toggle is off, and the
    model choosing its own length unless ``duration_seconds`` is set.

    A wired source track flips to cover mode: ``music.upload`` extracts the
    source's composition plan (an ElevenLabs-side analysis; billed like a
    generation), the prompt joins the plan's global styles, and ``compose``
    regenerates from the plan — so length follows the source, not the
    duration param.
    """

    name = "elevenlabs-music"
    discovery_support = DiscoverySupport.NONE

    @classmethod
    def create_registry(cls) -> ModelRegistry:
        return ModelRegistry(
            provider_families=(_ELEVEN_MUSIC_FAMILY,),
            fallback=_ELEVEN_MUSIC_FAMILY.spec_template,
        )

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.AUDIO],
            supported_inputs=["text", "audio"],
            accepts_chain_input=True,
            max_duration=600.0,
            models=self._models.known(),
            output_formats=["audio/mpeg"],
        )

    def __init__(
        self,
        api_key: str | None = None,
        output_dir: str | Path | None = None,
        *,
        models: ModelRegistry | None = None,
        retry_policy: RetryPolicy | None = None,
        probe_cache_ttl: float | None = None,
        probe_cache_max_entries: int | None = None,
    ):
        super().__init__(
            models=models,
            retry_policy=retry_policy,
            probe_cache_ttl=probe_cache_ttl,
            probe_cache_max_entries=probe_cache_max_entries,
        )
        self._api_key = api_key
        self._output_dir = Path(output_dir) if output_dir else None
        self._client: Any = None

    def _get_client(self):
        if self._client is None:
            self._client = _elevenlabs_client(self._api_key)
        return self._client

    def build_compose_kwargs(self, step: Step) -> dict[str, Any]:
        """The prompt-mode ``compose`` call — separated from generate for tests.

        Cover mode (a wired source) swaps ``prompt`` for ``composition_plan``
        in generate(), keeping everything else from here.
        """
        payload = self.prepare_payload(step)

        kwargs: dict[str, Any] = {"model_id": step.model}
        # Default vocals-on: a fresh node infers vocals from the prompt. The
        # toggle off forces a purely instrumental track.
        vocals = bool(payload.get("vocals", True))
        if not vocals:
            kwargs["force_instrumental"] = True

        prompt = payload.get("prompt", step.prompt or "")
        lyrics = str(payload.get("lyrics") or "").strip()
        # The API has no lyrics field; lyrics written into the prompt are
        # sung as written. Suppressed when vocals are off so a stale lyrics
        # box cannot leak singing into an instrumental track.
        if lyrics and vocals:
            prompt = f"{prompt}\n\nLyrics:\n{lyrics}" if prompt else f"Lyrics:\n{lyrics}"
        kwargs["prompt"] = prompt

        if "duration_seconds" in payload:
            ms = int(float(payload["duration_seconds"]) * 1000)
            lo, hi = _MUSIC_LENGTH_BOUNDS_MS
            if ms < lo or ms > hi:
                raise ProviderError(
                    f"Invalid duration_seconds={payload['duration_seconds']!r}. "
                    f"Must be {lo // 1000}-{hi // 1000} seconds.",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )
            kwargs["music_length_ms"] = ms
        if step.seed is not None:
            kwargs["seed"] = step.seed
        return kwargs

    def generate(self, step: Step, config: RunnableConfig | None = None) -> Step:
        try:
            # prepare_payload (inside) SSRF-validates the wired URLs before
            # any of them is downloaded.
            kwargs = self.build_compose_kwargs(step)
            client = self._get_client()

            audios = [
                a for a in step.inputs if (a.media_type or "").startswith("audio/")
            ]
            if audios:
                uploaded = client.music.upload(
                    file=("source-audio", _read_asset_bytes(audios[0].url)),
                    extract_composition_plan=step.model,
                )
                plan = getattr(uploaded, "composition_plan", None)
                if plan is None:
                    raise ProviderError(
                        "ElevenLabs could not extract a composition plan from "
                        "the wired source track.",
                        error_code=ProviderErrorCode.INVALID_INPUT,
                    )
                # prompt and composition_plan are mutually exclusive upstream;
                # the prompt survives as one more global style on the plan.
                prompt = kwargs.pop("prompt", "")
                styles = getattr(plan, "positive_global_styles", None)
                if prompt and isinstance(styles, list):
                    styles.append(prompt)
                # Length follows the plan's sections, not the duration param.
                kwargs.pop("music_length_ms", None)
                kwargs["composition_plan"] = plan

            audio_bytes = b"".join(client.music.compose(**kwargs))
            _append_audio_asset(
                step, audio_bytes, audio_type="music", output_dir=self._output_dir
            )
            self._apply_registry_pricing(step)
            return step
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"ElevenLabs music failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc


def elevenlabs_music_provider() -> ElevenLabsMusicProvider:
    """Eleven Music — describe a track, or wire one in to cover it."""
    return ElevenLabsMusicProvider()


_ELEVEN_SFX_FAMILY = ModelFamily(
    name="elevenlabs-sfx-loop",
    pattern=re.compile(r"^eleven_text_to_sound"),
    spec_template=ModelSpec(model_id="*", modality=Modality.AUDIO),
    description="ElevenLabs sound-effects family, loop-capable.",
    example_slugs=("eleven_text_to_sound_v2",),
)

# The API's own duration bounds; omitting the param lets the model choose.
_SFX_DURATION_BOUNDS = (0.5, 30.0)


class ElevenLabsLoopSFXProvider(SyncProvider):
    """Sound effects with the full current surface of the SFX endpoint.

    genblaze_elevenlabs' SFX provider predates two of the API's knobs and
    silently drops them: ``loop`` (seamlessly loopable output) and the
    explicit ``model_id``. This one forwards both, keeps duration optional
    (absent means the model picks), and passes ``prompt_influence`` through.
    """

    name = "elevenlabs-sfx"
    discovery_support = DiscoverySupport.NONE

    @classmethod
    def create_registry(cls) -> ModelRegistry:
        return ModelRegistry(
            provider_families=(_ELEVEN_SFX_FAMILY,),
            fallback=_ELEVEN_SFX_FAMILY.spec_template,
        )

    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            supported_modalities=[Modality.AUDIO],
            supported_inputs=["text"],
            max_duration=_SFX_DURATION_BOUNDS[1],
            models=self._models.known(),
            output_formats=["audio/mpeg"],
        )

    def __init__(
        self,
        api_key: str | None = None,
        output_dir: str | Path | None = None,
        *,
        models: ModelRegistry | None = None,
        retry_policy: RetryPolicy | None = None,
        probe_cache_ttl: float | None = None,
        probe_cache_max_entries: int | None = None,
    ):
        super().__init__(
            models=models,
            retry_policy=retry_policy,
            probe_cache_ttl=probe_cache_ttl,
            probe_cache_max_entries=probe_cache_max_entries,
        )
        self._api_key = api_key
        self._output_dir = Path(output_dir) if output_dir else None
        self._client: Any = None

    def _get_client(self):
        if self._client is None:
            self._client = _elevenlabs_client(self._api_key)
        return self._client

    def build_convert_kwargs(self, step: Step) -> dict[str, Any]:
        """The ``text_to_sound_effects.convert`` call — separated for tests."""
        payload = self.prepare_payload(step)

        kwargs: dict[str, Any] = {
            "text": payload.get("prompt", step.prompt or ""),
            "model_id": step.model,
        }
        if "duration_seconds" in payload:
            try:
                dur = float(payload["duration_seconds"])
            except (TypeError, ValueError) as exc:
                raise ProviderError(
                    f"Invalid duration_seconds={payload['duration_seconds']!r}. "
                    "Must be 0.5-30.",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                ) from exc
            lo, hi = _SFX_DURATION_BOUNDS
            if dur < lo or dur > hi:
                raise ProviderError(
                    f"Invalid duration_seconds={dur}. Must be {lo}-{hi}.",
                    error_code=ProviderErrorCode.INVALID_INPUT,
                )
            kwargs["duration_seconds"] = dur
        if "prompt_influence" in payload:
            kwargs["prompt_influence"] = float(payload["prompt_influence"])
        if "loop" in payload:
            kwargs["loop"] = bool(payload["loop"])
        return kwargs

    def generate(self, step: Step, config: RunnableConfig | None = None) -> Step:
        try:
            kwargs = self.build_convert_kwargs(step)
            client = self._get_client()
            audio_bytes = b"".join(client.text_to_sound_effects.convert(**kwargs))
            _append_audio_asset(
                step, audio_bytes, audio_type="sfx", output_dir=self._output_dir
            )
            self._apply_registry_pricing(step)
            return step
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(
                f"ElevenLabs SFX failed: {exc}",
                error_code=ProviderErrorCode.UNKNOWN,
                retry_after=retry_after_from_response(exc),
            ) from exc


def elevenlabs_sfx_provider() -> ElevenLabsLoopSFXProvider:
    """ElevenLabs sound effects — loop-capable, auto duration unless set."""
    return ElevenLabsLoopSFXProvider()
