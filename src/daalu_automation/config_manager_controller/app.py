"""FastAPI app + reconcile loop for config-manager-controller.

Mirrors ``nautobot_controller/app.py``: a small REST surface daalu-api
drives (service-token JWT, ``purpose='config-manager-provision'``) plus a
background reconciler that converges ``config_manager_tenants`` rows to a
running NV-CM Helm release. Unlike the nautobot-controller, materialisation
is ``helm upgrade --install`` of the vendored pinned chart (via HelmRunner)
rather than raw-manifest apply.

Endpoints:
* ``POST /tenants/{tenant_id}`` — get-or-create the row + start provisioning.
* ``GET  /tenants/{tenant_id}`` — read state + (when active) the resolved URLs.
* ``DELETE /tenants/{tenant_id}`` — schedule teardown (helm uninstall).
"""

from __future__ import annotations

import asyncio
import os
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.config import get_settings
from daalu_automation.config_manager_controller import prechecks
from daalu_automation.config_manager_controller import values as values_mod
from daalu_automation.config_manager_controller.deployer_runner import DeployerRunner
from daalu_automation.config_manager_controller.helm_runner import HelmRunner
from daalu_automation.core.crypto import encrypt_secret
from daalu_automation.core.service_tokens import (
    ServiceTokenClaims,
    ServiceTokenError,
    verify_service_token,
)
from daalu_automation.database import get_db
from daalu_automation.models import (
    ClusterTunnel,
    ClusterTunnelStatus,
    ConfigManagerTenant,
    ConfigManagerTenantState,
    Tenant,
)

# Reuse the nautobot-controller's tunnel-kubeconfig loader — one place
# decides how to reach a customer cluster over the wg mesh.
from daalu_automation.nautobot_controller.app import _load_customer_kubeconfig

logger = structlog.get_logger(__name__)

_RECONCILE_INTERVAL = 30.0
_ACCEPTED_PURPOSE = "config-manager-provision"


class TenantSpec(BaseModel):
    target_cluster_tunnel_id: uuid.UUID | None = None
    base_hostname: str | None = None
    components: dict[str, bool] | None = None
    size_profile: str = "small"
    chart_version: str | None = None


class TenantView(BaseModel):
    id: str
    tenant_id: str
    state: str
    target_cluster_tunnel_id: str | None
    namespace: str
    base_hostname: str
    components: dict[str, Any]
    last_error: str | None
    urls: dict[str, Any] = {}


def _authenticate(authorization: str | None) -> ServiceTokenClaims:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    try:
        claims = verify_service_token(authorization.split(None, 1)[1])
    except ServiceTokenError as e:
        logger.warning("config_manager_controller.auth_failed", error=str(e))
        raise HTTPException(status_code=401, detail="invalid token") from e
    if claims.purpose != _ACCEPTED_PURPOSE:
        raise HTTPException(status_code=403, detail="wrong token purpose")
    return claims


def _chart_path(chart_version: str) -> str:
    settings = get_settings()
    return os.path.join(
        settings.config_manager_chart_dir,
        f"nv-config-manager-{chart_version}",
    )


