"""Error taxonomy, rendered as RFC 9457 `application/problem+json`.

Deliberately free of any `genblaze_*` import — provider errors are translated
into this vocabulary by `app.engine.errors`, so the HTTP layer never depends on
the SDK. Raw exception reprs must never reach a client.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

PROBLEM_JSON = "application/problem+json"


class AppError(Exception):
    """Base for every error we render to a client."""

    status: int = 500
    code: str = "internal_error"
    title: str = "Internal server error"
    retryable: bool = False

    def __init__(
        self,
        detail: str | None = None,
        *,
        hint: str | None = None,
        errors: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(detail or self.title)
        self.detail = detail or self.title
        self.hint = hint
        self.errors = errors or []

    def to_problem(self, instance: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": f"https://assetflow.dev/errors/{self.code}",
            "title": self.title,
            "status": self.status,
            "detail": self.detail,
            "code": self.code,
            "retryable": self.retryable,
        }
        if self.hint:
            body["hint"] = self.hint
        if self.errors:
            body["errors"] = self.errors
        if instance:
            body["instance"] = instance
        return body


class BadRequest(AppError):
    status, code, title = 400, "bad_request", "Bad request"


class Unauthorized(AppError):
    status, code, title = 401, "unauthorized", "Unauthorized"


class Forbidden(AppError):
    status, code, title = 403, "forbidden", "Forbidden"


class NotFound(AppError):
    status, code, title = 404, "not_found", "Not found"


class Conflict(AppError):
    status, code, title = 409, "conflict", "Conflict"


class UnprocessableGraph(AppError):
    """The submitted graph failed to compile. `errors` holds compiler diagnostics."""

    status, code, title = 422, "invalid_graph", "Graph could not be compiled"


class RateLimited(AppError):
    status, code, title, retryable = 429, "rate_limited", "Too many requests", True


class ProviderUnavailable(AppError):
    status, code, title = 503, "provider_unavailable", "Provider unavailable"


class StorageError(AppError):
    status, code, title, retryable = 502, "storage_error", "Storage backend error", True


class ProviderFailure(AppError):
    """A generation provider rejected or failed the request."""

    status, code, title = 502, "provider_failure", "Provider request failed"

    def __init__(
        self,
        detail: str,
        *,
        code: str | None = None,
        retryable: bool = False,
        hint: str | None = None,
    ) -> None:
        super().__init__(detail, hint=hint)
        if code:
            self.code = code
        self.retryable = retryable


def _respond(problem: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        status_code=problem["status"], content=problem, media_type=PROBLEM_JSON
    )


def install_error_handlers(app: FastAPI) -> None:
    from app.logging import get_logger, request_id_var

    log = get_logger(__name__)

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        log.warning(
            "request.error", code=exc.code, status=exc.status, detail=exc.detail,
            path=request.url.path,
        )
        return _respond(exc.to_problem(instance=request_id_var.get()))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        err = BadRequest(
            "Request body failed validation.",
            errors=[
                {
                    "loc": ".".join(str(p) for p in e.get("loc", ())),
                    "message": e.get("msg", ""),
                    "type": e.get("type", ""),
                }
                for e in exc.errors()
            ],
        )
        return _respond(err.to_problem(instance=request_id_var.get()))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        # Log the real exception; return an opaque body.
        log.exception("request.unhandled", path=request.url.path, exc_type=type(exc).__name__)
        return _respond(AppError().to_problem(instance=request_id_var.get()))
