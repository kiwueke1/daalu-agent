# The agent and its guardrails

This is the document to read first if you are a skeptical infra engineer. The
short version: **Daalu's agent can investigate freely and propose changes, but
it cannot apply a change to anything. Only a human approval followed by a
separate, narrowly-scoped executor process can.** This page explains exactly how
that is enforced in code — not by convention, but by structural barriers that a
prompt-injected or buggy agent cannot route around.

See also: [01-architecture.md](01-architecture.md), [05-tools.md](05-tools.md),
[04-deployment.md](04-deployment.md).

## The four barriers

There are four independent gates between "the LLM wants to change something" and
"a device changed". Each one alone is sufficient to stop an unapproved change;
together they are defense in depth.

1. **Tool tiers** — write tools never execute inline; they are recorded as
   pending approvals (`core/kube_tools.py`).
2. **The `ChangeProposal` lifecycle** — a change only exists as a row that must
   be explicitly `approved` by a human (`core/change_proposals.py`).
3. **The execute() identity + freshness gate** — `execute()` refuses to call a
   device unless the caller is an executor-scoped actor, the row is `approved`,
   and the re-rendered intent still matches the snapshot.
4. **The executor's own Celery queue** — only the executor process is subscribed
   to the queue the execute task runs on, so a mis-deployed worker physically
   cannot pick the job up (`workers/celery_app.py`, `workers/executor.py`).

## Barrier 1 — read vs write tool tiers

`core/kube_tools.py` exposes an allowlist of kubectl-style operations in two
tiers:

- **Read tools** auto-run whenever the LLM calls them; they cannot mutate
  cluster state:
  `get_pod_logs`, `describe_pod`, `get_pod_events`, `list_pods`,
  `get_deployment`, `rollout_history` (plus `query_prometheus`, `query_loki`,
  and the read-only cloud tools).
- **Write tools** are *recorded* and surfaced to the operator; nothing runs
  until the operator clicks Approve:
  `rollout_undo`, `scale_deployment`, `restart_deployment`, `delete_pod`,
  `patch_resource`.

The set of gated names is explicit in the module:

```python
_WRITE_TOOLS = {
    "rollout_undo",
    "scale_deployment",
    "restart_deployment",
    "delete_pod",
    "patch_resource",
}
```

The decision is centralized in `tool_requires_approval(name, tool_input)`. A
`ToolSpec` with `requires_approval=True` always gates. `call_external_api`
additionally gates whenever the HTTP method is anything other than `GET` — write
verbs are operator-gated just like kubectl writes. There is no code path that
runs a write tool inline; the call lands as a pending action for the operator.

This tier is the chokepoint for the *cluster* tools. For *device* configuration
(Linux hosts, network gear, BMCs) the chokepoint is the `ChangeProposal`
lifecycle below.

## Barrier 2 — the ChangeProposal lifecycle

`core/change_proposals.py` is the service layer for every change to a managed
device. A proposal moves through an explicit status machine:

```
 propose()  ─────────────►  pending
                              │  approve()          reject()
                              ▼                        │
                           approved ──► execute() ──►  ▼
                              │            │        rejected
                              │            ├──► executed
                              │            ├──► failed
                              ▼            └──► stale  (intent drifted)
                            stale  (mark_stale / drift on execute)
```

- `propose()` may be called by anyone — the engine, the reconciler, an importer,
  or a human via the UI. Creating a proposal is *not* authorization; it is a
  request. It records `intended_config`, `observed_config`, `diff`, `evidence`,
  `renderer_version`, and `created_by`.
- `approve()` / `reject()` are the human decision. They lock the row
  (`with_for_update()`), refuse unless it is `pending`, and stamp `approved_by` /
  `approved_at`. This is the one and only authorization step a human performs.
- `mark_stale()` records that a proposal is no longer applicable.
- `execute()` is the only function that touches a device — covered next.

Every transition publishes an event (`proposal.created`, `proposal.approved`,
`proposal.rejected`, `proposal.executed`) so the timeline is observable.

## Barrier 3 — why execute() is the crown jewel

The module docstring states the hard architectural constraint plainly:

> `execute()` is the only function in the codebase that calls
> `DeviceAdapter.execute`, and it refuses to do so unless
> (1) `actor.kind == "executor"` AND `actor.scope == settings.executor_jwt_scope`,
> (2) `proposal.status == "approved"`, and
> (3) the freshly-rendered intended config matches the snapshot taken at
> proposal time.

The identity check is the first thing `execute()` does:

```python
settings = get_settings()
if actor.kind != "executor" or actor.scope != settings.executor_jwt_scope:
    raise PermissionError(
        "change_proposals.execute requires an executor-scoped actor"
    )
```

This is what makes **prompt injection on the agent harmless** for execution. The
agent runs with a *user-scoped* identity. The LLM can be tricked into calling
any tool, drafting any proposal, even drafting a proposal that "approves itself"
in its text — but it cannot manufacture an `Actor` with `kind == "executor"` and
the matching `scope`, because that scope lives on the executor process's
environment (`settings.executor_jwt_scope`, default `"executor"`), not in the
agent's session. The scopes are deliberately **disjoint**: user JWTs (which the
engine mints) and executor JWTs never overlap, so a compromised or confused
agent session simply lacks the credential `execute()` demands. From the comment
on the setting in `config.py`:

