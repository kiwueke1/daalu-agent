"use client";

/**
 * /operations — the Source of Truth hub.
 *
 * Tabbed layout matches docs/book-customer/03-core-concepts/12-source-of-truth.md
 * and the chapter-17 walkthrough. Sub-pages (/devices, /proposals) used
 * to be separate sidebar entries; they now redirect here and the tabs
 * own the surface area.
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { OverviewView } from "@/components/operations/overview-view";
import { DevicesView } from "@/components/operations/devices-view";
import { DriftView } from "@/components/operations/drift-view";
import { ProposalsView } from "@/components/operations/proposals-view";
import { BulkImportView } from "@/components/operations/bulk-import-view";
import { RoutineRunsView } from "@/components/operations/routine-runs-view";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "devices", label: "Devices" },
  { id: "drift", label: "Drift" },
  { id: "proposals", label: "Proposals" },
  { id: "bulk-import", label: "Bulk import" },
  { id: "routine-runs", label: "Routine runs" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(value: string | null): value is TabId {
  return value !== null && TABS.some((t) => t.id === value);
}

function OperationsPageInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const urlTab = sp.get("tab");
  const initial: TabId = isTabId(urlTab) ? urlTab : "overview";
  const [tab, setTab] = useState<TabId>(initial);

  // Keep URL and state in sync when the user changes tabs or arrives
  // via a deep link.
  useEffect(() => {
    if (isTabId(urlTab) && urlTab !== tab) {
      setTab(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const onSelect = (id: TabId) => {
    setTab(id);
    const params = new URLSearchParams(Array.from(sp.entries()));
    params.set("tab", id);
    router.replace(`/operations?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-6 max-w-[1400px]">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <LayoutGrid className="h-5 w-5 text-accent-cyan" /> Operations
        </h1>
        <p className="text-muted text-sm mt-1">
          Devices, drift detection, change proposals, and bulk inventory — your
          Source of Truth in one place.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-line pb-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              tab === t.id
                ? "border-accent-blue/60 text-[color:var(--text)] bg-accent-blue/15 shadow-glow"
                : "border-line text-muted hover:text-[color:var(--text)] hover:bg-bg-elevated/60"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div>
        {tab === "overview" && (
          <OverviewView onJumpTo={(id) => onSelect(id as TabId)} />
        )}
        {tab === "devices" && <DevicesView />}
        {tab === "drift" && <DriftView />}
        {tab === "proposals" && <ProposalsView />}
        {tab === "bulk-import" && <BulkImportView />}
        {tab === "routine-runs" && <RoutineRunsView />}
      </div>
    </div>
  );
}

export default function OperationsPage() {
  // useSearchParams must be wrapped in Suspense per Next 14's app-router rules.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted">Loading…</div>}>
      <OperationsPageInner />
    </Suspense>
  );
}
