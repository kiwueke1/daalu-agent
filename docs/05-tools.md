# Tool catalog

This is the full set of tools the agent can call during an investigation, which
tier each is in, and how to enable it. The two tiers are explained in
[02-agent-and-guardrails.md](02-agent-and-guardrails.md):

- **Read (auto)** — runs immediately when the LLM calls it; cannot mutate state.
- **Write (gated)** — recorded as a pending action and applied only after a human
  clicks Approve.

The registry lives in `src/daalu_automation/core/kube_tools.py` (the `TOOLS`
dict). Cloud tools and source-of-truth tools merge into the same registry at
import time via `tool_specs()`. `tool_requires_approval(name, tool_input)` is the
single function that decides whether a call is gated.

Most non-Kubernetes tools resolve their credentials from an **Integration** row
for the current tenant (provider + a `config` blob). You create these in the UI
under Integrations, or via the API. Kubernetes is the exception — it uses an
in-cluster ServiceAccount or a kubeconfig.

## Kubernetes

Tool names are exactly as registered in `core/kube_tools.py`.

| Tool | Tier | What it does |
|------|------|--------------|
| `get_pod_logs` | read | Recent stdout/stderr from a pod (`tail_lines`, `previous`). |
| `describe_pod` | read | Phase, container statuses, restart counts, conditions. |
| `get_pod_events` | read | Namespace events (OOMKill, ImagePullBackOff, FailedScheduling, …). |
| `list_pods` | read | Pods in a namespace with status + restart counts. |
| `get_deployment` | read | Desired/ready replicas, images, conditions. |
| `rollout_history` | read | Last ~10 Deployment revisions with images + timestamps. |
| `rollout_undo` | **write** | Roll a Deployment back to its previous (or a specific) revision. |
| `scale_deployment` | **write** | Set a Deployment's replica count. |
| `restart_deployment` | **write** | Rolling restart (stamps the pod template). |
| `delete_pod` | **write** | Delete one pod so its controller reschedules it. |
| `patch_resource` | **write** | Strategic-merge patch to a Deployment, StatefulSet, DaemonSet, ReplicaSet, Pod, ConfigMap, Service, or Secret. |

**How to enable.** The Kubernetes tools talk to the API server through one of
(in order, see `_load_kube`):

1. A per-tenant **kubeconfig** stored as an `Integration` row with
   `provider="kubernetes"` and `config={"kubeconfig": <yaml or dict>}`.
2. The **in-cluster ServiceAccount** token mounted on the api pod (the default
   when Daalu runs inside the cluster it operates).
3. `~/.kube/config` — local-dev fallback only.

