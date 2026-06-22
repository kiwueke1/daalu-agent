"""Event bus — Redis Streams under the hood, but the public surface is a
small set of helpers so we can swap in NATS / Kafka later without
touching the rest of the codebase.

Every operationally interesting change in the system flows through this
bus. Modules emit events with ``publish()`` and run agents that consume
them with ``subscribe()``. The same events get persisted to the
``events`` table so the UI feed can be a simple SQL query.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import structlog

from daalu_automation.config import DEFAULT_TENANT_ID, get_settings

logger = structlog.get_logger(__name__)


@dataclass(slots=True)
class EventEnvelope:
    """The on-the-wire shape of an event.

    Fields are deliberately flat so it round-trips cleanly through Redis
    Streams (which only accept string key/value pairs).
    """

    type: str
    module: str
    source: str
    summary: str
    payload: dict[str, Any] = field(default_factory=dict)
    severity: str = "info"
    tenant_id: str = field(default_factory=lambda: str(DEFAULT_TENANT_ID))
    occurred_at: str = field(
        default_factory=lambda: datetime.now(tz=timezone.utc).isoformat()
    )
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_redis(self) -> dict[str, str]:
        return {
            "event_id": self.event_id,
            "type": self.type,
            "module": self.module,
            "source": self.source,
            "summary": self.summary,
            "severity": self.severity,
            "tenant_id": self.tenant_id,
            "occurred_at": self.occurred_at,
            "payload_json": json.dumps(self.payload),
        }

    @classmethod
    def from_redis(cls, fields: dict[str, str]) -> EventEnvelope:
        return cls(
            event_id=fields.get("event_id", str(uuid.uuid4())),
            type=fields["type"],
            module=fields["module"],
            source=fields["source"],
            summary=fields.get("summary", ""),
            severity=fields.get("severity", "info"),
            tenant_id=fields.get("tenant_id", str(DEFAULT_TENANT_ID)),
            occurred_at=fields.get("occurred_at", datetime.now(tz=timezone.utc).isoformat()),
            payload=json.loads(fields.get("payload_json", "{}")),
        )


# ── Redis connection ─────────────────────────────────────────────────────
# redis.asyncio pins a client's connection pool to the event loop that first
# drives it. The api and agents daemon each run one persistent loop, so a bare
# singleton would be fine for them — but the Celery tasks call ``asyncio.run()``
# once *per tick*, spinning up a fresh loop every time. A client cached on an
# earlier tick is bound to that tick's now-closed loop, so the next tick's reuse
# raises "got Future <...> attached to a different loop" / "Event loop is closed"
# (the same hazard the worker tasks already guard for the asyncpg pool with
# ``engine.dispose()`` — redis was simply missed).
#
# Fix: cache the client against the *running loop*. The same loop reuses it; a
# new loop transparently gets a fresh client and the stale one is dropped for GC
# (it can't be awaited closed — its loop is already gone).
_redis = None
_redis_loop = None


async def _get_redis():
    global _redis, _redis_loop
    loop = asyncio.get_running_loop()
    if _redis is None or _redis_loop is not loop:
        from redis.asyncio import Redis

        settings = get_settings()
        _redis = Redis.from_url(settings.redis_url, decode_responses=True)
        _redis_loop = loop
    return _redis


# ── Remediation step tap (live execution view) ───────────────────────────
# A dedicated, NON-persisted stream the alert "execution log" subscribes to
# over SSE. Kept off the main event bus so granular per-tool steps neither
# pollute the operational feed nor bloat the events table.
REMEDIATION_STREAM_KEY = "daalu.remediation.steps"


async def publish_remediation_step(
    *,
    tenant_id: Any,
    alert_id: Any,
    phase: str,
    text: str = "",
    tool_name: str = "",
    status: str = "",
) -> None:
    """Append one live remediation step to the per-alert execution stream.

    ``phase`` is one of: ``investigate`` (read tool running), ``tool_result``
    (its output), ``propose`` (a write awaiting approval), ``execute`` (an
    approved write running), ``assistant`` (model narration), ``done``.
    Best-effort: a streaming hiccup must never fail the remediation itself.
    """
    try:
        r = await _get_redis()
        await r.xadd(
            REMEDIATION_STREAM_KEY,
            {
                "tenant_id": str(tenant_id),
                "alert_id": str(alert_id),
                "phase": phase,
                "tool_name": tool_name or "",
                "status": status or "",
                "text": (text or "")[:4000],
                "ts": datetime.now(tz=timezone.utc).isoformat(),
            },
            maxlen=5000,
            approximate=True,
        )
    except Exception as e:  # noqa: BLE001 — streaming is best-effort
        logger.warning("remediation_step.publish_failed", error=str(e))


# ── Publish path ─────────────────────────────────────────────────────────
async def publish(event: EventEnvelope, *, persist: bool = True) -> str:
    """Append the event to the Redis stream and (by default) to Postgres.

    Returns the Redis-assigned stream ID so callers can correlate. Persistence
    is opt-out so very high-volume tap events can stay in Redis only.
    """
    settings = get_settings()
    r = await _get_redis()
    stream_id = await r.xadd(settings.event_stream_key, event.to_redis())
    if persist:
        await _persist_event(event)
    logger.debug(
        "event.published",
        type=event.type,
        module=event.module,
        source=event.source,
        stream_id=stream_id,
    )
    return stream_id


async def _persist_event(event: EventEnvelope) -> None:
    """Write the event to Postgres so the UI feed has a queryable history."""
    from daalu_automation.database import AsyncSessionLocal
    from daalu_automation.models import Event, EventSeverity

    async with AsyncSessionLocal() as db:
        db.add(
            Event(
                id=uuid.UUID(event.event_id),
                tenant_id=uuid.UUID(event.tenant_id),
                type=event.type,
                module=event.module,
                source=event.source,
                severity=EventSeverity(event.severity),
                summary=event.summary,
                occurred_at=datetime.fromisoformat(event.occurred_at),
                payload=event.payload,
            )
        )
        await db.commit()


# ── Consume path ─────────────────────────────────────────────────────────
async def subscribe(
    consumer: str,
    *,
    group: str | None = None,
    block_ms: int = 5_000,
    count: int = 32,
) -> AsyncIterator[tuple[str, EventEnvelope]]:
    """Async iterator yielding ``(stream_id, event)`` pairs.

    Uses a Redis consumer group so multiple workers can share the load.
    The group is auto-created on first use.
    """
    settings = get_settings()
    r = await _get_redis()
    group_name = group or settings.event_stream_group
    try:
        await r.xgroup_create(settings.event_stream_key, group_name, id="0", mkstream=True)
    except Exception as e:  # pragma: no cover — BUSYGROUP is fine
        if "BUSYGROUP" not in str(e):
            raise

    while True:
        try:
            resp = await r.xreadgroup(
                group_name,
                consumer,
                streams={settings.event_stream_key: ">"},
                count=count,
                block=block_ms,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("event.read_failed")
            await asyncio.sleep(1)
            continue
        if not resp:
            continue
        for _stream, messages in resp:
            for stream_id, fields in messages:
                try:
                    yield stream_id, EventEnvelope.from_redis(fields)
                    await r.xack(settings.event_stream_key, group_name, stream_id)
                except Exception:
                    logger.exception("event.handler_failed", stream_id=stream_id)
