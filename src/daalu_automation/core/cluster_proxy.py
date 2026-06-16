"""Cross-cluster HTTP forward-proxy lookup.

When an ``Integration`` row has a ``cluster_tunnel_id``, its URL is meant
to be dialed *inside* the named workload cluster — typically because it
points at an in-cluster Service (``*.svc.cluster.local``) that the hub
can't resolve. The daalu-edge pod in that cluster runs a tiny HTTP
forward proxy on the tunnel IP (see ``deploy/edge/proxy.py``); this
module resolves a ``cluster_tunnel_id`` to the proxy URL the hub's
``httpx.AsyncClient(proxy=...)`` should use.

A ``None`` return means: dial the URL directly (current behavior for
publicly-reachable URLs, or for integrations that simply have no cluster
attached).
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.models import ClusterTunnel, ClusterTunnelStatus

# Port the edge-side forward proxy listens on (bound to the wg0 tunnel
# IP only). Kept as a module constant so the hub and the Helm chart's
# `edgeProxy.listenPort` don't drift — change them together.
EDGE_PROXY_PORT = 8888


async def get_proxy_url(
    db: AsyncSession, cluster_tunnel_id: uuid.UUID | None
) -> str | None:
    """Return ``http://<tunnel_ip>:8888`` or ``None``.

    Returns ``None`` when:
    - no cluster is attached to the integration,
    - the cluster_tunnel_id doesn't exist,
    - the tunnel is in a state other than ``connected`` (no point dialing
      a dead tunnel — fail fast at the call site with a clearer error).
    """
    if cluster_tunnel_id is None:
        return None
    row = await db.get(ClusterTunnel, cluster_tunnel_id)
    if row is None or row.status != ClusterTunnelStatus.connected:
        return None
    return f"http://{row.tunnel_ip}:{EDGE_PROXY_PORT}"
