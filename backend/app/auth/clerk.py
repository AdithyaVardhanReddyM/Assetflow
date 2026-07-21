"""Clerk JWT verification.

PyJWT directly rather than `clerk-backend-api`: we are Bearer-only and
cross-origin with no cookies, so the SDK's handshake, cookie, and redirect
machinery is dead weight, and this stays testable offline with a locally
generated RSA key and a stubbed JWKS endpoint.

Clerk's RS256 session tokens carry no `aud` by default, so authorization is
checked via `iss` and `azp` (the authorized party — this is what stops a token
minted for a different frontend from being replayed against our API).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import jwt
from fastapi import Request
from jwt import PyJWKClient

from app.config import Settings, get_settings
from app.errors import Unauthorized
from app.logging import get_logger, tenant_id_var

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class AuthContext:
    user_id: str
    org_id: str | None
    tenant_id: str

    @property
    def is_org(self) -> bool:
        return self.org_id is not None


def tenant_for(user_id: str, org_id: str | None) -> str:
    """One tenant per org, else one per user.

    This value is threaded through every database query, GenBlaze's
    `Pipeline(tenant_id=...)`, and — because the sink uses a hierarchical key
    strategy — the B2 object prefix, so isolation is visible in the bucket.
    """
    return org_id or f"user_{user_id}"


@lru_cache(maxsize=1)
def _jwk_client(issuer: str) -> PyJWKClient:
    return PyJWKClient(
        f"{issuer.rstrip('/')}/.well-known/jwks.json", cache_keys=True, lifespan=300
    )


def _bearer(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise Unauthorized(
            "Missing bearer token.",
            hint="Send `Authorization: Bearer <clerk session token>`.",
        )
    return token.strip()


def _decode(token: str, settings: Settings) -> dict[str, Any]:
    issuer = settings.resolved_clerk_issuer
    signing_key = _jwk_client(issuer).get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        signing_key,
        algorithms=["RS256"],
        issuer=issuer,
        options={"require": ["exp", "iat", "sub"], "verify_aud": False},
        leeway=10,
    )


async def verify_token(token: str, settings: Settings | None = None) -> AuthContext:
    settings = settings or get_settings()
    if not settings.resolved_clerk_issuer:
        raise Unauthorized(
            "Authentication is not configured.",
            hint="Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (the issuer is derived "
            "from it), or CLERK_ISSUER explicitly.",
        )

    try:
        # JWKS fetch is blocking; keep it off the event loop. PyJWKClient caches,
        # so this only costs a thread hop on a cold key.
        claims = await asyncio.to_thread(_decode, token, settings)
    except jwt.PyJWTError as exc:
        raise Unauthorized(f"Invalid token: {exc}") from exc
    except Exception as exc:
        log.warning("auth.jwks_failed", error=f"{type(exc).__name__}: {exc}")
        raise Unauthorized("Could not verify the token signing key.") from exc

    if settings.clerk_authorized_parties:
        azp = claims.get("azp")
        if azp not in settings.clerk_authorized_parties:
            raise Unauthorized("Token was issued for a different application.")

    user_id = claims.get("sub")
    if not user_id:
        raise Unauthorized("Token has no subject.")

    org_id = claims.get("org_id") or claims.get("o", {}).get("id")
    return AuthContext(user_id=user_id, org_id=org_id, tenant_id=tenant_for(user_id, org_id))


async def require_user(request: Request) -> AuthContext:
    """FastAPI dependency: the authenticated caller, or 401."""
    settings = get_settings()

    if settings.auth_dev_bypass:
        # Local-only escape hatch so the backend is usable before Clerk keys are
        # restored. create_app() refuses to start with this on in production.
        header = request.headers.get("X-Dev-User", "dev_user")
        ctx = AuthContext(user_id=header, org_id=None, tenant_id=tenant_for(header, None))
    else:
        ctx = await verify_token(_bearer(request), settings)

    tenant_id_var.set(ctx.tenant_id)
    return ctx
