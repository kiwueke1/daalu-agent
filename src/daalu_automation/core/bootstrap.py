"""Idempotent startup hooks — seed the default tenant.

Called from the API lifespan + the worker bootstrap. Both pre-Phase-2
deployments (where a single env-var INGEST_API_KEY backs the only tenant)
and fresh Phase-2 deployments (where tenants are created via the API)
need DEFAULT_TENANT_ID to exist in the tenants table so existing rows
that point at it via FK don't dangle.
"""

from __future__ import annotations

import structlog

from daalu_automation.config import (
    DEFAULT_TENANT_ID,
    DEFAULT_USER_EMAIL,
    DEFAULT_USER_ID,
    get_settings,
)
from daalu_automation.core.auth import hash_ingest_api_key
from daalu_automation.database import AsyncSessionLocal
from daalu_automation.models import Tenant, User

logger = structlog.get_logger(__name__)


async def ensure_default_tenant() -> None:
    """Create DEFAULT_TENANT_ID if it isn't already in the tenants table.

    Backfills the ingest_api_key_hash from the env var INGEST_API_KEY
    when the column is empty so Phase-1 single-tenant deployments
    upgrade in place without a manual key rotation. If the column is
    already populated (operator rotated the key via the API), the env
    var is ignored — the DB is the source of truth from that point on.
    """
    settings = get_settings()
    async with AsyncSessionLocal() as db:
        tenant = await db.get(Tenant, DEFAULT_TENANT_ID)
        if tenant is None:
            tenant = Tenant(
                id=DEFAULT_TENANT_ID,
                name="Default tenant",
                slug="default",
                timezone="UTC",
            )
            db.add(tenant)
            logger.info("bootstrap.default_tenant_created", id=str(DEFAULT_TENANT_ID))
        if not tenant.ingest_api_key_hash and settings.ingest_api_key:
            tenant.ingest_api_key_hash = hash_ingest_api_key(settings.ingest_api_key)
            logger.info(
                "bootstrap.default_tenant_ingest_key_seeded",
                id=str(DEFAULT_TENANT_ID),
            )
        await db.commit()


async def ensure_default_user() -> None:
    """Create the built-in local operator for single-tenant mode.

    Only relevant when ``local_no_auth`` is on (open-source / self-host
    laptop mode): the API resolves every request to this user, so it must
    exist for foreign-key-bound rows (alerts ack'd by user, PATs, etc.).
    Idempotent — a no-op once the row exists. Does NOT run in multi-user
    deployments, which create users through their own identity flow.
    """
    settings = get_settings()
    if not settings.local_no_auth:
        return
    async with AsyncSessionLocal() as db:
        user = await db.get(User, DEFAULT_USER_ID)
        if user is not None:
            return
        db.add(
            User(
                id=DEFAULT_USER_ID,
                tenant_id=DEFAULT_TENANT_ID,
                email=DEFAULT_USER_EMAIL,
                full_name="Local Operator",
                is_active=True,
                is_admin=True,
                is_superuser=True,
            )
        )
        await db.commit()
        logger.info("bootstrap.default_user_created", id=str(DEFAULT_USER_ID))
