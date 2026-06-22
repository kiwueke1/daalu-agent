"""Daalu Automation CLI — management commands.

Usage:
  daalu server         -- run the API
  daalu worker         -- run the celery worker
  daalu beat           -- run the celery beat scheduler
  daalu agents         -- run the long-running agent host
  daalu executor       -- run the executor worker (executor queue only)
  daalu migrate        -- idempotent DB bootstrap + alembic upgrade
  daalu seed           -- create the default tenant + admin user
  daalu seed-demo      -- generate a wave of synthetic events for demos
  daalu briefing <ch>  -- generate a briefing now
  daalu ingest <prov>  -- trigger an integration ingestion run
"""

from __future__ import annotations

import asyncio

import typer
from rich.console import Console

app = typer.Typer(help="Daalu Automation management CLI")
console = Console()


@app.command()
def server(
    host: str = "127.0.0.1",
    port: int = 8000,
    reload: bool = False,
    mode: str = "hub",
) -> None:
    """Start the FastAPI server.

    Binds to ``127.0.0.1`` by default so a fresh install is not exposed
    on the network with authentication disabled (``LOCAL_NO_AUTH=true``).
    To serve other hosts, put it behind an authenticating reverse proxy
    and pass ``--host 0.0.0.0`` explicitly (see docs/04-deployment.md §1.6).

    ``--mode=hub`` (default) — the full daalu-api on the Daalu hub.

    ``--mode=edge`` — the per-tenant edge data plane for Daalu
    Private (full sovereignty). Runs in the daalu-edge-data pod on
    the customer's cluster; serves tenant-scoped CRUD from the
    customer's local Postgres.
    """
    import os

    import uvicorn

    if mode not in ("hub", "edge"):
        raise typer.BadParameter(f"mode must be 'hub' or 'edge', got {mode!r}")
    # Make the mode visible to create_app() since uvicorn imports the
    # module by string and the factory has to know the mode at app-
    # construction time.
    os.environ["DAALU_MODE"] = mode
    uvicorn.run(
        "daalu_automation.api.main:app", host=host, port=port, reload=reload
    )


@app.command()
def worker(concurrency: int = 4, loglevel: str = "INFO") -> None:
    """Start a Celery worker."""
    from daalu_automation.workers.celery_app import celery_app

    celery_app.worker_main(
        argv=["worker", f"--concurrency={concurrency}", f"--loglevel={loglevel}"]
    )


@app.command()
def beat(loglevel: str = "INFO") -> None:
    """Start the Celery beat scheduler."""
    from daalu_automation.workers.celery_app import celery_app

    celery_app.start(argv=["beat", f"--loglevel={loglevel}"])


@app.command()
def agents(mode: str = "hub") -> None:
    """Run the agent host.

    ``--mode=hub`` (default) — agents run on the operator's hub for
    every tenant that doesn't have ``edge_agents_enabled``. This is
    how the daalu-agents Deployment in the hub cluster has always
    behaved.

    ``--mode=edge`` — Daalu Private edge-side mode. The pod runs
    inside the customer's cluster (``daalu-edge`` chart with
    ``agents.enabled=true``); it polls the hub's internal API for
    *only* the tenant it was provisioned for and runs the loop
    locally.

    Phase 1: ``--mode=edge`` is accepted by the CLI so the chart can
    deploy and the wiring is end-to-end; the runner currently
    behaves the same in both modes. Per-tenant gating + the
    long-poll path land in Phase 2.
    """
    if mode not in ("hub", "edge"):
        raise typer.BadParameter(f"mode must be 'hub' or 'edge', got {mode!r}")
    from daalu_automation.workers.agent_runner import main

    main(mode=mode)


@app.command(name="nautobot-controller")
def nautobot_controller(host: str = "0.0.0.0", port: int = 8082) -> None:
    """Start the nautobot-controller (per-tenant Nautobot lifecycle).

    Reconciles ``nautobot_tenants`` rows into per-tenant Nautobot
    stacks in either the operator's cluster (default) or the
    customer's federated cluster (when target_cluster_tunnel_id is
    set on the row).
    """
    import uvicorn

    uvicorn.run(
        "daalu_automation.nautobot_controller.app:app",
        host=host,
        port=port,
        reload=False,
    )


