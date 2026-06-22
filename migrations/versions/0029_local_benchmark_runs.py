"""Local-inference benchmark runs (AI Factory laptop path).

A row per local-endpoint concurrency sweep kicked from the hub. daalu-api writes
it ``pending`` and dispatches ``localbench.run`` to the Celery worker, which
benchmarks the operator's OpenAI-compatible endpoint (typically Ollama) directly
and writes back ``summary`` (TTFT/ITL/throughput per concurrency) + ``state``.
The laptop analogue of ``aiperf_runs`` — no GPU / Kubernetes / Prometheus.

Revision ID: 0029_local_benchmark_runs
Revises: 0028_cli_device_auth
Create Date: 2026-06-17
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision = "0029_local_benchmark_runs"
down_revision = "0028_cli_device_auth"
branch_labels = None
depends_on = None

# Let op.create_table own the enum lifecycle (default create_type=True) — see
# 0024_aiperf_runs for why we don't call _STATE.create() explicitly.
_STATE = sa.Enum(
    "pending",
    "running",
    "passed",
    "failed",
    "error",
    name="local_benchmark_run_state",
)


def upgrade() -> None:
    op.create_table(
        "local_benchmark_runs",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "tenant_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("state", _STATE, nullable=False, server_default="pending"),
        sa.Column("target_url", sa.String(512), nullable=False),
        sa.Column("model", sa.String(255), nullable=False),
        sa.Column("concurrency", sa.String(255), nullable=False),
        sa.Column("request_count", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("summary", JSONB, nullable=False, server_default="{}"),
        sa.Column("output", sa.Text(), nullable=True),
        sa.Column("requested_by", sa.String(255), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("local_benchmark_runs")
    bind = op.get_bind()
    _STATE.drop(bind, checkfirst=True)
