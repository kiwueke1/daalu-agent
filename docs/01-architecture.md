# Architecture

Daalu is a self-hosted AI agent for infrastructure and ops teams. It ingests
alerts and events, investigates them with **read-only** tools, drafts a
proposed change, and waits for a human to approve before a dedicated executor
applies anything. This page explains the runtime components and traces an
event from source to (optionally) a live change.

See also: [02-agent-and-guardrails.md](02-agent-and-guardrails.md) for the safety
model, [05-tools.md](05-tools.md) for the tool catalog,
[03-llm-and-sovereignty.md](03-llm-and-sovereignty.md) for inference,
[04-deployment.md](04-deployment.md) for installation, and [../README.md](../README.md)
for the overview.

## Components

Daalu is one Python codebase (`src/daalu_automation/`) built into one Docker
image. Each component below is **the same image started with a different command**
— `daalu server` is the API, `daalu worker` a background worker, `daalu beat` the
scheduler, and so on. The executor is just a worker pinned to its own Celery
queue, which is what ensures only it applies changes. See `docker-compose.yml`:
every Python service shares one `image:` and differs only in `command:`.

| Component | Role | Notes |
|-----------|------|-------|
| **api** | FastAPI app — UI backend, webhook ingest, alert-chat | Publishes events to the bus; runs read tools live; records write-tool calls as pending approvals. |
| **worker** | Celery worker on the default queue | Runs agents' event loops + scheduled tasks (ingest, reconcile, reports, health). |
| **beat** | Celery beat | Fires the periodic schedule in `workers/celery_app.py`. |
| **agents** | Long-running coroutines (run inside the worker) | `Agent.run_forever()` subscribes to the Redis event stream; the `InfraAgent` is the built-in one. |
| **executor** | Celery worker on a *dedicated* queue | The **only** process that applies changes to devices. See below. |
| **frontend** | The web UI | Talks to the api over `settings.api_v1_prefix` (`/api/v1`). |
| **postgres** | System of record | Alerts, incidents, `ChangeProposal`s, `AgentRun`s, integrations, usage. |
| **redis** | Event bus + Celery broker/result backend | The event stream key is `settings.event_stream_key` (`daalu.events`). |

Configuration for every component comes from environment variables loaded by
`src/daalu_automation/config.py` (a pydantic-settings `Settings` model). Notable
settings referenced below: `event_stream_key`, `executor_queue_name`,
`executor_jwt_scope`, `executor_period_s`, `sot_reconcile_period_s`, and the
LLM-routing variables documented in
[03-llm-and-sovereignty.md](03-llm-and-sovereignty.md).

## Single-tenant framing

This open-source build is designed to run as a single self-hosted operator.
Pre-auth rows are stamped with `config.DEFAULT_TENANT_ID`, and
`settings.local_no_auth` resolves every request to the built-in local operator
(`config.DEFAULT_USER_ID`) so `docker compose up` works with no identity
provider. The codebase carries `tenant_id` columns and a routing tier that some
deployments use to federate inference to a customer's own GPU; the multi-tenant
control plane that drives those is a separate **commercial hub** and is not part
of this repo. Read everything here as single-tenant.

## End-to-end event flow

The `[n]` on each box / arrow matches the numbered step below it.

```
 ┌──────────────┐  [1] webhook/poll   ┌──────────┐ [2] publish ┌───────────────────┐
 │ Alertmanager │ ──────────────────► │   api    │ ──────────► │  Redis event bus  │
 │ PagerDuty    │                     │ (ingest) │             │  (daalu.events)   │
 │ CloudWatch   │  beat poll tasks    └──────────┘             └─────────┬─────────┘
 │ synthetic    │ ◄───── worker/beat                                     │ [3] subscribe
 └──────────────┘                                                        ▼
                                                          ┌──────────────────────────┐
                                                          │ [4] InfraAgent.run_forever│
                                                          │     (worker process)      │
                                                          │     - LLM triage          │
                                                          │     - read-only tools [5] │
                                                          │     - emit Alert/Incident │
                                                          └────────────┬─────────────┘
                                                                       │ [5] a write is needed
                                                                       ▼
                                                          ┌──────────────────────────┐
                                                          │ ChangeProposal (pending)  │  ← in Postgres
                                                          └────────────┬─────────────┘
                                                                       │ [6] human clicks Approve
                                                                       ▼
                                                          ┌──────────────────────────┐
                                                          │ ChangeProposal (approved) │
                                                          └────────────┬─────────────┘
                                       [7] executor queue (executor_period_s poll)
                                                                       ▼
                                                          ┌──────────────────────────┐
                                                          │ [7] daalu-executor process│
                                                          │ change_proposals.execute  │  ── applies to device
                                                          └──────────────────────────┘
```

Step by step (numbers match the `[n]` markers above):

1. **Source → api.** A monitoring system POSTs to the webhook ingest endpoint
   (gated by `settings.ingest_api_key`), or a beat task polls a source. The
   periodic pollers live in `workers/celery_app.py`'s `beat_schedule`:
   `infra.monitoring_ingest` for Alertmanager (`prometheus_ingest_period_s`)
   and CloudWatch alarms, plus `sot.reconcile_devices` and others. The adapters
   that do the polling are in `src/daalu_automation/modules/infra/integrations.py`
   (`PrometheusAdapter`, `PagerDutyAdapter`, `AWSCloudWatchAlarmAdapter`,
   `LokiAdapter`, `ThanosAdapter`, `SyntheticInfraAdapter`).