@app.command(name="config-manager-controller")
def config_manager_controller(host: str = "0.0.0.0", port: int = 8083) -> None:
    """Start the config-manager-controller (per-tenant NV-CM lifecycle).

    Reconciles ``config_manager_tenants`` rows into per-tenant NVIDIA
    Config Manager Helm releases in either the operator's cluster
    (default) or the customer's federated cluster (when
    target_cluster_tunnel_id is set on the row). Unlike the
    nautobot-controller it runs ``helm upgrade --install`` of the
    vendored pinned chart, so the image must ship the ``helm`` binary
    and ``deploy/charts/`` (see Dockerfile).
    """
    import uvicorn

    # The app is built by a factory (no module-level singleton), so the
    # reconcile-loop startup hook fires once per process.
    uvicorn.run(
        "daalu_automation.config_manager_controller.app:create_app",
        host=host,
        port=port,
        reload=False,
        factory=True,
    )


@app.command()
def executor(concurrency: int = 2, loglevel: str = "INFO") -> None:
    """Start a Celery worker dedicated to the executor queue.

    Subscribes only to the queue named by ``settings.executor_queue_name``
    so this process is the only thing that can run
    ``sot.execute_approved`` — the task that calls
    ``change_proposals.execute()`` and therefore pushes config to real
    devices. Run this from the ``daalu-executor`` k8s Deployment, which
    carries the executor-scoped JWT in its env.
    """
    from daalu_automation.config import get_settings
    from daalu_automation.workers.celery_app import celery_app

    queue = get_settings().executor_queue_name
    celery_app.worker_main(
        argv=[
            "worker",
            f"--concurrency={concurrency}",
            f"--loglevel={loglevel}",
            f"--queues={queue}",
            "--hostname=executor@%h",
        ]
    )


@app.command()
def migrate() -> None:
    """Idempotent DB bootstrap + alembic upgrade.

    If the ``alembic_version`` table is missing — i.e. this is a freshly
    provisioned database — creates every table from SQLAlchemy metadata
    and stamps the migration chain at ``head``. No incremental
    migrations are run in that case because there is no pre-existing
    schema for them to alter.

    Otherwise runs ``alembic upgrade head`` normally so existing
    clusters pick up new migrations on every deploy.

    The API + workers init container shells to this command rather than
    raw ``alembic upgrade head`` so that a recreated namespace (e.g. an
    accidental Argo prune) can re-bootstrap without an out-of-band
    ``Base.metadata.create_all`` step. The pre-existing migration
    0001_multi_tenancy starts with ``op.add_column("tenants", …)``,
    which would fail on an empty DB.
    """
    import os

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect

    sync_url = os.environ.get("DATABASE_SYNC_URL")
    if not sync_url:
        console.print(
            "[red]DATABASE_SYNC_URL is not set[/]; alembic needs a sync driver URL "
            "(use the postgresql:// scheme, not postgresql+asyncpg://)."
        )
        raise typer.Exit(1)

    engine = create_engine(sync_url)
    try:
        with engine.connect() as conn:
            has_alembic_version = inspect(conn).has_table("alembic_version")
    finally:
        engine.dispose()

    cfg = Config("alembic.ini")

    if has_alembic_version:
        console.print("[dim]alembic_version present → alembic upgrade head[/]")
        command.upgrade(cfg, "head")
        console.print("[green]upgraded[/]")
        return

    console.print(
        "[yellow]alembic_version missing → fresh DB. "
        "Running Base.metadata.create_all + alembic stamp head.[/]"
    )
    # Side-effect imports ensure every model + module-registered model
    # is bound to Base.metadata before we call create_all. Without these
    # imports the metadata set on a fresh process only contains models
    # that other parts of `daalu_automation.__init__` happen to pull in.
    import daalu_automation.models  # noqa: F401
    import daalu_automation.modules  # noqa: F401
    from daalu_automation.database import Base

    Base.metadata.create_all(engine)
    command.stamp(cfg, "head")
    console.print("[green]Fresh DB initialized + stamped at head[/]")


@app.command()
def seed() -> None:
    """Create the default tenant + admin user."""
    asyncio.run(_seed())


async def _seed() -> None:
    from sqlalchemy import select

    from daalu_automation.config import DEFAULT_TENANT_ID
    from daalu_automation.database import AsyncSessionLocal, create_tables
    from daalu_automation.models import Tenant

    await create_tables()
    async with AsyncSessionLocal() as db:
        existing = (
            await db.execute(select(Tenant).where(Tenant.id == DEFAULT_TENANT_ID))
        ).scalar_one_or_none()
        if existing is None:
            db.add(Tenant(id=DEFAULT_TENANT_ID, name="Default", slug="default"))
            await db.commit()
            console.print("[green]Default tenant created.[/green]")
        else:
            console.print("[yellow]Default tenant already exists.[/yellow]")

    # Pricing catalog — idempotent. Run as part of every `daalu seed` so a
    # fresh install lands on the Local-First plan and the /billing page
    # has something to show.
    await _seed_skus()


