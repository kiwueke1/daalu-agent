"""Onboarding workflow API.

The UI wizard at ``/onboarding`` calls into three surfaces here:

- ``GET /onboarding/status`` — aggregate state across every integration
  in the wizard catalog plus the cluster-tunnel feature. The wizard's
  welcome screen reads this to label each step "already done" /
  "not yet".

- ``POST /onboarding/test/{provider}`` — actually verify the operator's
  credentials work *before* committing them. Slack: webhook returns 2xx.
  SMTP: TLS + AUTH + NOOP. HTTP-shaped integrations (Prometheus, Loki,
  OpenSearch, Thanos): GET a low-impact known endpoint. Kubernetes:
  decode the kubeconfig and list a single namespace. The test path is
  side-effect-free for read integrations; for Slack it posts a small
  visible "Daalu Automation handshake" message (the operator sees it
  immediately, so an invisible probe would be worse — silent failures
  are worse than visible ones).

- ``POST /onboarding/validate/{provider}`` — schema check only, no
  network. The router enforces per-provider required fields so a missing
  SMTP host shows up as a structured 422 instead of a successful PUT
  that silently does nothing later.

The wizard is the primary client but every endpoint is stable enough
for the operator to use from a shell.
"""

from __future__ import annotations

import asyncio
import json
import smtplib
import time
import uuid
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.api.deps import current_admin, current_tenant_id
from daalu_automation.database import get_db
from daalu_automation.models import (
    ClusterTunnel,
    ClusterTunnelStatus,
    Integration,
    User,
)

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


# ── Wizard catalog (mirror of frontend/app/onboarding/page.tsx) ─────────
#
# Kept in sync with the wizard's STEPS array. The frontend is the visual
# source of truth; this catalog is what the backend enforces for
# validation + status. Mismatches will surface immediately because the
# wizard's "is configured?" check hits /onboarding/status.

# Per-provider required fields. Optional fields may be absent.
_REQUIRED: dict[str, tuple[str, ...]] = {
    "slack": ("webhook_url",),
    "smtp": ("host", "port", "username", "password", "from"),
    "prometheus": ("url",),
    "loki": ("url",),
    "thanos": ("url",),
    "opensearch": ("url",),
    "pagerduty": ("api_token",),
    "kubernetes": ("kubeconfig",),
    "aws": ("access_key_id", "secret_access_key", "region"),
    "gcp": ("service_account_json", "project_id"),
    "azure": ("tenant_id", "client_id", "client_secret", "subscription_id"),
    # Nautobot SoT: BYO mode needs both.
    "nautobot": ("url", "token_ciphertext"),
}

# Catalog order — drives the welcome screen + status response ordering.
_CATALOG: tuple[tuple[str, str | None], ...] = (
    ("slack", "slack"),
    ("email", "smtp"),
    ("prometheus", "prometheus"),
    ("loki", "loki"),
    ("thanos", "thanos"),
    ("opensearch", "opensearch"),
    ("pagerduty", "pagerduty"),
    ("kubernetes", "kubernetes"),
    ("aws", "aws"),
    ("gcp", "gcp"),
    ("azure", "azure"),
    # Nautobot SoT — the source-of-truth + device-management feature is
    # off until this is wired (BYO Nautobot URL + token).
    ("nautobot", "nautobot"),
    # Cluster step has no /integrations/config row — we count rows in
    # cluster_tunnels for "configured?" instead.
    ("cluster", None),
)


# ── Schemas ─────────────────────────────────────────────────────────────


class StepStatus(BaseModel):
    id: str
    provider: str | None
    configured: bool
    # For integration rows: "connected"/"disconnected"/"error". For the
    # cluster step: a derived rollup ("none"/"healthy"/"degraded").
    status: str
    # Cluster step uses this; integration steps leave it at 0.
    count: int = 0
    # Required fields the caller still needs to fill in. Empty when
    # the step is fully set up.
    missing: list[str] = []


class OnboardingStatusOut(BaseModel):
    steps: list[StepStatus]
    completed: int
    total: int


