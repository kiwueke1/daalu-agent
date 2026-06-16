"""Render Helm values + derive per-component URLs for a tenant's NV-CM stack.

Values are written to a temp file the HelmRunner passes via ``-f``. We set
the multi-tenant-safe knobs (shared GatewayClass, unique base hostname,
per-tenant namespace) and toggle components from the row's ``components``
map. Image registry is overridden to daalu's Harbor mirror.

See docs/design/nv-config-manager-integration.md §5.3, §5.4.
"""

from __future__ import annotations

from typing import Any

from daalu_automation.config import get_settings
from daalu_automation.models import ConfigManagerTenant

# Shared GatewayClass installed once per host cluster (Tier-A). Every tenant
# release references it with createGatewayClass=false.
SHARED_GATEWAY_CLASS = "envoy-gateway"

# Harbor project the NV-CM images are mirrored under (see the mirror
# script: deploy/scripts/config-manager/mirror-images.sh). Every image
# lands at ``<harbor_registry>/<HARBOR_PROJECT>/<basename>``.
HARBOR_PROJECT = "nv-config-manager"

# ``global.images.<key>`` → image basename, for the pinned chart. This
# chart pulls each image as ``<repository>:<tag>`` directly — it has **no**
# ``global.imageRegistry`` indirection — so to use the Harbor mirror we
# override each *repository* to ``<harbor>/<project>/<basename>`` (the
# mirror script pushes to the exact same path) and leave ``tag`` to the
# chart default. KEEP IN SYNC with
# ``deploy/charts/nv-config-manager-<ver>/values.yaml`` (the ``global.images``
# block) on a chart bump — the mirror script derives basenames the same way
# (last path segment), so the two stay aligned by construction.
_HARBOR_IMAGE_BASENAMES: dict[str, str] = {
    "nvConfigManager": "nv-config-manager",
    "nvConfigManagerUi": "nv-config-manager-ui",
    "kea": "nv-config-manager-kea",
    "keaAdmin": "nv-config-manager-kea-admin",
    "nautobot": "nv-config-manager-nautobot",
    "natsReady": "nv-config-manager-nats-ready",
    "httpEcho": "http-echo",
    "kubectl": "kubectl",
    "busybox": "busybox",
    "redis": "redis",
    "nats": "nats",
    "natsBox": "nats-box",
    "temporalServer": "server",
    "temporalUi": "ui",
    "temporalAdminTools": "admin-tools",
}

# CNPG instance count per size profile. Small tenants run single-instance
# Postgres to keep the footprint sane (open decision K.1 default).
_SIZE_TO_PG_INSTANCES = {"small": 1, "medium": 2, "large": 3}

# Component key (row.components) → chart values path that enables it.
_COMPONENT_TOGGLES: dict[str, str] = {
    "render": "renderService",
    "configStore": "configStore",
    "temporal": "temporal",
    "nautobot": "nautobot",
    "ztp": "networkZtp",
    "dhcp": "networkDhcp",
    "ui": "ui",
}

# Default profile (the "Lean" config-&-change set from §6/§7).
DEFAULT_COMPONENTS: dict[str, bool] = {
    "render": True,
    "configStore": True,
    "temporal": True,
    "nautobot": True,
    "ztp": False,
    "dhcp": False,
    "ui": False,
}


def compute_urls(base_hostname: str) -> dict[str, str]:
    """Per-component URLs derived from ``base_hostname``.

    Returns both human (OIDC, browser-facing) and machine (``svc-*``,
    JWT-only) URLs.

    **Human URLs are flat, single-label hosts** under the cmtools wildcard
    zone — ``<tool>-<slug>.<zone>`` — so a single ``*.<zone>`` DNS record +
    one wildcard cert on the hub serve every tenant/tool. They are reached
    *through the hub* (hub terminates TLS, reverse-proxies over the WG
    tunnel — see api/tool_proxy.py), NOT by direct DNS to the tenant
    gateway. The config-browser UI keeps the bare ``<slug>.<zone>`` host
    (also covered by the wildcard). ``base_hostname`` is expected to be
    ``<slug>.<zone>`` (e.g. ``default.cmtools.example.com``).

    **Machine URLs are unchanged** (``svc-<tool>.<base_hostname>``): the
    hub's executor + SoT call these with a service JWT over the tunnel;
    they are never browser-facing. KEEP these stable — see the
    machine-path notes in onboarding/_upsert_config_manager_integration.
    """
    b = base_hostname
    # slug = first label; zone = the wildcard domain the hub serves.
    slug, _, zone = base_hostname.partition(".")
    zone = zone or base_hostname  # defensive: bare hostname → no flattening

    def human(tool: str) -> str:
        return f"https://{tool}-{slug}.{zone}"

    return {
        # Config-browser UI: bare base host (single label, wildcard-covered).
        "ui": f"https://{b}",
        # Machine (svc-*, JWT-only) — NOT browser-facing. Plain HTTP: the tenant
        # gateway is HTTP-only (the hub terminates TLS at its wildcard and reverse-
        # proxies over the WG tunnel; the gateway has no HTTPS listener / cert —
        # see render_values' gateway block + deployer_runner._daalu_values_overlay).
        # The hub executor/SoT dial these over the edge proxy (svc-* resolves to a
        # private in-cluster address), so no public TLS is involved.
        "config_store_url": f"http://svc-config-store.{b}",
        "render_url": f"http://svc-render.{b}",
        "workflow_url": f"http://svc-workflow.{b}",
        "nautobot_url": f"http://svc-nautobot.{b}",
        # Human (OIDC) — flat hosts served through the hub.
        "config_store_human": human("config-store"),
        "render_human": human("render"),
        # The "Workflow" tool is Temporal: link to its WEB UI (devUi host,
        # temporal-<slug>), NOT the workflow API host (workflow-<slug>) which has
        # no browser UI and 404s on /. See render_values temporal.gateway.devUi.
        "workflow_human": human("temporal"),
        "nautobot_human": human("nautobot"),
    }


