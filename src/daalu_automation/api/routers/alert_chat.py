"""Per-alert chat panel + remediation action endpoints.

Surface area:

* ``GET  /alerts/{alert_id}/chat``                       — full transcript.
* ``POST /alerts/{alert_id}/chat``                       — user message → assistant
                                                          reply, possibly with
                                                          tool calls (read auto-run,
                                                          write rows land pending).
* ``POST /alerts/{alert_id}/actions/{action_id}/approve``— execute a pending write.
* ``POST /alerts/{alert_id}/actions/{action_id}/reject`` — drop a pending write.

The LLM transcript replay deliberately rebuilds the message list from
the DB on every turn instead of holding session state in-process — this
way the chat survives pod restarts and is concurrently safe across
replicas.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import asc, select
from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.api.deps import current_tenant_id, current_user
from daalu_automation.api.schemas import (
    AlertActionOut,
    AlertChatMessageOut,
    AlertChatPostRequest,
)
from daalu_automation.core import kube_tools, llm
from daalu_automation.core.llm import LLMUnavailable
from daalu_automation.database import get_db
from daalu_automation.models import (
    ActionStatus,
    Alert,
    AlertAction,
    AlertChatMessage,
    ChatRole,
    User,
)

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/alerts", tags=["alerts"])


SYSTEM_PROMPT = """\
You are the Daalu remediation copilot. The user has opened a specific
alert. Your job is to autonomously investigate, decide the root
cause, and propose a remediation plan — *before* the operator has to
ask anything. You have a small set of kubectl-style tools plus
Prometheus / Loki / arbitrary HTTP tools.

Operating rules:
- Investigate first, conclude second. Begin every new alert by
  pulling: pod logs (current + previous if crashing), pod events,
  describe-pod, and the owning Deployment's status / rollout history
  when the alert references a workload. Pull Prometheus metrics when
  the alert is about latency / saturation / errors.
- Read tools (get_pod_logs, describe_pod, get_pod_events, list_pods,
  get_deployment, rollout_history, query_prometheus, query_loki,
  GET-method call_external_api, plus the cloud read tools listed
  below) run automatically — call as many as you need.

  Cloud read tools (all read-only, all auto-execute):
    AWS    — aws_describe_instances, aws_get_cloudwatch_logs,
             aws_query_cloudwatch_metric, aws_describe_rds_instances,
             aws_describe_lambda
    GCP    — gcp_list_instances, gcp_query_logging,
             gcp_query_monitoring, gcp_describe_sql_instance,
             gcp_describe_function
    Azure  — azure_list_vms, azure_query_log_analytics,
             azure_query_metrics, azure_describe_sql_db,
             azure_describe_function

  Tenants register a cloud connection as an Integration row
  (provider='aws' / 'gcp' / 'azure'). If a tool returns "no AWS
  integration registered" / "no GCP integration registered" / etc.,
  the tenant hasn't connected that provider — say so in Root cause
  and skip that tool, don't keep retrying.
- Write tools (rollout_undo, scale_deployment, restart_deployment,
  delete_pod, patch_resource, non-GET call_external_api) DO NOT run
  automatically — the operator must click Approve. Always propose
  writes with a one-sentence rationale referencing the evidence you
  collected.
- Prefer a [system] step over an [operator] step whenever a write tool
  fits. `patch_resource` covers spec edits the targeted tools don't
  (e.g. adding container capabilities like NET_ADMIN/NET_RAW, tweaking
  resource limits, flipping a configmap key). If you can express the
  fix as a strategic-merge patch, propose it as a [system] step — do
  NOT downgrade it to a manual [operator] step just because it is a
  "manifest change".