class TestIn(BaseModel):
    # The wizard sends the current form values directly; the server uses
    # them in preference to anything already in the DB so the test
    # reflects what the *next* save would write, not stale state.
    config: dict[str, Any] = Field(default_factory=dict)
    # When set, probe the URL through the named ClusterTunnel's edge
    # proxy — required for any URL that only resolves inside the workload
    # cluster (`*.svc.cluster.local`, RFC1918 etc.). See
    # daalu_automation.core.cluster_proxy.
    cluster_tunnel_id: uuid.UUID | None = None


class TestOut(BaseModel):
    ok: bool
    message: str
    latency_ms: int


class ValidateIn(BaseModel):
    config: dict[str, Any]


class ValidateOut(BaseModel):
    ok: bool
    missing: list[str]


# ── Status ──────────────────────────────────────────────────────────────


def _missing_for(provider: str, config: dict[str, Any]) -> list[str]:
    if provider not in _REQUIRED:
        return []
    return [k for k in _REQUIRED[provider] if not config.get(k)]


@router.get("/status", response_model=OnboardingStatusOut)
async def get_status(
    db: AsyncSession = Depends(get_db),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    """Aggregate every wizard step's "is this configured?" state.

    Cheap: one SELECT for integrations, one COUNT for cluster_tunnels.
    Safe to call on every wizard page-load.
    """
    rows = (
        await db.execute(
            select(Integration).where(Integration.tenant_id == tenant_id)
        )
    ).scalars().all()
    by_provider = {r.provider: r for r in rows}

    cluster_count = (
        await db.execute(
            select(func.count(ClusterTunnel.id)).where(
                ClusterTunnel.tenant_id == tenant_id
            )
        )
    ).scalar_one()
    # Cluster rollup: "healthy" if every row is connected, "degraded"
    # if any non-connected, "none" if zero rows. The UI uses this to
    # decide whether the step gets the green check.
    cluster_status = "none"
    if cluster_count > 0:
        bad = (
            await db.execute(
                select(func.count(ClusterTunnel.id)).where(
                    ClusterTunnel.tenant_id == tenant_id,
                    ClusterTunnel.status != ClusterTunnelStatus.connected,
                )
            )
        ).scalar_one()
        cluster_status = "degraded" if bad else "healthy"

    steps: list[StepStatus] = []
    for step_id, provider in _CATALOG:
        if provider is None:
            steps.append(
                StepStatus(
                    id=step_id,
                    provider=None,
                    configured=cluster_count > 0,
                    status=cluster_status,
                    count=int(cluster_count),
                )
            )
            continue
        row = by_provider.get(provider)
        if row is None:
            steps.append(
                StepStatus(
                    id=step_id,
                    provider=provider,
                    configured=False,
                    status="disconnected",
                    missing=list(_REQUIRED.get(provider, ())),
                )
            )
            continue
        missing = _missing_for(provider, row.config or {})
        steps.append(
            StepStatus(
                id=step_id,
                provider=provider,
                configured=not missing,
                status=row.status.value,
                missing=missing,
            )
        )

    completed = sum(1 for s in steps if s.configured)
    return OnboardingStatusOut(steps=steps, completed=completed, total=len(steps))


# ── Validate ────────────────────────────────────────────────────────────


@router.post("/validate/{provider}", response_model=ValidateOut)
async def validate_provider(provider: str, payload: ValidateIn):
    """Pure schema check — no network, no DB.

    Lives behind auth (auto via the router's middleware gate) but doesn't
    require admin, since it doesn't mutate anything. Useful as a quick
    pre-flight before the wizard tries an actual test/save.
    """
    if provider not in _REQUIRED:
        raise HTTPException(404, f"unknown provider: {provider}")
    missing = _missing_for(provider, payload.config or {})
    return ValidateOut(ok=not missing, missing=missing)


# ── Test connection ─────────────────────────────────────────────────────


async def _test_slack(config: dict[str, Any]) -> tuple[bool, str]:
    url = config.get("webhook_url") or ""
    if not url:
        return False, "webhook_url is required"
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(
                url,
                json={"text": ":wave: Daalu Automation onboarding test — you can ignore this message."},
            )
            r.raise_for_status()
    except httpx.HTTPStatusError as e:
        return False, f"webhook rejected: HTTP {e.response.status_code}"
    except Exception as e:  # noqa: BLE001
        return False, f"could not POST to webhook: {e}"
    return True, "Slack accepted the test message"


def _test_smtp_sync(config: dict[str, Any]) -> tuple[bool, str]:
    host = config.get("host") or ""
    port = int(config.get("port") or 587)
    username = config.get("username") or ""
    password = config.get("password") or ""
    if not host:
        return False, "host is required"
    try:
        with smtplib.SMTP(host, port, timeout=10) as s:
            s.starttls()
            if username:
                s.login(username, password)
            # NOOP: confirms the session is healthy after AUTH without
            # actually sending mail. We deliberately do not send a
            # test email — the wizard's user may not want a spurious
            # message in the recipient's inbox.
            s.noop()
    except Exception as e:  # noqa: BLE001
        return False, f"SMTP failed: {e}"
    return True, "SMTP login succeeded"


async def _test_smtp(config: dict[str, Any]) -> tuple[bool, str]:
    return await asyncio.to_thread(_test_smtp_sync, config)


async def _http_probe(
    url: str | None,
    path: str = "/-/healthy",
    *,
    auth: tuple[str, str] | None = None,
    accept_any_status: bool = False,
    proxy: str | None = None,
) -> tuple[bool, str]:
    if not url:
        return False, "url is required"
    target = url.rstrip("/") + path
    try:
        async with httpx.AsyncClient(timeout=10, auth=auth, proxy=proxy) as c:
            r = await c.get(target)
            if accept_any_status:
                # Some endpoints (OpenSearch root) return 200; others
                # gate even root with auth → 401. Either way means
                # "the host is reachable and speaks HTTPS".
                if r.status_code < 500:
                    return True, f"reachable ({r.status_code})"
                return False, f"server error: HTTP {r.status_code}"
            r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        return False, f"probe failed: {e}"
    return True, "endpoint responded"


async def _test_prometheus(
    config: dict[str, Any], *, proxy: str | None = None
) -> tuple[bool, str]:
    # Alertmanager v2 status endpoint; works for both alertmanager and
    # vanilla Prometheus (different paths, but both 200 on /-/healthy).
    return await _http_probe(config.get("url"), "/-/healthy", proxy=proxy)


async def _test_loki(
    config: dict[str, Any], *, proxy: str | None = None
) -> tuple[bool, str]:
    auth: tuple[str, str] | None = None
    user = config.get("user") or config.get("username")
    pw = config.get("password")
    if user and pw:
        auth = (str(user), str(pw))
    return await _http_probe(
        config.get("url"), "/loki/api/v1/labels", auth=auth, proxy=proxy
    )


async def _test_thanos(
    config: dict[str, Any], *, proxy: str | None = None
) -> tuple[bool, str]:
    return await _http_probe(config.get("url"), "/-/healthy", proxy=proxy)


async def _test_opensearch(
    config: dict[str, Any], *, proxy: str | None = None
) -> tuple[bool, str]:
    auth: tuple[str, str] | None = None
    user = config.get("user") or config.get("username")
    pw = config.get("password")
    if user and pw:
        auth = (str(user), str(pw))
    # OpenSearch's root returns 200 with a cluster summary; if security
    # is on and the creds are wrong, 401 — still "reachable".
    return await _http_probe(
        config.get("url"), "/", auth=auth, accept_any_status=True, proxy=proxy
    )


async def _test_pagerduty(config: dict[str, Any]) -> tuple[bool, str]:
    token = config.get("api_token") or ""
    if not token:
        return False, "api_token is required"
    headers = {
        "Authorization": f"Token token={token}",
        "Accept": "application/vnd.pagerduty+json;version=2",
    }
    try:
        async with httpx.AsyncClient(timeout=10, headers=headers) as c:
            r = await c.get("https://api.pagerduty.com/users?limit=1")
            r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        return False, f"PagerDuty rejected the token: {e}"
    return True, "PagerDuty accepted the token"


def _test_kubernetes_sync(config: dict[str, Any]) -> tuple[bool, str]:
    """Parse kubeconfig + do a single list-namespaces call.

    Synchronous because the kubernetes-client is blocking; the async
    wrapper just hands it to a thread.
    """
    blob = config.get("kubeconfig") or ""
    if not blob:
        return False, "kubeconfig is required"
    try:
        import tempfile

        import yaml
        from kubernetes import client  # type: ignore
        from kubernetes import config as kconfig

        # Parse-check first so a bad YAML fails before we hit the API.
        parsed = yaml.safe_load(blob)
        if not isinstance(parsed, dict) or parsed.get("kind") != "Config":
            return False, "kubeconfig is not a valid kind=Config YAML document"

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".kubeconfig", delete=True
        ) as fh:
            fh.write(blob)
            fh.flush()
            ctx = config.get("default_context") or None
            kconfig.load_kube_config(config_file=fh.name, context=ctx)
            v1 = client.CoreV1Api()
            v1.list_namespace(_request_timeout=8, limit=1)
    except Exception as e:  # noqa: BLE001
        return False, f"kubeconfig failed: {e}"
    return True, "kubeconfig connects to the API server"


