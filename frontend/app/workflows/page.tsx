"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Workflow as WorkflowIcon, ChevronRight, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/utils";
import { StatusBadge } from "@/components/workflows/status-badge";

/**
 * /workflows — every remediation the agent has run (one per "Approve & run").
 * Each row opens a step-by-step detail page and links back to the alert it
 * remediated. Distinct from /automations (code-registered, manually-triggered
 * workflows); these are agent-run remediations tied to an alert.
 */
export default function WorkflowsPage() {
  const { data: runs } = useQuery({
    queryKey: ["workflow-runs", "alert"],
    queryFn: () => api.workflows.runs({ source: "alert" }),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <WorkflowIcon className="h-5 w-5 text-accent-cyan" /> Workflows
        </h1>
        <p className="text-muted text-sm mt-1">
          Remediations the agent has run. Each one executes a plan&apos;s steps
          end to end — open it to see every tool call and its outcome, or jump
          to the alert it resolved.
        </p>
      </div>

      <div className="rounded-2xl border border-line bg-bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-elevated/50">
            <tr>
              <th className="text-left px-4 py-2.5">Workflow</th>
              <th className="text-left px-4 py-2.5">Status</th>
              <th className="text-left px-4 py-2.5">Source alert</th>
              <th className="text-left px-4 py-2.5">Started</th>
              <th className="text-right px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {(runs ?? []).map((r) => (
              <tr
                key={r.id}
                className="border-t border-line/60 hover:bg-bg-elevated/30"
              >
                <td className="px-4 py-2.5">
                  <Link
                    href={`/workflows/${r.id}`}
                    className="font-medium hover:text-accent-cyan hover:underline"
                  >
                    {r.workflow_name}
                  </Link>
                  <div className="text-[11px] text-muted flex items-center gap-2">
                    <span className="font-mono">#{r.id.slice(0, 8)}</span>
                    <span>·</span>
                    <span>
                      {r.steps?.length ?? 0} step
                      {(r.steps?.length ?? 0) === 1 ? "" : "s"}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-2.5">
                  {r.alert_id ? (
                    <Link
                      href={`/alerts/${r.alert_id}`}
                      className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent-cyan hover:underline"
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {r.alert_title ?? "alert"}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {formatRelative(r.started_at)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Link
                    href={`/workflows/${r.id}`}
                    className="text-muted hover:text-accent-cyan inline-flex items-center gap-1 text-xs"
                  >
                    Open <ChevronRight className="h-4 w-4" />
                  </Link>
                </td>
              </tr>
            ))}
            {(runs ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted">
                  No workflows yet. Approve a remediation plan on an alert to run
                  one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
