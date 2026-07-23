"""Async SQLAlchemy engine and session factory.

Supabase's pooled endpoint (port 6543) runs pgbouncer in transaction mode, which
cannot support prepared statements — hence `statement_cache_size=0`. Without it,
asyncpg raises `DuplicatePreparedStatementError` intermittently under load, which
is a miserable bug to find later. The Next.js client does the same thing via
`prepare: false` in db/index.ts.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings


@lru_cache(maxsize=1)
def get_engine() -> AsyncEngine:
    settings = get_settings()
    if not settings.db_configured:
        raise RuntimeError("DATABASE_URL is not set")
    return create_async_engine(
        settings.async_dsn(),
        # Recycle by age instead of pre-ping: with the database ~300ms away, a
        # ping on every checkout taxed every request and worker operation with
        # a full round trip before its first real query. Recycling well inside
        # the pooler's idle timeout keeps connections fresh for free; a
        # connection that still dies mid-life costs one failed request instead
        # of 300ms on all of them.
        pool_pre_ping=False,
        pool_recycle=240,
        pool_size=10,
        max_overflow=10,
        connect_args={
            "statement_cache_size": 0,
            "prepared_statement_cache_size": 0,
            # Server-side settings the pooler would otherwise reject per-session.
            "server_settings": {"application_name": "assetflow-api"},
        },
    )


@lru_cache(maxsize=1)
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False, autoflush=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding a session that rolls back on error."""
    async with get_sessionmaker()() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


async def dispose_engine() -> None:
    try:
        engine = get_engine()
    except RuntimeError:
        return
    await engine.dispose()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()
