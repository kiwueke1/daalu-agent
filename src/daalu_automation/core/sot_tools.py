"""LLM-callable tools that interact with the Source of Truth.

Currently just one: :func:`_propose_change`. The engine emits a
``propose_change`` tool call during an alert investigation; the
handler renders the desired Linux facts via the device adapter,
captures the LLM's reasoning + evidence on the proposal row, and
writes a ``pending`` ``ChangeProposal``.

``requires_approval`` is **False** — not because the change is safe,
but because the ChangeProposal *is* the approval surface. The operator
approves the proposal in the dedicated Proposals UI, not in the
alert-chat action card.  Double-gating would make the chat card claim
authority it doesn't have (its approve button would not execute the
push — only flipping the proposal to ``approved`` does that, and the
executor is the only thing that can push).
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from daalu_automation.config import get_settings
from daalu_automation.core.sot.models import LinuxFacts

logger = logging.getLogger(__name__)


PROPOSE_CHANGE_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "device_id": {
            "type": "string",
            "description": (
                "Nautobot device UUID. Look it up via list_devices / "
                "the SoT before calling this tool — do not invent IDs."
            ),
        },
        "intended_facts": {
            "type": "object",
            "description": (
                "The desired LinuxFacts to converge the device toward. "
                "Schema matches the LinuxFacts model: hostname (str), "
                "authorized_keys (list of {user, key}), sysctl (list of "
                "{name, value}), packages (list of {name, state}), "
                "cloud_init ({content}). Omit any fact you don't intend "
                "to manage — only the keys you set will be diffed."
            ),
            "properties": {
                "hostname": {"type": "string"},
                "authorized_keys": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "user": {"type": "string"},
                            "key": {"type": "string"},
                        },
                        "required": ["user", "key"],
                    },
                },
                "sysctl": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "value": {"type": "string"},
                        },
                        "required": ["name", "value"],
                    },
                },
                "packages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "state": {
                                "type": "string",
                                "enum": ["present", "absent"],
                            },
                        },
                        "required": ["name"],
                    },
                },
                "cloud_init": {
                    "type": "object",
                    "properties": {"content": {"type": "string"}},
                },
            },
        },
        "llm_reasoning": {
            "type": "string",
            "description": (
                "1–3 sentence explanation of why this change is being "
                "proposed. Surfaced verbatim to the operator on the "
                "approval card — this is the single most important "
                "argument for the approver."
            ),
        },
        "evidence_event_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "UUIDs of Event rows that motivated the change. The UI "
                "renders these as clickable links back into the events "
                "stream."
            ),
        },
        "evidence_alert_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": "UUIDs of Alert rows related to this proposal.",
        },
        "evidence_metrics": {
            "type": "array",
            "items": {"type": "object"},
            "description": (
                "Metric samples or queries that motivated the change. "
                "Free-form dicts — typical shape: "
                "{name, value, ts, source}."
            ),
        },
        "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": (
                "Self-reported confidence in this proposal (0–1). Helps "
                "the operator triage a long approval queue."
            ),
        },
    },
    "required": ["device_id", "intended_facts", "llm_reasoning"],
}


async def _propose_change(
    *,
    device_id: str,
    intended_facts: dict[str, Any],
    llm_reasoning: str,
    evidence_event_ids: list[str] | None = None,
    evidence_alert_ids: list[str] | None = None,
    evidence_metrics: list[dict[str, Any]] | None = None,
    confidence: float | None = None,
    _tenant_id: uuid.UUID | None = None,
) -> str:
    """Author a pending :class:`ChangeProposal` for operator approval.

    Looks the device up on the SoT, renders both the current intent
    (for the observed-config snapshot baseline) and the proposed intent
    (for the intended-config snapshot the executor will compare against
    at execute time), computes a unified diff, and writes the row with
    ``kind="manual"`` and ``Actor(kind="engine", name="infra-agent")``.

    The full ``llm_reasoning`` + evidence go onto ``ChangeProposal.evidence``
    so the approval UI can render the model's argument directly. Returns
    a short confirmation containing the new proposal ID; the operator
    approves via the Proposals page, not via the alert chat.
    """
    # Imports inside the function body — the alert chat module imports
    # this file at startup, before the DB engine / Anthropic client are
    # configured. Lazy-import keeps test-time fixtures (which patch
    # env before importing daalu_automation modules) authoritative.
    from daalu_automation.core import change_proposals as cps
    from daalu_automation.core.device import get_device_adapter
    from daalu_automation.core.sot import NautobotSoT, NautobotUnavailable
    from daalu_automation.core.sot.models import Actor
    from daalu_automation.database import AsyncSessionLocal
    from daalu_automation.models import ChangeProposalKind

    if _tenant_id is None:
        return "error: tenant context missing for propose_change"

    try:
        facts = LinuxFacts(**intended_facts)
    except Exception as e:  # noqa: BLE001 — pydantic raises ValidationError; surface to LLM
        return f"error: intended_facts did not match LinuxFacts schema — {e}"

    if not (llm_reasoning or "").strip():
        return "error: llm_reasoning is required (the approver reads it)"

    sot = NautobotSoT()
    async with AsyncSessionLocal() as db:
        try:
            device = await sot.get_device(db, _tenant_id, device_id)
        except NautobotUnavailable as e:
            return f"error: nautobot not reachable — {e}"
        if device is None:
            return f"error: device {device_id!r} not found in this tenant's SoT"

        try:
            adapter = get_device_adapter(device.transport)
        except KeyError:
            return (
                f"error: no adapter registered for device transport "
                f"{device.transport!r} — supported transports are linux_ssh"
            )

        rendered_intended = await adapter.render(facts)
        intended_text = cps.serialize_rendered_files(rendered_intended.files)

        # Diff baseline: what the SoT *currently* intends. This is what
        # the operator sees as "observed_config" on the proposal — not a
        # live device read, but the canonical prior state the model
        # wants to change. The drift reconciler is the path that
        # compares to actual device state.
        try:
            current_intent = await sot.get_intended_config(db, _tenant_id, device_id)
        except NautobotUnavailable:
            current_intent = None

        if current_intent is not None:
            rendered_current = await adapter.render(current_intent.facts)
            observed_text = cps.serialize_rendered_files(rendered_current.files)
            cdiff = await adapter.diff(current_intent.facts, facts)
            diff_text = cdiff.unified_diff if cdiff.has_changes else ""
        else:
            # First-time intent for this device — there's nothing to
            # diff against. Show the whole rendered config as the diff
            # so the operator sees what will be written.
            observed_text = ""
            diff_text = intended_text

        settings = get_settings()
        evidence_payload: dict[str, Any] = {
            "triggered_by": "engine",
            "llm_reasoning": llm_reasoning,
            "llm_model": settings.anthropic_model or None,
            "evidence_events": [str(e) for e in (evidence_event_ids or [])],
            "evidence_alerts": [str(a) for a in (evidence_alert_ids or [])],
            # evidence_metrics stays free-form (list[dict]) per the
            # sot-pr2-decisions memo — typing it here adds schema work
            # without changing what reviewers actually see.
            "evidence_metrics": list(evidence_metrics or []),
        }
        if confidence is not None:
            evidence_payload["confidence"] = float(confidence)
        evidence_payload["proposed_at"] = datetime.now(tz=timezone.utc).isoformat()

        row = await cps.propose(
            db,
            _tenant_id,
            device_id=device_id,
            kind=ChangeProposalKind.manual,
            intended_config=intended_text,
            observed_config=observed_text,
            diff=diff_text,
            renderer_version=rendered_intended.renderer_version,
            evidence=evidence_payload,
            actor=Actor(kind="engine", name="infra-agent"),
        )

    return (
        f"Created ChangeProposal {row.id} for device {device.name} "
        f"({device_id}). Status: pending. The operator must approve "
        f"this proposal via the Proposals UI before the executor will "
        f"push to the device."
    )


def tool_specs() -> dict[str, dict[str, Any]]:
    """Return SoT tool specs in the same shape ``cloud_*.tool_specs()`` does.

    The kube_tools registry merges these in via ``_register_sot_tools()``
    so the alert-chat surface (``anthropic_tool_definitions``,
    ``execute_tool``, ``tool_requires_approval``) sees them as plain
    tools without special-casing.
    """
    return {
        "propose_change": {
            "description": (
                "Author a ChangeProposal that captures the desired "
                "LinuxFacts state for a device, the reasoning behind "
                "the change, and the supporting evidence. The proposal "
                "lands in `pending` status; an operator approves it in "
                "the Proposals UI, and the executor service is the only "
                "thing that can then push it to the device. Use this "
                "whenever an alert investigation concludes that a "
                "managed device's config should be changed — never try "
                "to push directly via call_external_api or any other "
                "tool."
            ),
            "input_schema": PROPOSE_CHANGE_INPUT_SCHEMA,
            "handler": _propose_change,
            "requires_approval": False,
        },
    }
