"""Per-tenant NVIDIA Config Manager (NV-CM) stack state.

One row per Daalu tenant that opted into the network config-management
plane. Owns the lifecycle of an isolated NV-CM Helm release (Render +
Config Store + Temporal + optional ZTP/DHCP/UI + bundled Nautobot) —
either in the operator's cluster (``target_cluster_tunnel_id IS NULL``)
or in the customer's own cluster reached via WireGuard.

Mirrors :class:`NautobotTenant` in shape and intent. The customer-facing
surface (service URLs + Keycloak client) is the tenant's
``Integration(provider="config_manager")`` row, written from this row
once provisioning reaches ``active``; this table is the operator-side
materialisation state driven by ``config_manager_controller``.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from daalu_automation.database import Base
from daalu_automation.models._mixins import (
    TenantScopedMixin,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
)


class ConfigManagerTenantState(str, enum.Enum):
    pending = "pending"
    provisioning = "provisioning"
    active = "active"
    error = "error"
    deleting = "deleting"
    destroyed = "destroyed"


class ConfigManagerTenant(
    UUIDPrimaryKeyMixin, TenantScopedMixin, TimestampMixin, Base
):
    __tablename__ = "config_manager_tenants"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", name="uq_config_manager_tenants_tenant_id"
        ),
    )

    state: Mapped[ConfigManagerTenantState] = mapped_column(
        SAEnum(ConfigManagerTenantState, name="config_manager_tenant_state"),
        default=ConfigManagerTenantState.pending,
        nullable=False,
    )

    # NULL → operator/local cluster. NOT NULL → customer cluster reached
    # via the named WireGuard tunnel. The controller picks its Helm/kube
    # target from this (reusing _load_customer_kubeconfig).
    target_cluster_tunnel_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("cluster_tunnels.id", ondelete="SET NULL"),
        nullable=True,
    )

    # K8s namespace the Helm release is installed into: ``cm-<slug>``.
    namespace: Mapped[str] = mapped_column(String(253), nullable=False)

    # Base hostname the chart derives per-component URLs from, e.g.
    # ``<slug>.host.example.com``. Unique per tenant so HTTPRoutes/listeners on
    # the shared GatewayClass don't collide.
    base_hostname: Mapped[str] = mapped_column(String(253), nullable=False)

    # Chosen NV-CM components (chart ``services.*`` toggles), e.g.
    # {"render": true, "configStore": true, "temporal": true,
    #  "nautobot": true, "ztp": false, "dhcp": false, "ui": false}.
    components: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    # Sizing profile (small/medium/large) → CNPG instance count + resource
    # overrides at values-render time.
    size_profile: Mapped[str] = mapped_column(
        String(16), default="small", nullable=False
    )

    # Pinned vendored chart version the controller installs/upgrades to.
    chart_version: Mapped[str] = mapped_column(
        String(64), default="", nullable=False
    )

    # Resolved per-component URLs (svc-* machine + human), populated when
    # state == active. Copied into the Integration(provider="config_manager")
    # row by the onboarding route.
    urls: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    # Keycloak service client the hub uses against NV-CM svc-* endpoints.
    keycloak_client_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    keycloak_client_secret_ciphertext: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )

    # Encrypted JSON bag of generated per-tenant secrets (e.g. CNPG/NATS
    # passwords) the controller stamps into the release — kept so an
    # operator can recover them without spelunking K8s Secrets.
    secrets_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)

    last_ready_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    last_error: Mapped[str | None] = mapped_column(Text)
