"""Catalog data model — the contract the canvas renders property panels from.

`ParamDescriptor` is intentionally JSON-Schema-ish *plus* UI hints (label, unit,
group, help) so the frontend can render every model's panel with one generic
field component, instead of hand-writing a form per model.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class ProviderStatus(StrEnum):
    READY = "ready"
    MISSING_KEY = "missing_key"
    NOT_INSTALLED = "not_installed"


class Modality(StrEnum):
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    TEXT = "text"


ParamType = Literal["number", "integer", "string", "boolean", "enum"]


class ParamOption(BaseModel):
    value: str
    label: str | None = None


class ParamDescriptor(BaseModel):
    name: str
    type: ParamType
    label: str | None = None
    help: str | None = None
    unit: str | None = None
    group: Literal["basic", "advanced"] = "basic"
    required: bool = False
    default: Any = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    max_length: int | None = None
    options: list[ParamOption] = Field(default_factory=list)

    def display_label(self) -> str:
        return self.label or self.name.replace("_", " ").capitalize()


class PortHandoff(BaseModel):
    """How an incoming asset port is delivered to this model.

    `external_inputs` uses GenBlaze's native chain-input path. `param` instead
    passes the asset's durable URL as an ordinary model parameter — the escape
    hatch that lets an uploaded image feed an image-to-video model even though
    `external_inputs` and `input_from` are mutually exclusive.
    """

    port: str
    via: Literal["external_inputs", "param"] = "external_inputs"
    param: str | None = None
    modality: Modality


class ModelDescriptor(BaseModel):
    id: str
    label: str
    modality: Modality
    # What the model is *for*, when modality alone is too coarse to tell the
    # canvas how to present it. Music, text-to-speech and sound effects are all
    # `audio` and would otherwise render as three identical nodes. Optional:
    # image and video models are adequately described by their modality.
    role: str | None = None
    adapter: str  # "module:ClassName", imported lazily and only when running
    expected_duration_sec: float | None = None
    est_cost_usd: float | None = None
    output_media_type: str | None = None
    # Shape of what this model emits, for models that expose no `aspect_ratio`
    # param to choose it. Lipsync is the case: the output follows the avatar
    # that drove it, so the canvas has nothing to offer the user but still
    # wants to preview the right shape. Absent means "square".
    output_aspect_ratio: str | None = None
    # False for models driven entirely by their input ports. The compiler skips
    # its NO_PROMPT check and the canvas drops the prompt box for these.
    requires_prompt: bool = True
    params: list[ParamDescriptor] = Field(default_factory=list)
    accepts: list[PortHandoff] = Field(default_factory=list)

    # Populated at load time from the owning provider.
    provider_key: str = ""
    provider_label: str = ""
    status: ProviderStatus = ProviderStatus.NOT_INSTALLED

    def param(self, name: str) -> ParamDescriptor | None:
        return next((p for p in self.params if p.name == name), None)

    def accepts_port(self, port: str) -> PortHandoff | None:
        return next((a for a in self.accepts if a.port == port), None)


class ProviderDescriptor(BaseModel):
    key: str
    label: str
    package: str | None = None  # import name, e.g. "genblaze_google"
    extra: str | None = None  # pip extra, e.g. "google"
    env_var: str | None = None
    signup_url: str | None = None
    always_available: bool = False
    models: list[ModelDescriptor] = Field(default_factory=list)

    status: ProviderStatus = ProviderStatus.NOT_INSTALLED

    @property
    def modalities(self) -> list[str]:
        return sorted({m.modality.value for m in self.models})

    def unavailable_reason(self) -> str | None:
        match self.status:
            case ProviderStatus.READY:
                return None
            case ProviderStatus.MISSING_KEY:
                return f"Set {self.env_var} to enable {self.label}."
            case ProviderStatus.NOT_INSTALLED:
                extra = self.extra or self.key
                return f'Install with: uv add "genblaze[{extra}]"'
