"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ChangeProposalStatus } from "@/lib/api";
import { ProposalTile } from "@/components/proposals/proposal-tile";

const TABS: { id: ChangeProposalStatus | "all"; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "executed", label: "Executed" },
  { id: "failed", label: "Failed" },
  { id: "stale", label: "Stale" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

export function ProposalsView() {
  const [status, setStatus] = useState<(typeof TABS)[number]["id"]>("pending");
  const { data, isLoading, error } = useQuery({
    queryKey: ["change-proposals", status],
    queryFn: () =>
      api.changeProposals.list(status === "all" ? {} : { status }),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-4">
      <p className="text-muted text-sm">
        Device-config changes proposed by the engine or by drift detection.
        Approving a proposal queues it for the executor — the engine itself
        never pushes to a device.
      </p>

      <div className="flex gap-2 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setStatus(t.id)}
            className={`text-xs px-3 py-1.5 rounded-lg border ${
              status === t.id
                ? "border-accent-blue/60 bg-accent-blue/15 text-[color:var(--text)] shadow-glow"
                : "border-line text-muted hover:text-[color:var(--text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="text-sm text-muted">Loading proposals…</div>
      )}
      {error && (
        <div className="text-sm text-[color:var(--critical)]">
          Couldn't load proposals.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {(data ?? []).map((p) => (
          <ProposalTile key={p.id} proposal={p} />
        ))}
        {data && data.length === 0 && !isLoading && (
          <div className="text-sm text-muted">
            No {status === "all" ? "" : status} proposals.
          </div>
        )}
      </div>
    </div>
  );
}
