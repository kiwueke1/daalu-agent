"""Kubernetes clusters API — list, detail, and a read-only kubectl console.

The open-source build attaches a cluster via a stored kubeconfig (the
``Integration(provider="kubernetes")`` row), so there is a single logical
cluster reached under the reserved slug ``kubeconfig``. Its detail page shows
an overview (server version / nodes / namespaces) and a curated read-only
kubectl runner — both driven by :mod:`daalu_automation.core.kube_console`,
which loads the stored kubeconfig and issues authenticated GETs to the API
server.

The WireGuard tunnel-federated cluster list (``GET /clusters``) is part of the
commercial build's cluster-tunnel backend, which isn't included here — so it
returns an empty list and onboarding a tunnel cluster is unsupported (501).
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.api.deps import current_admin, current_tenant_id
from daalu_automation.core import kube_console
from daalu_automation.database import get_db
from daalu_automation.models import Integration, IntegrationStatus, User

router = APIRouter(prefix="/clusters", tags=["clusters"])

# The single kubeconfig-attached cluster lives under this reserved slug.
KUBECONFIG_SLUG = "kubeconfig"


# ── schemas (mirror frontend/lib/api.ts) ─────────────────────────────────


class ClusterOut(BaseModel):
    id: str
    slug: str
    name: str
    status: str
    tunnel_ip: str = ""
    operator_pubkey: str = ""
    customer_pubkey: str | None = None
    customer_endpoint: str | None = None
    last_handshake_at: str | None = None
    last_error: str | None = None


class NodeSummaryOut(BaseModel):
    name: str
    status: str
    roles: list[str]
    version: str
    internal_ip: str | None
    os_image: str | None
    cpu: str | None
    memory: str | None
    created_at: str | None


class ClusterOverviewOut(BaseModel):
    reachable: bool
    server_version: str | None
    node_count: int
    namespace_count: int
    nodes: list[NodeSummaryOut]
    error: str | None


class CommandSpecOut(BaseModel):
    id: str
    label: str
    kubectl: str
    group: str
    namespaced: bool
    supports_selector: bool


class KubectlRunIn(BaseModel):
    command_ids: list[str] = Field(..., min_length=1, max_length=25)
    namespace: str | None = Field(default=None, max_length=63)
    label_selector: str | None = Field(default=None, max_length=256)
    output: Literal["json", "yaml", "cli"] = "cli"


class KubectlResultOut(BaseModel):
    id: str
    command: str
    ok: bool
    output: str
    error: str | None


class KubectlRunOut(BaseModel):
    results: list[KubectlResultOut]


# ── helpers ──────────────────────────────────────────────────────────────


def _status_for(intg: Integration) -> str:
    if intg.status == IntegrationStatus.connected:
        return "connected"
    if intg.status == IntegrationStatus.error:
        return "error"
    return "pending"


async def _kube_integration(
    db: AsyncSession, tenant_id: uuid.UUID
) -> Integration | None:
    return (
        await db.execute(
            select(Integration).where(
                Integration.tenant_id == tenant_id,
                Integration.provider == "kubernetes",
            )
        )
    ).scalar_one_or_none()


def _cluster_out(intg: Integration) -> ClusterOut:
    return ClusterOut(
        id=str(intg.id),
        slug=KUBECONFIG_SLUG,
        name=intg.name or "Kubernetes cluster",
        status=_status_for(intg),
        tunnel_ip="",
        last_handshake_at=(
            intg.last_probed_at.isoformat() if intg.last_probed_at else None
        ),
        last_error=intg.last_error,
    )


# ── endpoints ──────────────────────────────────────────────────────────────


@router.get("", response_model=list[ClusterOut])
async def list_clusters(
    db: AsyncSession = Depends(get_db),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    """Tunnel-federated clusters. Empty in this build (the cluster-tunnel
    backend isn't included); the kubeconfig cluster is surfaced separately
    under the Kubernetes (kubeconfig) tab and at ``/clusters/kubeconfig``."""
    return []


# Literal route must precede ``/{slug}`` so it isn't captured as a slug.
@router.get("/kubectl/catalog", response_model=list[CommandSpecOut])
async def kubectl_catalog(
    _tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    return [
        CommandSpecOut(
            id=c.id,
            label=c.label,
            kubectl=c.kubectl,
            group=c.group,
            namespaced=c.namespaced,
            supports_selector=c.supports_selector,
        )
        for c in kube_console.catalog()
    ]


@router.get("/{slug}", response_model=ClusterOut)
async def get_cluster(
    slug: str,
    db: AsyncSession = Depends(get_db),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    if slug != KUBECONFIG_SLUG:
        raise HTTPException(404, "cluster not found")
    intg = await _kube_integration(db, tenant_id)
    if intg is None:
        raise HTTPException(404, "no kubeconfig cluster connected")
    return _cluster_out(intg)


@router.get("/{slug}/overview", response_model=ClusterOverviewOut)
async def cluster_overview(
    slug: str,
    db: AsyncSession = Depends(get_db),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    if slug != KUBECONFIG_SLUG:
        raise HTTPException(404, "cluster not found")
    ov = await kube_console.cluster_overview(tenant_id)
    return ClusterOverviewOut(
        reachable=ov.reachable,
        server_version=ov.server_version,
        node_count=ov.node_count,
        namespace_count=ov.namespace_count,
        nodes=[NodeSummaryOut(**n.__dict__) for n in ov.nodes],
        error=ov.error,
    )


@router.post("/{slug}/kubectl", response_model=KubectlRunOut)
async def run_kubectl(
    slug: str,
    body: KubectlRunIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_admin),
):
    if slug != KUBECONFIG_SLUG:
        raise HTTPException(404, "cluster not found")
    try:
        results = await kube_console.run_commands(
            user.tenant_id,
            command_ids=body.command_ids,
            namespace=body.namespace,
            selector=body.label_selector,
            output=body.output,
            actor_id=user.id,
        )
    except kube_console.KubeConsoleError as e:
        raise HTTPException(400, str(e)) from e
    return KubectlRunOut(
        results=[
            KubectlResultOut(
                id=r.id, command=r.command, ok=r.ok, output=r.output, error=r.error
            )
            for r in results
        ]
    )


@router.post("")
async def onboard_cluster(_user: User = Depends(current_admin)):
    raise HTTPException(
        501,
        "tunnel-federated cluster onboarding requires the cluster-tunnel "
        "backend, which isn't included in this build. Attach a cluster with a "
        "kubeconfig under Managed infra → Kubernetes instead.",
    )