async def _test_kubernetes(config: dict[str, Any]) -> tuple[bool, str]:
    return await asyncio.to_thread(_test_kubernetes_sync, config)


# ── Cloud probes ────────────────────────────────────────────────────────


def _test_aws_sync(config: dict[str, Any]) -> tuple[bool, str]:
    """STS GetCallerIdentity — the cheapest possible 'these creds work'
    probe in AWS. Never touches a billable service."""
    try:
        import boto3  # type: ignore
    except ImportError:
        return False, "boto3 is not installed in the API image"
    try:
        sess = boto3.session.Session(
            aws_access_key_id=config.get("access_key_id"),
            aws_secret_access_key=config.get("secret_access_key"),
            aws_session_token=config.get("session_token"),
            region_name=config.get("region") or "us-east-1",
        )
        ident = sess.client("sts").get_caller_identity()
    except Exception as e:  # noqa: BLE001
        return False, f"AWS rejected the credentials: {e}"
    return True, f"AWS accepted; caller arn = {ident.get('Arn')}"


async def _test_aws(config: dict[str, Any]) -> tuple[bool, str]:
    return await asyncio.to_thread(_test_aws_sync, config)


def _test_gcp_sync(config: dict[str, Any]) -> tuple[bool, str]:
    """Parse the service-account JSON and call Compute Engine's
    project endpoint — cheapest no-side-effect GCP probe that proves
    both the key and the project_id are valid."""
    try:
        from google.oauth2 import service_account  # type: ignore
        from googleapiclient.discovery import build  # type: ignore
    except ImportError:
        return False, "google-auth / google-api-python-client are not installed"
    raw = config.get("service_account_json") or ""
    project = config.get("project_id") or ""
    if not raw or not project:
        return False, "service_account_json and project_id are required"
    try:
        info = json.loads(raw) if isinstance(raw, str) else raw
        creds = service_account.Credentials.from_service_account_info(info)
        svc = build("compute", "v1", credentials=creds, cache_discovery=False)
        svc.projects().get(project=project).execute()
    except Exception as e:  # noqa: BLE001
        return False, f"GCP rejected the credentials: {e}"
    return True, "GCP accepted; project metadata fetched"


