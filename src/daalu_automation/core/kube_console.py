"""Read-only Kubernetes console for the managed cluster.

Backs the per-cluster page under ``/clusters/{slug}`` in the UI. It gives an
operator two things against the cluster Daalu reads via its stored kubeconfig
(the ``Integration(provider="kubernetes")`` row):

* **Overview** — server version, node inventory (status / roles / kubelet
  version / capacity), and namespace count.
* **A curated kubectl runner** — a fixed allowlist of read-only
  ``kubectl get``-style commands. The operator ticks one or more, picks an
  output format (``json`` / ``yaml`` / ``cli`` table), and each runs against
  the cluster and returns the rendered output.

Why a generic GET executor instead of shelling out to ``kubectl``:

* No shell, no binary, no argument-injection surface. The only inputs the
  caller controls are a command *id* (validated against the catalog), an
  optional namespace, and an optional label selector (both regex-checked).
* Every command resolves to a single HTTP ``GET`` against a fixed API path —
  nothing here can mutate cluster state.
* The Kubernetes API server renders all three output shapes itself
  (``application/json`` for json/yaml; ``application/json;as=Table`` for the
  ``cli`` view, which returns the same server-side printer columns
  ``kubectl get`` shows).

Connectivity reuses the kubeconfig resolution the alert-chat read tools use
(:mod:`daalu_automation.core.kube_tools`): the kubeconfig stored on the
``kubernetes`` integration is loaded into a client; the daalu-api process
dials the cluster's API server directly.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

import structlog
import yaml

from daalu_automation.core.kube_tools import (
    KubeUnavailable,
    _tenant_kube_or_default,
)

logger = structlog.get_logger(__name__)


class KubeConsoleError(RuntimeError):
    """A console command could not be resolved or executed."""


OutputFormat = Literal["json", "yaml", "cli"]

# Content negotiation. The Table accept header asks the API server to do the
# same server-side printing ``kubectl get`` relies on.
_ACCEPT_JSON = "application/json"
_ACCEPT_TABLE = (
    "application/json;as=Table;v=v1;g=meta.k8s.io,"
    "application/json;as=Table;v=v1beta1;g=meta.k8s.io,"
    "application/json"
)

# Validation for the only free-form inputs we accept.
_NS_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_SELECTOR_RE = re.compile(r"^[A-Za-z0-9_.\-/=,!() ]{0,256}$")

_MAX_COMMANDS_PER_RUN = 25


# ── command catalog ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class CommandSpec:
    """One read-only command surfaced in the UI.

    ``path`` is the cluster-scoped API path. For namespaced resources,
    ``namespaced_path`` is the per-namespace template (``{ns}`` slot) used
    when the caller supplies a namespace; otherwise ``path`` (the
    all-namespaces collection) is used.
    """

    id: str
    label: str
    kubectl: str
    group: str
    path: str
    namespaced: bool = False
    namespaced_path: str | None = None
    # Some endpoints (``/version``) don't support Table printing.
    supports_table: bool = True
    # Whether a label selector is meaningful for this resource.
    supports_selector: bool = True


CATALOG: list[CommandSpec] = [
    # ── Cluster ──────────────────────────────────────────────────────────
    CommandSpec(
        id="version",
        label="Server version",
        kubectl="kubectl version",
        group="Cluster",
        path="/version",
        supports_table=False,
        supports_selector=False,
    ),
    CommandSpec(
        id="get-nodes",
        label="Nodes",
        kubectl="kubectl get nodes -o wide",
        group="Cluster",
        path="/api/v1/nodes",
    ),
    CommandSpec(
        id="get-namespaces",
        label="Namespaces",
        kubectl="kubectl get namespaces",
        group="Cluster",
        path="/api/v1/namespaces",
        supports_selector=False,
    ),
    CommandSpec(
        id="top-nodes",
        label="Node resource usage",
        kubectl="kubectl top nodes",
        group="Cluster",
        path="/apis/metrics.k8s.io/v1beta1/nodes",
    ),
    CommandSpec(
        id="get-events",
        label="Events",
        kubectl="kubectl get events",
        group="Cluster",
        path="/api/v1/events",
        namespaced=True,
        namespaced_path="/api/v1/namespaces/{ns}/events",
        supports_selector=False,
    ),
    # ── Workloads ────────────────────────────────────────────────────────
    CommandSpec(
        id="get-pods",
        label="Pods",
        kubectl="kubectl get pods -o wide",
        group="Workloads",
        path="/api/v1/pods",
        namespaced=True,
        namespaced_path="/api/v1/namespaces/{ns}/pods",
    ),
    CommandSpec(
        id="get-deployments",
        label="Deployments",
        kubectl="kubectl get deployments",
        group="Workloads",
        path="/apis/apps/v1/deployments",
        namespaced=True,
        namespaced_path="/apis/apps/v1/namespaces/{ns}/deployments",
    ),
    CommandSpec(
        id="get-statefulsets",
        label="StatefulSets",
        kubectl="kubectl get statefulsets",
        group="Workloads",
        path="/apis/apps/v1/statefulsets",
        namespaced=True,
        namespaced_path="/apis/apps/v1/namespaces/{ns}/statefulsets",
    ),
    CommandSpec(
        id="get-daemonsets",
        label="DaemonSets",
        kubectl="kubectl get daemonsets",
        group="Workloads",
        path="/apis/apps/v1/daemonsets",
        namespaced=True,
        namespaced_path="/apis/apps/v1/namespaces/{ns}/daemonsets",
    ),
    CommandSpec(
        id="get-replicasets",
        label="ReplicaSets",
        kubectl="kubectl get replicasets",
        group="Workloads",
        path="/apis/apps/v1/replicasets",
        namespaced=True,
        namespaced_path="/apis/apps/v1/namespaces/{ns}/replicasets",
    ),
    CommandSpec(
        id="get-jobs",
        label="Jobs",
        kubectl="kubectl get jobs",
        group="Workloads",
        path="/apis/batch/v1/jobs",
        namespaced=True,
        namespaced_path="/apis/batch/v1/namespaces/{ns}/jobs",
    ),
    CommandSpec(
        id="get-cronjobs",
        label="CronJobs",
        kubectl="kubectl get cronjobs",
        group="Workloads",
        path="/apis/batch/v1/cronjobs",
        namespaced=True,
        namespaced_path="/apis/batch/v1/namespaces/{ns}/cronjobs",
    ),
    # ── Networking ───────────────────────────────────────────────────────
    CommandSpec(
        id="get-services",
        label="Services",
        kubectl="kubectl get services -o wide",
        group="Networking",
        path="/api/v1/services",
        namespaced=True,
        namespaced_path="/api/v1/namespaces/{ns}/services",
    ),
    CommandSpec(
        id="get-endpoints",
        label="Endpoints",
        kubectl="kubectl get endpoints",
        group="Networking",
        path="/api/v1/endpoints",
        namespaced=True,
        namespaced_path="/api/v1/namespaces/{ns}/endpoints",
    ),
    CommandSpec(
        id="get-ingresses",
        label="Ingresses",
        kubectl="kubectl get ingresses",
        group="Networking",
        path="/apis/networking.k8s.io/v1/ingresses",
        namespaced=True,
        namespaced_path="/apis/networking.k8s.io/v1/namespaces/{ns}/ingresses",
    ),
    # ── Storage ──────────────────────────────────────────────────────────
    CommandSpec(
        id="get-pvcs",
        label="PersistentVolumeClaims",
        kubectl="kubectl get pvc",
        group="Storage",
        path="/api/v1/persistentvolumeclaims",
        namespaced=True,
        namespaced_path="/api/v1/namespaces/{ns}/persistentvolumeclaims",
    ),
    CommandSpec(
        id="get-pvs",
        label="PersistentVolumes",
        kubectl="kubectl get pv",
        group="Storage",
        path="/api/v1/persistentvolumes",
    ),
    CommandSpec(
        id="get-storageclasses",
        label="StorageClasses",
        kubectl="kubectl get storageclasses",
        group="Storage",
        path="/apis/storage.k8s.io/v1/storageclasses",
    ),
    # ── Config ───────────────────────────────────────────────────────────
    #
    # ConfigMaps are listed (names/keys only — Table printing never returns
    # data values). Secrets are deliberately excluded: even a name listing
    # leaks more than an operator console should.
    CommandSpec(
        id="get-configmaps",
        label="ConfigMaps",
        kubectl="kubectl get configmaps",
        group="Config",
        path="/api/v1/configmaps",
        namespaced=True,
        namespaced_path="/api/v1/namespaces/{ns}/configmaps",
    ),
]

_CATALOG_BY_ID: dict[str, CommandSpec] = {c.id: c for c in CATALOG}


def catalog() -> list[CommandSpec]:
    return list(CATALOG)


# ── overview ─────────────────────────────────────────────────────────────


@dataclass
class NodeSummary:
    name: str
    status: str
    roles: list[str]
    version: str
    internal_ip: str | None
    os_image: str | None
    cpu: str | None
    memory: str | None
    created_at: str | None


@dataclass
class ClusterOverview:
    reachable: bool
    server_version: str | None = None
    node_count: int = 0
    namespace_count: int = 0
    nodes: list[NodeSummary] = field(default_factory=list)
    error: str | None = None


async def cluster_overview(tenant_id: uuid.UUID | None) -> ClusterOverview:
    """Server version + node inventory + namespace count for the header."""
    try:
        core, _apps, client_mod = await _tenant_kube_or_default(tenant_id)
    except (KubeConsoleError, KubeUnavailable) as e:
        return ClusterOverview(reachable=False, error=str(e))

    def _collect() -> ClusterOverview:
        version_api = client_mod.VersionApi(core.api_client)
        ver = version_api.get_code()
        nodes = core.list_node().items
        namespaces = core.list_namespace().items
        node_rows: list[NodeSummary] = []
        for n in nodes:
            conds = {c.type: c.status for c in (n.status.conditions or [])}
            ready = conds.get("Ready")
            status = "Ready" if ready == "True" else "NotReady"
            if (n.spec.taints or []) and any(
                t.effect == "NoSchedule"
                and t.key == "node.kubernetes.io/unschedulable"
                for t in n.spec.taints
            ):
                status += ",SchedulingDisabled"
            roles = sorted(
                k.split("/", 1)[1] or "<none>"
                for k in (n.metadata.labels or {})
                if k.startswith("node-role.kubernetes.io/")
            ) or ["<none>"]
            addrs = {a.type: a.address for a in (n.status.addresses or [])}
            cap = n.status.capacity or {}
            node_rows.append(
                NodeSummary(
                    name=n.metadata.name,
                    status=status,
                    roles=roles,
                    version=(n.status.node_info.kubelet_version
                             if n.status.node_info else ""),
                    internal_ip=addrs.get("InternalIP"),
                    os_image=(n.status.node_info.os_image
                              if n.status.node_info else None),
                    cpu=cap.get("cpu"),
                    memory=cap.get("memory"),
                    created_at=n.metadata.creation_timestamp.isoformat()
                    if n.metadata.creation_timestamp
                    else None,
                )
            )
        return ClusterOverview(
            reachable=True,
            server_version=ver.git_version,
            node_count=len(nodes),
            namespace_count=len(namespaces),
            nodes=node_rows,
        )

    try:
        return await asyncio.to_thread(_collect)
    except Exception as e:  # noqa: BLE001
        logger.warning("kube_console.overview_failed", error=str(e))
        return ClusterOverview(reachable=False, error=str(e)[:500])


# ── command execution ────────────────────────────────────────────────────


@dataclass
class CommandResult:
    id: str
    command: str
    ok: bool
    output: str
    error: str | None = None


def _resolve_path(spec: CommandSpec, namespace: str | None) -> str:
    if spec.namespaced and namespace and spec.namespaced_path:
        return spec.namespaced_path.format(ns=namespace)
    return spec.path


def _display_command(spec: CommandSpec, namespace: str | None,
                     selector: str | None, output: OutputFormat) -> str:
    parts = [spec.kubectl]
    if spec.namespaced:
        parts.append(f"-n {namespace}" if namespace else "-A")
    if selector and spec.supports_selector:
        parts.append(f"-l {selector}")
    if output in ("json", "yaml"):
        parts.append(f"-o {output}")
    return " ".join(parts)


def _raw_get(api_client: Any, path: str, *, accept: str,
             query: list[tuple[str, str]] | None = None) -> Any:
    """Issue a single authenticated GET via the configured ApiClient and
    return the parsed JSON body.

    Uses ``_preload_content=False`` and parses the raw bytes ourselves — the
    deserialization keyword on ``call_api`` changed across kubernetes-client
    majors, so parsing the raw response is version-stable. Auth (bearer token
    or client cert from the kubeconfig) and TLS are still applied.
    """
    resp = api_client.call_api(
        path,
        "GET",
        query_params=query or [],
        header_params={"Accept": accept},
        auth_settings=["BearerToken"],
        _preload_content=False,
    )
    data = resp.data
    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8")
    return json.loads(data)


def _render_table(obj: dict[str, Any]) -> str:
    """Render an API ``Table`` object as aligned columns, like kubectl."""
    cols = obj.get("columnDefinitions") or []
    rows = obj.get("rows") or []
    headers = [c.get("name", "") for c in cols]
    if not headers:
        return "(no columns returned)"
    body = [[("" if v is None else str(v)) for v in (r.get("cells") or [])]
            for r in rows]
    widths = [len(h) for h in headers]
    for line in body:
        for i, cell in enumerate(line):
            if i < len(widths):
                widths[i] = max(widths[i], len(cell))
    fmt = "   ".join(f"{{:<{w}}}" for w in widths)
    out = [fmt.format(*headers).rstrip()]
    for line in body:
        padded = line + [""] * (len(headers) - len(line))
        out.append(fmt.format(*padded[: len(headers)]).rstrip())
    if not body:
        out.append("(no resources found)")
    return "\n".join(out)


def _run_one(api_client: Any, spec: CommandSpec, namespace: str | None,
             selector: str | None, output: OutputFormat) -> str:
    path = _resolve_path(spec, namespace)
    query: list[tuple[str, str]] = []
    if selector and spec.supports_selector:
        query.append(("labelSelector", selector))

    if output == "cli" and spec.supports_table:
        obj = _raw_get(api_client, path, accept=_ACCEPT_TABLE, query=query)
        if isinstance(obj, dict) and obj.get("kind") == "Table":
            return _render_table(obj)
        # Server ignored the Table accept (older API) — fall through to JSON.
        return json.dumps(obj, indent=2, default=str)

    obj = _raw_get(api_client, path, accept=_ACCEPT_JSON, query=query)
    if output == "yaml":
        return yaml.safe_dump(obj, default_flow_style=False, sort_keys=False)
    return json.dumps(obj, indent=2, default=str)


async def run_commands(
    tenant_id: uuid.UUID | None,
    *,
    command_ids: list[str],
    namespace: str | None,
    selector: str | None,
    output: OutputFormat,
    actor_id: uuid.UUID | None = None,
) -> list[CommandResult]:
    """Run each selected command read-only and return rendered output."""
    if not command_ids:
        raise KubeConsoleError("select at least one command")
    if len(command_ids) > _MAX_COMMANDS_PER_RUN:
        raise KubeConsoleError(
            f"too many commands selected (max {_MAX_COMMANDS_PER_RUN})"
        )
    if output not in ("json", "yaml", "cli"):
        raise KubeConsoleError(f"unknown output format {output!r}")
    if namespace is not None:
        namespace = namespace.strip() or None
    if namespace is not None and not _NS_RE.match(namespace):
        raise KubeConsoleError(f"invalid namespace {namespace!r}")
    if selector is not None:
        selector = selector.strip() or None
    if selector is not None and not _SELECTOR_RE.match(selector):
        raise KubeConsoleError("invalid label selector")

    specs: list[CommandSpec] = []
    for cid in command_ids:
        spec = _CATALOG_BY_ID.get(cid)
        if spec is None:
            raise KubeConsoleError(f"unknown command {cid!r}")
        specs.append(spec)

    core, _apps, _client_mod = await _tenant_kube_or_default(tenant_id)
    api_client = core.api_client

    logger.info(
        "kube_console.run",
        tenant_id=str(tenant_id) if tenant_id else None,
        actor_id=str(actor_id) if actor_id else None,
        commands=command_ids,
        namespace=namespace,
        output=output,
    )

    def _execute() -> list[CommandResult]:
        results: list[CommandResult] = []
        for spec in specs:
            display = _display_command(spec, namespace, selector, output)
            try:
                text = _run_one(api_client, spec, namespace, selector, output)
                results.append(
                    CommandResult(id=spec.id, command=display, ok=True,
                                  output=text)
                )
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "kube_console.command_failed", command=spec.id, error=str(e),
                )
                results.append(
                    CommandResult(
                        id=spec.id, command=display, ok=False, output="",
                        error=_humanise_error(e),
                    )
                )
        return results

    return await asyncio.to_thread(_execute)


def _humanise_error(e: Exception) -> str:
    """Best-effort short message from a kubernetes ApiException or other."""
    status = getattr(e, "status", None)
    reason = getattr(e, "reason", None)
    if status is not None:
        body = getattr(e, "body", "") or ""
        msg = ""
        try:
            msg = (json.loads(body) or {}).get("message", "")
        except Exception:  # noqa: BLE001
            msg = ""
        return f"HTTP {status} {reason or ''}: {msg or body[:200]}".strip()
    return f"{type(e).__name__}: {e}"


def utcnow_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()