2. **api → event bus.** Sources are normalized into an `EventEnvelope`
   (`core/events.py`) and `publish()`ed to the Redis stream. Events carry a
   `type` (e.g. `infra.alert.fired`), `module`, `source`, `severity`, `summary`,
   and a `payload` dict.

3. **Event bus → agent.** Each agent runs `Agent.run_forever()`
   (`core/agents.py`), which `subscribe()`s to the stream and filters with
   `should_handle()`. The `InfraAgent`
   (`modules/infra/agent.py`) subscribes to `infra.alert.fired`,
   `infra.alert.resolved`, `infra.deployment.failed`, `infra.capacity.warning`,
   and `infra.incident.opened`. Every handled event is bracketed by an
   `AgentRun` row (start/end + status), which is the audit trail for "what did
   the agent do, and when".

4. **Agent investigates.** For a firing alert the agent runs LLM triage via
   `core/llm.py` (`complete_json`) and emits an `Alert` (deduplicated by
   fingerprint via `emit_alert`) and an `Incident` row with an AI-drafted root
   cause and remediation. The interactive **alert-chat** surface lets the LLM
   call the allowlisted tools in [05-tools.md](05-tools.md) to dig further.

5. **Read tools auto-run; writes become proposals.** Read tools
   (`get_pod_logs`, `query_prometheus`, …) execute immediately and cannot mutate
   state. A write tool, or a device config change, becomes a **pending
   `ChangeProposal`** — nothing is applied yet.

6. **Human approves.** An operator reviews the proposal (diff + evidence) in the
   UI and clicks Approve, flipping `ChangeProposal.status` to `approved`
   (`core/change_proposals.py::approve`).

7. **Executor applies.** The `sot.execute_approved` beat task
   (`workers/executor.py`, every `executor_period_s`) drains approved rows. It
   runs **only** in the executor process because the task is routed to
   `settings.executor_queue_name`. It calls `change_proposals.execute()`, which
   is the single chokepoint to a live device. Outcome (`executed` / `failed` /
   `stale`) is written back to the row and emitted as `proposal.executed`.

The hard guarantee — that the agent can *propose* but never *apply* — is the
subject of [02-agent-and-guardrails.md](02-agent-and-guardrails.md).

## The module system: `core` vs `modules`

- **`core/`** is the framework: the `Agent` base class and registry
  (`core/agents.py`), the event bus (`core/events.py`), the LLM router
  (`core/llm.py`), the tool layer (`core/kube_tools.py`, `core/cloud_*.py`), the
  device adapters (`core/device/`), the `ChangeProposal` lifecycle
  (`core/change_proposals.py`), and the registries below.
- **`modules/<name>/`** is a vertical feature area. The built-in one is
  `modules/infra/`: `agent.py` (the `InfraAgent`), `prompts.py`,
  `briefing.py`, `tasks.py`, `workflows.py`, and `integrations.py`.

Adding a capability means writing a module and calling the matching registrar at
import time; `workers/celery_app.py` imports the module packages so those
side-effecting registrations take effect. See
[06-extending.md](06-extending.md) for a walkthrough.

## Registries

Everything pluggable is a registry populated at import time:

| Registry | Registrar | Where it lives | Example |
|----------|-----------|----------------|---------|
| Agents | `register_agent(factory)` | `core/agents.py` | `register_agent(InfraAgent)` |
| Integrations | `register_integration(factory)` | `core/integrations.py` | `PrometheusAdapter`, `PagerDutyAdapter`, … in `modules/infra/integrations.py` |
| Briefings | `register_briefing(factory)` | `core/briefings.py` | `InfraBriefingGenerator` in `modules/infra/briefing.py` |
| Workflows | `register_workflow(name, module=...)` | `core/workflows.py` | `infra.incident.coordinate` in `modules/infra/workflows.py` |
| Tools | entries in the `TOOLS` dict | `core/kube_tools.py` | cloud + SoT tools merge in via `tool_specs()` |
| Device adapters | `register_device_adapter(factory)` | `core/device/registry.py` | keyed by `transport` (`linux_ssh`, `eos`, `junos`, `iosxr`, `redfish`) |

Agents and integrations are discoverable in the UI via `list_agents()` /
`list_integrations()`. Device adapters are looked up by transport with
`get_device_adapter(transport)` — that's how the executor decides which adapter
applies a given proposal.

## Data model (audit-relevant rows)

- **`AgentRun`** — one row per event an agent handled, with timing and
  success/error. Written by `Agent._record_run_start/_record_run_end`.
- **`Alert` / `AlertOccurrence`** — deduplicated alerts; re-fires bump an
  occurrence count instead of spawning duplicates (`emit_alert`).
- **`Incident`** — opened on triage, carries the AI root cause / remediation.
- **`ChangeProposal`** — the proposal lifecycle row: `intended_config`,
  `observed_config`, `diff`, `evidence`, `status`, `created_by`, `approved_by`,
  `executed_at`, `executor_result`. This plus `AgentRun` is the complete audit
  trail of what was proposed, who approved it, and what happened on execute.

## Where to go next

- The safety model and why a prompt-injected agent still can't apply changes:
  [02-agent-and-guardrails.md](02-agent-and-guardrails.md).
- The full tool catalog and how to enable each family: [05-tools.md](05-tools.md).
- Pointing inference at your own GPU: [03-llm-and-sovereignty.md](03-llm-and-sovereignty.md).
- Installing and configuring every variable: [04-deployment.md](04-deployment.md).