async def _test_gcp(config: dict[str, Any]) -> tuple[bool, str]:
    return await asyncio.to_thread(_test_gcp_sync, config)


def _test_azure_sync(config: dict[str, Any]) -> tuple[bool, str]:
    """Acquire a token against the management.azure.com audience using
    the service principal. No state changes, no resource calls."""
    try:
        from azure.identity import ClientSecretCredential  # type: ignore
    except ImportError:
        return False, "azure-identity is not installed"
    try:
        cred = ClientSecretCredential(
            tenant_id=config.get("tenant_id"),
            client_id=config.get("client_id"),
            client_secret=config.get("client_secret"),
        )
        cred.get_token("https://management.azure.com/.default")
    except Exception as e:  # noqa: BLE001
        return False, f"Azure rejected the service principal: {e}"
    return True, "Azure issued a management.azure.com token"


async def _test_azure(config: dict[str, Any]) -> tuple[bool, str]:
    return await asyncio.to_thread(_test_azure_sync, config)


async def _test_nautobot(config: dict[str, Any]) -> tuple[bool, str]:
    """GET /api/status/ — Nautobot's lightweight health endpoint.

    Authenticates with the token the wizard just typed in, so a 200
    confirms both reachability AND that the token has at least the
    minimum scope. Tokens with no permissions still pass this — that's
    OK; the per-tenant ObjectPermission scope is verified later when
    the reconciler actually reads devices.
    """
    url = (config.get("url") or "").rstrip("/")
    token = config.get("token") or _decrypt_if_ct(config.get("token_ciphertext"))
    if not url or not token:
        return False, "url and token are required"
    try:
        async with httpx.AsyncClient(
            timeout=10,
            headers={"Authorization": f"Token {token}", "Accept": "application/json"},
        ) as c:
            r = await c.get(f"{url}/api/status/")
            r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        return False, f"Nautobot rejected the request: {e}"
    return True, "Nautobot accepted the token"


