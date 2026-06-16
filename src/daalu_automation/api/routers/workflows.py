from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from daalu_automation.api.deps import current_tenant_id
from daalu_automation.api.schemas import WorkflowDescriptorOut, WorkflowRunOut
from daalu_automation.core.workflows import list_workflows, run_workflow
from daalu_automation.database import get_db
from daalu_automation.models import WorkflowRun

router = APIRouter(prefix="/workflows", tags=["workflows"])


class RunWorkflowRequest(BaseModel):
    name: str
    input: dict = {}


@router.get("", response_model=list[WorkflowDescriptorOut])
async def list_workflows_route():
    return [
        WorkflowDescriptorOut(name=name, module=module) for name, module in list_workflows()
    ]


@router.get("/runs", response_model=list[WorkflowRunOut])
async def list_workflow_runs(
    module: str | None = Query(default=None),
    limit: int = Query(default=50, le=500),
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(current_tenant_id),
):
    stmt = (
        select(WorkflowRun)
        .where(WorkflowRun.tenant_id == tenant_id)
        .order_by(desc(WorkflowRun.created_at))
        .limit(limit)
    )
    if module:
        stmt = stmt.where(WorkflowRun.module == module)
    return (await db.execute(stmt)).scalars().all()


@router.post("/run", status_code=202)
async def run_workflow_route(
    req: RunWorkflowRequest, tenant_id=Depends(current_tenant_id)
):
    run_id = await run_workflow(req.name, req.input, tenant_id=tenant_id)
    return {"run_id": str(run_id)}