def create_app() -> FastAPI:
    app = FastAPI(
        title="Daalu Config Manager Controller",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.on_event("startup")
    async def _startup() -> None:
        app.state.reconcile_task = asyncio.create_task(_reconcile_loop())

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        task = getattr(app.state, "reconcile_task", None)
        if task is not None:
            task.cancel()

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/tenants/{tenant_id}", response_model=TenantView)
    async def upsert_tenant(
        tenant_id: uuid.UUID,
        spec: TenantSpec,
        authorization: str | None = Header(default=None),
        db: AsyncSession = Depends(get_db),
    ) -> TenantView:
        claims = _authenticate(authorization)
        if claims.tenant_id != str(tenant_id):
            raise HTTPException(status_code=403, detail="tenant_id mismatch")
        tenant = await db.get(Tenant, tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="tenant not found")

        if spec.target_cluster_tunnel_id is not None:
            ct = await db.get(ClusterTunnel, spec.target_cluster_tunnel_id)
            if ct is None:
                raise HTTPException(status_code=404, detail="cluster_tunnel not found")
            if ct.tenant_id != tenant_id:
                raise HTTPException(status_code=403, detail="cluster_tunnel tenant mismatch")
            if ct.status != ClusterTunnelStatus.connected:
                raise HTTPException(
                    status_code=409,
                    detail=f"cluster_tunnel is {ct.status.value} — must be 'connected'",
                )

        settings = get_settings()
        row = await _find_row(db, tenant_id)
        base_hostname = (
            spec.base_hostname
            or f"{tenant.slug}.{settings.cmtools_base_domain}"
        )
        if row is None:
            row = ConfigManagerTenant(
                tenant_id=tenant_id,
                state=ConfigManagerTenantState.pending,
                target_cluster_tunnel_id=spec.target_cluster_tunnel_id,
                namespace=f"cm-{tenant.slug}",
                base_hostname=base_hostname,
                components=spec.components or dict(values_mod.DEFAULT_COMPONENTS),
                size_profile=spec.size_profile,
                chart_version=spec.chart_version
                or settings.config_manager_default_chart_version,
                # Per-tenant generated secrets (encrypted at rest).
                secrets_ciphertext=encrypt_secret(secrets.token_urlsafe(32)),
            )
            db.add(row)
        elif row.state == ConfigManagerTenantState.pending:
            row.target_cluster_tunnel_id = spec.target_cluster_tunnel_id
            row.base_hostname = base_hostname
            if spec.components is not None:
                row.components = spec.components
            row.size_profile = spec.size_profile
            if spec.chart_version:
                row.chart_version = spec.chart_version
        await db.commit()
        await db.refresh(row)
        return _to_view(row)

    @app.get("/tenants/{tenant_id}", response_model=TenantView)
    async def get_tenant(
        tenant_id: uuid.UUID,
        authorization: str | None = Header(default=None),
        db: AsyncSession = Depends(get_db),
    ) -> TenantView:
        claims = _authenticate(authorization)
        if claims.tenant_id != str(tenant_id):
            raise HTTPException(status_code=403, detail="tenant_id mismatch")
        row = await _find_row(db, tenant_id)
        if row is None:
            raise HTTPException(status_code=404, detail="no config_manager tenant")
        return _to_view(row)

    @app.delete("/tenants/{tenant_id}")
    async def destroy_tenant(
        tenant_id: uuid.UUID,
        authorization: str | None = Header(default=None),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, str]:
        claims = _authenticate(authorization)
        if claims.tenant_id != str(tenant_id):
            raise HTTPException(status_code=403, detail="tenant_id mismatch")
        row = await _find_row(db, tenant_id)
        if row is None:
            raise HTTPException(status_code=404, detail="no config_manager tenant")
        row.state = ConfigManagerTenantState.deleting
        await db.commit()
        return {"status": "scheduled"}

    return app


# ── Helpers ────────────────────────────────────────────────────────────


async def _find_row(
    db: AsyncSession, tenant_id: uuid.UUID
) -> ConfigManagerTenant | None:
    return (
        await db.execute(
            select(ConfigManagerTenant).where(
                ConfigManagerTenant.tenant_id == tenant_id
            )
        )
    ).scalar_one_or_none()


def _to_view(row: ConfigManagerTenant) -> TenantView:
    return TenantView(
        id=str(row.id),
        tenant_id=str(row.tenant_id),
        state=row.state.value,
        target_cluster_tunnel_id=(
            str(row.target_cluster_tunnel_id)
            if row.target_cluster_tunnel_id
            else None
        ),
        namespace=row.namespace,
        base_hostname=row.base_hostname,
        components=row.components or {},
        last_error=row.last_error,
        urls=row.urls or {},
    )


# ── Reconcile loop ─────────────────────────────────────────────────────


async def _reconcile_loop() -> None:
    from daalu_automation.database import AsyncSessionLocal

    logger.info("config_manager_controller.reconcile_loop_started")
    while True:
        try:
            async with AsyncSessionLocal() as db:
                rows = (
                    await db.execute(
                        select(ConfigManagerTenant).where(
                            ConfigManagerTenant.state
                            != ConfigManagerTenantState.destroyed
                        )
                    )
                ).scalars().all()
                for row in rows:
                    try:
                        await _reconcile_one(db, row)
                    except Exception as e:  # noqa: BLE001
                        logger.exception(
                            "config_manager_controller.reconcile_row_failed",
                            tenant_id=str(row.tenant_id),
                        )
                        row.last_error = str(e)[:1000]
                        await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("config_manager_controller.reconcile_iteration_failed")
        await asyncio.sleep(_RECONCILE_INTERVAL)


async def _kubeconfig_for(
    db: AsyncSession, row: ConfigManagerTenant
) -> dict[str, Any] | None:
    if row.target_cluster_tunnel_id is None:
        return None  # local/in-cluster: helm uses its default KUBECONFIG
    return await _load_customer_kubeconfig(db, row.target_cluster_tunnel_id)


def _runner_for(row: ConfigManagerTenant) -> HelmRunner:
    return HelmRunner(chart_path=_chart_path(row.chart_version))


def _deployer_runner_for(row: ConfigManagerTenant) -> DeployerRunner:
    return DeployerRunner(chart_dir=_chart_path(row.chart_version))


async def _provision(
    row: ConfigManagerTenant, kubeconfig: dict[str, Any] | None, settings: Any
) -> tuple[bool, str]:
    """Install/upgrade the release; returns ``(ok, error_text)``.

    Uses the vendored NV-CM Deployer when ``config_manager_use_deployer`` is
    set (the path that breaks the secret-assembler deadlock), else the legacy
    bare-helm HelmRunner. Both are normalised to ``(ok, error)`` so the state
    machine below doesn't care which ran.
    """
    if settings.config_manager_use_deployer:
        res = await _deployer_runner_for(row).upgrade_install(
            row=row, kubeconfig=kubeconfig
        )
        return res.ok, res.error
    vals = values_mod.render_values(
        row, harbor_registry=settings.config_manager_harbor_registry or None
    )
    helm_res = await _runner_for(row).upgrade_install(
        release=f"cm-{row.tenant_id.hex[:12]}",
        namespace=row.namespace,
        values=vals,
        kubeconfig=kubeconfig,
        wait=True,
    )
    return helm_res.ok, helm_res.stderr


async def _teardown(
    row: ConfigManagerTenant, kubeconfig: dict[str, Any] | None, settings: Any
) -> tuple[bool, str]:
    """Uninstall the release; returns ``(ok, error_text)``."""
    if settings.config_manager_use_deployer:
        res = await _deployer_runner_for(row).uninstall(row=row, kubeconfig=kubeconfig)
        return res.ok, res.error
    helm_res = await _runner_for(row).uninstall(
        release=f"cm-{row.tenant_id.hex[:12]}",
        namespace=row.namespace,
        kubeconfig=kubeconfig,
    )
    return helm_res.ok, helm_res.stderr


async def _reconcile_one(db: AsyncSession, row: ConfigManagerTenant) -> None:
    settings = get_settings()
    if row.state == ConfigManagerTenantState.deleting:
        kubeconfig = await _kubeconfig_for(db, row)
        ok, err = await _teardown(row, kubeconfig, settings)
        if ok:
            row.state = ConfigManagerTenantState.destroyed
            await db.commit()
            logger.info(
                "config_manager_controller.tenant_destroyed",
                tenant_id=str(row.tenant_id),
            )
        else:
            row.last_error = err[:1000]
            await db.commit()
        return

    if row.state in (
        ConfigManagerTenantState.pending,
        ConfigManagerTenantState.error,
        ConfigManagerTenantState.provisioning,
        ConfigManagerTenantState.active,
    ):
        kubeconfig = await _kubeconfig_for(db, row)

        # Steady-state short-circuit: an already-`active` tenant whose helm
        # release is `deployed` needs no re-`helm upgrade`. The reconcile loop
        # runs every 30s; re-running `helm upgrade --wait` each tick mints a
        # fresh revision (the chart values aren't bit-stable), churning the row
        # active↔provisioning and risking a `pending-upgrade` lock if an
        # upgrade is interrupted (e.g. a controller image roll). k8s already
        # self-heals the workloads, so skip — just refresh the readiness stamp.
        # To roll out a chart/spec change, reset the row to `pending` (that
        # path still re-provisions). Any uncertainty (helm error, not-deployed)
        # falls through to a full provision.
        if (
            row.state == ConfigManagerTenantState.active
            and settings.config_manager_use_deployer
            and await _deployer_runner_for(row).release_status(
                row=row, kubeconfig=kubeconfig
            )
            == "deployed"
        ):
            row.last_ready_at = datetime.now(tz=timezone.utc)
            await db.commit()
            return

        if row.state in (
            ConfigManagerTenantState.pending,
            ConfigManagerTenantState.error,
        ):
            row.state = ConfigManagerTenantState.provisioning
            await db.commit()

        # Tier-A precheck: refuse to install into a host cluster missing
        # the shared GatewayClass / cert-manager / CNPG. Surfaces a precise
        # "missing …" error instead of an opaque helm failure.
        if not settings.config_manager_skip_host_precheck:
            ready, missing = await prechecks.host_cluster_ready(kubeconfig)
            if not ready:
                row.state = ConfigManagerTenantState.error
                row.last_error = (
                    "host cluster not ready (Tier-A singletons missing): "
                    + ", ".join(missing)
                )[:1000]
                await db.commit()
                logger.warning(
                    "config_manager_controller.host_not_ready",
                    tenant_id=str(row.tenant_id),
                    missing=missing,
                )
                return

        ok, err = await _provision(row, kubeconfig, settings)
        if ok:
            row.urls = values_mod.compute_urls(row.base_hostname)
            row.last_ready_at = datetime.now(tz=timezone.utc)
            row.last_error = None
            row.state = ConfigManagerTenantState.active
            await db.commit()
            logger.info(
                "config_manager_controller.tenant_active",
                tenant_id=str(row.tenant_id),
            )
        else:
            row.state = ConfigManagerTenantState.error
            row.last_error = err[:1000]
            await db.commit()
