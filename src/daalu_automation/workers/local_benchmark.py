"""Celery task that runs a local-inference benchmark.

The laptop-path analogue of the gpu-controller's AIPerf Job: where AIPerf needs
Kubernetes to run, this benchmarks the operator's OpenAI-compatible endpoint
directly from the worker — the one execution surface a Docker-Compose install
already has. daalu-api creates the ``local_benchmark_runs`` row ``pending`` and
calls ``run_local_benchmark_task.delay(run_id)``; this loads it, runs the sweep,
and writes back ``summary`` / ``output`` / ``state``.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import structlog

from daalu_automation.core import local_inference
from daalu_automation.database import AsyncSessionLocal, engine
from daalu_automation.models import LocalBenchmarkRun, LocalBenchmarkRunState
from daalu_automation.workers.celery_app import celery_app

logger = structlog.get_logger(__name__)


async def _run(run_id: uuid.UUID) -> str:
    async with AsyncSessionLocal() as db:
        run = await db.get(LocalBenchmarkRun, run_id)
        if run is None:
            return "missing"
        run.state = LocalBenchmarkRunState.running
        run.started_at = datetime.now(tz=timezone.utc)
        await db.commit()

        try:
            summary = await local_inference.run_benchmark(
                concurrency=local_inference.parse_concurrency(run.concurrency),
                request_count=run.request_count,
                output_tokens=run.output_tokens,
            )
            run.summary = summary
            # "failed" (a clean result we can act on) is reserved for endpoints
            # that answered but missed an SLO; a benchmark that produced a curve
            # is a "passed" run regardless of the numbers.
            run.state = LocalBenchmarkRunState.passed
            run.output = "benchmark completed"
        except Exception as e:  # noqa: BLE001 — surface failure on the row
            logger.warning("localbench.failed", run_id=str(run_id), error=str(e))
            run.state = LocalBenchmarkRunState.error
            run.summary = {"error": f"{type(e).__name__}: {e}"[:500]}
            run.output = str(e)[:2000]
        finally:
            run.finished_at = datetime.now(tz=timezone.utc)
            await db.commit()
        return run.state.value


@celery_app.task(name="localbench.run")
def run_local_benchmark_task(run_id: str) -> str:
    """Worker entrypoint. Engine disposed after the run (see integration_health
    for the asyncio.run + module-level engine rationale)."""

    async def _wrapped() -> str:
        try:
            return await _run(uuid.UUID(run_id))
        finally:
            await engine.dispose()

    return asyncio.run(_wrapped())
