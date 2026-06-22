"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  AlertTriangle,
  Heart,
  MessageSquare,
  Send,
  Sparkles,
  TriangleAlert,
  Activity as ActivityIcon,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { CopilotMarkdown } from "@/components/copilot/markdown";
import { formatRelative } from "@/lib/utils";

/**
 * Right rail. Mirrors the cinematic surface system used everywhere else:
 * the rail itself is a deeper-tinted column with its own ambient wash,
 * each section is an illuminated-glass surface, and notifications carry
 * a left edge glow tinted by severity instead of a hard border colour.
 */
export function RightPanel() {
  return (
    <aside
      className="hidden xl:flex flex-col w-[340px] shrink-0 px-4 py-6 gap-5 relative"
      style={{
        background:
          "linear-gradient(180deg, rgba(8,16,13,0.55), rgba(4,10,8,0.85))",
        boxShadow: "inset 1px 0 0 rgba(255,255,255,0.03)",
      }}
    >
      {/* Rail ambient wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 90% 10%, rgba(var(--accent-rgb),0.08), transparent 60%), radial-gradient(40% 40% at 100% 100%, rgba(var(--accent-rgb),0.05), transparent 70%)",
        }}
      />
      <div className="relative space-y-5">
        <CopilotPanel />
        <NotificationsPanel />
        <ActiveSessionsPanel />
        <SystemHealthCard />
      </div>
    </aside>
  );
}

const PROMPTS = [
  "What services are degraded?",
  "Summarise today's events.",
  "Which alerts need attention?",
];

function CopilotPanel() {
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<{ q: string; a: string }[]>([]);
  const [pending, setPending] = useState(false);

  async function send(prompt?: string) {
    const query = (prompt ?? q).trim();
    if (!query) return;
    setQ("");
    setPending(true);
    try {
      const r = await api.copilot.ask(query);
      setHistory((h) => [...h, { q: query, a: r.answer }]);
    } catch {
      setHistory((h) => [...h, { q: query, a: "(copilot unavailable)" }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="surface surface-bloom p-4">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium">
        <MessageSquare className="h-4 w-4" style={{ color: "var(--accent)" }} />
        AI Assistant
      </div>
      <div className="text-xs space-y-3">
        {history.length === 0 ? (
          <div className="space-y-2">
            <p className="text-muted leading-relaxed">
              Ask anything about your live operational state.
            </p>
            <div className="space-y-1.5">
              {PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  className="w-full text-left px-3 py-2 rounded-lg text-[12px] text-muted hover:text-[color:var(--text)] transition-colors"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-h-56 overflow-auto scrollbar-thin space-y-3">
            {history.map((m, i) => (
              <div key={i} className="space-y-1">
                <div className="text-muted">You · {m.q}</div>
                <div
                  className="rounded-lg px-3 py-2"
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
                  }}
                >
                  <CopilotMarkdown>{m.a}</CopilotMarkdown>
                </div>
              </div>
            ))}
            {pending && <div className="text-muted animate-shimmer">Thinking…</div>}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            placeholder="Message the copilot"
            className="flex-1 rounded-lg px-2.5 py-1.5 outline-none transition-colors text-[color:var(--text)] placeholder:text-muted"
            style={{
              background: "rgba(255,255,255,0.03)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
            }}
          />
          <button
            onClick={() => send()}
            className="rounded-lg px-2.5 transition-transform hover:scale-[1.04]"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--accent) 95%, white) 0%, var(--accent) 100%)",
              color: "#031814",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.35), 0 0 18px var(--accent-glow)",
            }}
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </section>
  );
}

function NotificationsPanel() {
  const { data: alerts } = useQuery({
    queryKey: ["alerts", "open"],
    queryFn: () => api.alerts.list({ status: "open" }),
    refetchInterval: 15_000,
  });
  const { data: recs } = useQuery({
    queryKey: ["recommendations", "pending"],
    queryFn: () => api.recommendations.list({ status: "pending" }),
    refetchInterval: 20_000,
  });

  const open = alerts ?? [];
  const critical = open.filter((a) => a.severity === "critical").slice(0, 2);
  const warning = open.filter((a) => a.severity === "warning").slice(0, 2);
  const aiGenerated = (recs ?? []).slice(0, 2);

  return (
    <section className="surface p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" style={{ color: "var(--warning)" }} />
          Notifications
        </div>
        <a href="/alerts" className="text-[11px] text-muted hover:text-[color:var(--text)]">
          View all
        </a>
      </div>

      <NotificationGroup
        label="Critical"
        accent="var(--critical)"
        items={critical.map((a) => ({
          id: a.id,
          title: a.title,
          subtitle: formatRelative(a.created_at),
          href: `/alerts/${a.id}`,
        }))}
        emptyText="No critical alerts."
        icon="critical"
      />
      <NotificationGroup
        label="Warning"
        accent="var(--warning)"
        items={warning.map((a) => ({
          id: a.id,
          title: a.title,
          subtitle: formatRelative(a.created_at),
          href: `/alerts/${a.id}`,
        }))}
        emptyText="No warnings."
        icon="warning"
      />
      <NotificationGroup
        label="AI Generated"
        accent="var(--accent)"
        items={aiGenerated.map((r) => ({
          id: r.id,
          title: r.title,
          subtitle: r.suggested_action || "Tap to review",
          href: "/proposals",
        }))}
        emptyText="No new recommendations."
        icon="ai"
      />
    </section>
  );
}

function NotificationGroup({
  label,
  accent,
  items,
  emptyText,
  icon,
}: {
  label: string;
  accent: string;
  items: { id: string; title: string; subtitle: string; href: string }[];
  emptyText: string;
  icon: "critical" | "warning" | "ai";
}) {
  const Icon =
    icon === "critical" ? AlertTriangle : icon === "warning" ? TriangleAlert : Sparkles;
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.20em] text-muted mb-1.5">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
        />
        {label}
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-muted px-2 py-1">{emptyText}</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((n) => (
            <motion.div
              key={n.id}
              initial={{ opacity: 0, x: 4 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <Link
                href={n.href}
                className="relative block rounded-lg px-3 py-2 text-xs overflow-hidden transition-colors hover:bg-bg-elevated/60"
                style={{
                  background: "rgba(255,255,255,0.025)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
                }}
              >
                {/* Left edge glow tinted by severity */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-0 w-px"
                  style={{
                    background: accent,
                    boxShadow: `0 0 12px ${accent}`,
                    opacity: 0.7,
                  }}
                />
                <div className="flex items-start gap-2 relative">
                  <Icon className="h-3 w-3 mt-0.5 shrink-0" style={{ color: accent }} />
                  <div className="min-w-0">
                    <div className="font-medium leading-snug truncate">{n.title}</div>
                    <div className="text-[10px] text-muted mt-0.5 truncate">
                      {n.subtitle}
                    </div>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveSessionsPanel() {
  const { data } = useQuery({
    queryKey: ["workflow-runs", "right-panel"],
    queryFn: () => api.workflows.runs(),
    refetchInterval: 12_000,
  });
  const active = (data ?? [])
    .filter((r) => r.status === "running" || r.status === "waiting_for_approval")
    .slice(0, 4);

  return (
    <section className="surface p-4">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium">
        <ActivityIcon className="h-4 w-4" style={{ color: "var(--accent)" }} />
        Active sessions
      </div>
      <div className="space-y-1.5">
        {active.length === 0 && (
          <div className="text-xs text-muted">Nothing running.</div>
        )}
        {active.map((w) => (
          <div
            key={w.id}
            className="rounded-lg px-3 py-2 text-xs relative overflow-hidden"
            style={{
              background: "rgba(255,255,255,0.025)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium truncate">{prettyName(w.workflow_name)}</span>
              <span
                className="text-[10px] uppercase tracking-[0.18em]"
                style={{ color: "var(--accent)" }}
              >
                {w.status === "waiting_for_approval" ? "awaiting" : "running"}
              </span>
            </div>
            <div className="text-[10px] text-muted mt-0.5">
              started {formatRelative(w.started_at)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function prettyName(name: string) {
  return name
    .replace(/\./g, " · ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function SystemHealthCard() {
  const { data: alerts } = useQuery({
    queryKey: ["alerts", "all", "health"],
    queryFn: () => api.alerts.list(),
    refetchInterval: 30_000,
  });
  const open = (alerts ?? []).filter((a) => a.status === "open");
  const score = Math.max(
    50,
    100 -
      open.filter((a) => a.severity === "critical").length * 8 -
      open.filter((a) => a.severity === "warning").length * 2
  );

  return (
    <section className="surface surface-bloom p-4">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium">
        <Heart className="h-4 w-4" style={{ color: "var(--accent)" }} />
        System health
      </div>
      <div className="flex items-center gap-4">
        <Gauge value={score} />
        <div className="text-xs">
          <div className="font-medium text-base">
            {score}%{" "}
            <span className="text-muted text-xs font-normal">reliability</span>
          </div>
          <div className="text-muted leading-snug mt-1">
            {open.length === 0
              ? "All systems nominal."
              : `${open.length} signals being watched.`}
          </div>
        </div>
      </div>
    </section>
  );
}

function Gauge({ value }: { value: number }) {
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const dash = (value / 100) * circumference;
  return (
    <div className="relative h-[72px] w-[72px] shrink-0">
      <div
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(50% 50% at 50% 50%, var(--accent-glow), transparent 70%)",
          filter: "blur(2px)",
        }}
      />
      <svg viewBox="0 0 72 72" className="relative h-full w-full -rotate-90">
        <circle
          cx="36"
          cy="36"
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="6"
        />
        <circle
          cx="36"
          cy="36"
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          style={{ filter: "drop-shadow(0 0 8px var(--accent-bloom))" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold">
        {value}%
      </div>
    </div>
  );
}
