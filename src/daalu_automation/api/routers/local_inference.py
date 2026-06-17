"""AI Factory — local inference panel + benchmarking (laptop / Compose path).

On a GPU Kubernetes deployment the AI Factory shows DCGM hardware metrics from
Prometheus (``gpu_metrics.py``). A laptop / Docker-Compose install has no GPU,
no Prometheus and no onboarded card — so that floor is dark. But the operator
still has an inference brain: the OpenAI-compatible endpoint wired up in
deployment doc Part 2 (typically Ollama). These endpoints surface *that* in the
same AI Factory page:

* ``GET  /ai-factory/local/summary``    — endpoint liveness + served models.
* ``POST /ai-factory/local/validate``   — quick reachability + chat self-check.
* ``POST /ai-factory/local/benchmark``  — kick a concurrency sweep (worker-run).
* ``GET  /ai-factory/local/benchmark``  — list this tenant's benchmark runs.
* ``GET  /ai-factory/local/benchmark/{id}`` — one run with full output.

All tenant-scoped. The benchmark is the laptop analogue of AIPerf: instead of a
Kubernetes Job on a GPU, it runs from the Celery worker straight against the
endpoint, so it works without a GPU/cluster.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.api.deps import current_admin, current_tenant_id
from daalu_automation.core import local_inference
from daalu_automation.database import get_db
from daalu_automation.models import LocalBenchmarkRun, LocalBenchmarkRunState
from daalu_automation.models.user import User

router = APIRouter(prefix="/ai-factory/local", tags=["ai-factory"])


# ── summary ────────────────────────────────────────────────────────────────


@router.get("/summary")
async def local_summary(
    _tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    """Liveness + served models for the agent's configured local endpoint."""
    probe = await local_inference.probe_endpoint()
    return {
        "configured": probe.configured,
        "base_url": probe.base_url,
        "model": probe.model,
        "source": probe.source,
        "reachable": probe.reachable,
        "latency_ms": probe.latency_ms,
        "models": probe.models,
        "error": probe.error,
        "updated_at": _now_iso(),
    }


# ── validate ─────────────────────────────────────────────────────────────


@router.post("/validate")
async def local_validate(
    _tenant_id: uuid.UUID = Depends(current_tenant_id),
    _user: User = Depends(current_admin),
):
    """End-to-end self-check of the local inference path: configured, the
    ``/v1/models`` list answers, and the configured model can complete a tiny
    chat. Mirrors the GPU observability self-check, but for the local brain."""
    ep = local_inference.resolve_endpoint()
    checks: list[dict] = []

    def add(name: str, status: str, detail: str):
        checks.append({"name": name, "status": status, "detail": detail})

    if not ep.configured:
        add("endpoint_configured", "fail", "LLM_BASE_URL is not set")
        return {"checks": checks, "passed": False}
    add("endpoint_configured", "pass", ep.base_url)

    probe = await local_inference.probe_endpoint(ep)
    if probe.reachable:
        add("models_listed", "pass", f"{len(probe.models)} model(s) advertised")
        if ep.model in probe.models:
            add("model_present", "pass", ep.model)
        else:
            add(
                "model_present",
                "fail" if probe.models else "skip",
                f"'{ep.model}' not in advertised models"
                if probe.models
                else "no models advertised",
            )
    else:
        add("models_listed", "fail", probe.error or "endpoint unreachable")

    # A tiny completion proves the model actually serves, not just /models.
    try:
        summary = await local_inference.run_benchmark(
            concurrency=[1], request_count=1, output_tokens=16, ep=ep
        )
        ttft = summary["metrics"].get("ttft_ms")
        add("chat_completion", "pass", f"first token in {ttft:.0f} ms")
    except Exception as e:  # noqa: BLE001 — failure is a check result
        add("chat_completion", "fail", f"{type(e).__name__}: {e}"[:200])

    passed = all(c["status"] != "fail" for c in checks)
    return {"checks": checks, "passed": passed}


# ── benchmark ──────────────────────────────────────────────────────────────


class LocalBenchmarkRequest(BaseModel):
    # Laptop-friendly defaults: a short sweep, few requests, small outputs —
    # CPU inference is slow. The runner clamps to its own ceilings.
    concurrency: str = "1,2,4"
    request_count: int = 10
    output_tokens: int = 64


@router.post("/benchmark")
async def run_local_benchmark(
    req: LocalBenchmarkRequest,
    db: AsyncSession = Depends(get_db),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
    user: User = Depends(current_admin),
):
    from daalu_automation.workers.local_benchmark import run_local_benchmark_task

    ep = local_inference.resolve_endpoint()
    if not ep.configured:
        raise HTTPException(409, "no local inference endpoint configured")
    # Normalise the sweep server-side so the stored row matches what runs.
    levels = local_inference.parse_concurrency(req.concurrency)
    run = LocalBenchmarkRun(
        tenant_id=tenant_id,
        state=LocalBenchmarkRunState.pending,
        target_url=ep.base_url,
        model=ep.model,
        concurrency=",".join(str(c) for c in levels),
        request_count=max(1, min(req.request_count, local_inference.MAX_REQUESTS_PER_LEVEL)),
        output_tokens=max(1, min(req.output_tokens, local_inference.MAX_OUTPUT_TOKENS)),
        requested_by=user.email,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    # Hand off to the worker — the API never blocks on a sweep.
    run_local_benchmark_task.delay(str(run.id))
    return {"id": str(run.id), "state": run.state.value}


@router.get("/benchmark")
async def list_local_benchmarks(
    db: AsyncSession = Depends(get_db),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    rows = (
        (
            await db.execute(
                select(LocalBenchmarkRun)
                .where(LocalBenchmarkRun.tenant_id == tenant_id)
                .order_by(LocalBenchmarkRun.created_at.desc())
                .limit(25)
            )
        )
        .scalars()
        .all()
    )
    return {"runs": [_run_view(r, with_output=False) for r in rows]}


@router.get("/benchmark/{run_id}")
async def get_local_benchmark(
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    run = await db.get(LocalBenchmarkRun, run_id)
    if run is None or run.tenant_id != tenant_id:
        raise HTTPException(404, "benchmark run not found")
    return _run_view(run, with_output=True)


def _run_view(r: LocalBenchmarkRun, *, with_output: bool) -> dict:
    out = {
        "id": str(r.id),
        "state": r.state.value,
        "model": r.model,
        "target_url": r.target_url,
        "concurrency": r.concurrency,
        "request_count": r.request_count,
        "output_tokens": r.output_tokens,
        "summary": r.summary or None,
        "requested_by": r.requested_by,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
    }
    if with_output:
        out["output"] = r.output
    return out


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()