@app.command(name="seed-skus")
def seed_skus() -> None:
    """Create / update the default SKU catalog. Idempotent."""
    asyncio.run(_seed_skus())


async def _seed_skus() -> None:
    """Insert the four default SKUs and pin the default tenant to Local-First.

    The rates are illustrative — production deploys can edit them via
    direct SQL or a future admin UI. They are picked so the unit
    economics line up: the local tier is
    priced an order of magnitude under the external classifier, which
    is itself an order of magnitude under Anthropic's quality tier.
    """
    from datetime import datetime, timezone

    from sqlalchemy import select

    from daalu_automation.config import DEFAULT_TENANT_ID
    from daalu_automation.database import AsyncSessionLocal, create_tables
    from daalu_automation.models import Sku, TenantSku
    from daalu_automation.models.billing import RoutingPolicy

    await create_tables()

    catalog = [
        {
            "slug": "local-first",
            "name": "Local-First",
            "tagline": "Your home GPU runs the hot path. Anthropic for the hard prompts.",
            "description": (
                "Classifier-tier traffic (alert triage, log "
                "classification, embeddings) routes to the local "
                "vLLM you operate on your own card. Quality-tier prompts "
                "(briefings, deep reasoning) route to Anthropic. Cheapest "
                "unit economics; the home GPU pays for itself in weeks."
            ),
            "routing_policy": RoutingPolicy.LOCAL_FIRST,
            "monthly_base_usd": 49.0,
            "included_events_per_month": 50_000,
            "price_local_in_per_mtok": 0.10,
            "price_local_out_per_mtok": 0.40,
            "price_external_classifier_in_per_mtok": 0.60,
            "price_external_classifier_out_per_mtok": 2.40,
            "price_external_quality_in_per_mtok": 3.00,
            "price_external_quality_out_per_mtok": 15.00,
            "monthly_soft_cap_usd": 0,
            "display_order": 10,
        },
        {
            "slug": "hybrid",
            "name": "Hybrid",
            "tagline": "Tries local first for everything; external on miss.",
            "description": (
                "Both classifier and quality calls try the local GPU "
                "first when a model fits, falling back to Anthropic / "
                "external classifier on miss or failure. Best mix of "
                "quality and cost once a 48 GB card joins the pool."
            ),
            "routing_policy": RoutingPolicy.HYBRID,
            "monthly_base_usd": 99.0,
            "included_events_per_month": 25_000,
            "price_local_in_per_mtok": 0.20,
            "price_local_out_per_mtok": 0.80,
            "price_external_classifier_in_per_mtok": 0.60,
            "price_external_classifier_out_per_mtok": 2.40,
            "price_external_quality_in_per_mtok": 3.00,
            "price_external_quality_out_per_mtok": 15.00,
            "monthly_soft_cap_usd": 0,
            "display_order": 20,
        },
        {
            "slug": "external-only",
            "name": "External-Only",
            "tagline": "No data crosses the operator's GPU. Anthropic + DeepSeek only.",
            "description": (
                "For tenants with data-residency clauses that forbid "
                "traffic through any Daalu-operated hardware. Every "
                "call routes to Anthropic (quality) or the configured "
                "OpenAI-compatible endpoint (classifier). Higher base "
                "fee, no local price benefit."
            ),
            "routing_policy": RoutingPolicy.EXTERNAL_ONLY,
            "monthly_base_usd": 149.0,
            "included_events_per_month": 20_000,
            "price_local_in_per_mtok": 0.0,
            "price_local_out_per_mtok": 0.0,
            "price_external_classifier_in_per_mtok": 0.80,
            "price_external_classifier_out_per_mtok": 3.20,
            "price_external_quality_in_per_mtok": 3.50,
            "price_external_quality_out_per_mtok": 17.00,
            "monthly_soft_cap_usd": 0,
            "display_order": 30,
        },
        {
            "slug": "sovereign",
            "name": "Sovereign",
            "tagline": "Bring your own GPU. Flat fee, no per-event metering.",
            "description": (
                "Daalu federates into your Kubernetes cluster as a "
                "remote control plane; your hardware serves every "
                "call. We charge a flat licence; we never see your "
                "data. Federation rollout is staged — talk to us."
            ),
            "routing_policy": RoutingPolicy.SOVEREIGN,
            "monthly_base_usd": 500.0,
            "included_events_per_month": 0,
            "price_local_in_per_mtok": 0.0,
            "price_local_out_per_mtok": 0.0,
            "price_external_classifier_in_per_mtok": 0.0,
            "price_external_classifier_out_per_mtok": 0.0,
            "price_external_quality_in_per_mtok": 0.0,
            "price_external_quality_out_per_mtok": 0.0,
            "monthly_soft_cap_usd": 0,
            "display_order": 40,
        },
    ]

    async with AsyncSessionLocal() as db:
        for spec in catalog:
            existing = (
                await db.execute(select(Sku).where(Sku.slug == spec["slug"]))
            ).scalar_one_or_none()
            if existing is None:
                db.add(Sku(**spec))
                console.print(f"[green]SKU created:[/green] {spec['slug']}")
            else:
                for k, v in spec.items():
                    setattr(existing, k, v)
                console.print(f"[yellow]SKU updated:[/yellow] {spec['slug']}")
        await db.commit()

        # Pin the default tenant to Local-First if it has no current row.
        default_sku = (
            await db.execute(select(Sku).where(Sku.slug == "local-first"))
        ).scalar_one()
        existing_sub = (
            await db.execute(
                select(TenantSku)
                .where(
                    TenantSku.tenant_id == DEFAULT_TENANT_ID,
                    TenantSku.current.is_(True),
                )
            )
        ).scalar_one_or_none()
        if existing_sub is None:
            db.add(
                TenantSku(
                    tenant_id=DEFAULT_TENANT_ID,
                    sku_id=default_sku.id,
                    current=True,
                    started_at=datetime.now(tz=timezone.utc),
                )
            )
            await db.commit()
            console.print(
                "[green]Default tenant pinned to Local-First.[/green]"
            )


