"use client";

import { Suspense, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { ReportsQueryTab } from "@/components/reports/query-tab";
import { ReportsDashboardsTab } from "@/components/reports/dashboards-tab";

type Tab = "briefings" | "query" | "dashboards";

function ReportsPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("tab");
  const tab: Tab = raw === "query" ? "query" : raw === "dashboards" ? "dashboards" : "briefings";

  const setTab = (next: Tab) => {
    const sp = new URLSearchParams(params.toString());
    if (next === "briefings") sp.delete("tab");
    else sp.set("tab", next);
    const qs = sp.toString();
    router.replace(`/reports${qs ? `?${qs}` : ""}`);
  };

  return (
    <div className="space-y-6 max-w-[1200px]">
      <header>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-muted text-sm mt-1">
          AI-generated operational intelligence — interactive, not static.
        </p>
      </header>

      <nav className="flex gap-1 border-b border-line">
        <TabButton active={tab === "briefings"} onClick={() => setTab("briefings")}>
          Briefings
        </TabButton>
        <TabButton active={tab === "query"} onClick={() => setTab("query")}>
          Query
        </TabButton>
        <TabButton active={tab === "dashboards"} onClick={() => setTab("dashboards")}>
          Dashboards
        </TabButton>
      </nav>

      {tab === "briefings" ? (
        <BriefingsTab />
      ) : tab === "query" ? (
        <ReportsQueryTab />
      ) : (
        <ReportsDashboardsTab />
      )}
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsPageInner />
    </Suspense>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
        active
          ? "border-accent-blue text-[color:var(--text)]"
          : "border-transparent text-muted hover:text-[color:var(--text)]"
      }`}
    >
      {children}
    </button>
  );
}

function BriefingsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["briefings", "infra"],
    queryFn: () => api.briefings.list("infra"),
  });

  const generate = useMutation({
    mutationFn: () => api.briefings.generate("infra"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["briefings"] });
      qc.invalidateQueries({ queryKey: ["briefing"] });
    },
  });

  useEffect(() => {
    // Refresh stale list whenever the user re-enters this tab.
    qc.invalidateQueries({ queryKey: ["briefings", "infra"] });
  }, [qc]);

  const latest = data?.[0];
  const earlier = (data ?? []).slice(1);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-muted hover:text-[color:var(--text)] hover:bg-bg-elevated/60 transition-colors disabled:opacity-50"
        >
          <RotateCcw
            className={`h-3.5 w-3.5 ${generate.isPending ? "animate-spin" : ""}`}
          />
          {generate.isPending ? "Generating…" : "Regenerate"}
        </button>
      </div>

      {latest ? (
        <Link
          href={`/reports/briefings/${latest.id}`}
          className="block gradient-border p-6 lg:p-8 bg-hero-grad hover:opacity-95 transition-opacity"
        >
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-accent-blue mb-2">
            <FileText className="h-3.5 w-3.5" /> {latest.channel} ·{" "}
            {latest.coverage_date}
          </div>
          <h2 className="text-2xl font-semibold mb-3">{latest.title}</h2>
          <p className="text-[color:var(--text)]/70">{latest.summary}</p>
        </Link>
      ) : (
        <div className="rounded-2xl border border-line bg-bg-card p-6 text-sm text-muted">
          No briefings yet. Click{" "}
          <span className="text-[color:var(--text)]">Regenerate</span> above, or
          run <code className="text-[color:var(--text)]">daalu briefing infra</code>{" "}
          from the CLI.
        </div>
      )}

      {earlier.length > 0 && (
        <section>
          <h3 className="text-sm uppercase tracking-wider text-muted mb-3">
            Earlier
          </h3>
          <ul className="space-y-2">
            {earlier.slice(0, 20).map((b) => (
              <li key={b.id}>
                <Link
                  href={`/reports/briefings/${b.id}`}
                  className="block w-full text-left rounded-xl border border-line bg-bg-card p-3 text-sm hover:border-accent-blue/60 hover:bg-bg-elevated/60 transition-colors"
                >
                  <div className="text-muted text-xs">{b.coverage_date}</div>
                  <div className="font-medium">{b.title}</div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
