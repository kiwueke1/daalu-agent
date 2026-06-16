"""Nautobot implementation of :class:`SourceOfTruth`.

Reads use Nautobot's GraphQL endpoint (``/api/graphql/``). Writes use
the REST endpoint (``/api/extras/config-contexts/``) because GraphQL
mutations are not enabled in stock Nautobot.

The intended config for a Linux server is stored as a Config Context
attached to the Device, named ``daalu_intent``. The shape of its JSON
body matches :class:`~daalu_automation.core.sot.models.LinuxFacts`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, ClassVar

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.core.crypto import decrypt_secret
from daalu_automation.core.sot.base import SourceOfTruth
from daalu_automation.core.sot.models import (
    AuthorizedKey,
    BiosAttribute,
    BootOverride,
    CloudInitUserData,
    Device,
    DeviceFacts,
    IntendedConfig,
    InterfaceConfig,
    LinuxFacts,
    NetworkFacts,
    ObservedSnapshot,
    PackagePresence,
    PowerControl,
    RedfishFacts,
    SoTRevision,
    StaticRoute,
    SysctlValue,
    VlanDefinition,
)

# Transports whose intent payload is parsed into NetworkFacts. Kept
# as a set rather than a tuple because the membership test reads
# more naturally and new transports get added one-per-line.
_NETWORK_TRANSPORTS: set[str] = {"junos", "iosxr", "eos"}
from daalu_automation.models import Integration

logger = logging.getLogger(__name__)

NAUTOBOT_PROVIDER = "nautobot"
INTENT_CONTEXT_NAME = "daalu_intent"
OBSERVED_CONTEXT_NAME = "daalu_observed"


class NautobotUnavailable(RuntimeError):
    """No Nautobot integration configured, or its credentials are malformed."""


def _build_http_client(
    url: str, token: str, *, proxy_url: str | None = None
) -> httpx.AsyncClient:
    """Construct the AsyncClient used to talk to Nautobot.

    Factored out as a module-level function so tests can monkeypatch it
    with one backed by ``httpx.MockTransport``.

    ``proxy_url`` (``http://<tunnel_ip>:8888``) routes the request through the
    tenant's daalu-edge forward proxy over WireGuard — needed when the
    bundled Nautobot runs on a workload cluster whose ``svc-*`` host only
    resolves in-cluster. ``None`` → direct dial (unchanged default; keeps the
    MockTransport tests + the verified direct path working).
    """
    return httpx.AsyncClient(
        base_url=url.rstrip("/"),
        timeout=15.0,
        proxy=proxy_url,
        headers={
            "Authorization": f"Token {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )


async def _load_credentials(
    db: AsyncSession, tenant_id: uuid.UUID
) -> tuple[str, str, str | None]:
    """Return ``(url, token, proxy_url)`` for the tenant's Nautobot integration.

    Prefers the **shared NV-CM-bundled Nautobot** when the tenant has a
    ``config_manager`` integration carrying ``nautobot_url`` +
    ``nautobot_token_ciphertext`` — that one Nautobot is the source of
    truth for both network devices and servers. Falls back to the
    standalone ``nautobot`` integration (BYO / legacy nautobot_controller).

    ``proxy_url`` is resolved from the chosen integration's
    ``cluster_tunnel_id`` (``None`` when the integration has no tunnel, i.e.
    the Nautobot is directly reachable from the hub).
    """
    from daalu_automation.core.cluster_proxy import get_proxy_url

    cm_row = (
        await db.execute(
            select(Integration).where(
                Integration.tenant_id == tenant_id,
                Integration.provider == "config_manager",
            )
        )
    ).scalar_one_or_none()
    if cm_row is not None:
        cm_cfg = cm_row.config or {}
        cm_url = cm_cfg.get("nautobot_url")
        cm_token_ct = cm_cfg.get("nautobot_token_ciphertext")
        cm_token_pt = cm_cfg.get("nautobot_token")
        if cm_url and (cm_token_ct or cm_token_pt):
            cm_token = decrypt_secret(cm_token_ct) if cm_token_ct else cm_token_pt
            cm_proxy = await get_proxy_url(db, cm_row.cluster_tunnel_id)
            return cm_url, cm_token, cm_proxy

    row = (
        await db.execute(
            select(Integration).where(
                Integration.tenant_id == tenant_id,
                Integration.provider == NAUTOBOT_PROVIDER,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise NautobotUnavailable(
            f"no nautobot integration for tenant {tenant_id}"
        )
    cfg = row.config or {}
    url = cfg.get("url")
    # Accept both shapes: the wizard PUTs plaintext `token` from the
    # onboarding form (matching how slack.webhook_url / pagerduty.api_token
    # are stored in cleartext), while the hosted-provisioning route and
    # operators who PUT directly use the encrypted `token_ciphertext`
    # form. Prefer the encrypted form when both are present.
    token_ct = cfg.get("token_ciphertext")
    token_pt = cfg.get("token")
    if not url or not (token_ct or token_pt):
        raise NautobotUnavailable(
            f"nautobot integration {row.id} missing url or token"
        )
    token = decrypt_secret(token_ct) if token_ct else token_pt
    proxy_url = await get_proxy_url(db, row.cluster_tunnel_id)
    return url, token, proxy_url


# ── Fact parsing ──────────────────────────────────────────────────────


def _parse_facts(blob: dict[str, Any]) -> LinuxFacts:
    """Coerce a Nautobot ConfigContext JSON body into LinuxFacts.

    Tolerant of missing/malformed fields: a single bad key shouldn't
    poison the rest of the device's intent.
    """
    facts = LinuxFacts()
    facts.hostname = blob.get("hostname")
    for ak in blob.get("authorized_keys", []) or []:
        try:
            facts.authorized_keys.append(AuthorizedKey(**ak))
        except Exception:
            logger.warning("nautobot.intent.bad_authorized_key", extra={"raw": ak})
    for sc in blob.get("sysctl", []) or []:
        try:
            facts.sysctl.append(SysctlValue(**sc))
        except Exception:
            logger.warning("nautobot.intent.bad_sysctl", extra={"raw": sc})
    for pkg in blob.get("packages", []) or []:
        try:
            facts.packages.append(PackagePresence(**pkg))
        except Exception:
            logger.warning("nautobot.intent.bad_package", extra={"raw": pkg})
    ci = blob.get("cloud_init")
    if isinstance(ci, dict) and "content" in ci:
        facts.cloud_init = CloudInitUserData(content=ci.get("content") or "")
    return facts


def _facts_to_blob(facts: LinuxFacts) -> dict[str, Any]:
    blob: dict[str, Any] = {}
    if facts.hostname is not None:
        blob["hostname"] = facts.hostname
    blob["authorized_keys"] = [k.model_dump() for k in facts.authorized_keys]
    blob["sysctl"] = [v.model_dump() for v in facts.sysctl]
    blob["packages"] = [p.model_dump() for p in facts.packages]
    if facts.cloud_init is not None:
        blob["cloud_init"] = facts.cloud_init.model_dump()
    return blob


# ── Redfish-facts parsing ─────────────────────────────────────────────


def _parse_redfish_facts(blob: dict[str, Any]) -> RedfishFacts:
    facts = RedfishFacts()
    for attr in blob.get("bios_attributes", []) or []:
        try:
            # Tolerate non-string values in the SoT blob — Redfish often
            # surfaces booleans / ints as native JSON types.
            attr2 = dict(attr)
            if "value" in attr2 and not isinstance(attr2["value"], str):
                attr2["value"] = str(attr2["value"])
            facts.bios_attributes.append(BiosAttribute(**attr2))
        except Exception:
            logger.warning("nautobot.intent.bad_bios_attr", extra={"raw": attr})
    bo = blob.get("boot_override")
    if isinstance(bo, dict):
        try:
            facts.boot_override = BootOverride(**bo)
        except Exception:
            logger.warning("nautobot.intent.bad_boot_override", extra={"raw": bo})
    p = blob.get("power")
    if isinstance(p, dict):
        try:
            facts.power = PowerControl(**p)
        except Exception:
            logger.warning("nautobot.intent.bad_power", extra={"raw": p})
    return facts


def _redfish_facts_to_blob(facts: RedfishFacts) -> dict[str, Any]:
    blob: dict[str, Any] = {
        "bios_attributes": [a.model_dump() for a in facts.bios_attributes],
    }
    if facts.boot_override is not None:
        blob["boot_override"] = facts.boot_override.model_dump()
    if facts.power is not None:
        blob["power"] = facts.power.model_dump()
    return blob


# ── Network-facts parsing (Junos / IOS-XR / Arista EOS) ──────────────


def _parse_network_facts(blob: dict[str, Any]) -> NetworkFacts:
    facts = NetworkFacts()
    facts.hostname = blob.get("hostname")
    for iface in blob.get("interfaces", []) or []:
        try:
            facts.interfaces.append(InterfaceConfig(**iface))
        except Exception:
            logger.warning("nautobot.intent.bad_interface", extra={"raw": iface})
    for vlan in blob.get("vlans", []) or []:
        try:
            facts.vlans.append(VlanDefinition(**vlan))
        except Exception:
            logger.warning("nautobot.intent.bad_vlan", extra={"raw": vlan})
    for route in blob.get("static_routes", []) or []:
        try:
            facts.static_routes.append(StaticRoute(**route))
        except Exception:
            logger.warning("nautobot.intent.bad_static_route", extra={"raw": route})
    return facts


def _network_facts_to_blob(facts: NetworkFacts) -> dict[str, Any]:
    blob: dict[str, Any] = {}
    if facts.hostname is not None:
        blob["hostname"] = facts.hostname
    blob["interfaces"] = [i.model_dump() for i in facts.interfaces]
    blob["vlans"] = [v.model_dump() for v in facts.vlans]
    blob["static_routes"] = [r.model_dump() for r in facts.static_routes]
    return blob


def _dispatch_parse(transport: str, blob: dict[str, Any]) -> DeviceFacts:
    """Pick the right facts parser given the device's transport string.

    The SoT blob doesn't carry a discriminator field — the device's
    Nautobot ``daalu_transport`` custom field (or the platform-name
    fallback) is what tells us which fact schema to instantiate.
    """
    if transport == "redfish":
        return _parse_redfish_facts(blob)
    if transport in _NETWORK_TRANSPORTS:
        return _parse_network_facts(blob)
    return _parse_facts(blob)


def _dispatch_to_blob(facts: DeviceFacts) -> dict[str, Any]:
    if isinstance(facts, RedfishFacts):
        return _redfish_facts_to_blob(facts)
    if isinstance(facts, NetworkFacts):
        return _network_facts_to_blob(facts)
    return _facts_to_blob(facts)


def _revision_of(blob: Any) -> str:
    return hashlib.sha256(
        json.dumps(blob, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:16]


def _platform_bucket(platform_name: str | None) -> str:
    if not platform_name:
        return "unknown"
    p = platform_name.lower()
    if any(t in p for t in ("linux", "ubuntu", "debian", "rhel", "centos", "fedora")):
        return "linux"
    # Common Nautobot platform names for Redfish-speaking BMCs (Dell
    # iDRAC, HPE iLO, Lenovo XCC, Fujitsu iRMC, generic "redfish").
    # Keeping this list explicit rather than glob-matching "bmc" so a
    # custom platform called "bmc-monitoring" doesn't get auto-tagged.
    if any(
        t in p
        for t in ("redfish", "idrac", "ilo", "xcc", "irmc", "ipmi-redfish")
    ):
        return "redfish"
    # Network-OS buckets. Check IOS-XR before plain "ios" (NX-OS / IOS
    # XE are out of scope for v1; if a tenant tags one we leave it as
    # the raw platform string and ``_to_device`` falls through to
    # transport=unknown).
    if "iosxr" in p or "ios-xr" in p or "ios_xr" in p:
        return "iosxr"
    if "junos" in p or "juniper" in p:
        return "junos"
    if "eos" in p or "arista" in p:
        return "eos"
    return p


# ── The adapter ───────────────────────────────────────────────────────


_DEVICES_QUERY = """
query ListDevices {
  devices {
    id
    name
    primary_ip4 { address }
    platform { name }
    tags { name }
    config_context
    custom_field_data
  }
}
"""

_DEVICE_QUERY = """
query GetDevice($id: ID!) {
  device(id: $id) {
    id
    name
    primary_ip4 { address }
    platform { name }
    tags { name }
    config_context
    custom_field_data
  }
}
"""


class NautobotSoT(SourceOfTruth):
    provider: ClassVar[str] = NAUTOBOT_PROVIDER

    async def _client(
        self, db: AsyncSession, tenant_id: uuid.UUID
    ) -> httpx.AsyncClient:
        url, token, proxy_url = await _load_credentials(db, tenant_id)
        return _build_http_client(url, token, proxy_url=proxy_url)

    async def _graphql(
        self,
        client: httpx.AsyncClient,
        query: str,
        variables: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        resp = await client.post(
            "/api/graphql/",
            json={"query": query, "variables": variables or {}},
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("errors"):
            raise NautobotUnavailable(f"graphql errors: {body['errors']}")
        return body.get("data") or {}

    def _to_device(self, raw: dict[str, Any]) -> Device:
        platform = (raw.get("platform") or {}).get("name")
        primary_ip = ((raw.get("primary_ip4") or {}).get("address") or None)
        if primary_ip and "/" in primary_ip:
            primary_ip = primary_ip.split("/", 1)[0]
        tags = [t.get("name") for t in raw.get("tags") or [] if t.get("name")]
        cfd = raw.get("custom_field_data") or {}
        bucket = _platform_bucket(platform)
        # Prefer an explicit transport custom field; fall back to a
        # platform-name heuristic. New transports added here must also
        # land an entry in core/device/registry so dispatch resolves.
        if cfd.get("daalu_transport"):
            transport = cfd["daalu_transport"]
        elif bucket == "linux":
            transport = "linux_ssh"
        elif bucket == "redfish":
            transport = "redfish"
        elif bucket in _NETWORK_TRANSPORTS:
            # bucket name already matches the transport identifier
            # ("junos" / "iosxr" / "eos") — no further mapping needed.
            transport = bucket
        else:
            transport = "unknown"
        return Device(
            id=str(raw["id"]),
            name=raw.get("name") or "",
            primary_ip=primary_ip,
            platform=bucket,
            transport=transport,
            tags=tags,
            extra=cfd,
        )

    async def list_devices(
        self,
        db: AsyncSession,
        tenant_id: uuid.UUID,
        *,
        platform: str | None = None,
    ) -> list[Device]:
        async with await self._client(db, tenant_id) as client:
            data = await self._graphql(client, _DEVICES_QUERY)
        out: list[Device] = []
        for raw in data.get("devices") or []:
            dev = self._to_device(raw)
            if platform and dev.platform != platform:
                continue
            out.append(dev)
        return out

    async def get_device(
        self, db: AsyncSession, tenant_id: uuid.UUID, device_id: str
    ) -> Device | None:
        async with await self._client(db, tenant_id) as client:
            data = await self._graphql(
                client, _DEVICE_QUERY, {"id": device_id}
            )
        raw = data.get("device")
        if not raw:
            return None
        return self._to_device(raw)

    async def get_intended_config(
        self, db: AsyncSession, tenant_id: uuid.UUID, device_id: str
    ) -> IntendedConfig | None:
        async with await self._client(db, tenant_id) as client:
            data = await self._graphql(
                client, _DEVICE_QUERY, {"id": device_id}
            )
        raw = data.get("device")
        if not raw:
            return None
        ctx = raw.get("config_context") or {}
        intent_blob = ctx.get(INTENT_CONTEXT_NAME)
        if not isinstance(intent_blob, dict):
            return None
        # Discover the device's transport from the same GraphQL response
        # so we can pick the right fact parser. Avoids a second round-trip.
        dev = self._to_device(raw)
        return IntendedConfig(
            device_id=device_id,
            revision=_revision_of(intent_blob),
            facts=_dispatch_parse(dev.transport, intent_blob),
            extra={},
            fetched_at=datetime.now(tz=timezone.utc),
        )

    async def _find_intent_context_id(
        self, client: httpx.AsyncClient, device_id: str
    ) -> str | None:
        resp = await client.get(
            "/api/extras/config-contexts/",
            params={"name": INTENT_CONTEXT_NAME, "devices": device_id},
        )
        resp.raise_for_status()
        results = resp.json().get("results") or []
        if not results:
            return None
        return str(results[0]["id"])

    async def put_intended_config(
        self,
        db: AsyncSession,
        tenant_id: uuid.UUID,
        device_id: str,
        intended: IntendedConfig,
    ) -> SoTRevision:
        body_blob = _dispatch_to_blob(intended.facts)
        async with await self._client(db, tenant_id) as client:
            ctx_id = await self._find_intent_context_id(client, device_id)
            if ctx_id is None:
                resp = await client.post(
                    "/api/extras/config-contexts/",
                    json={
                        "name": INTENT_CONTEXT_NAME,
                        "weight": 1000,
                        "is_active": True,
                        "devices": [device_id],
                        "data": body_blob,
                    },
                )
            else:
                resp = await client.patch(
                    f"/api/extras/config-contexts/{ctx_id}/",
                    json={"data": body_blob},
                )
            resp.raise_for_status()
            payload = resp.json()
        revision = (
            payload.get("last_updated")
            or payload.get("id")
            or _revision_of(body_blob)
        )
        return SoTRevision(
            device_id=device_id,
            revision=str(revision),
            written_at=datetime.now(tz=timezone.utc),
        )

    async def record_observed(
        self,
        db: AsyncSession,
        tenant_id: uuid.UUID,
        observed: ObservedSnapshot,
    ) -> None:
        body_blob = _dispatch_to_blob(observed.facts)
        async with await self._client(db, tenant_id) as client:
            # Find-or-create a daalu_observed context for the device.
            resp = await client.get(
                "/api/extras/config-contexts/",
                params={
                    "name": OBSERVED_CONTEXT_NAME,
                    "devices": observed.device_id,
                },
            )
            resp.raise_for_status()
            results = resp.json().get("results") or []
            if results:
                ctx_id = str(results[0]["id"])
                resp = await client.patch(
                    f"/api/extras/config-contexts/{ctx_id}/",
                    json={"data": body_blob},
                )
            else:
                resp = await client.post(
                    "/api/extras/config-contexts/",
                    json={
                        "name": OBSERVED_CONTEXT_NAME,
                        "weight": 100,
                        "is_active": True,
                        "devices": [observed.device_id],
                        "data": body_blob,
                    },
                )
            resp.raise_for_status()

    async def health(
        self, db: AsyncSession, tenant_id: uuid.UUID
    ) -> tuple[bool, str]:
        try:
            async with await self._client(db, tenant_id) as client:
                resp = await client.get("/api/status/")
                resp.raise_for_status()
                return True, "ok"
        except NautobotUnavailable as e:
            return False, str(e)
        except Exception as e:  # noqa: BLE001 — surface anything as unhealthy
            return False, f"{type(e).__name__}: {e}"
