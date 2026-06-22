"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  GitPullRequest,
  HardDrive,
} from "lucide-react";
import { api } from "@/lib/api";

interface OverviewViewProps {
  onJumpTo: (tabId: string) => void;
}

export function OverviewView({ onJumpTo }: OverviewViewProps) {
  const { data: devices } = useQuery({
    queryKey: ["sot-devices"],
    queryFn: () => api.sot.devices.list(),
  });
  const { data: openDrift } = useQuery({
    queryKey: ["change-proposals", "drift"],
    queryFn: () =>
      api.changeProposals.list({ kind: "drift", status: "pending" }),
    refetchInterval: 15_000,
  });
  const { data: pending } = useQuery({
    queryKey: ["change-proposals", "pending"],
    queryFn: () => api.changeProposals.list({ status: "pending" }),
    refetchInterval: 15_000,
  });

  const totalDevices = devices?.length ?? 0;
  const driftCount = openDrift?.length ?? 0;
  const inSyncCount = Math.max(totalDevices - driftCount, 0);
  const pendingCount = pending?.length ?? 0;

  return (
    <div className="space-y-6">
      {/* Vocabulary card */}
      <div className="surface p-5 space-y-3">
        <h2 className="text-base font-semibold">The Source of Truth model</h2>
        <p className="text-sm text-muted leading-relaxed">
          <strong className="text-[color:var(--text)]">Source of Truth</strong>{" "}
          (SoT) is your authoritative inventory — Nautobot in the current
          product. It says what each device <em>should</em> look like.{" "}
          <strong className="text-[color:var(--text)]">Live state</strong> is
          what the device actually looks like, right now, on the box.{" "}
          <strong className="text-[color:var(--text)]">Drift</strong> is a
          difference between the two.
        </p>
        <p className="text-sm text-muted leading-relaxed">
          The reconciler runs every 5 minutes per device. When it finds drift
          it opens a change proposal — never pushes a fix on its own. A human
          decides whether to apply Nautobot&apos;s config to the device or
          update Nautobot to match the device.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KpiCard
          label="Devices in SoT"
          value={totalDevices}
          accent="var(--accent-cyan, #06b6d4)"
          icon={HardDrive}
          onClick={() => onJumpTo("devices")}
        />
        <KpiCard
          label="In sync"
          value={inSyncCount}
          accent="var(--accent-emerald, #10b981)"
          icon={CheckCircle2}
          onClick={() => onJumpTo("devices")}
          help={`${totalDevices === 0 ? 0 : Math.round((inSyncCount / totalDevices) * 100)}% of the fleet`}
        />
        <KpiCard
          label="Open drift"
          value={driftCount}
          accent="var(--warning, #f59e0b)"
          icon={AlertTriangle}
          onClick={() => onJumpTo("drift")}
          help={driftCount === 0 ? "all clean" : "needs an operator decision"}
        />
      </div>

      {/* Secondary stats + jump-ins */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="surface p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted">
              Proposals
            </span>
            <Link
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onJumpTo("proposals");
              }}
              className="text-[10px] text-muted hover:text-[color:var(--text)]"
            >
              Open queue →
            </Link>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold">{pendingCount}</span>
            <span className="text-xs text-muted">pending</span>
          </div>
          <p className="text-[11.5px] text-muted leading-relaxed">
            Every proposal — drift, ai-suggested, manual, workflow — flows
            through the same approve/reject queue. The executor is the only
            identity that can push to a device.
          </p>
        </div>

        <div className="surface p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted">
              Onboarding
            </span>
            <Link
              href="/integrations"
              className="text-[10px] text-muted hover:text-[color:var(--text)]"
            >
              Integrations →
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <GitPullRequest className="h-4 w-4 text-accent-blue" />
            <span className="text-sm">
              Use the <strong>Bulk import</strong> tab to seed Nautobot from a
              YAML or Excel spreadsheet.
            </span>
          </div>
          <p className="text-[11.5px] text-muted leading-relaxed">
            Already have your own Nautobot? Connect it via{" "}
            <Link
              href="/integrations"
              className="underline text-accent-cyan"
            >
              Integrations
            </Link>{" "}
            and skip our hosted instance — same experience either way.
          </p>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  accent,
  icon: Icon,
  onClick,
  help,
}: {
  label: string;
  value: number;
  accent: string;
  icon: typeof HardDrive;
  onClick: () => void;
  help?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="surface text-left p-4 hover:border-accent-blue/40 transition-colors"
      style={{ boxShadow: `inset 4px 0 0 ${accent}` }}
    >
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
        <Icon className="h-3 w-3" style={{ color: accent }} />
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-3xl font-semibold">{value}</span>
        {help && <span className="text-[11px] text-muted">{help}</span>}
      </div>
    </button>
  );
}
