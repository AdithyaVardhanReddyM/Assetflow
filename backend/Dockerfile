# Build context is the REPO ROOT (not backend/): the caption burner needs
# public/fonts/captions, which lives beside the frontend so preview == burn.
# Railway: set Root Directory to "/" and point at this file via railway.json.

FROM python:3.12-slim

# ffmpeg: composition renders, caption burn-in (libass ships with it), waveforms.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fontconfig \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# Dependency layer first so code changes don't re-resolve the lockfile.
# `package = false` in pyproject means sync installs deps only, no project build.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --extra providers

COPY backend/ ./
COPY public/fonts/captions /app/public/fonts/captions
ENV CAPTIONS_FONTS_DIR=/app/public/fonts/captions

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8000}
