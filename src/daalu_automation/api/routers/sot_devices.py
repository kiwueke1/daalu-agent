"""HTTP routes for device management — list / create / read / update-intent / delete.

These are thin proxies through the :class:`SourceOfTruth` abstraction so the
frontend never has to talk to Nautobot directly. Tenants don't need
Nautobot-UI access; everything they need flows through the daalu API
with the tenant's own JWT.

Read paths reuse ``NautobotSoT.list_devices`` / ``get_device`` /
``get_intended_config`` from PR 1.

Write paths are new in this module:

* ``POST /sot/devices`` creates a Nautobot Device row. Hits the same
  Nautobot REST surface the provisioning code uses (PR 8) — admin
  token comes from the per-tenant integration row, never the
  platform-admin token.
* ``PUT /sot/devices/{id}/intent`` updates the device's ``daalu_intent``
  Config Context via :meth:`SourceOfTruth.put_intended_config`. This is
  the path the operator's intent editor lands on.
* ``DELETE /sot/devices/{id}`` removes the device from Nautobot. The
  daalu side has nothing else to clean up — Integration rows live by
  ``device_id`` reference but a dead reference is fine; the reconciler
  just stops seeing the device on its next pass.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.api.deps import current_admin, current_tenant_id
from daalu_automation.core.crypto import decrypt_secret
from daalu_automation.core.sot import (
    IntendedConfig,
    NautobotSoT,
    NautobotUnavailable,
)
from daalu_automation.core.sot.bulk_import import ParsedRow, parse_upload
from daalu_automation.core.sot.models import DeviceFacts
from daalu_automation.core.sot.nautobot import (
    NAUTOBOT_PROVIDER,
    _build_http_client,
)
from daalu_automation.database import get_db
from daalu_automation.models import Integration, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sot/devices", tags=["sot_devices"])


# ── Schemas ──────────────────────────────────────────────────────────────


class DeviceOut(BaseModel):
    id: str
    name: str
    primary_ip: str | None = None
    platform: str
    transport: str
    tags: list[str] = Field(default_factory=list)
    # Nautobot custom_field_data — surfaces our overrides
    # (daalu_transport, ssh_user, ssh_credentials_ref, …) plus any
    # operator-defined fields. Free-form on purpose.
    extra: dict[str, Any] = Field(default_factory=dict)


class IntentOut(BaseModel):
    device_id: str
    revision: str
    transport: str
    facts: dict[str, Any]  # serialized DeviceFacts — type depends on transport
    fetched_at: datetime


class DeviceCreateIn(BaseModel):
    """Minimal payload to create a Nautobot Device row.

    The frontend resolves UUID references (site, device_type, role) on the
    customer's behalf by hitting their Nautobot directly via the proxy
    GET routes below — or, more usually, the customer picks from the
    catalogues the wizard pre-fetches. To keep v1 simple we accept the
    UUIDs directly; the wizard does the resolution before POSTing.
    """

    name: str
    primary_ip: str  # CIDR form, e.g. "10.0.0.5/24"
    site_id: str
    device_type_id: str
    device_role_id: str
    platform_id: str | None = None
    # daalu_transport custom field. Required so the device is dispatchable
    # the moment it lands — saves a follow-up edit.
    transport: str  # linux_ssh | redfish | junos | iosxr | eos


class IntentUpdateIn(BaseModel):
    # Same shape as the facts: a transport-dependent JSON blob. Validated
    # against the matching pydantic model server-side before write.
    facts: dict[str, Any]


# ── Catalog (small read-only set the wizard needs to render dropdowns) ──


class CatalogItem(BaseModel):
    id: str
    name: str
    slug: str | None = None


class CatalogOut(BaseModel):
    sites: list[CatalogItem]
    device_types: list[CatalogItem]
    device_roles: list[CatalogItem]
    platforms: list[CatalogItem]


# ── Helpers ──────────────────────────────────────────────────────────────


async def _nautobot_client(
    db: AsyncSession, tenant_id: uuid.UUID
) -> httpx.AsyncClient:
    """Build the per-tenant Nautobot HTTP client.

    Mirrors :func:`core.sot.nautobot._load_credentials` but exposed
    here as an async-context client so the write paths can issue
    arbitrary REST calls beyond what the SoT abstraction wraps.
    """
    row = (
        await db.execute(
            select(Integration).where(
                Integration.tenant_id == tenant_id,
                Integration.provider == NAUTOBOT_PROVIDER,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(409, "this tenant has no Nautobot integration; set one up at /onboarding/sot")
    cfg = row.config or {}
    url = cfg.get("url")
    token_ct = cfg.get("token_ciphertext")
    token_pt = cfg.get("token")
    if not url or not (token_ct or token_pt):
        raise HTTPException(
            409,
            "Nautobot integration is missing url or token — re-run the SoT wizard",
        )
    token = decrypt_secret(token_ct) if token_ct else token_pt
    # Route over the tenant's WireGuard tunnel when the Nautobot lives on a
    # workload cluster (svc-* / in-cluster address). NULL → direct dial.
    from daalu_automation.core.cluster_proxy import get_proxy_url

    proxy_url = await get_proxy_url(db, row.cluster_tunnel_id)
    return _build_http_client(url, token, proxy_url=proxy_url)


def _facts_to_blob(facts: DeviceFacts) -> dict[str, Any]:
    """Round-trip the typed facts back to a JSON-serialisable dict for the API."""
    from daalu_automation.core.sot.nautobot import _dispatch_to_blob

    return _dispatch_to_blob(facts)


def _parse_intent(transport: str, raw: dict[str, Any]) -> DeviceFacts:
    """Coerce a wizard-posted intent blob to the right DeviceFacts subtype.

    Uses strict pydantic validation so malformed shapes raise instead of
    being silently dropped. NautobotSoT's _dispatch_parse is intentionally
    tolerant on the *read* path (don't poison a device's whole intent
    on one bad key) — on the *write* path through the wizard, the
    operator deserves a 422 telling them exactly what's wrong rather
    than silent data loss.
    """
    from daalu_automation.core.sot.models import (
        LinuxFacts,
        NetworkFacts,
        RedfishFacts,
    )

    if transport == "redfish":
        return RedfishFacts(**raw)
    if transport in {"junos", "iosxr", "eos"}:
        return NetworkFacts(**raw)
    return LinuxFacts(**raw)


# ── List + read ──────────────────────────────────────────────────────────


@router.get("", response_model=list[DeviceOut])
async def list_devices(
    platform: str | None = None,
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
):
    """List every device the tenant has in their SoT.

    Optional ``?platform=linux`` filters to one bucket. Cross-tenant
    isolation is handled by the per-tenant Nautobot token — each
    tenant's token can only see their own Tenant's devices (the
    ObjectPermission constraint set up by hosted-Nautobot provisioning,
    or whatever scope the BYO operator wired).
    """
    sot = NautobotSoT()
    try:
        return await sot.list_devices(db, tenant_id, platform=platform)
    except NautobotUnavailable as e:
        raise HTTPException(409, str(e)) from e


@router.get("/{device_id}", response_model=DeviceOut)
async def get_device(
    device_id: str,
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
):
    sot = NautobotSoT()
    try:
        dev = await sot.get_device(db, tenant_id, device_id)
    except NautobotUnavailable as e:
        raise HTTPException(409, str(e)) from e
    if dev is None:
        raise HTTPException(404, f"device {device_id} not found")
    return dev


@router.get("/{device_id}/intent", response_model=IntentOut)
async def get_intent(
    device_id: str,
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
):
    """Read the device's current ``daalu_intent`` Config Context.

    404 when intent is unset — that's the "operator hasn't authored
    intent for this device yet" state, distinct from "device doesn't
    exist" (which is also 404 from get_device). The wizard distinguishes
    the two by calling get_device first.
    """
    sot = NautobotSoT()
    try:
        intent = await sot.get_intended_config(db, tenant_id, device_id)
    except NautobotUnavailable as e:
        raise HTTPException(409, str(e)) from e
    if intent is None:
        raise HTTPException(404, f"device {device_id} has no daalu_intent set")
    dev = await sot.get_device(db, tenant_id, device_id)
    transport = dev.transport if dev else "unknown"
    return IntentOut(
        device_id=device_id,
        revision=intent.revision,
        transport=transport,
        facts=_facts_to_blob(intent.facts),
        fetched_at=intent.fetched_at,
    )


# ── Catalog (for the "Add device" form's dropdowns) ─────────────────────


@router.get("/_catalog/list", response_model=CatalogOut)
async def catalog(
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
):
    """Return enough Nautobot reference data to populate the Add-Device form.

    Sites / device types / roles / platforms. Each is a small bounded
    list per tenant; we fetch all of them in one batch rather than
    paginate. If a tenant has thousands of any of these the wizard will
    need a typeahead — a follow-up.
    """
    async with await _nautobot_client(db, tenant_id) as client:
        out = CatalogOut(sites=[], device_types=[], device_roles=[], platforms=[])
        for endpoint, attr in [
            ("/api/dcim/locations/", "sites"),
            ("/api/dcim/device-types/", "device_types"),
            ("/api/dcim/roles/", "device_roles"),
            ("/api/dcim/platforms/", "platforms"),
        ]:
            try:
                resp = await client.get(endpoint, params={"limit": 250})
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()
                items = (resp.json() or {}).get("results") or []
                getattr(out, attr).extend(
                    CatalogItem(
                        id=str(it["id"]),
                        name=it.get("name") or it.get("display") or str(it["id"]),
                        slug=it.get("slug"),
                    )
                    for it in items
                )
            except httpx.HTTPError as e:
                logger.warning(
                    "sot_devices.catalog.fetch_failed",
                    extra={"endpoint": endpoint, "error": str(e)},
                )
        return out


# ── Create / update / delete ─────────────────────────────────────────────


async def _resolve_nautobot_tenant_id(
    db: AsyncSession, tenant_id: uuid.UUID
) -> str | None:
    integ_row = (
        await db.execute(
            select(Integration).where(
                Integration.tenant_id == tenant_id,
                Integration.provider == NAUTOBOT_PROVIDER,
            )
        )
    ).scalar_one_or_none()
    if integ_row is None:
        raise HTTPException(409, "this tenant has no Nautobot integration")
    return (integ_row.config or {}).get("nautobot_tenant_id")


async def _create_one_device(
    client: httpx.AsyncClient,
    *,
    name: str,
    primary_ip: str,
    site_id: str,
    device_type_id: str,
    device_role_id: str,
    platform_id: str | None,
    transport: str,
    nautobot_tenant_id: str | None,
) -> str:
    """Create a Device row + assign the primary IP. Returns the device UUID.

    Raises HTTPException on a 4xx/5xx from Nautobot so the caller can
    surface a meaningful row-level error in bulk mode.
    """
    body: dict[str, Any] = {
        "name": name,
        "location": site_id,
        "device_type": device_type_id,
        "role": device_role_id,
        "status": "Active",
        "custom_fields": {"daalu_transport": transport},
    }
    if platform_id:
        body["platform"] = platform_id
    if nautobot_tenant_id:
        body["tenant"] = nautobot_tenant_id

    resp = await client.post("/api/dcim/devices/", json=body)
    if resp.status_code not in (200, 201):
        raise HTTPException(
            502,
            f"Nautobot rejected device create: HTTP {resp.status_code} — {resp.text[:200]}",
        )
    device_uuid = str(resp.json()["id"])

    # Attach the primary IP — Nautobot requires a two-step flow:
    # create the IP, then PATCH the device to set primary_ip4.
    ip_resp = await client.post(
        "/api/ipam/ip-addresses/",
        json={
            "address": primary_ip,
            "status": "Active",
            "assigned_object_type": "dcim.device",
            "assigned_object_id": device_uuid,
        },
    )
    if ip_resp.status_code in (200, 201):
        ip_uuid = ip_resp.json()["id"]
        patch_resp = await client.patch(
            f"/api/dcim/devices/{device_uuid}/",
            json={"primary_ip4": ip_uuid},
        )
        if patch_resp.status_code not in (200, 201):
            logger.warning(
                "sot_devices.create.primary_ip_assign_failed",
                extra={"device_id": device_uuid, "ip_uuid": ip_uuid},
            )
    else:
        logger.warning(
            "sot_devices.create.ip_failed",
            extra={
                "device_id": device_uuid,
                "status": ip_resp.status_code,
                "body": ip_resp.text[:200],
            },
        )
    return device_uuid


@router.post("", response_model=DeviceOut)
async def create_device(
    payload: DeviceCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_admin),
):
    """Create a new Device row in Nautobot, pre-stamped with daalu_transport.

    Admin-only. The Nautobot Tenant the device gets associated with is
    derived from the daalu tenant slug — looked up via the integration
    row's ``nautobot_tenant_id`` (set by hosted provisioning) or
    inferred via the daalu tenant slug for BYO setups.
    """
    tenant_id = user.tenant_id
    nautobot_tenant_id = await _resolve_nautobot_tenant_id(db, tenant_id)

    async with await _nautobot_client(db, tenant_id) as client:
        device_uuid = await _create_one_device(
            client,
            name=payload.name,
            primary_ip=payload.primary_ip,
            site_id=payload.site_id,
            device_type_id=payload.device_type_id,
            device_role_id=payload.device_role_id,
            platform_id=payload.platform_id,
            transport=payload.transport,
            nautobot_tenant_id=nautobot_tenant_id,
        )

    # Re-fetch via the SoT layer so the response shape matches list/get
    sot = NautobotSoT()
    dev = await sot.get_device(db, tenant_id, device_uuid)
    if dev is None:
        # Should be unreachable — Nautobot just confirmed the create
        raise HTTPException(502, "device created but not visible to get_device")
    return dev


# ── Bulk import ─────────────────────────────────────────────────────────


class BulkRowResult(BaseModel):
    row: int
    name: str
    primary_ip: str
    transport: str
    site: str
    device_type: str
    role: str
    platform: str | None = None
    status: str  # 'valid' | 'error' | 'created'
    error: str | None = None
    device_id: str | None = None


class BulkImportResult(BaseModel):
    dry_run: bool
    summary: dict[str, int]
    rows: list[BulkRowResult]


def _catalog_index(items: list[CatalogItem]) -> dict[str, str]:
    """Lower-case name → UUID. Falls back to slug for cases where
    the operator typed the slug.
    """
    idx: dict[str, str] = {}
    for it in items:
        if it.name:
            idx[it.name.strip().lower()] = it.id
        if it.slug:
            idx[it.slug.strip().lower()] = it.id
    return idx


def _resolve_row(
    row: ParsedRow,
    *,
    sites: dict[str, str],
    device_types: dict[str, str],
    roles: dict[str, str],
    platforms: dict[str, str],
) -> tuple[BulkRowResult, dict[str, str] | None]:
    """Resolve catalog names → IDs for one row.

    Returns the row-result plus, when valid, a dict with the resolved IDs
    ready for :func:`_create_one_device`. ``None`` for the second value
    means the row has errors and should be skipped on apply.
    """
    base = BulkRowResult(
        row=row.row_index,
        name=row.name,
        primary_ip=row.primary_ip,
        transport=row.transport,
        site=row.site,
        device_type=row.device_type,
        role=row.role,
        platform=row.platform,
        status="valid",
    )
    if row.parse_error:
        return base.model_copy(update={"status": "error", "error": row.parse_error}), None

    errors: list[str] = []
    site_id = sites.get(row.site.lower())
    if not site_id:
        errors.append(f"unknown site '{row.site}'")
    type_id = device_types.get(row.device_type.lower())
    if not type_id:
        errors.append(f"unknown device_type '{row.device_type}'")
    role_id = roles.get(row.role.lower())
    if not role_id:
        errors.append(f"unknown role '{row.role}'")
    platform_id: str | None = None
    if row.platform:
        platform_id = platforms.get(row.platform.lower())
        if not platform_id:
            errors.append(f"unknown platform '{row.platform}'")

    if errors:
        return base.model_copy(
            update={"status": "error", "error": "; ".join(errors)}
        ), None

    return base, {
        "site_id": site_id or "",
        "device_type_id": type_id or "",
        "device_role_id": role_id or "",
        "platform_id": platform_id or "",
    }


@router.post("/bulk-import", response_model=BulkImportResult)
async def bulk_import_devices(
    file: UploadFile = File(...),
    dry_run: bool = Query(default=True),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_admin),
):
    """Bulk-create devices from a YAML or Excel upload.

    Two-phase by default: ``dry_run=true`` (the default) parses + resolves
    names against the tenant's Nautobot catalog and returns the per-row
    outcome without writing. The frontend shows the preview; the operator
    re-submits with ``dry_run=false`` to actually create the devices.

    Per-row errors don't abort the batch — each row succeeds or fails
    independently, mirroring what the operator sees in the dry-run table.
    """
    tenant_id = user.tenant_id
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "upload is empty")

    try:
        rows = parse_upload(file.filename or "", file.content_type, raw)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not rows:
        raise HTTPException(400, "no device rows found in upload")

    catalog_resp = await catalog(db=db, tenant_id=tenant_id)
    sites = _catalog_index(catalog_resp.sites)
    device_types = _catalog_index(catalog_resp.device_types)
    roles = _catalog_index(catalog_resp.device_roles)
    platforms = _catalog_index(catalog_resp.platforms)

    nautobot_tenant_id = await _resolve_nautobot_tenant_id(db, tenant_id)

    results: list[BulkRowResult] = []
    resolved: list[tuple[BulkRowResult, dict[str, str] | None, ParsedRow]] = []
    for row in rows:
        result, ids = _resolve_row(
            row,
            sites=sites,
            device_types=device_types,
            roles=roles,
            platforms=platforms,
        )
        resolved.append((result, ids, row))

    if dry_run:
        results = [r for r, _, _ in resolved]
    else:
        async with await _nautobot_client(db, tenant_id) as client:
            for result, ids, row in resolved:
                if ids is None:
                    results.append(result)
                    continue
                try:
                    device_uuid = await _create_one_device(
                        client,
                        name=row.name,
                        primary_ip=row.primary_ip,
                        site_id=ids["site_id"],
                        device_type_id=ids["device_type_id"],
                        device_role_id=ids["device_role_id"],
                        platform_id=ids["platform_id"] or None,
                        transport=row.transport,
                        nautobot_tenant_id=nautobot_tenant_id,
                    )
                    results.append(
                        result.model_copy(
                            update={"status": "created", "device_id": device_uuid}
                        )
                    )
                except HTTPException as e:
                    results.append(
                        result.model_copy(
                            update={"status": "error", "error": str(e.detail)}
                        )
                    )
                except Exception as e:  # noqa: BLE001 — per-row boundary
                    logger.exception(
                        "sot_devices.bulk_import.row_failed",
                        extra={"row": row.row_index, "name": row.name},
                    )
                    results.append(
                        result.model_copy(
                            update={
                                "status": "error",
                                "error": f"{type(e).__name__}: {e}",
                            }
                        )
                    )

    summary = {
        "total": len(results),
        "valid": sum(1 for r in results if r.status == "valid"),
        "errors": sum(1 for r in results if r.status == "error"),
        "created": sum(1 for r in results if r.status == "created"),
    }
    return BulkImportResult(dry_run=dry_run, summary=summary, rows=results)


# ── On-demand reconciliation ────────────────────────────────────────────


class ReconcileResultOut(BaseModel):
    device_id: str
    status: str  # 'in_sync' | 'drift' | 'skipped' | 'error'
    detail: str | None = None
    proposal_id: str | None = None


@router.post("/{device_id}/reconcile", response_model=ReconcileResultOut)
async def reconcile_device(
    device_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_admin),
):
    """Run the reconciler synchronously for a single device.

    Admin-only. Wraps the same per-device path used by the Celery beat
    sweep (``workers/reconciler.py``) — extracted so the "Reconcile now"
    button can give the operator an immediate result instead of waiting
    for the next scheduled sweep.
    """
    from daalu_automation.core import change_proposals as cps
    from daalu_automation.core.device import get_device_adapter
    from daalu_automation.core.events import EventEnvelope, publish
    from daalu_automation.core.sot.models import Actor
    from daalu_automation.models import (
        ChangeProposal,
        ChangeProposalKind,
        ChangeProposalStatus,
    )

    tenant_id = user.tenant_id
    sot = NautobotSoT()
    try:
        device = await sot.get_device(db, tenant_id, device_id)
    except NautobotUnavailable as e:
        raise HTTPException(409, str(e)) from e
    if device is None:
        raise HTTPException(404, f"device {device_id} not found")

    # Don't fire a fresh proposal if one is already open — same rule the
    # background sweep follows. We still tell the user what happened.
    open_row = (
        await db.execute(
            select(ChangeProposal.id)
            .where(
                ChangeProposal.tenant_id == tenant_id,
                ChangeProposal.device_id == device_id,
                ChangeProposal.status.in_(
                    (ChangeProposalStatus.pending, ChangeProposalStatus.approved)
                ),
            )
            .limit(1)
        )
    ).first()
    if open_row is not None:
        return ReconcileResultOut(
            device_id=device_id,
            status="skipped",
            detail="an open proposal already exists for this device",
            proposal_id=str(open_row[0]),
        )

    intended = await sot.get_intended_config(db, tenant_id, device_id)
    if intended is None:
        return ReconcileResultOut(
            device_id=device_id,
            status="skipped",
            detail="device has no daalu_intent set — author it from the device page first",
        )

    adapter = get_device_adapter(device.transport)
    try:
        creds = await cps.resolve_credentials(db, tenant_id, device)
        observed = await adapter.collect(creds, intended_hint=intended.facts)
        diff = await adapter.diff(observed, intended.facts)
    except Exception as e:  # noqa: BLE001 — surfaces device-level failures
        logger.exception(
            "sot_devices.reconcile.device_failed",
            extra={"device_id": device_id, "error": f"{type(e).__name__}: {e}"},
        )
        return ReconcileResultOut(
            device_id=device_id,
            status="error",
            detail=f"{type(e).__name__}: {e}",
        )

    if not diff.has_changes:
        await publish(
            EventEnvelope(
                tenant_id=str(tenant_id),
                type="device.observed.snapshot",
                module="sot",
                source="reconciler",
                severity="info",
                summary=f"device {device.name} in sync",
                payload={"device_id": device_id, "facts_changed": []},
            )
        )
        return ReconcileResultOut(
            device_id=device_id,
            status="in_sync",
            detail="no drift detected",
        )

    rendered_intended = await adapter.render(intended.facts)
    rendered_observed = await adapter.render(observed)
    proposal = await cps.propose(
        db,
        tenant_id,
        device_id=device_id,
        kind=ChangeProposalKind.drift,
        intended_config=cps.serialize_rendered_files(rendered_intended.files),
        observed_config=cps.serialize_rendered_files(rendered_observed.files),
        diff=diff.unified_diff,
        renderer_version=rendered_intended.renderer_version,
        evidence={
            "triggered_by": "operator.reconcile_now",
            "confidence": 1.0,
            "facts_changed": diff.facts_changed,
        },
        actor=Actor(kind="user", name=user.email or "operator"),
    )
    return ReconcileResultOut(
        device_id=device_id,
        status="drift",
        detail="drift detected — opened a change proposal",
        proposal_id=str(proposal.id),
    )


@router.put("/{device_id}/intent", response_model=IntentOut)
async def update_intent(
    device_id: str,
    payload: IntentUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_admin),
):
    """Write ``daalu_intent`` for the device.

    The frontend's intent editor (form-based for the common LinuxFacts /
    RedfishFacts / NetworkFacts shapes) posts the resulting JSON blob
    here. Validation happens server-side via the right facts pydantic
    model — invalid shapes return 422 instead of corrupting the SoT.
    """
    tenant_id = user.tenant_id
    sot = NautobotSoT()

    # Discover transport so we know which facts schema to validate against
    try:
        dev = await sot.get_device(db, tenant_id, device_id)
    except NautobotUnavailable as e:
        raise HTTPException(409, str(e)) from e
    if dev is None:
        raise HTTPException(404, f"device {device_id} not found")

    try:
        facts = _parse_intent(dev.transport, payload.facts)
    except Exception as e:  # noqa: BLE001 — pydantic ValidationError
        raise HTTPException(422, f"intent payload did not validate: {e}") from e

    intended = IntendedConfig(
        device_id=device_id,
        revision="(unset)",  # SoT will recompute on write
        facts=facts,
        extra={},
        fetched_at=datetime.now(tz=timezone.utc),
    )
    try:
        rev = await sot.put_intended_config(db, tenant_id, device_id, intended)
    except NautobotUnavailable as e:
        raise HTTPException(502, f"Nautobot rejected the write: {e}") from e

    return IntentOut(
        device_id=device_id,
        revision=rev.revision,
        transport=dev.transport,
        facts=_facts_to_blob(facts),
        fetched_at=intended.fetched_at,
    )


@router.delete("/{device_id}", status_code=204)
async def delete_device(
    device_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_admin),
):
    """Remove the device from Nautobot.

    Admin-only. Daalu's own row references the device by Nautobot UUID
    but doesn't FK to it; dangling references in old ChangeProposal
    rows are fine — the executor will skip them with
    ``executor.device_not_found`` on the next tick.
    """
    tenant_id = user.tenant_id
    async with await _nautobot_client(db, tenant_id) as client:
        resp = await client.delete(f"/api/dcim/devices/{device_id}/")
        if resp.status_code not in (200, 202, 204):
            raise HTTPException(
                502,
                f"Nautobot rejected device delete: HTTP {resp.status_code} — {resp.text[:200]}",
            )
    return None
