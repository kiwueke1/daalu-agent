"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Bell } from "lucide-react";
import { api } from "@/lib/api";
import { AlertTile } from "@/components/alerts/alert-tile";

const TABS = ["open", "acknowledged", "resolved"] as const;

export default function AlertsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("open");
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["alerts", tab],
    queryFn: () => api.alerts.list({ status: tab }),
    refetchInterval: 10_000,
  });
  const ack = useMutation({
    mutationFn: (id: string) => api.alerts.acknowledge(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const resolve = useMutation({
    mutationFn: (id: string) => api.alerts.resolve(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Bell className="h-5 w-5 text-accent-red" /> Alerts
        </h1>
        <p className="text-muted text-sm mt-1">
          AI-promoted operational signals — grouped by status. Click a
          tile to open the diagnostic + remediation chat for that alert.
        </p>
      </div>

      <div className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs px-3 py-1.5 rounded-lg border ${
              tab === t
                ? "border-accent-blue/60 bg-accent-blue/15 text-[color:var(--text)] shadow-glow"
                : "border-line text-muted hover:text-[color:var(--text)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {(data ?? []).map((a) => (
          <AlertTile
            key={a.id}
            alert={a}
            onAcknowledge={() => ack.mutate(a.id)}
            onResolve={() => resolve.mutate(a.id)}
          />
        ))}
        {data && data.length === 0 && (
          <div className="text-sm text-muted">No {tab} alerts.</div>
        )}
      </div>
    </div>
  );
}