The write tools need RBAC permission to patch/delete the relevant objects; scope
the ServiceAccount (or the kubeconfig's user) to the namespaces you want the
agent to be able to act in. See
[04-deployment.md §A7](04-deployment.md#a7-giving-the-agent-a-cluster-to-operate).

## Cloud — AWS, GCP, Azure (read-only)

All cloud tools are **read-only** in this build (`requires_approval=False`).
Write actions against cloud providers are intentionally not exposed yet; when
they are, they will flow through the same Approve UI.

**AWS** (`core/cloud_aws.py`). Integration `provider="aws"`,
`config={access_key_id, secret_access_key, region, [session_token], [role_arn]}`.
If `role_arn` is set, Daalu assumes that role (cross-account / short-lived creds).

| Tool | What it reads |
|------|---------------|
| `aws_describe_instances` | EC2 instances (state, type, IPs, AZ, tags). |
| `aws_get_cloudwatch_logs` | CloudWatch Logs lines from a log group + optional filter. |
| `aws_query_cloudwatch_metric` | One CloudWatch metric over a window. |
| `aws_describe_rds_instances` | RDS instance state, engine, storage, endpoint, MultiAZ. |
| `aws_describe_lambda` | Lambda config + recent Errors metric in one call. |

**GCP** (`core/cloud_gcp.py`). Integration `provider="gcp"`.

| Tool | What it reads |
|------|---------------|
| `gcp_list_instances` | Compute Engine instances. |
| `gcp_query_logging` | Cloud Logging entries. |
| `gcp_query_monitoring` | Cloud Monitoring metrics. |
| `gcp_describe_sql_instance` | Cloud SQL instance state. |
| `gcp_describe_function` | Cloud Function config + recent errors. |

**Azure** (`core/cloud_azure.py`). Integration `provider="azure"`.

| Tool | What it reads |
|------|---------------|
| `azure_list_vms` | Virtual machines. |
| `azure_query_log_analytics` | Log Analytics (KQL) query. |
| `azure_query_metrics` | Azure Monitor metrics. |
| `azure_describe_sql_db` | SQL Database state. |
| `azure_describe_function` | Function App config + recent errors. |

## Metrics and logs

| Tool | Tier | Integration | Notes |
|------|------|-------------|-------|
| `query_prometheus` | read | `thanos` then `prometheus` | PromQL instant or range query. Prefers a `thanos` integration's `url`, falls back to `prometheus`, then the env default `prometheus_url`. |
| `query_loki` | read | `loki` | LogQL query against `config.url`; honours an auth header if configured. |

Add these as `Integration` rows with `config={"url": "...", [auth fields]}`. The
`prometheus`/`thanos`/`loki` adapters live in
`src/daalu_automation/modules/infra/integrations.py`.

## Generic external HTTP

`call_external_api` (`core/kube_tools.py`) calls any system you register as an
Integration. The integration supplies the base URL and auth; the LLM passes only
the path, method, query, and body.

- **Tier:** read for `GET`, **gated** for `POST`/`PUT`/`PATCH`/`DELETE` (write
  verbs require approval, per `tool_requires_approval`).
- **Integration:** any `provider` slug with
  `config={"base_url": "...", "auth_header": "Bearer …" | bearer_token | api_token | username+password, ["extra_headers"], ["verify_tls"]}`.
- Response bodies are truncated to ~4 KB to protect the context window.

Use this for switches, firewalls, managed servers, a CMDB, or any internal API
you have not yet built a first-class adapter for.

## Source-of-truth / device tools

The agent can also draft a **device configuration change** via the SoT tools
(`core/sot_tools.py`, merged into the registry). The key one, `propose_change`,
is intentionally **not** gated at the chat-action level
(`requires_approval=False`) — because the `ChangeProposal` row it creates *is*
the approval surface (see [02-agent-and-guardrails.md](02-agent-and-guardrails.md)).
Gating it twice would split authority across two UIs. The proposal still cannot
reach a device until a human approves it and the executor applies it.

Device changes are applied by a **DeviceAdapter** chosen by the device's
`transport`. Adapters self-register in `core/device/registry.py`; the executor
calls `get_device_adapter(transport)`:

| `transport` | Adapter | Credentials Integration | Default port |
|-------------|---------|-------------------------|--------------|
| `linux_ssh` | `core/device/linux_ssh.py` | `ssh_credentials` | 22 |
| `eos` (Arista) | `core/device/eos.py` | `network_credentials` | 22 → NETCONF 830 |
| `junos` (Juniper) | `core/device/junos.py` | `network_credentials` | 22 → NETCONF 830 |
| `iosxr` (Cisco) | `core/device/iosxr.py` | `network_credentials` | 22 → NETCONF 830 |
| `redfish` (BMC) | `core/device/redfish.py` | `redfish_credentials` | 443 |

Credential resolution is in `change_proposals.resolve_credentials()`. The three
network OSes share one `network_credentials` provider because the credential
shape is identical. Secrets in the `config` blob are stored as ciphertext
(`*_ciphertext` fields, decrypted at use). Per-device overrides
(`ssh_user`/`ssh_port`, `network_user`/`network_port`, `redfish_user`/
`redfish_port`) and named-credential pointers are honoured via device custom
fields — see the docstring on `resolve_credentials` and `_select_credentials_row`
for the full priority order.

> Note: the device/SoT path expects a configured source of truth. The optional
> NVIDIA Config Manager component and other commercial-hub provisioning paths are
> out of scope for this open-source build.

## Adding a tool

Tools are plain entries in the `TOOLS` dict (or a `tool_specs()` provider that
gets merged in). A `ToolSpec` is `name`, `description`, JSON-Schema
`input_schema`, an async `handler`, and `requires_approval`. Set
`requires_approval=True` for anything that mutates state so it lands as a pending
approval automatically. See [06-extending.md](06-extending.md).

## Where to go next

- The safety model behind the read/write split: [02-agent-and-guardrails.md](02-agent-and-guardrails.md).
- How tools fit the event flow: [01-architecture.md](01-architecture.md).
- Installing and granting access: [04-deployment.md](04-deployment.md).
