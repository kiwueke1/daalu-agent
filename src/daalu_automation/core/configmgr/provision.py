"""Drive the config-manager-controller to provision a tenant's NV-CM stack.

Mirrors ``core/sot/nautobot_provisioning.provision_via_controller``: mints a
``config-manager-provision`` service token, POSTs the desired spec to the
controller, polls until ``active``, and returns the resolved per-component
URLs the onboarding route writes into the
``Integration(provider="config_manager")`` row.

See docs/design/nv-config-manager-integration.md §7.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from typing import Any

import httpx

from daalu_automation.config import get_settings


class ConfigManagerProvisioningError(RuntimeError):
    pass


@dataclass
class ProvisionedConfigManager:
    urls: dict[str, Any]
    base_hostname: str
    components: dict[str, Any]
    controller_row_id: str


def is_config_manager_controller_enabled() -> bool:
    return bool(get_settings().config_manager_controller_url)


async def provision_via_config_manager_controller(
    *,
    tenant_id: uuid.UUID,
    components: dict[str, bool] | None = None,
    size_profile: str = "small",
    base_hostname: str | None = None,
    target_cluster_tunnel_id: uuid.UUID | None = None,
    poll_deadline_s: int = 600,
) -> ProvisionedConfigManager:
    """Upsert + poll the controller until the NV-CM stack is ``active``.

    NV-CM first-boot (image pulls + CNPG bootstrap + Django migrations) is
    slower than a bare Nautobot, hence the longer default poll ceiling.
    """
    s = get_settings()
    if not s.config_manager_controller_url:
        raise ConfigManagerProvisioningError(
            "config_manager_controller_url is not configured on this deploy"
        )
    from daalu_automation.core.service_tokens import mint_service_token

    token = mint_service_token(
        tenant_id=str(tenant_id),
        user_id=str(tenant_id),
        purpose="config-manager-provision",
        ttl_seconds=600,
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    base = s.config_manager_controller_url.rstrip("/")
    body: dict[str, Any] = {
        "target_cluster_tunnel_id": (
            str(target_cluster_tunnel_id) if target_cluster_tunnel_id else None
        ),
        "size_profile": size_profile,
    }
    if components is not None:
        body["components"] = components
    if base_hostname:
        body["base_hostname"] = base_hostname

    async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
        resp = await client.post(f"{base}/tenants/{tenant_id}", json=body)
        if resp.status_code not in (200, 201):
            raise ConfigManagerProvisioningError(
                f"config-manager-controller rejected upsert: "
                f"HTTP {resp.status_code} — {resp.text[:300]}"
            )
        view = resp.json()
        waited = 0
        while view.get("state") != "active":
            if view.get("state") == "error":
                raise ConfigManagerProvisioningError(
                    f"controller marked tenant errored: "
                    f"{view.get('last_error') or '(no detail)'}"
                )
            if waited >= poll_deadline_s:
                raise ConfigManagerProvisioningError(
                    f"NV-CM stack did not reach 'active' in {poll_deadline_s}s "
                    f"(currently '{view.get('state')}'); still booting — retry soon"
                )
            await asyncio.sleep(5)
            waited += 5
            r = await client.get(f"{base}/tenants/{tenant_id}")
            if r.status_code != 200:
                raise ConfigManagerProvisioningError(
                    f"controller poll failed: HTTP {r.status_code}"
                )
            view = r.json()

    return ProvisionedConfigManager(
        urls=view.get("urls", {}),
        base_hostname=view.get("base_hostname", ""),
        components=view.get("components", {}),
        controller_row_id=view["id"],
    )
