"""FastAPI application entry point (open-source single-tenant build).

Importing this module imports every domain module package, which in turn
registers their agents, briefings, integrations, and workflows. The app
is intentionally side-effecty so a single
``uvicorn daalu_automation.api.main:app`` gives you the whole agent.

This is the open-source carve: the multi-tenant hub, SSO/OIDC, billing,
GPU provisioning, and the WireGuard edge-fleet routers/middleware have
been removed. Auth is a single local operator gated by ``local_no_auth``
(see ``api/deps.py`` and ``core/bootstrap.py``).
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

import daalu_automation


def _build_info() -> dict[str, str]:
    """Resolve build identity from env vars set by the Dockerfile.

    BUILD_SHA / BUILD_TIME default to "unknown" so a local `uvicorn`
    still serves /version without crashing.
    """
    return {
        "version": daalu_automation.__version__,
        "commit_sha": os.environ.get("BUILD_SHA", "unknown"),
        "built_at": os.environ.get("BUILD_TIME", "unknown"),
    }


# Side-effect imports — register agents/briefings/integrations/workflows.
import daalu_automation.modules  # noqa: E402,F401
from daalu_automation.api.routers import (  # noqa: E402
    agents,
    alert_chat,
    alerts,
    briefings,
    change_proposals,
    clusters,
    events,
    feedback,
    gpu_metrics,
    infra,
    integrations,
    local_inference,
    observability,
    onboarding,
    recommendations,
    reports,
    sot_devices,
    sot_webhooks,
    workflows,
)
from daalu_automation.config import get_settings  # noqa: E402
from daalu_automation.core.auth import (  # noqa: E402
    TokenError,
    decode_token,
    looks_like_pat,
)
from daalu_automation.core.bootstrap import (  # noqa: E402
    ensure_default_tenant,
    ensure_default_user,
)
from daalu_automation.database import create_tables  # noqa: E402
from daalu_automation.observability import init_observability  # noqa: E402

logger = structlog.get_logger(__name__)
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_observability(component="api")
    logger.info(
        "daalu.startup",
        env=settings.environment,
        local_no_auth=settings.local_no_auth,
    )
    # Local-dev / single-node convenience. A multi-node deploy should run
    # alembic from the init container instead (see deploy/).
    await create_tables()
    await ensure_default_tenant()
    await ensure_default_user()
    yield
    logger.info("daalu.shutdown")


class AuthGateMiddleware(BaseHTTPMiddleware):
    """Reject unauthenticated requests early.

    Public paths (health, version, metrics, docs) pass through. The
    webhook ingest endpoint (``POST {prefix}/events``) is exempt — it has
    its own ``X-Daalu-Key`` gate inside the route. Nautobot SoT webhooks
    are HMAC-verified in-route, so they bypass the cookie gate too.

    Not installed at all when ``local_no_auth`` is on.
    """

    def __init__(self, app, public_paths: set[str], ingest_path: str) -> None:
        super().__init__(app)
        self._public = public_paths
        self._ingest_path = ingest_path
        import re as _re

        self._sot_webhook_re = _re.compile(
            rf"^{_re.escape(ingest_path.rsplit('/', 1)[0])}/sot/webhooks/[^/]+$"
        )

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in self._public:
            return await call_next(request)
        # Webhook ingest — POST {prefix}/events — uses X-Daalu-Key.
        if request.method == "POST" and path == self._ingest_path:
            return await call_next(request)
        # Nautobot webhooks — HMAC-verified inside the route.
        if request.method == "POST" and self._sot_webhook_re.match(path):
            return await call_next(request)
        if request.method == "OPTIONS":
            return await call_next(request)

        token = request.cookies.get(settings.auth_cookie_name)
        if not token:
            authz = request.headers.get("authorization", "")
            if authz.lower().startswith("bearer "):
                token = authz.split(None, 1)[1]
        if not token:
            return JSONResponse(
                {"detail": "not authenticated"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        # PATs are opaque (not JWTs) — defer their validation to
        # current_user's hash lookup. This gate only keeps anon traffic out.
        if not looks_like_pat(token):
            try:
                decode_token(token)
            except TokenError as e:
                return JSONResponse(
                    {"detail": f"invalid token: {e}"},
                    status_code=401,
                    headers={"WWW-Authenticate": "Bearer"},
                )
        return await call_next(request)


def create_app() -> FastAPI:
    """Construct the single-tenant FastAPI app."""
    app = FastAPI(
        title="Daalu — AI Ops Agent",
        description=(
            "An AI agent for infrastructure / ops teams. It investigates, "
            "proposes changes, and executes only after you approve."
        ),
        version=daalu_automation.__version__,
        docs_url="/docs" if not settings.is_production else None,
        redoc_url="/redoc" if not settings.is_production else None,
        lifespan=lifespan,
    )

    # CORS first — preflight must flow even for unauthenticated requests.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Auth gate — skipped entirely in single-tenant local mode.
    if not settings.local_no_auth:
        public_paths = {
            p.strip() for p in settings.auth_public_paths.split(",") if p.strip()
        }
        app.add_middleware(
            AuthGateMiddleware,
            public_paths=public_paths,
            ingest_path=f"{settings.api_v1_prefix}/events",
        )

    prefix = settings.api_v1_prefix
    for r in (
        events.router,
        briefings.router,
        alerts.router,
        alert_chat.router,
        recommendations.router,
        reports.router,
        agents.router,
        workflows.router,
        integrations.router,
        infra.router,
        onboarding.router,
        gpu_metrics.router,
        local_inference.router,
        clusters.router,
        observability.router,
        change_proposals.router,
        sot_devices.router,
        sot_webhooks.router,
        feedback.router,
    ):
        app.include_router(r, prefix=prefix)

    @app.get("/health")
    async def health():
        return {"status": "ok", "version": _build_info()["version"]}

    @app.get("/version")
    async def version():
        return _build_info()

    @app.get("/")
    async def root():
        return {"service": "daalu-agent", "docs": "/docs", "api": prefix}

    # Prometheus metrics — instrument every route + expose /metrics.
    # Custom domain counters register as a side-effect of importing
    # core.metrics.
    try:
        from prometheus_fastapi_instrumentator import Instrumentator

        from daalu_automation.core import metrics  # noqa: F401

        Instrumentator(
            should_group_status_codes=True,
            should_ignore_untemplated=True,
            should_respect_env_var=False,
            excluded_handlers=["/metrics", "/health"],
        ).instrument(app).expose(
            app, endpoint="/metrics", include_in_schema=False, tags=["observability"]
        )
    except ImportError:  # pragma: no cover
        logger.warning("prometheus_instrumentator.missing")

    return app


app = create_app()
