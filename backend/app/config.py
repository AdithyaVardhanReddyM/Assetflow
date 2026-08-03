"""Application settings.

Reads, in increasing order of precedence: the monorepo-root `.env` and
`.env.local` (shared with the Next.js app — DATABASE_URL, Clerk keys), then
`backend/.env`, then the real process environment.
"""

from __future__ import annotations

import base64
import os
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent


class GenblazeMode(StrEnum):
    MOCK = "mock"
    LIVE = "live"


class StorageMode(StrEnum):
    LOCAL = "local"
    B2 = "b2"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Later files win, matching Next.js precedence (.env.local overrides
        # .env) so the backend and the frontend read the same values.
        env_file=(
            REPO_ROOT / ".env",
            REPO_ROOT / ".env.local",
            BACKEND_DIR / ".env",
        ),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- app ---
    app_env: str = "development"
    log_level: str = "INFO"
    api_port: int = 8000
    # NoDecode: pydantic-settings otherwise requires list fields set via real
    # environment variables to be JSON arrays; these are documented as plain
    # comma-separated strings, so hand the raw value to _split_csv instead.
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:3000"]
    )

    # --- modes: both default to the credential-free path ---
    genblaze_mode: GenblazeMode = GenblazeMode.MOCK
    storage_mode: StorageMode = StorageMode.LOCAL

    # --- database (Supabase) ---
    # Pooled DSN (port 6543, pgbouncer transaction mode) for normal queries.
    database_url: str = ""
    # Direct DSN (port 5432). Required for LISTEN/NOTIFY, which the pooler does
    # not support. Unused today — progress fan-out polls run_events by seq.
    database_url_direct: str = ""

    # --- auth (Clerk) ---
    # Usually left unset: it is derived from the publishable key the frontend
    # already has (see `resolved_clerk_issuer`), so there is one fewer env var
    # to keep in sync between the two apps.
    clerk_issuer: str = ""
    next_public_clerk_publishable_key: str = ""
    clerk_authorized_parties: Annotated[list[str], NoDecode] = Field(default_factory=list)
    # Escape hatch for local work before Clerk keys are restored. Never in prod;
    # guarded by an assertion in create_app().
    auth_dev_bypass: bool = False

    # --- Backblaze B2 ---
    b2_key_id: str = ""
    b2_app_key: str = ""
    b2_bucket: str = ""
    b2_region: str = "us-west-004"
    b2_prefix: str = "assetflow"

    # --- local storage (storage_mode=local) ---
    local_media_dir: Path = BACKEND_DIR / ".data" / "media"
    local_media_base_url: str = "http://localhost:8000/media"

    # --- enrichment + search ---
    # Kill switch for the whole pipeline; enrichment failing must never take
    # uploads or runs down with it, but off is still simpler than degraded.
    enrich_enabled: bool = True
    # Vision captioning/tagging goes through GMI Cloud (GenBlaze's chat
    # connector, GMI_API_KEY), so swapping models is a config change.
    # Flash-Lite: cheapest multi-image vision that does structured JSON.
    # (The LLM node runs on Replicate; enrichment stays apart because
    # Replicate throttles predictions hard on a low balance and publishes no
    # Flash-Lite.)
    enrich_vision_model: str = "google/gemini-3.1-flash-lite-preview"
    # Jina embeddings ("jina-embeddings-v3"). Absent key degrades search to
    # keyword-only and enrichment to text-without-vectors.
    jina_api_key: str = ""

    # --- worker ---
    run_worker_in_process: bool = True
    worker_concurrency: int = 2
    worker_lease_seconds: int = 90
    per_tenant_run_limit: int = 3
    step_timeout_seconds: float = 600.0
    # Video jobs routinely outlive the default ceiling (a queued Seedance clip
    # burned its credits against a 600s poll limit while GMI kept generating).
    # Plans containing a video step poll up to this long instead.
    video_step_timeout_seconds: float = 1800.0
    max_run_attempts: int = 3

    @field_validator("cors_origins", "clerk_authorized_parties", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str):
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in ("production", "prod")

    @property
    def resolved_clerk_issuer(self) -> str:
        """Clerk's issuer URL, derived from the publishable key when not set.

        A publishable key is `pk_(test|live)_<base64 of "host$">`, so the
        frontend API host — which is also the JWT issuer — is recoverable from
        the key the frontend already publishes.
        """
        if self.clerk_issuer:
            return self.clerk_issuer.rstrip("/")

        key = self.next_public_clerk_publishable_key
        for prefix in ("pk_test_", "pk_live_"):
            if key.startswith(prefix):
                encoded = key[len(prefix) :]
                try:
                    padded = encoded + "=" * (-len(encoded) % 4)
                    host = base64.b64decode(padded).decode("utf-8").rstrip("$")
                except (ValueError, UnicodeDecodeError):
                    return ""
                return f"https://{host}" if host else ""
        return ""

    @property
    def db_configured(self) -> bool:
        return bool(self.database_url)

    @property
    def b2_configured(self) -> bool:
        return bool(self.b2_key_id and self.b2_app_key and self.b2_bucket)

    def async_dsn(self) -> str:
        """Normalize a Supabase/Postgres URL for SQLAlchemy + asyncpg."""
        dsn = self.database_url
        for prefix in ("postgresql+asyncpg://", "postgresql://", "postgres://"):
            if dsn.startswith(prefix):
                return "postgresql+asyncpg://" + dsn[len(prefix) :]
        return dsn


def _export_env_files() -> None:
    """Copy the env-file chain into the process environment.

    `Settings` materializes only its own fields and ignores the rest, but two
    consumers read `os.environ` directly: the catalog's availability probe
    (`resolve_status` checks `provider.env_var`) and the GenBlaze adapters,
    which pick up their API keys at construction. Without this export, a
    GMI_API_KEY sitting in `backend/.env` leaves GMI Cloud greyed out as
    "missing key" forever.

    The real environment always wins (`override` never happens), and among
    files the first hit wins — so they are walked from most to least specific,
    matching the precedence documented on `Settings.model_config`.
    """
    from dotenv import dotenv_values

    for path in (BACKEND_DIR / ".env", REPO_ROOT / ".env.local", REPO_ROOT / ".env"):
        if not path.is_file():
            continue
        for key, value in dotenv_values(path).items():
            if value is not None and key not in os.environ:
                os.environ[key] = value


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    # Before Settings() so both read one consistent view of the files.
    _export_env_files()
    return Settings()
