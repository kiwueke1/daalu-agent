"""Structured logging + Sentry + Prometheus init.

No-op when the relevant secrets aren't set so local development doesn't
need any observability backends running.
"""

from __future__ import annotations

import logging

import structlog

from daalu_automation.config import get_settings


def init_observability(component: str) -> None:
    settings = get_settings()
    logging.basicConfig(
        format="%(message)s",
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer()
            if settings.is_production
            else structlog.dev.ConsoleRenderer(colors=True),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, settings.log_level.upper(), logging.INFO)
        ),
        cache_logger_on_first_use=True,
    )
    if settings.sentry_dsn:
        try:
            import sentry_sdk

            sentry_sdk.init(
                dsn=settings.sentry_dsn,
                traces_sample_rate=settings.sentry_traces_sample_rate,
                environment=settings.environment,
                release=f"daalu-automation@{__import__('daalu_automation').__version__}",
            )
        except Exception:  # pragma: no cover — observability must never crash boot
            structlog.get_logger(__name__).warning("sentry.init_failed", exc_info=True)
    structlog.get_logger(__name__).info(
        "observability.ready",
        component=component,
        env=settings.environment,
    )