@app.command(name="seed-demo")
def seed_demo() -> None:
    """Generate a wave of synthetic events so the UI has interesting data."""
    asyncio.run(_seed_demo())


async def _seed_demo() -> None:
    import daalu_automation.modules  # noqa: F401
    from daalu_automation.core.integrations import get_integration

    await _seed()
    for provider in ("synthetic-infra",):
        emitted = await get_integration(provider).ingest()
        console.print(f"[green]{provider}[/green]: emitted {emitted} events")


@app.command()
def briefing(channel: str) -> None:
    """Generate a briefing for one channel right now."""
    asyncio.run(_briefing(channel))


async def _briefing(channel: str) -> None:
    import daalu_automation.modules  # noqa: F401
    from daalu_automation.core.briefings import get_briefing_generator
    from daalu_automation.models import BriefingChannel

    gen = get_briefing_generator(BriefingChannel(channel))
    b = await gen.generate()
    console.print(f"[green]Briefing {b.id}[/green] — {b.title}")
    console.print(b.summary)


@app.command(name="create-admin")
def create_admin(
    email: str = typer.Option(..., prompt=True),
    password: str = typer.Option(..., prompt=True, hide_input=True),
    full_name: str | None = typer.Option(None),
) -> None:
    """Create (or update) an admin user."""
    asyncio.run(_create_admin(email, password, full_name))


async def _create_admin(email: str, password: str, full_name: str | None) -> None:
    from sqlalchemy import select

    from daalu_automation.config import DEFAULT_TENANT_ID
    from daalu_automation.core.auth import hash_password
    from daalu_automation.database import AsyncSessionLocal, create_tables
    from daalu_automation.models import Tenant, User

    await create_tables()
    email = email.strip().lower()
    async with AsyncSessionLocal() as db:
        tenant = (
            await db.execute(select(Tenant).where(Tenant.id == DEFAULT_TENANT_ID))
        ).scalar_one_or_none()
        if tenant is None:
            db.add(Tenant(id=DEFAULT_TENANT_ID, name="Default", slug="default"))
            await db.commit()
        existing = (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                User(
                    tenant_id=DEFAULT_TENANT_ID,
                    email=email,
                    full_name=full_name,
                    hashed_password=hash_password(password),
                    is_active=True,
                    is_admin=True,
                )
            )
            await db.commit()
            console.print(f"[green]Admin user created:[/green] {email}")
        else:
            existing.hashed_password = hash_password(password)
            existing.is_admin = True
            existing.is_active = True
            if full_name:
                existing.full_name = full_name
            await db.commit()
            console.print(f"[yellow]Existing user updated:[/yellow] {email}")


@app.command()
def ingest(provider: str) -> None:
    """Trigger an integration ingestion run."""
    asyncio.run(_ingest(provider))


async def _ingest(provider: str) -> None:
    import daalu_automation.modules  # noqa: F401
    from daalu_automation.core.integrations import get_integration

    n = await get_integration(provider).ingest()
    console.print(f"[green]{provider}[/green]: emitted {n} events")


if __name__ == "__main__":
    app()