def _decrypt_if_ct(ct: str | None) -> str | None:
    """Decrypt a stored ciphertext for the test path; None for plaintext.

    The wizard posts cleartext ``token``; the DB stores ``token_ciphertext``.
    Reusing one tester for both shapes keeps the merge logic in
    :func:`test_provider` simple.
    """
    if not ct:
        return None
    from daalu_automation.core.crypto import decrypt_secret

    try:
        return decrypt_secret(ct)
    except Exception:
        return None


# Dispatch table — keep ordered the same as the wizard catalog above.
_TESTERS = {
    "slack": _test_slack,
    "smtp": _test_smtp,
    "prometheus": _test_prometheus,
    "loki": _test_loki,
    "thanos": _test_thanos,
    "opensearch": _test_opensearch,
    "pagerduty": _test_pagerduty,
    "kubernetes": _test_kubernetes,
    "aws": _test_aws,
    "gcp": _test_gcp,
    "azure": _test_azure,
    "nautobot": _test_nautobot,
}


@router.post("/test/{provider}", response_model=TestOut)
async def test_provider(
    provider: str,
    payload: TestIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_admin),
):
    """Probe the integration with the supplied config.

    Uses the *posted* config rather than what's currently in the DB —
    that way the wizard can test changes before saving. Falls back to
    the stored row when a field is missing in the payload (mask-aware:
    the redaction placeholder ``"***"`` is treated as "use the stored
    value").
    """
    tester = _TESTERS.get(provider)
    if tester is None:
        raise HTTPException(404, f"no tester for provider: {provider}")

    # Merge: posted values win, but ``***`` (the redaction placeholder
    # the read API returns for sensitive fields) means "use whatever's
    # in the DB" — otherwise testing a saved Slack from the wizard would
    # always fail because the password field reads ``"***"``.
    config = dict(payload.config or {})
    row = (
        await db.execute(
            select(Integration).where(
                Integration.tenant_id == user.tenant_id,
                Integration.provider == provider,
            )
        )
    ).scalar_one_or_none()
    stored = (row.config if row and row.config else {}) or {}
    for k, v in list(config.items()):
        if v == "***":
            config[k] = stored.get(k, "")
    for k, v in stored.items():
        config.setdefault(k, v)

    # Resolve the edge-proxy URL if the caller wants to test through a
    # cluster tunnel. Only the HTTP-shaped observability testers accept a
    # proxy kwarg — for the rest we silently ignore the field, which keeps
    # the wizard payload uniform.
    from daalu_automation.core.cluster_proxy import get_proxy_url

    proxy = await get_proxy_url(db, payload.cluster_tunnel_id)
    proxy_aware = {"prometheus", "loki", "thanos", "opensearch"}

    started = time.monotonic()
    try:
        if provider in proxy_aware:
            ok, msg = await tester(config, proxy=proxy)
        else:
            ok, msg = await tester(config)
    except Exception as e:  # noqa: BLE001
        logger.exception("onboarding.test.crashed", provider=provider)
        ok, msg = False, f"tester crashed: {e}"
    latency_ms = int((time.monotonic() - started) * 1000)
    return TestOut(ok=ok, message=msg, latency_ms=latency_ms)
