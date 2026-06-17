"""A single local-inference benchmark run, kicked from the AI Factory UI.

The laptop-path analogue of ``AiperfRun``. Where AIPerf benchmarks a GPU vLLM
endpoint via a Kubernetes Job run by the gpu-controller, this benchmarks the
operator's *local* OpenAI-compatible endpoint (typically Ollama) directly from
the Celery **worker** — the only moving part both deployments share. No GPU,
no Kubernetes, no Prometheus required.

daalu-api writes the row ``pending`` and dispatches ``localbench.run`` to the
worker, which marks it ``running``, executes the concurrency sweep
(``core/local_inference.run_benchmark``), and writes back ``summary``
(per-concurrency TTFT/ITL/throughput) + ``state``. Mirrors ``aiperf_runs`` so
the frontend can reuse the same concurrency-curve renderer.
"""

from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from daalu_automation.database import Base
from daalu_automation.models._mixins import (
    TenantScopedMixin,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
)


class LocalBenchmarkRunState(str, enum.Enum):
    pending = "pending"
    running = "running"
    passed = "passed"
    failed = "failed"
    error = "error"


class LocalBenchmarkRun(
    UUIDPrimaryKeyMixin, TenantScopedMixin, TimestampMixin, Base
):
    __tablename__ = "local_benchmark_runs"

    state: Mapped[LocalBenchmarkRunState] = mapped_column(
        SAEnum(LocalBenchmarkRunState, name="local_benchmark_run_state"),
        default=LocalBenchmarkRunState.pending,
        nullable=False,
    )
    # The endpoint under test + the served-model name, captured at run time so
    # the row is self-describing even if .env changes later.
    target_url: Mapped[str] = mapped_column(String(512), nullable=False)
    model: Mapped[str] = mapped_column(String(255), nullable=False)
    # The concurrency sweep, as the comma list the runner consumes ("1,2,4").
    concurrency: Mapped[str] = mapped_column(String(255), nullable=False)
    request_count: Mapped[int] = mapped_column(Integer, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    # Parsed result: per-concurrency TTFT/ITL/throughput rows, or {error} on
    # failure. Same shape AIPerf produces, so the UI curve renderer is reused.
    summary: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    output: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
