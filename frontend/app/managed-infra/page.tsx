"use client";

import { useState } from "react";
import { Boxes, Network, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import ClustersPage from "@/app/clusters/page";
import NetworkPage from "@/app/network/page";
import OnboardingPage from "@/app/onboarding/page";

/**
 * /managed-infra — a single home for the three closely-related infra
 * surfaces that used to be separate sidebar entries: cloud accounts +
 * observability + Kubernetes clusters (Managed infra), the per-tenant
 * NV-CM stack (Network & servers), and the guided integration wizard
 * (Onboarding). They're all "wire up / inspect the things Daalu reads
 * from", so they live here as tabs.
 *
 * Each tab renders the existing route's component unchanged, and only the
 * active tab mounts — so a tab's data fetching doesn't run until it's
 * opened, and the standalone routes (/clusters, /network, /onboarding)
 * still resolve directly for deep links.
 */

type Tab = "clusters" | "network" | "onboarding";

const TABS: { key: Tab; label: string; icon: typeof Boxes }[] = [
  { key: "clusters", label: "Clusters & observability", icon: Boxes },
  { key: "network", label: "Network & servers", icon: Network },
  { key: "onboarding", label: "Onboarding", icon: Sparkles },
];

export default function ManagedInfraHub() {
  const [tab, setTab] = useState<Tab>("clusters");

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Managed infrastructure"
        className="flex items-center gap-1 border-b border-line overflow-x-auto"
      >
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(key)}
              className={cn(
                "relative inline-flex items-center gap-2 px-4 py-2.5 text-sm whitespace-nowrap transition-colors",
                active
                  ? "text-[color:var(--text)]"
                  : "text-muted hover:text-[color:var(--text)]"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full"
                  style={{
                    background: "var(--accent)",
                    boxShadow: "0 0 8px var(--accent-glow)",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div>
        {tab === "clusters" && <ClustersPage />}
        {tab === "network" && <NetworkPage />}
        {tab === "onboarding" && <OnboardingPage />}
      </div>
    </div>
  );
}
