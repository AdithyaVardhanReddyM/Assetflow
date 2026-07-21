"""Shared FastAPI dependencies."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.clerk import AuthContext, require_user
from app.catalog.registry import Catalog, get_catalog
from app.config import Settings, get_settings
from app.db.session import get_sessionmaker
from app.errors import AppError


class DatabaseUnavailable(AppError):
    status, code, title, retryable = 503, "database_unavailable", "Database unavailable", True


async def db_session() -> AsyncIterator[AsyncSession]:
    settings = get_settings()
    if not settings.db_configured:
        raise DatabaseUnavailable(
            "DATABASE_URL is not configured.",
            hint="Set DATABASE_URL in .env.local (Supabase pooled connection string).",
        )
    async with get_sessionmaker()() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


def catalog() -> Catalog:
    return get_catalog()


def settings() -> Settings:
    return get_settings()


Session = Annotated[AsyncSession, Depends(db_session)]
CurrentUser = Annotated[AuthContext, Depends(require_user)]
CatalogDep = Annotated[Catalog, Depends(catalog)]
SettingsDep = Annotated[Settings, Depends(settings)]
