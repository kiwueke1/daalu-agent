"""Local inference introspection + benchmarking for the AI Factory laptop path.

On a GPU Kubernetes deployment the AI Factory reads NVIDIA DCGM series from
Prometheus (see ``api/routers/gpu_metrics.py``). A laptop / Docker-Compose
install has neither a DCGM exporter nor Prometheus nor an onboarded GPU — so the
factory floor is dark. But the operator *does* have an inference brain: the
OpenAI-compatible endpoint they wired up in deployment doc Part 2 (typically
Ollama). This module is the laptop-path equivalent of the DCGM/AIPerf machinery:

* :func:`resolve_endpoint` — which OpenAI-compatible endpoint is actually
  serving the agent right now, mirroring the precedence in ``core/llm``
  (a configured local vLLM wins, else the external/Ollama ``llm_base_url``).
* :func:`probe_endpoint` — is it reachable, how fast, and which models does it
  advertise on ``/v1/models``.
* :func:`run_benchmark` — a small concurrency sweep (the AIPerf analogue) that
  measures TTFT / inter-token latency / throughput against the live endpoint.

Everything is plain OpenAI-API I/O via the already-vendored ``openai`` SDK, so
it works against Ollama, vLLM, or any OpenAI-compatible server without a GPU,
Kubernetes, or Prometheus.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

import structlog

from daalu_automation.config import get_settings

logger = structlog.get_logger(__name__)

# A short, fixed prompt so every request in a sweep is comparable and cheap on
# CPU inference. The benchmark measures the *server*, not prompt variety.
_BENCH_SYSTEM = "You are a benchmark target. Answer concisely."
_BENCH_PROMPT = (
    "In one short paragraph, explain what an inference server does. "
    "Keep it under a hundred words."
)

# Laptop-safe ceilings — a CPU Ollama box is slow, so we cap the sweep so a
# misclicked "1000 requests at concurrency 64" can't wedge the worker.
MAX_REQUESTS_PER_LEVEL = 200
MAX_CONCURRENCY = 64
MAX_OUTPUT_TOKENS = 1024


@dataclass(slots=True)
class ResolvedEndpoint:
    """The OpenAI-compatible endpoint currently serving the agent."""

    base_url: str
    api_key: str
    model: str
    # A human label for where this came from, for the UI ("Local vLLM",
    # "Ollama / OpenAI-compatible"). Best-effort — we can't always know the
    # server software, so this describes the *config slot*, not the vendor.
    source: str
    configured: bool


@dataclass(slots=True)
class EndpointProbe:
    configured: bool
    base_url: str
    model: str
    source: str
    reachable: bool
    latency_ms: int | None = None
    models: list[str] = field(default_factory=list)
    error: str | None = None


def resolve_endpoint() -> ResolvedEndpoint:
    """Pick the OpenAI-compatible endpoint the agent actually uses.

    Precedence mirrors the OpenAI branches of ``core/llm._dispatch``: a
    configured local vLLM (``llm_local_base_url``) is the sovereign first
    choice; otherwise the external/Ollama endpoint (``llm_base_url``, which the
    laptop deployment doc sets to ``http://host.docker.internal:11434/v1``).
    We deliberately do NOT surface the Anthropic tier here — it is a public
    cloud provider with no ``/v1/models`` we introspect, and the whole point of
    this panel is the *local* brain.
    """
    s = get_settings()
    if s.llm_local_base_url:
        return ResolvedEndpoint(
            base_url=s.llm_local_base_url,
            api_key=s.llm_local_api_key or "not-required",
            model=s.llm_local_model_classifier,
            source="Local vLLM",
            configured=True,
        )
    return ResolvedEndpoint(
        base_url=s.llm_base_url,
        api_key=s.llm_api_key or "not-required",
        model=s.llm_model or s.llm_model_classifier,
        source="OpenAI-compatible (e.g. Ollama)",
        configured=bool(s.llm_base_url),
    )


def _client(ep: ResolvedEndpoint) -> Any:
    """Build an AsyncOpenAI client for ``ep`` (raises if the SDK is absent)."""
    from openai import AsyncOpenAI

    return AsyncOpenAI(api_key=ep.api_key or "not-required", base_url=ep.base_url)


async def probe_endpoint(ep: ResolvedEndpoint | None = None) -> EndpointProbe:
    """Liveness + model list for the resolved endpoint.

    Never raises — a probe failure is data the UI renders, not an exception.
    """
    ep = ep or resolve_endpoint()
    if not ep.configured:
        return EndpointProbe(
            configured=False,
            base_url=ep.base_url,
            model=ep.model,
            source=ep.source,
            reachable=False,
            error="no inference endpoint configured (set LLM_BASE_URL)",
        )
    start = time.monotonic()
    try:
        client = _client(ep)
        listed = await client.models.list()
        models = [m.id for m in getattr(listed, "data", []) if getattr(m, "id", None)]
        latency_ms = int((time.monotonic() - start) * 1000)
        return EndpointProbe(
            configured=True,
            base_url=ep.base_url,
            model=ep.model,
            source=ep.source,
            reachable=True,
            latency_ms=latency_ms,
            models=models,
        )
    except Exception as e:  # noqa: BLE001 — any failure is "unreachable" to the UI
        logger.info("local_inference.probe_failed", base_url=ep.base_url, error=str(e))
        return EndpointProbe(
            configured=True,
            base_url=ep.base_url,
            model=ep.model,
            source=ep.source,
            reachable=False,
            error=f"{type(e).__name__}: {e}"[:300],
        )


def parse_concurrency(spec: str) -> list[int]:
    """Parse a ``"1,2,4,8"`` sweep spec into a sorted, deduped, capped list."""
    levels: set[int] = set()
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            continue
        if n >= 1:
            levels.add(min(n, MAX_CONCURRENCY))
    return sorted(levels) or [1]


@dataclass(slots=True)
class _ReqResult:
    ok: bool
    ttft_ms: float | None
    latency_ms: float
    completion_tokens: int
    error: str | None = None


async def _one_request(
    client: Any, model: str, output_tokens: int
) -> _ReqResult:
    """One streamed chat completion, timing TTFT and counting output tokens."""
    start = time.monotonic()
    ttft: float | None = None
    tokens = 0
    usage_completion: int | None = None
    try:
        stream = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _BENCH_SYSTEM},
                {"role": "user", "content": _BENCH_PROMPT},
            ],
            max_tokens=output_tokens,
            stream=True,
            stream_options={"include_usage": True},
        )
        async for chunk in stream:
            # The usage-only final chunk (include_usage) carries no choices.
            if getattr(chunk, "usage", None):
                usage_completion = chunk.usage.completion_tokens
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta = choices[0].delta
            if delta and (delta.content or getattr(delta, "tool_calls", None)):
                if ttft is None:
                    ttft = (time.monotonic() - start) * 1000
                if delta.content:
                    tokens += 1
        latency_ms = (time.monotonic() - start) * 1000
        # Prefer the server's own usage count; fall back to chunk count.
        completion = usage_completion if usage_completion is not None else tokens
        return _ReqResult(
            ok=True, ttft_ms=ttft, latency_ms=latency_ms, completion_tokens=completion
        )
    except Exception as e:  # noqa: BLE001 — record per-request failure, keep sweeping
        latency_ms = (time.monotonic() - start) * 1000
        return _ReqResult(
            ok=False,
            ttft_ms=ttft,
            latency_ms=latency_ms,
            completion_tokens=tokens,
            error=f"{type(e).__name__}: {e}"[:200],
        )


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


async def _run_level(
    client: Any, model: str, concurrency: int, request_count: int, output_tokens: int
) -> dict[str, Any]:
    """Fire ``request_count`` requests at ``concurrency`` in-flight; aggregate."""
    sem = asyncio.Semaphore(concurrency)

    async def _guarded() -> _ReqResult:
        async with sem:
            return await _one_request(client, model, output_tokens)

    wall_start = time.monotonic()
    results = await asyncio.gather(*[_guarded() for _ in range(request_count)])
    wall_s = max(time.monotonic() - wall_start, 1e-6)

    ok = [r for r in results if r.ok]
    ttfts = [r.ttft_ms for r in ok if r.ttft_ms is not None]
    latencies = [r.latency_ms for r in ok]
    total_tokens = sum(r.completion_tokens for r in ok)
    # Inter-token latency: time after the first token, spread over the rest.
    itls = [
        (r.latency_ms - r.ttft_ms) / (r.completion_tokens - 1)
        for r in ok
        if r.ttft_ms is not None and r.completion_tokens > 1
    ]
    first_error = next((r.error for r in results if not r.ok and r.error), None)
    return {
        "concurrency": concurrency,
        "requests": request_count,
        "succeeded": len(ok),
        "failed": len(results) - len(ok),
        "metrics": {
            "ttft_ms": round(_mean(ttfts), 1),
            "itl_ms": round(_mean(itls), 1),
            "request_latency_ms": round(_mean(latencies), 1),
            "output_token_throughput": round(total_tokens / wall_s, 1),
            "request_throughput": round(len(ok) / wall_s, 2),
        },
        "error": first_error,
    }


async def run_benchmark(
    *,
    concurrency: list[int],
    request_count: int,
    output_tokens: int,
    ep: ResolvedEndpoint | None = None,
) -> dict[str, Any]:
    """Run the sweep and return a summary in the AIPerf summary shape.

    Returns ``{concurrency_levels: [...], metrics: {...}, model, base_url}`` so
    the frontend's existing concurrency-curve renderer can display it. The
    headline ``metrics`` is the highest-concurrency level (the saturation
    point), which is what capacity planning cares about. Raises on a fully
    dead endpoint (no level produced a single success) so the run is marked
    ``failed`` rather than silently "passing" with zeroes.
    """
    ep = ep or resolve_endpoint()
    request_count = max(1, min(request_count, MAX_REQUESTS_PER_LEVEL))
    output_tokens = max(1, min(output_tokens, MAX_OUTPUT_TOKENS))
    client = _client(ep)

    levels: list[dict[str, Any]] = []
    for c in concurrency:
        logger.info(
            "local_inference.bench_level", concurrency=c, requests=request_count
        )
        levels.append(await _run_level(client, ep.model, c, request_count, output_tokens))

    total_ok = sum(lv["succeeded"] for lv in levels)
    if total_ok == 0:
        first_error = next((lv["error"] for lv in levels if lv.get("error")), None)
        raise RuntimeError(first_error or "every request failed against the endpoint")

    return {
        "model": ep.model,
        "base_url": ep.base_url,
        "concurrency_levels": levels,
        # Headline = the top concurrency level reached.
        "metrics": levels[-1]["metrics"],
    }
