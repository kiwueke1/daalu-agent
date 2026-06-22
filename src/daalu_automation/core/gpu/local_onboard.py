"""Self-hosted GPU onboarding for AI Factory — the UI equivalent of
``scripts/onboard-cluster.sh`` steps (a) + (b).

Two operations, both against the cluster Daalu already reads via its stored
``kubernetes`` integration kubeconfig:

* :func:`discover_gpus` — list the GPUs the cluster advertises
  (``nvidia.com/gpu`` capacity + the GPU Operator/NFD product & memory labels),
  probe whether DCGM is already scrapeable, and suggest a GPU class + the
  served model — everything the wizard needs to pre-fill itself.
* :func:`onboard_gpu` — stamp a tenant-labelled DCGM ServiceMonitor (so
  Prometheus scrapes the GPU for *this* tenant) and write the ``gpu_tenants``
  owner row that flips AI Factory to the live GPU view.

No CLI, no ``.env`` edit, no restart: metrics resolve through the tenant's
``prometheus`` integration (:meth:`PrometheusClient.for_tenant`), which the
operator wires from the UI like any other observability store.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import structlog
from sqlalchemy import select

from daalu_automation.core.prometheus import PrometheusClient, PrometheusUnavailable
from daalu_automation.database import AsyncSessionLocal
from daalu_automation.models.gpu_tenant import GpuTenant, GpuTenantState

logger = structlog.get_logger(__name__)

DCGM_NAMESPACE = "gpu-operator"
DCGM_SERVICEMONITOR = "nvidia-dcgm-exporter"


class GpuOnboardError(RuntimeError):
    """Onboarding could not be completed (kube/cluster problem)."""


# ── discovery ────────────────────────────────────────────────────────────


@dataclass
class GpuNodeInfo:
    name: str
    gpu_count: int
    gpu_product: str | None
    gpu_memory: str | None  # human, e.g. "48 GB"
    ready: bool


@dataclass
class GpuDiscovery:
    reachable: bool
    error: str | None = None
    total_gpus: int = 0
    nodes: list[GpuNodeInfo] = field(default_factory=list)
    suggested_gpu_class: str | None = None
    suggested_model: str | None = None
    suggested_service_url: str | None = None
    prometheus_connected: bool = False
    dcgm_scrapeable: bool = False
    already_onboarded: bool = False


def _suggest_gpu_class(product: str | None, memory_mib: str | None) -> str | None:
    p = (product or "").lower()
    if "ada" in p or "l40" in p or "l4" in p:
        fam = "ada"
    elif "h100" in p or "h200" in p or "hopper" in p:
        fam = "hopper"
    elif "b200" in p or "blackwell" in p or "gb200" in p:
        fam = "blackwell"
    elif "a100" in p or "a40" in p or "a30" in p or "ampere" in p:
        fam = "ampere"
    else:
        fam = "gpu"
    gb: int | None = None
    try:
        if memory_mib:
            gb = round(int(memory_mib) / 1024)
    except (ValueError, TypeError):
        gb = None
    return f"{fam}-{gb}" if gb else (fam if fam != "gpu" else None)


def _mib_to_human(memory_mib: str | None) -> str | None:
    try:
        if memory_mib:
            return f"{round(int(memory_mib) / 1024)} GB"
    except (ValueError, TypeError):
        pass
    return memory_mib


async def discover_gpus(tenant_id: uuid.UUID) -> GpuDiscovery:
    """Inspect the connected cluster for schedulable GPUs + pre-fill hints."""
    from daalu_automation.core.kube_tools import KubeUnavailable, _tenant_kube_or_default
    from daalu_automation.core.local_inference import resolve_endpoint

    # Already onboarded? (used by the UI to show "re-sync" instead of "add")
    async with AsyncSessionLocal() as db:
        existing = (
            await db.execute(
                select(GpuTenant).where(GpuTenant.tenant_id == tenant_id)
            )
        ).scalar_one_or_none()

    ep = resolve_endpoint()
    disc = GpuDiscovery(
        reachable=False,
        suggested_model=ep.model or None,
        suggested_service_url=ep.base_url or None,
        already_onboarded=existing is not None,
    )

    try:
        core, _apps, _mod = await _tenant_kube_or_default(tenant_id)
    except (KubeUnavailable, GpuOnboardError) as e:
        disc.error = (
            f"{e}. Add the cluster under Managed infra → Kubernetes first."
        )
        return disc

    def _collect() -> tuple[list[GpuNodeInfo], str | None]:
        rows: list[GpuNodeInfo] = []
        suggestion: str | None = None
        for n in core.list_node().items:
            cap = n.status.capacity or {}
            count = int(cap.get("nvidia.com/gpu", 0) or 0)
            if count <= 0:
                continue
            labels = n.metadata.labels or {}
            conds = {c.type: c.status for c in (n.status.conditions or [])}
            product = labels.get("nvidia.com/gpu.product")
            memory_mib = labels.get("nvidia.com/gpu.memory")
            if suggestion is None:
                suggestion = _suggest_gpu_class(product, memory_mib)
            rows.append(
                GpuNodeInfo(
                    name=n.metadata.name,
                    gpu_count=count,
                    gpu_product=product,
                    gpu_memory=_mib_to_human(memory_mib),
                    ready=conds.get("Ready") == "True",
                )
            )
        return rows, suggestion

    try:
        nodes, suggested = await asyncio.to_thread(_collect)
    except Exception as e:  # noqa: BLE001
        logger.warning("gpu.discover_failed", error=str(e))
        disc.error = f"couldn't read cluster nodes: {str(e)[:300]}"
        return disc

    disc.reachable = True
    disc.nodes = nodes
    disc.total_gpus = sum(n.gpu_count for n in nodes)
    disc.suggested_gpu_class = suggested

    # Is Prometheus wired, and is DCGM already being scraped?
    prom = await PrometheusClient.for_tenant(tenant_id)
    disc.prometheus_connected = prom.configured
    if prom.configured:
        try:
            disc.dcgm_scrapeable = bool(
                await prom.query_scalar("count(DCGM_FI_DEV_GPU_TEMP)", default=0.0)
            )
        except PrometheusUnavailable:
            disc.dcgm_scrapeable = False
    return disc


# ── onboarding ─────────────────────────────────────────────────────────────


@dataclass
class OnboardResult:
    ok: bool
    warnings: list[str] = field(default_factory=list)
    dcgm_scrapeable: bool = False


def _servicemonitor_manifest(tenant_id: uuid.UUID, gpu_class: str) -> dict[str, Any]:
    return {
        "apiVersion": "monitoring.coreos.com/v1",
        "kind": "ServiceMonitor",
        "metadata": {
            "name": DCGM_SERVICEMONITOR,
            "namespace": DCGM_NAMESPACE,
            "labels": {"release": "kube-prometheus-stack"},
        },
        "spec": {
            "selector": {"matchLabels": {"app": "nvidia-dcgm-exporter"}},
            "endpoints": [
                {
                    "port": "gpu-metrics",
                    "interval": "15s",
                    "relabelings": [
                        {"targetLabel": "tenant", "replacement": str(tenant_id)},
                        {"targetLabel": "gpu_class", "replacement": gpu_class},
                    ],
                }
            ],
        },
    }


async def onboard_gpu(
    tenant_id: uuid.UUID,
    *,
    gpu_class: str,
    model_classifier: str,
    namespace: str = "daalu",
    service_url: str | None = None,
    actor_id: uuid.UUID | None = None,
) -> OnboardResult:
    """Apply the tenant-labelled DCGM ServiceMonitor and upsert the owner row."""
    from daalu_automation.core.kube_tools import KubeUnavailable, _tenant_kube_or_default

    result = OnboardResult(ok=True)
    logger.info(
        "gpu.onboard", tenant_id=str(tenant_id),
        actor_id=str(actor_id) if actor_id else None,
        gpu_class=gpu_class, model=model_classifier, namespace=namespace,
    )

    # (a) DCGM ServiceMonitor — best-effort: a cluster without the Prometheus
    # Operator (no ServiceMonitor CRD) still gets the owner row; the UI just
    # surfaces a warning that metrics won't flow until telemetry is installed.
    try:
        core, _apps, mod = await _tenant_kube_or_default(tenant_id)
        manifest = _servicemonitor_manifest(tenant_id, gpu_class)

        def _apply() -> None:
            co = mod.CustomObjectsApi(core.api_client)
            try:
                co.create_namespaced_custom_object(
                    group="monitoring.coreos.com", version="v1",
                    namespace=DCGM_NAMESPACE, plural="servicemonitors",
                    body=manifest,
                )
            except mod.exceptions.ApiException as e:
                if e.status != 409:
                    raise
                co.patch_namespaced_custom_object(
                    group="monitoring.coreos.com", version="v1",
                    namespace=DCGM_NAMESPACE, plural="servicemonitors",
                    name=DCGM_SERVICEMONITOR, body=manifest,
                )

        await asyncio.to_thread(_apply)
    except KubeUnavailable as e:
        result.warnings.append(
            f"couldn't reach the cluster to install the DCGM ServiceMonitor "
            f"({e}); add the Kubernetes integration, then re-sync."
        )
    except Exception as e:  # noqa: BLE001
        msg = _humanise(e)
        if "monitoring.coreos.com" in msg or "404" in msg or "the server could not find" in msg:
            result.warnings.append(
                "the Prometheus Operator (ServiceMonitor CRD) isn't installed — "
                "GPU metrics won't flow until telemetry is set up (2B.2)."
            )
        else:
            result.warnings.append(f"DCGM ServiceMonitor apply failed: {msg}")

    # (b) gpu_tenants owner row — the flip to the live owner view.
    now = datetime.now(tz=timezone.utc)
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(GpuTenant).where(GpuTenant.tenant_id == tenant_id)
            )
        ).scalar_one_or_none()
        if row is None:
            row = GpuTenant(tenant_id=tenant_id)
            db.add(row)
        row.state = GpuTenantState.active
        row.shared = False
        row.gpu_class = gpu_class
        row.model_classifier = model_classifier
        row.namespace = namespace or "daalu"
        if service_url:
            row.service_url = service_url
        row.last_ready_at = now
        row.last_error = None
        await db.commit()

    # Report whether metrics are flowing yet (the label takes ~30s to appear).
    prom = await PrometheusClient.for_tenant(tenant_id)
    if prom.configured:
        try:
            result.dcgm_scrapeable = bool(
                await prom.query_scalar("count(DCGM_FI_DEV_GPU_TEMP)", default=0.0)
            )
        except PrometheusUnavailable:
            result.dcgm_scrapeable = False
    else:
        result.warnings.append(
            "no Prometheus integration is connected — add one under Managed "
            "infra → Observability so the GPU metric cards can populate."
        )
    return result


def _humanise(e: Exception) -> str:
    status = getattr(e, "status", None)
    if status is not None:
        return f"HTTP {status} {getattr(e, 'reason', '') or ''}".strip()
    return f"{type(e).__name__}: {e}"