> `ChangeProposal.execute()` refuses any actor whose scope doesn't match — that's
> the gate that keeps the engine (which mints user-scope tokens) from ever
> pushing config to a device. Disjoint from user JWTs so prompt-injection on the
> LLM agent cannot smuggle execute-rights into its own session.

The status check is second: a row that is not `approved` is rejected with
`ProposalStatusError`. The agent cannot approve its own proposal — approval is a
separate human action (Barrier 2) under a row lock.

The **freshness / snapshot** check is third and subtle. `execute()` does not push
the bytes captured at propose time. It re-reads intent from the source of truth,
re-renders it through the adapter, and compares the fresh render to the snapshot
stored on the row:

```python
fresh = await adapter.render(intended.facts)
fresh_blob = _serialize_files(fresh.files)
if fresh_blob != row.intended_config:
    row.status = ChangeProposalStatus.stale
    ...
    raise StaleProposalError("intended config changed since proposal")
```

If anything about the intended state changed between propose and execute — a
human edited the SoT, a renderer was upgraded, the device was decommissioned —
the proposal is flipped to `stale` and **not** applied. An approval is consent to
apply *a specific reviewed change*, not a standing license to push whatever the
SoT says later. Only after all three checks pass does `execute()` call
`adapter.execute(creds, fresh)` — the single line in the codebase that mutates a
device.

`DeviceAdapter` (`core/device/base.py`) reinforces this at the type level: every
adapter exposes `execute()`, but the base class docstring states that **nothing
outside `change_proposals.execute()` may call it**. You can grep the codebase
for `adapter.execute` / `.execute(creds` to verify there is exactly one caller.

(The imperative server-lifecycle path, `execute_provision()`, applies the same
identity + status invariants with an observed-state compare instead of the
render-drift compare. It is the same gate, shaped for a different change kind.)

## Barrier 4 — the executor's dedicated Celery queue

Even with the identity gate, you want it to be *impossible* for an ordinary
worker to ever run the execute task. That is enforced by Celery routing in
`workers/celery_app.py`:

```python
celery_app.conf.task_routes = {
    "sot.execute_approved": {"queue": settings.executor_queue_name},
}
```

The main worker pool (`daalu worker`) consumes only the default `celery` queue.
The execute task is routed to `settings.executor_queue_name` (default
`"executor"`). As the comment puts it:

> The main worker pool — which consumes the default "celery" queue — physically
> cannot pick it up. That makes "is this pod the executor?" a question of Celery
> subscription, not just env var, and means an accidentally mis-deployed worker
> can't smuggle execute-rights into its own pod.

`workers/executor.py` documents the matching deployment posture: the executor
runs as its own process (in Kubernetes, the `daalu-executor` Deployment with its
own ServiceAccount), it is the only thing whose env carries the executor scope,
and it is kept at **replica 1** — extra replicas would create competing executor
identities racing on the same approved rows; throughput is scaled with
`--concurrency=N` inside the one process instead. The executor constructs the
executor-scoped `Actor` itself:

```python
actor = Actor(kind="executor", scope=settings.executor_jwt_scope, name="executor-worker")
```

so the only place that legitimate executor identity is ever minted is inside the
process that owns the dedicated queue.

## Audit trail

Two row types record the full history:

- **`AgentRun`** — one row per event an agent handled, with `started_at`,
  `finished_at`, `status`, and `error_message`
  (`core/agents.py::_record_run_start/_record_run_end`). This answers "what did
  the agent look at, and did it succeed?".
- **`ChangeProposal`** — the change itself: who created it (`created_by`), the
  reviewed `diff` and `evidence`, who approved it (`approved_by`,
  `approved_at`), when it executed (`executed_at`), and the adapter's
  `executor_result` (including `success`, `rollback_performed`, and any error).

Together they answer the question an auditor actually asks: *who approved this
change, what exactly was approved, and what happened when it ran.* Nothing
reaches a device without a `ChangeProposal` row in `executed`/`failed` state,
and that row names the human who approved it.

## Threat model summary

| Threat | Why it fails |
|--------|--------------|
| Prompt injection tells the agent to "apply this now" | The agent has no executor scope; `execute()` raises `PermissionError`. Best case the LLM creates a `pending` proposal a human still has to approve. |
| Agent drafts and "approves" its own proposal | Approval is a separate, human, lock-guarded transition; the agent's identity can't call it with effect. |
| A bug deploys the execute task to an ordinary worker | The task is routed to a dedicated queue that ordinary workers don't subscribe to. |
| Intent drifts between approval and execute | The snapshot freshness check flips the row to `stale` and refuses to push. |
| Someone bypasses the lifecycle and calls an adapter directly | Only `change_proposals.execute()` calls `DeviceAdapter.execute()`; the base class documents this and it is greppably the single call site. |

## Where to go next

- The catalog of tools and which tier each is in: [05-tools.md](05-tools.md).
- How the pieces connect end to end: [01-architecture.md](01-architecture.md).
- Configuring the executor scope and cadence: [04-deployment.md](04-deployment.md)
  (`EXECUTOR_JWT_SCOPE`, `EXECUTOR_QUEUE_NAME`, `EXECUTOR_PERIOD_S`).
