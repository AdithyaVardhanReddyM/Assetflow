"""Schema drift guard.

Drizzle owns the schema and this backend mirrors it, which is only safe if drift
is caught immediately. Reflect the live database and compare against the mirror:
a missing table or column becomes a loud startup failure with the exact fix,
rather than an `UndefinedColumnError` halfway through someone's first run.

Deliberately one-directional — extra columns in the database are fine (the
Next.js app may add its own), missing ones are not.
"""

from __future__ import annotations

from sqlalchemy import inspect

from app.db.models import EXPECTED_TABLES
from app.db.session import get_engine
from app.logging import get_logger

log = get_logger(__name__)


class SchemaDriftError(RuntimeError):
    pass


async def verify_schema(*, raise_on_drift: bool = True) -> list[str]:
    """Returns a list of human-readable drift problems (empty when in sync)."""
    engine = get_engine()

    def _collect(sync_conn) -> dict[str, set[str]]:  # type: ignore[no-untyped-def]
        insp = inspect(sync_conn)
        present = set(insp.get_table_names())
        return {
            table: {c["name"] for c in insp.get_columns(table)}
            for table in EXPECTED_TABLES
            if table in present
        }

    async with engine.connect() as conn:
        actual = await conn.run_sync(_collect)

    problems: list[str] = []
    for table, model in EXPECTED_TABLES.items():
        if table not in actual:
            problems.append(f"table {table!r} is missing")
            continue
        expected_cols = {c.name for c in model.__table__.columns}
        missing = sorted(expected_cols - actual[table])
        if missing:
            problems.append(f"table {table!r} is missing column(s): {', '.join(missing)}")

    if problems:
        detail = "; ".join(problems)
        # Not `db:push` — it introspects the live database first and drizzle-kit
        # 0.31 crashes doing so here. `migrate` replays the generated SQL.
        hint = (
            "Run `pnpm db:generate && pnpm db:migrate` from the repo root "
            "to apply db/schema.ts."
        )
        if raise_on_drift:
            raise SchemaDriftError(f"Database schema is out of sync — {detail}. {hint}")
        log.warning("db.schema_drift", problems=problems, hint=hint)
    else:
        log.info("db.schema_ok", tables=sorted(EXPECTED_TABLES))

    return problems