Final answer format. The UI renders your final assistant message as
three tiles. You MUST emit EXACTLY these three sections, in this
order, using the exact level-2 headers below. No other top-level
sections. Do NOT add a "Likely operator questions" section or any
self-Q&A — the UI does not render that and it clutters the chat.

    ## Root cause
    One or two sentences. Concrete. Cite the specific log line,
    event reason, metric value, or config key you found.

    ## Background
    Two to four sentences of context the operator may not have.
    What this component normally does, why this kind of failure
    matters, related history if you saw any. Skip if there is
    genuinely nothing useful to say (write "—").

    ## Remediation plan
    A single numbered list covering every step needed to fix the
    alert — both the steps the system can run and the steps the
    operator must do themselves. Tag EVERY step with one of:

      **[system]** — the system will run this when the operator
                     clicks "Approve plan". You MUST also call the
                     matching write tool in this same response so
                     the Approve button has something to fire
                     (`restart_deployment(...)`, `scale_deployment(...)`,
                     `patch_resource(...)`, etc.).

      **[operator]** — the operator must do this themselves. The
                       system cannot do it (e.g. third-party
                       console click, vendor support ticket,
                       physical hardware action, a kubectl call
                       against a cluster the system can't reach).

    Formatting rules for EVERY step (both [system] and [operator]):

      1. Lead with ONE plain-English sentence describing what the
         step does and why ("Patch the cilium-agent DaemonSet to add
         NET_ADMIN and NET_RAW under the container's
         securityContext.capabilities.add, so the agent's eth0 setup
         stops failing"). Plain prose. NO inline `backticks` around
         words inside this sentence. Capability names like NET_ADMIN,
         tool names like delete_pod, pod names like
         octavia-health-manager-default-787mv, container fields like
         securityContext.capabilities.add — all of those go in the
         sentence as plain text, not as inline `code` tokens. The UI
         renders every inline-backtick token as a separate visual
         chip, so peppering the sentence with backticks shatters it
         into unreadable fragments.
      2. Immediately below the sentence, exactly ONE fenced code
         block containing the COMPLETE command — fully self-contained,
         no placeholders, no `<your-namespace>`-style tokens. Use the
         right language tag (`bash`, `sql`, `yaml`, `console`). All
         flags, values, and JSON blobs go inside this one block. If a
         step genuinely needs two alternative commands (e.g. "kubectl
         edit OR helm upgrade"), use ONE fenced block per alternative
         — never split a single command's argv across blocks.
      3. For [operator] steps, also add a `→` line BETWEEN the
         sentence and the code block telling the operator WHERE to
         run it ("→ from your laptop with the customer kubeconfig
         loaded", "→ in the Cloudflare DNS dashboard for daalu.io").
         [system] steps do NOT need a `→` line — the system runs
         them in-cluster on Approve.

    For [system] steps the code block is the kubectl-equivalent of
    the tool call you proposed — so the operator can either Approve
    to have the system run it, OR copy-paste the kubectl command
    and run it themselves. The two are interchangeable; show both.

    CRITICAL — Approve button contract. The Approve button can ONLY
    appear when you emit a `tool_use` block alongside your text in
    the same assistant response. Writing "click Approve" or "return
    here and approve the delete_pod step" in the markdown does NOT
    create a button — the button is wired to the tool_use you
    actually emit. So whenever you write `**[system]**` in a step:

      • You MUST also call the matching write tool (`patch_resource`,
        `delete_pod`, `restart_deployment`, `scale_deployment`,
        `rollout_undo`, or non-GET `call_external_api`) in the SAME
        response.
      • The tool call's arguments must match the kubectl command you
        showed in the fenced code block — same namespace, same name,
        same patch body. They should be two views of the same action.
      • If no tool fits, downgrade the step to [operator] and give
        the operator the command to run themselves. Don't write
        [system] without a tool_use — that produces a plan that
        promises an Approve button that physically cannot render.

    Example shape:

        1. **[system]** Patch the cilium-agent DaemonSet to add the
           NET_ADMIN and NET_RAW capabilities under the container's
           securityContext.capabilities.add, so the agent's eth0
           setup stops failing.
           ```bash
           kubectl patch daemonset cilium -n kube-system --type=strategic -p '{"spec":{"template":{"spec":{"containers":[{"name":"cilium-agent","securityContext":{"capabilities":{"add":["NET_ADMIN","NET_RAW"]}}}]}}}}'
           ```
           (And in the same response, call
           `patch_resource(namespace="kube-system", kind="DaemonSet",
           name="cilium", patch={...same body as above...})`.)
        2. **[system]** Delete the wedged pod cilium-abc12 so the
           controller reschedules a replacement under the new pod
           spec.
           ```bash
           kubectl delete pod cilium-abc12 -n kube-system
           ```
           (And call `delete_pod(namespace="kube-system",
           name="cilium-abc12")` in the same response.)
        3. **[operator]** Drain the affected node before maintenance.
           → run on the customer cluster with kubectl context set to
             daalu-workload.
           ```bash
           kubectl drain cp01 --ignore-daemonsets --delete-emptydir-data
           ```

    Ordering: list steps in the order they should be executed,
    interleaving [system] and [operator] freely. The "Approve plan"
    button only fires the [system] steps' tool calls; operator
    steps stay visible so the operator can copy + run them at the
    right moment in the sequence.

    If the system can fully fix the alert with no operator help,
    every step is **[system]** and you call every matching write
    tool in this same response. If only manual work is possible,
    every step is **[operator]**. Either is fine — but every step
    must carry one of the two tags.

    Default to [system] for the connected cluster. The patch_resource,
    delete_pod, restart_deployment, scale_deployment, and rollout_undo
    tools all run against the cluster this API pod is attached to
    (via the in-cluster ServiceAccount or the tenant's registered
    kubeconfig). Treat that cluster as reachable — do NOT route a
    fix through [operator] just because the alert is on the
    customer's workload cluster. Only choose [operator] when the
    action is genuinely outside the cluster's surface area (DNS
    console click, vendor support ticket, physical hardware, etc.)
    or when no write tool fits.

- Spec-level root causes need spec-level fixes. If your Root cause
  section identifies a problem with a workload's *template* — a
  missing capability, a wrong env var, a tightened resource limit,
  a bad image tag, a broken volumeMount — the plan MUST patch the
  template. Deleting / restarting the pods without patching the
  template is not a fix: the controller schedules a replacement
  under the same broken spec and the alert re-fires within seconds.
  Concretely: never propose `delete_pod` (or `restart_deployment`)
  as the sole remediation when the diagnosis points at a
  capabilities / env / limits / image / volume problem — pair it
  with a `patch_resource` (or `rollout_undo`) that actually
  changes the spec, OR escalate the missing surface area as an
  [operator] step.

- Retry through prior failures. If you see a previous tool_use of
  `patch_resource` (or any write tool) in the transcript that
  failed with `Forbidden` / 403 / RBAC error: re-propose the SAME
  patch_resource in this plan. The operator likely widened the
  remediator's ClusterRole between then and now (that's a common
  fix path — the daalu-remediator-write role). Also add an [operator]
  step at the END of the plan with the kubectl command to widen
  the ClusterRole on the customer cluster, so the operator has
  the one-shot fix in hand if Approve 403s again. Do not silently
  swap the spec fix for a pod bounce.

- Cite specifics from the tool output (a stack trace line, a config
  key, an event reason) — never generalise.
- If you genuinely don't have enough signal to recommend a fix, say
  so in ## Root cause and put a single **[operator]** step in
  ## Remediation plan that gathers the missing signal (e.g.
  "Share the deploy diff from your CI").
- Be concise. Bullets one line each; Background ≤ one paragraph;
  Remediation plan ≤ ~6 steps for most alerts.
"""


TRIAGE_KICKOFF = """\
Triage this alert end-to-end on your own. Use the read tools to
gather diagnostic data, then post a single final assistant message
with EXACTLY three level-2 sections, in this order: Root cause,
Background, Remediation plan.

In the Remediation plan, tag every step as **[system]** or
**[operator]**. Every step is ONE plain-English sentence — no
inline backticks inside the sentence; capability names, tool
names, pod names, and field paths all go as plain words — followed
by exactly ONE fenced code block with the COMPLETE command. Never
split a single command's argv across multiple code blocks.

[system] steps REQUIRE a matching tool_use block in this same
response (patch_resource, delete_pod, restart_deployment,
scale_deployment, rollout_undo, or non-GET call_external_api).
The tool's arguments must match the kubectl command you showed.
Writing "approve the delete_pod step" without emitting a
delete_pod tool_use is broken — the UI's Approve button is wired
to the tool_use, not to the prose. If no write tool fits, the
step is [operator] and you give the operator a runnable command.

Default to [system] for anything the cluster can do — the
write tools run against the connected cluster, so a DaemonSet
patch or a pod delete is firmly [system], not [operator].

If you can see a previous failed `patch_resource` / write call in
the transcript (403, RBAC, Forbidden), re-propose the SAME patch
this round — the operator may have widened the remediator's
ClusterRole since. Don't downgrade a template fix to a pod-bounce
just because last attempt was blocked; the alert will keep firing
until the template is patched.

For [operator] steps add a `→` location line between the sentence
and the code block. Do not write any other sections, and do not
include self-questions / self-answers — the UI renders only these
three tiles.
"""


def _alert_context(alert: Alert) -> str:
    md = alert.metadata_json or {}
    pieces = [
        f"Alert title: {alert.title}",
        f"Severity: {alert.severity.value}",
        f"Module: {alert.module}",
        f"Status: {alert.status.value}",
        f"Fired at: {alert.created_at.isoformat()}",
    ]
    if md:
        # Keep namespace / pod / deployment / cluster hints prominent so
        # the model doesn't have to hunt for them in the body markdown.
        keys = ("namespace", "pod", "deployment", "service", "cluster", "alert_name")
        prominent = {k: md[k] for k in keys if k in md}
        if prominent:
            pieces.append(f"Pinned metadata: {json.dumps(prominent, sort_keys=True)}")
        other = {k: v for k, v in md.items() if k not in keys}
        if other:
            pieces.append(f"Other metadata: {json.dumps(other, sort_keys=True, default=str)}")
    pieces.append("")
    pieces.append(f"Alert body:\n{alert.body}")
    return "\n".join(pieces)


async def _load_chat(
    db: AsyncSession, tenant_id, alert_id: uuid.UUID
) -> tuple[list[AlertChatMessage], dict[uuid.UUID, list[AlertAction]]]:
    msgs = (
        (
            await db.execute(
                select(AlertChatMessage)
                .where(
                    AlertChatMessage.tenant_id == tenant_id,
                    AlertChatMessage.alert_id == alert_id,
                )
                .order_by(asc(AlertChatMessage.created_at))
            )
        )
        .scalars()
        .all()
    )
    actions = (
        (
            await db.execute(
                select(AlertAction)
                .where(
                    AlertAction.tenant_id == tenant_id,
                    AlertAction.alert_id == alert_id,
                )
                .order_by(asc(AlertAction.created_at))
            )
        )
        .scalars()
        .all()
    )
    by_msg: dict[uuid.UUID, list[AlertAction]] = {}
    for a in actions:
        by_msg.setdefault(a.message_id, []).append(a)
    return list(msgs), by_msg


def _serialize(
    msgs: list[AlertChatMessage], actions_by_msg: dict[uuid.UUID, list[AlertAction]]
) -> list[AlertChatMessageOut]:
    out: list[AlertChatMessageOut] = []
    for m in msgs:
        out.append(
            AlertChatMessageOut(
                id=m.id,
                role=m.role.value,
                content=m.content,
                tool_calls_json=list(m.tool_calls_json or []),
                tool_call_id=m.tool_call_id,
                created_at=m.created_at,
                actions=[
                    AlertActionOut.model_validate(a)
                    for a in actions_by_msg.get(m.id, [])
                ],
            )
        )
    return out


async def _get_alert(db: AsyncSession, alert_id: str, tenant_id) -> Alert:
    stmt = select(Alert).where(Alert.id == alert_id, Alert.tenant_id == tenant_id)
    alert = (await db.execute(stmt)).scalar_one_or_none()
    if alert is None:
        raise HTTPException(404, "alert not found")
    return alert


def _messages_for_anthropic(
    msgs: list[AlertChatMessage],
) -> list[dict[str, Any]]:
    """Replay the stored transcript into the shape Anthropic expects.

    Tool calls become assistant messages with ``tool_use`` content
    blocks; tool results become user messages with ``tool_result``
    blocks, matching the API contract.
    """
    out: list[dict[str, Any]] = []
    for m in msgs:
        if m.role is ChatRole.user:
            out.append({"role": "user", "content": m.content})
        elif m.role is ChatRole.assistant:
            blocks: list[dict[str, Any]] = []
            if m.content:
                blocks.append({"type": "text", "text": m.content})
            for tc in m.tool_calls_json or []:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": tc["id"],
                        "name": tc["name"],
                        "input": tc.get("input", {}),
                    }
                )
            if blocks:
                out.append({"role": "assistant", "content": blocks})
        elif m.role is ChatRole.tool:
            out.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": m.tool_call_id or "",
                            "content": m.content,
                        }
                    ],
                }
            )
    return out


def _messages_for_openai(
    msgs: list[AlertChatMessage],
) -> list[dict[str, Any]]:
    """Replay the stored transcript into OpenAI chat-completions shape.

    Assistant tool calls become ``tool_calls`` on the assistant message;
    stored tool results become ``role:"tool"`` messages keyed by
    ``tool_call_id`` — the OpenAI counterpart of
    :func:`_messages_for_anthropic`.

    OpenAI rejects a request where an assistant ``tool_calls`` entry has
    no following ``role:"tool"`` reply. That happens whenever the agent
    proposed a *write* tool that is still awaiting approval (no result
    yet) and the operator then re-triaged. To keep the request valid we
    track which tool_call ids actually have results and synthesize a
    placeholder ``tool`` message for any that don't.
    """
    answered: set[str] = {
        m.tool_call_id for m in msgs if m.role is ChatRole.tool and m.tool_call_id
    }
    out: list[dict[str, Any]] = []
    for m in msgs:
        if m.role is ChatRole.user:
            out.append({"role": "user", "content": m.content})
        elif m.role is ChatRole.assistant:
            entry: dict[str, Any] = {"role": "assistant", "content": m.content or ""}
            tool_calls = [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {
                        "name": tc["name"],
                        "arguments": json.dumps(tc.get("input", {})),
                    },
                }
                for tc in m.tool_calls_json or []
            ]
            if tool_calls:
                entry["tool_calls"] = tool_calls
            out.append(entry)
            # Backfill any tool_call that never got a result so the
            # assistant turn is well-formed for the API.
            for tc in m.tool_calls_json or []:
                if tc["id"] not in answered:
                    out.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": "(no result — action pending approval or not executed)",
                        }
                    )
                    answered.add(tc["id"])
        elif m.role is ChatRole.tool:
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": m.tool_call_id or "",
                    "content": m.content,
                }
            )
    return out


async def _ask_model(
    *, alert: Alert, transcript: list[AlertChatMessage], tenant_id
) -> dict[str, Any]:
    """One model turn for the investigation, served by the LLM router's
    tool-capable path (``llm.chat_with_tools``).

    This used to call the Anthropic SDK directly, which silently went
    offline whenever ``ANTHROPIC_API_KEY`` was unset — even though the
    rest of the platform runs fine on the router's DeepSeek / local-vLLM
    tiers. Now the chat uses the same router as everything else, so it
    works on whatever tier is configured. We normalize the response back
    into the ``{stop_reason, content:[blocks]}`` shape the turn loop
    already understands (text blocks + ``tool_use`` blocks), so nothing
    downstream changes.
    """
    system = f"{SYSTEM_PROMPT}\n\n{_alert_context(alert)}"
    try:
        reply = await llm.chat_with_tools(
            system=system,
            messages=_messages_for_openai(transcript),
            tools=kube_tools.openai_tool_definitions(),
            tenant_id=tenant_id,
            source="infra.alert.triage",
            max_tokens=2048,
        )
    except LLMUnavailable as e:
        logger.warning("alert_chat.llm_unavailable", error=str(e))
        err = str(e).lower()
        if "timed out" in err or "timeout" in err:
            # The tier IS configured and reachable — it just didn't answer in
            # time. Almost always a large model on CPU that can't complete an
            # agentic tool-using turn within the request window. Say that,
            # rather than the misleading "no tier configured".
            text = (
                "The model didn't respond in time. The configured LLM is "
                "reachable but too slow to finish an agentic tool-using turn "
                "within the request window — typical for a large model on CPU. "
                "Point Daalu at a faster endpoint (a GPU-served vLLM model, or "
                "a hosted provider via ANTHROPIC_API_KEY) for live triage. "
                "Acknowledge / Resolve still work."
            )
        else:
            text = (
                "AI copilot is offline — no LLM tier is configured. Set "
                "LLM_API_KEY/LLM_BASE_URL (DeepSeek/OpenAI) or a local vLLM "
                "endpoint to enable remediation chat. The Acknowledge / "
                "Resolve buttons still work."
            )
        return {
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": text}],
        }

    blocks: list[dict[str, Any]] = []
    if reply.get("text"):
        blocks.append({"type": "text", "text": reply["text"]})
    for tc in reply.get("tool_calls", []):
        blocks.append(
            {
                "type": "tool_use",
                "id": tc["id"],
                "name": tc["name"],
                "input": tc.get("arguments", {}),
            }
        )
    # The turn loop continues while the model is still calling tools and
    # stops on a plain text turn — map finish accordingly.
    has_tools = bool(reply.get("tool_calls"))
    return {
        "stop_reason": "tool_use" if has_tools else "end_turn",
        "content": blocks,
    }


async def _record_assistant_turn(
    *,
    db: AsyncSession,
    tenant_id,
    alert: Alert,
) -> None:
    """Loop: ask the model, persist assistant blocks, auto-run read tools,
    persist tool results, ask again. Stops when the model returns
    ``end_turn`` or proposes a write tool (which waits for approval).
    """
    for _ in range(12):  # hard cap to avoid runaway loops
        # Re-read the transcript fresh each iteration so any tool
        # results we just persisted are included.
        msgs, _ = await _load_chat(db, tenant_id, alert.id)
        reply = await _ask_model(alert=alert, transcript=msgs, tenant_id=tenant_id)

        text_parts: list[str] = []
        tool_uses: list[dict[str, Any]] = []
        for block in reply["content"]:
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                tool_uses.append(
                    {
                        "id": block["id"],
                        "name": block["name"],
                        "input": block.get("input", {}),
                    }
                )

        assistant_msg = AlertChatMessage(
            tenant_id=tenant_id,
            alert_id=alert.id,
            role=ChatRole.assistant,
            content="\n".join(p for p in text_parts if p).strip(),
            tool_calls_json=tool_uses,
        )
        db.add(assistant_msg)
        await db.flush()  # populate id

        if not tool_uses:
            await db.commit()
            return

        any_pending_write = False
        for tc in tool_uses:
            requires_approval = kube_tools.tool_requires_approval(
                tc["name"], tc.get("input") or {}
            )
            action = AlertAction(
                tenant_id=tenant_id,
                alert_id=alert.id,
                message_id=assistant_msg.id,
                tool_call_id=tc["id"],
                tool_name=tc["name"],
                tool_input=tc["input"],
                requires_approval=requires_approval,
                status=ActionStatus.pending,
            )
            db.add(action)
            await db.flush()

            if requires_approval:
                any_pending_write = True
                continue

            # Read tool — execute now and persist the tool_result.
            output = await kube_tools.execute_tool(
                tc["name"], tc["input"], tenant_id=tenant_id
            )
            action.status = ActionStatus.executed
            action.executed_at = datetime.now(tz=timezone.utc)
            action.result_output = output
            tool_msg = AlertChatMessage(
                tenant_id=tenant_id,
                alert_id=alert.id,
                role=ChatRole.tool,
                content=output,
                tool_call_id=tc["id"],
            )
            db.add(tool_msg)
            await db.flush()

        await db.commit()

        if any_pending_write or reply.get("stop_reason") == "end_turn":
            return
    logger.warning("alert_chat.loop_cap_hit", alert_id=str(alert.id))


# ── Endpoints ────────────────────────────────────────────────────────────


@router.get("/{alert_id}/chat", response_model=list[AlertChatMessageOut])
async def get_chat(
    alert_id: str,
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
):
    alert = await _get_alert(db, alert_id, tenant_id)
    msgs, actions_by_msg = await _load_chat(db, tenant_id, alert.id)
    return _serialize(msgs, actions_by_msg)


@router.post("/{alert_id}/chat", response_model=list[AlertChatMessageOut])
async def post_chat(
    alert_id: str,
    req: AlertChatPostRequest,
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
    _user: User = Depends(current_user),
):
    alert = await _get_alert(db, alert_id, tenant_id)
    db.add(
        AlertChatMessage(
            tenant_id=tenant_id,
            alert_id=alert.id,
            role=ChatRole.user,
            content=req.content,
        )
    )
    await db.commit()
    await _record_assistant_turn(db=db, tenant_id=tenant_id, alert=alert)
    msgs, actions_by_msg = await _load_chat(db, tenant_id, alert.id)
    return _serialize(msgs, actions_by_msg)


@router.post("/{alert_id}/triage", response_model=list[AlertChatMessageOut])
async def trigger_triage(
    alert_id: str,
    force: bool = False,
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
    _user: User = Depends(current_user),
):
    """Kick off an autonomous triage pass.

    Default behavior is idempotent: if the alert already has any
    assistant message, this is a no-op and we just return the current
    transcript. That keeps the detail page's auto-trigger from
    re-spending a model turn every time you reload the tab.

    Pass ``?force=true`` to always append a fresh kickoff message and
    run a new pass — this is what the "Re-triage" button uses when the
    operator explicitly wants a do-over.
    """
    alert = await _get_alert(db, alert_id, tenant_id)

    should_kickoff = force
    if not should_kickoff:
        existing = (
            await db.execute(
                select(AlertChatMessage)
                .where(
                    AlertChatMessage.tenant_id == tenant_id,
                    AlertChatMessage.alert_id == alert.id,
                    AlertChatMessage.role == ChatRole.assistant,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        should_kickoff = existing is None

    if should_kickoff:
        db.add(
            AlertChatMessage(
                tenant_id=tenant_id,
                alert_id=alert.id,
                role=ChatRole.user,
                content=TRIAGE_KICKOFF,
            )
        )
        await db.commit()
        await _record_assistant_turn(db=db, tenant_id=tenant_id, alert=alert)

    msgs, actions_by_msg = await _load_chat(db, tenant_id, alert.id)
    return _serialize(msgs, actions_by_msg)


@router.post(
    "/{alert_id}/actions/{action_id}/approve",
    response_model=list[AlertChatMessageOut],
)
async def approve_action(
    alert_id: str,
    action_id: str,
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
    user: User = Depends(current_user),
):
    alert = await _get_alert(db, alert_id, tenant_id)
    action = (
        await db.execute(
            select(AlertAction).where(
                AlertAction.id == action_id,
                AlertAction.alert_id == alert.id,
                AlertAction.tenant_id == tenant_id,
            )
        )
    ).scalar_one_or_none()
    if action is None:
        raise HTTPException(404, "action not found")
    if action.status is not ActionStatus.pending:
        raise HTTPException(409, f"action is {action.status.value}, not pending")

    action.status = ActionStatus.approved
    action.approved_by = user.id
    action.approved_at = datetime.now(tz=timezone.utc)
    await db.flush()

    output = await kube_tools.execute_tool(
        action.tool_name, action.tool_input, tenant_id=tenant_id
    )
    is_error = output.startswith("error:")
    action.status = ActionStatus.failed if is_error else ActionStatus.executed
    action.executed_at = datetime.now(tz=timezone.utc)
    if is_error:
        action.result_error = output
    else:
        action.result_output = output

    db.add(
        AlertChatMessage(
            tenant_id=tenant_id,
            alert_id=alert.id,
            role=ChatRole.tool,
            content=output,
            tool_call_id=action.tool_call_id,
        )
    )
    await db.commit()

    # Hand control back to the model so it can react to the result.
    await _record_assistant_turn(db=db, tenant_id=tenant_id, alert=alert)
    msgs, actions_by_msg = await _load_chat(db, tenant_id, alert.id)
    return _serialize(msgs, actions_by_msg)


@router.post(
    "/{alert_id}/actions/{action_id}/reject",
    response_model=list[AlertChatMessageOut],
)
async def reject_action(
    alert_id: str,
    action_id: str,
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
    user: User = Depends(current_user),
):
    alert = await _get_alert(db, alert_id, tenant_id)
    action = (
        await db.execute(
            select(AlertAction).where(
                AlertAction.id == action_id,
                AlertAction.alert_id == alert.id,
                AlertAction.tenant_id == tenant_id,
            )
        )
    ).scalar_one_or_none()
    if action is None:
        raise HTTPException(404, "action not found")
    if action.status is not ActionStatus.pending:
        raise HTTPException(409, f"action is {action.status.value}, not pending")

    action.status = ActionStatus.rejected
    action.approved_by = user.id
    action.approved_at = datetime.now(tz=timezone.utc)
    rejection_note = (
        f"rejected by {user.email}: tool {action.tool_name} not executed"
    )
    db.add(
        AlertChatMessage(
            tenant_id=tenant_id,
            alert_id=alert.id,
            role=ChatRole.tool,
            content=rejection_note,
            tool_call_id=action.tool_call_id,
        )
    )
    await db.commit()
    await _record_assistant_turn(db=db, tenant_id=tenant_id, alert=alert)
    msgs, actions_by_msg = await _load_chat(db, tenant_id, alert.id)
    return _serialize(msgs, actions_by_msg)
