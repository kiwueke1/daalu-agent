"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/utils";

export default function AgentsPage() {
  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
  });
  const { data: runs } = useQuery({
    queryKey: ["agent-runs"],
    queryFn: () => api.agents.runs(),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-muted text-sm mt-1">
          AI workers continuously observing the event stream and acting on
          your behalf.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(agents ?? []).map((a) => {
          const last = (runs ?? []).find((r) => r.agent_name === a.name);
          const succ = (runs ?? []).filter(
            (r) => r.agent_name === a.name && r.status === "ok"
          ).length;
          const total = (runs ?? []).filter((r) => r.agent_name === a.name).length;
          const rate = total ? Math.round((succ / total) * 100) : 100;
          return (
            <div
              key={a.name}
              className="rounded-2xl border border-line bg-bg-card p-5 relative overflow-hidden hover:shadow-glow transition-shadow"
            >
              <div className="absolute -top-12 -right-12 h-32 w-32 rounded-full bg-accent-blue/15 blur-3xl pointer-events-none" />
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-accent-blue to-accent-violet flex items-center justify-center">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-base font-medium">{a.name}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted">
                      {a.module}
                    </div>
                  </div>
                </div>
                <span
                  className={`text-[10px] uppercase tracking-wider rounded px-2 py-1 ${
                    last?.status === "error"
                      ? "bg-accent-red/15 text-accent-red"
                      : "bg-accent-emerald/15 text-accent-emerald"
                  }`}
                >
                  {last?.status ?? "idle"}
                </span>
              </div>
              <p className="text-sm text-[color:var(--text)]/70 mt-3">{a.description}</p>
              <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                <Stat label="Success rate" value={`${rate}%`} />
                <Stat label="Runs (24h)" value={total} />
                <Stat label="Last seen" value={formatRelative(last?.started_at)} />
              </div>
              <div className="mt-3 text-[11px] text-muted">
                Subscribed to:{" "}
                {a.subscribed_event_types.slice(0, 3).join(", ")}
                {a.subscribed_event_types.length > 3 && "…"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-bg-elevated py-2">
      <div className="text-sm font-medium">{value}</div>
      <div className="text-[10px] text-muted uppercase tracking-wider">{label}</div>
    </div>
  );
}
