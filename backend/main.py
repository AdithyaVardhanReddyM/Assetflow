"""Vercel entrypoint.

Vercel's `entrypoint` setting expects a module-level ASGI app (`main:app`),
not a factory. Local dev keeps using the factory directly:
`uvicorn app.main:create_app --factory`.
"""

from app.main import create_app

app = create_app()