def render_values(
    row: ConfigManagerTenant,
    *,
    harbor_registry: str | None = None,
) -> dict[str, Any]:
    """Build the Helm values dict for this tenant's NV-CM release."""
    settings = get_settings()
    components = {**DEFAULT_COMPONENTS, **(row.components or {})}
    pg_instances = _SIZE_TO_PG_INSTANCES.get(row.size_profile, 1)

    # Flat, single-label public hostnames served *through the hub* (TLS
    # terminated at the hub's ``*.<zone>`` wildcard; reverse-proxied over
    # the WG tunnel — see api/tool_proxy.py). base_hostname is ``<slug>.<zone>``.
    # The tenant gateway host-routes + runs OIDC on these exact hosts.
    _slug, _, _zone = row.base_hostname.partition(".")
    _zone = _zone or row.base_hostname

    def _flat(tool: str) -> str:
        return f"{tool}-{_slug}.{_zone}"

    _human_hosts = [
        _flat("nautobot"),
        _flat("render"),
        _flat("workflow"),
        _flat("config-store"),
        row.base_hostname,  # config-browser UI on the bare base host
    ]

    values: dict[str, Any] = {
        "global": {
            "namespace": row.namespace,
            "createNamespace": True,
            "environment": "production" if settings.is_production else "staging",
        },
        "gateway": {
            "enabled": True,
            # Multi-tenant coexistence: reference the one shared GatewayClass
            # installed in Tier-A; do not create another (would collide —
            # it's cluster-scoped and not release-named).
            "createGatewayClass": False,
            "className": SHARED_GATEWAY_CLASS,
            "baseHostname": row.base_hostname,
            # The hub terminates TLS at its ``*.<zone>`` wildcard and reverse-
            # proxies over the WG tunnel, so the tenant gateway speaks plain
            # HTTP and needs no per-tenant cert (it also has no public DNS to
            # satisfy an ACME challenge). HTTP-only listener + no cert-manager
            # Certificate. (chart gateway.yaml ranges gateway.listeners and
            # only adds TLS for HTTPS; certificate.yaml is gated on
            # gateway.certificates.enabled.)
            "listeners": [{"name": "http", "protocol": "HTTP", "port": 80}],
            "certificates": {"enabled": False},
            # CORS allow-origins can't be auto-derived (the chart's
            # ``https://*.<base>`` won't match flat siblings) — list the
            # explicit human origins. (gateway.cors.allowOrigins is the real
            # chart path — see templates/security-policy.yaml.)
            "cors": {"allowOrigins": [f"https://{h}" for h in _human_hosts]},
        },
        # OIDC: trust daalu's Keycloak so the hub's machine JWTs are
        # accepted on svc-* endpoints (§8).
        "oidc": {
            "enabled": bool(settings.keycloak_issuer_url),
            "issuerUrl": settings.keycloak_issuer_url,
            # Internal Keycloak URL for JWKS fetches. The token ``iss`` stays the
            # external issuerUrl, but the workload cluster can't reach that host
            # (auth.example.com is split-horizon → 404 inside the cluster), so the
            # gateway JWT filter AND the Nautobot auth plugin
            # (NV_CONFIG_MANAGER_JWT_PROVIDERS, via the chart jwtProviders helper)
            # must validate against the in-cluster keycloak Service. Without this
            # the Nautobot plugin's jwks_uri falls back to the external issuer and
            # every login 401s.
            "internalIssuerUrl": settings.keycloak_internal_issuer_url or None,
            # Also set jwksUri explicitly: the chart's jwtProviders/security-policy
            # helpers check ``oidc.jwksUri`` BEFORE ``internalIssuerUrl``, and the
            # Deployer sets jwksUri to the EXTERNAL certs URL (which 404s inside
            # the cluster) — so internalIssuerUrl alone is ignored. Point it at
            # the in-cluster keycloak Service.
            "jwksUri": (
                settings.keycloak_internal_issuer_url.rstrip("/")
                + "/protocol/openid-connect/certs"
            )
            if settings.keycloak_internal_issuer_url
            else None,
            "audiences": [settings.keycloak_token_audience],
            # Interactive (browser) client the gateway SecurityPolicy uses for
            # the OIDC redirect — top-level ``oidc.clientId`` is the real chart
            # path (security-policy.yaml line ~367).
            "clientId": settings.keycloak_ui_client_id,
            # Keep JWT validation + claim-to-header ON (the hub injects a
            # daalu-hub-nvcm service Bearer the gateway validates) but turn the
            # interactive OIDC *redirect* OFF: tools are served at FLAT sibling
            # hosts <tool>-<slug>.<zone>, and the gateway's OIDC session cookie
            # is scoped to baseHostname (<slug>.<zone>), so it never reaches the
            # siblings → the oauth2 filter would redirect-loop forever
            # ("buffers"). The hub already authenticated the user. See
            # api/tool_proxy.py + the chart's security-policy.yaml gate.
            "interactiveRedirect": False,
        },
        "cnpg": {"enabled": True},
        # Secrets backend: the chart defaults to ``eso`` (External Secrets
        # Operator + Vault/OpenBao), which requires ``secrets.vault.paths.*``
        # and ESO SecretStores. daalu runs no Vault for NV-CM, so select the
        # chart's native-Kubernetes method — the installer creates the
        # secrets in-namespace and a pre-install Job assembles the unified
        # ``nv-config-manager-ini`` secret. No secrets live in values.
        "secrets": {"method": "kubernetes"},
        # Each per-tenant stack is self-contained: use the chart's bundled
        # (in-namespace) Nautobot / NATS / Redis rather than external ones.
        # The chart defaults ``<svc>.local=false``, which then *requires*
        # ``externalServices.<svc>.server``/``host``; setting local=true makes
        # the chart deploy them and auto-derive their URLs from the gateway
        # hostname. (Postgres is provided by the bundled CNPG, above.)
        "externalServices": {
            "nautobot": {"local": True},
            "nats": {"local": True},
            "redis": {"local": True},
        },
    }

    # Component enable toggles.
    for key, chart_path in _COMPONENT_TOGGLES.items():
        values.setdefault(chart_path, {})["enabled"] = bool(components.get(key))

    # Flat human hostnames per component, set at the *real* chart value paths
    # (the chart reads ``<comp>.gateway.hostname`` etc., NOT gateway.components).
    # The ``svcHostname`` defaults (svc-<comp>.<base>, the machine path the hub
    # executor calls) are left intact. The config-browser UI rides the bare
    # ``gateway.baseHostname`` and needs no override.
    if components.get("render"):
        values.setdefault("renderService", {}).setdefault("gateway", {})[
            "hostname"
        ] = _flat("render")
    if components.get("nautobot"):
        values.setdefault("nautobot", {}).setdefault("gateway", {})[
            "hostname"
        ] = _flat("nautobot")
        # Map Keycloak realm roles → Nautobot superuser so SSO'd admins get the
        # full UI (Devices/Extensibility/Organization/plugins) instead of the
        # RBAC-stripped sidebar a fresh user lands on. The JWT `roles` claim
        # (daalu-hub-nvcm realm-roles mapper) is matched against these names by
        # nv_config_manager_auth.jwt_authentication. See config.keycloak_nvcm_superuser_roles.
        _su = [r.strip() for r in (settings.keycloak_nvcm_superuser_roles or "").split(",") if r.strip()]
        if _su:
            values.setdefault("nautobot", {}).setdefault("rbac", {})[
                "superuserGroups"
            ] = _su
    if components.get("configStore"):
        values.setdefault("configStore", {}).setdefault("gateway", {}).setdefault(
            "api", {}
        )["hostname"] = _flat("config-store")
    if components.get("temporal"):
        _tg = values.setdefault("temporal", {}).setdefault("gateway", {})
        _tg.setdefault("api", {})["hostname"] = _flat("workflow")
        _tg.setdefault("devUi", {})["hostname"] = _flat("temporal")

    # Per-cluster CNPG instance count (sizing). The chart reads instance
    # counts under each cnpg cluster; we set a single global override knob
    # the chart honours, plus the explicit list for clarity.
    values["cnpg"]["instances"] = pg_instances

    # Image overrides → Harbor mirror. The chart has no global.imageRegistry
    # knob, so we repoint each global.images.<key>.repository at the mirror
    # (basenames + project match the mirror script). The upstream
    # registry.example.com/nvidia placeholders are NOT pullable, so this is
    # mandatory for a real install; left unset only for a dev/local install
    # that supplies its own images another way. Tags are inherited from the
    # chart defaults (we set repository only). See engineer chapter 64 §64.2.
    if harbor_registry:
        reg = harbor_registry.rstrip("/")
        images = values.setdefault("global", {}).setdefault("images", {})
        for key, basename in _HARBOR_IMAGE_BASENAMES.items():
            images.setdefault(key, {})["repository"] = (
                f"{reg}/{HARBOR_PROJECT}/{basename}"
            )

    return values
