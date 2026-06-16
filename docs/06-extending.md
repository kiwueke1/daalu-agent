# Extending Daalu

Daalu is built to be extended. A **domain module** bundles the pieces for one
area of operations (the bundled one is `infra`); within a module you add
**agents**, **integration adapters**, **briefings**, and **workflows**. Each
piece registers itself with a core registry at import time, so wiring it up is a
decorator plus one import.

See also: [01-architecture.md](01-architecture.md) (the registries and event
flow), [05-tools.md](05-tools.md) (what tools agents can call).

## The big picture

```
src/daalu_automation/
├── core/                      # reusable primitives + the registries
│   ├── agents.py              # register_agent()      + Agent base class
│   ├── integrations.py        # register_integration() + adapter contract
│   ├── briefings.py           # register_briefing()
│   └── workflows.py           # register_workflow()
└── modules/
    ├── __init__.py            # imports each module package (side-effect = registration)
    └── infra/                 # the bundled Infra/SRE module — copy this shape
        ├── __init__.py        # imports agent/integrations/briefing/tasks/workflows
        ├── agent.py           # the InfraAgent
        ├── integrations.py    # Prometheus / AWS / PagerDuty / … adapters
        ├── briefing.py        # the daily briefing generator
        ├── workflows.py       # multi-step workflows
        └── prompts.py         # the agent's system prompts
```

`import daalu_automation.modules` is the only thing the API/worker bootstrap
calls; every module registers itself transitively. To add a module, create the
package and add one line to `modules/__init__.py`.

## Add a new domain module

```bash
mkdir -p src/daalu_automation/modules/security
```

`modules/security/__init__.py` — import the pieces so their decorators run:

```python
"""Security operations module."""
from daalu_automation.modules.security import agent      # noqa: F401
from daalu_automation.modules.security import integrations  # noqa: F401
```

Then register the module for import in `modules/__init__.py`:

```python
from daalu_automation.modules import infra      # noqa: F401
from daalu_automation.modules import security   # noqa: F401   # <- add this
```

Everything below lives inside your module package.

## Add an agent

An agent subscribes to events and reacts. Subclass `Agent`
(`core/agents.py`), implement `handle`, and register a factory with
`@register_agent`.

```python
from daalu_automation.core.agents import (
    Agent, AgentDescriptor, register_agent, emit_alert, emit_recommendation,
)
from daalu_automation.core.events import EventEnvelope


class SecurityAgent(Agent):
    descriptor = AgentDescriptor(
        name="security-agent",
        module="security",
        description="Triages security findings",
        subscribed_event_types=("security.finding.created",),  # or "*" for the module
    )

    async def handle(self, event: EventEnvelope) -> None:
        # ... reason over event.payload, call tools (see 05-tools.md) ...
        await emit_alert(
            module="security",
            title="Suspicious login",
            body="...",
            severity="warning",
            tenant_id=event.tenant_id,
        )


@register_agent
def _make() -> SecurityAgent:
    return SecurityAgent()
```

The agent loop, run records (`AgentRun`), and the dispatcher are handled for you
by the base class. To make changes to infrastructure, **don't act directly** —
open a `ChangeProposal` so a human approves first. See
[02-agent-and-guardrails.md](02-agent-and-guardrails.md).

## Add an integration adapter

An integration is a typed connection to an external system (a monitoring stack,
a cloud, a ticketing tool). Register it with `register_integration`
(`core/integrations.py`); it then appears in the UI under **Integrations** and
its credentials are stored per the standard config CRUD.

Look at `modules/infra/integrations.py` for complete, real examples
(`PrometheusAdapter`, `AWSCloudWatchAlarmAdapter`, `PagerDutyAdapter`, …): each
declares a provider key, a health probe, and an `ingest`/read method that emits
events the agent consumes. Copy the closest one.

```python
from daalu_automation.core.integrations import register_integration

@register_integration(module="security", provider="my_siem")
class MySiemAdapter:
    async def health(self, config: dict) -> bool: ...
    async def ingest(self, config: dict, tenant_id) -> None: ...
```

## Add a briefing

A briefing generator produces the periodic digest shown on the Reports/Home
surfaces. Register with `@register_briefing` (`core/briefings.py`) and model it on
`modules/infra/briefing.py`. The cadence is a cron in settings
(`DAILY_BRIEFING_CRON`); the beat schedule in `workers/celery_app.py` triggers it.

## Add a workflow

A workflow is a named, multi-step procedure (e.g. "coordinate an incident").
Register with `@register_workflow(name=..., module=...)` (`core/workflows.py`) and
model it on `modules/infra/workflows.py`.

## Wire it into the API (optional)

If your module needs HTTP endpoints, add a router under `api/routers/` and
include it in `api/main.py`'s router list. Most modules don't need this — they
work entirely through events, the agent loop, and the shared alerts/proposals
endpoints.

## Run it

`docker compose up --build` (or restart the `api`, `worker`, and `agents`
services). On startup you'll see your registrations in the logs:

```
agent.registered        module=security name=security-agent
integration.registered  module=security provider=my_siem
```

That confirms the wiring; emit a test event (or POST to `/api/v1/events`) and
watch `docker compose logs -f agents`.
