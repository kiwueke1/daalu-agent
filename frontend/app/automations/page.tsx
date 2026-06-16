"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Workflow as WorkflowIcon, Play } from "lucide-react";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/utils";

export default function AutomationsPage() {
  const qc = useQueryClient();
  const { data: workflows } = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.workflows.list(),
  });
  const { data: runs } = useQuery({
    queryKey: ["workflow-runs"],
    queryFn: () => api.workflows.runs(),
    refetchInterval: 10_000,
  });

  const trigger = useMutation({
    mutationFn: ({ name, input }: { name: string; input: Record<string, unknown> }) =>
      api.workflows.run(name, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-runs"] }),
  });

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-2xl font-semibold">Automations</h1>
        <p className="text-muted text-sm mt-1">
          Visual workflow system — triggers, actions, history. Pluggable
          per-module workflows are registered in code.
        </p>
      </div>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">
          Registered workflows
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(workflows ?? []).map((w) => (
            <div
              key={w.name}
              className="rounded-2xl border border-line bg-bg-card p-4 flex items-start justify-between"
            >
              <div>
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
                  <WorkflowIcon className="h-3.5 w-3.5 text-accent-cyan" />
                  {w.module}
                </div>
                <div className="text-sm font-medium mt-1">{w.name}</div>
              </div>
              <button
                onClick={() => trigger.mutate({ name: w.name, input: {} })}
                className="text-xs h-8 px-3 rounded-lg bg-gradient-to-r from-accent-blue to-accent-violet shadow-glow flex items-center gap-1"
              >
                <Play className="h-3 w-3" /> Run
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">
          Recent runs
        </h2>
        <div className="rounded-2xl border border-line bg-bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-elevated/50">
              <tr>
                <th className="text-left px-4 py-2.5">Workflow</th>
                <th className="text-left px-4 py-2.5">Module</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Started</th>
                <th className="text-left px-4 py-2.5">Finished</th>
              </tr>
            </thead>
            <tbody>
              {(runs ?? []).slice(0, 25).map((r) => (
                <tr key={r.id} className="border-t border-line/60">
                  <td className="px-4 py-2.5 font-medium">{r.workflow_name}</td>
                  <td className="px-4 py-2.5 text-muted">{r.module}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${
                        r.status === "succeeded"
                          ? "bg-accent-emerald/15 text-accent-emerald"
                          : r.status === "failed"
                          ? "bg-accent-red/15 text-accent-red"
                          : "bg-accent-blue/15 text-accent-blue"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{formatRelative(r.started_at)}</td>
                  <td className="px-4 py-2.5 text-muted">{formatRelative(r.finished_at)}</td>
                </tr>
              ))}
              {(runs ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted">
                    No runs yet. Trigger a workflow above to see history.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
