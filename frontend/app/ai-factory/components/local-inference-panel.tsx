"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Cpu,
  Gauge,
  Loader2,
  Play,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  MinusCircle,
  ChevronDown,
  ChevronRight,
  Server,
} from "lucide-react";
import {
  api,
  type AiFactoryLocalBenchmarkRun,
  type AiFactoryAiperfState,
  type AiFactoryValidateCheck,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Local inference — the AI Factory panel for a laptop / Docker-Compose install.
 *
 * There's no onboarded GPU and no DCGM/Prometheus here, so the hardware floor
 * is dark. But the agent still runs on a local OpenAI-compatible endpoint
 * (typically Ollama) — this surfaces *that* brain: which model is serving, is
 * it reachable, how fast, and a small AIPerf-style concurrency benchmark you
 * can run straight against it (executed by the worker, no GPU required).
 */
export function LocalInferencePanel({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="space-y-4">
      <EndpointCard />
      {isAdmin && <ValidateRow />}
      {isAdmin && <BenchmarkPanel />}
      <p className="text-[11px] text-muted">
        Running on a GPU cluster instead? Run{" "}
        <code className="font-mono text-fg">./scripts/onboard-cluster.sh</code>{" "}
        on the node (or onboard it under Managed Infra) and the factory floor
        lights up with live utilisation, thermals and health.
      </p>
    </div>
  );
}

// ── endpoint summary ───────────────────────────────────────────────────────

function EndpointCard() {
  const q = useQuery({
    queryKey: ["aiFactory", "localSummary"],
    queryFn: api.aiFactory.local.summary,
    refetchInterval: 30_000,
  });
  const d = q.data;
  const reachable = d?.reachable ?? false;

  return (
    <section className="rounded-xl border border-line bg-[color:var(--bg-elevated)]/40 p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <Server className="h-4 w-4 text-accent-emerald" /> Local inference
            endpoint
          </h3>
          <p className="text-[11px] text-muted mt-1">
            {d?.source ?? "OpenAI-compatible endpoint"} — the brain serving your
            agent.
          </p>
        </div>
        {d &&
          (reachable ? (
            <span className="text-xs rounded-full px-3 py-1.5 border border-accent-emerald/40 bg-accent-emerald/10 inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }}
              />
              Serving
              {d.latency_ms != null && (
                <span className="text-muted font-mono">· {d.latency_ms}ms</span>
              )}
            </span>
          ) : (
            <span className="text-xs rounded-full px-3 py-1.5 border border-[color:var(--critical)]/40 bg-[color:var(--critical)]/10 text-[color:var(--critical)] inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Unreachable
            </span>
          ))}
      </div>

      {q.isLoading ? (
        <div className="text-xs text-muted mt-4">Probing endpoint…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
          <Stat label="Model" value={d?.model || "—"} mono icon={<Cpu className="h-3.5 w-3.5" />} />
          <Stat label="Endpoint" value={d?.base_url || "—"} mono />
          <Stat
            label="Models advertised"
            value={d?.models?.length ? String(d.models.length) : "—"}
          />
        </div>
      )}

      {d?.models && d.models.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {d.models.map((m) => (
            <span
              key={m}
              className={cn(
                "text-[11px] rounded border px-1.5 py-0.5 font-mono",
                m === d.model
                  ? "border-accent-emerald/40 text-accent-emerald bg-accent-emerald/10"
                  : "border-line text-muted",
              )}
            >
              {m}
            </span>
          ))}
        </div>
      )}

      {!reachable && d?.error && (
        <div className="mt-3 text-[11px] text-[color:var(--critical)] font-mono break-words flex items-start gap-1.5">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {d.error}
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-bg-base/40 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className={cn("text-sm mt-1 break-all", mono && "font-mono")}>
        {value}
      </div>
    </div>
  );
}

// ── validate ─────────────────────────────────────────────────────────────

const CHECK_ICON: Record<AiFactoryValidateCheck["status"], React.ReactNode> = {
  pass: <CheckCircle2 className="h-3.5 w-3.5 text-accent-emerald" />,
  fail: <XCircle className="h-3.5 w-3.5 text-[color:var(--critical)]" />,
  skip: <MinusCircle className="h-3.5 w-3.5 text-muted" />,
};

function ValidateRow() {
  const [open, setOpen] = useState(false);
  const validate = useMutation({
    mutationFn: api.aiFactory.local.validate,
    onSuccess: () => setOpen(true),
  });
  const result = validate.data;

  return (
    <section className="rounded-xl border border-line bg-[color:var(--bg-elevated)]/40 p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-accent-emerald" /> Endpoint
            self-check
          </h3>
          <p className="text-[11px] text-muted mt-1">
            Confirms the endpoint is configured, lists models, and completes a
            tiny chat — proof the model actually serves.
          </p>
        </div>
        <button
          type="button"
          onClick={() => validate.mutate()}
          disabled={validate.isPending}
          className="text-xs h-8 px-3 rounded-lg border border-line text-muted hover:text-[color:var(--text)] hover:border-accent-emerald/40 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {validate.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Validate
        </button>
      </div>
      {open && result && (
        <div className="mt-4 space-y-1.5">
          {result.checks.map((c) => (
            <div key={c.name} className="flex items-start gap-2 text-[11px]">
              {CHECK_ICON[c.status]}
              <span className="font-medium">{c.name}</span>
              <span className="text-muted break-all">— {c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── benchmark (AIPerf analogue) ─────────────────────────────────────────────

function BenchmarkPanel() {
  const qc = useQueryClient();
  const [concurrency, setConcurrency] = useState("1,2,4");
  const [requestCount, setRequestCount] = useState(10);
  const [err, setErr] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ["aiFactory", "localBench"],
    queryFn: api.aiFactory.local.benchmarkRuns,
    refetchInterval: (q) => {
      const data = q.state.data as
        | { runs?: AiFactoryLocalBenchmarkRun[] }
        | undefined;
      const busy = (data?.runs ?? []).some(
        (r) => r.state === "pending" || r.state === "running",
      );
      return busy ? 4_000 : 30_000;
    },
  });

  const run = useMutation({
    mutationFn: () =>
      api.aiFactory.local.runBenchmark({
        concurrency,
        request_count: requestCount,
      }),
    onMutate: () => setErr(null),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["aiFactory", "localBench"] }),
    onError: (e: unknown) =>
      setErr(e instanceof Error ? e.message : "failed to start benchmark"),
  });

  return (
    <section className="rounded-xl border border-line bg-[color:var(--bg-elevated)]/40 p-5">
      <h3 className="text-sm font-medium flex items-center gap-1.5">
        <Gauge className="h-4 w-4 text-accent-cyan" /> Benchmark
        <span className="text-[10px] text-muted font-normal ml-1 uppercase tracking-wide">
          your endpoint
        </span>
      </h3>
      <p className="text-xs text-muted mt-1 max-w-[620px]">
        A small concurrency sweep — TTFT, inter-token latency and throughput —
        run straight against your local endpoint by the worker. CPU inference is
        slow, so keep the sweep modest.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Concurrency sweep">
          <input
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            className="rounded-md border border-line bg-bg-base px-2 py-1.5 text-xs w-32 font-mono"
            placeholder="1,2,4"
          />
        </Field>
        <Field label="Requests / level">
          <input
            type="number"
            min={1}
            max={200}
            value={requestCount}
            onChange={(e) => setRequestCount(Number(e.target.value))}
            className="rounded-md border border-line bg-bg-base px-2 py-1.5 text-xs w-24"
          />
        </Field>
        <button
          type="button"
          disabled={run.isPending}
          onClick={() => run.mutate()}
          className="text-xs h-8 px-3 rounded-lg bg-gradient-to-r from-accent-cyan to-accent-emerald text-bg-base inline-flex items-center gap-1.5 disabled:opacity-60"
        >
          {run.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Run sweep
        </button>
      </div>

      {err && (
        <div className="mt-3 text-[11px] text-[color:var(--critical)] flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3" /> {err}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {(runs.data?.runs ?? []).length === 0 ? (
          <div className="text-xs text-muted">No benchmark runs yet.</div>
        ) : (
          (runs.data?.runs ?? []).map((r) => <BenchRow key={r.id} run={r} />)
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-wide text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

const STATE_TONE: Record<AiFactoryAiperfState, string> = {
  pending: "border-line text-muted",
  running: "border-accent-emerald/40 text-[color:var(--text)]",
  passed:
    "border-accent-emerald/40 text-[color:var(--text)] bg-accent-emerald/10",
  failed:
    "border-[color:var(--warning)]/40 text-[color:var(--warning)] bg-[color:var(--warning)]/10",
  error:
    "border-[color:var(--critical)]/40 text-[color:var(--critical)] bg-[color:var(--critical)]/10",
};

interface Level {
  concurrency?: number;
  metrics?: Record<string, number>;
}

const CURVE_COLS: [string, string][] = [
  ["ttft_ms", "TTFT (ms)"],
  ["itl_ms", "ITL (ms)"],
  ["output_token_throughput", "Output tok/s"],
  ["request_throughput", "Req/s"],
];

function levelsOf(summary: Record<string, unknown> | null): Level[] {
  const l = summary?.["concurrency_levels"];
  return Array.isArray(l) ? (l as Level[]) : [];
}

function errorOf(summary: Record<string, unknown> | null): string | null {
  const e = summary?.["error"];
  return typeof e === "string" ? e : null;
}

function fmt(v: number | undefined): string {
  return typeof v === "number" ? v.toFixed(1) : "—";
}

function BenchRow({ run }: { run: AiFactoryLocalBenchmarkRun }) {
  const [open, setOpen] = useState(false);
  const busy = run.state === "pending" || run.state === "running";
  const levels = levelsOf(run.summary);
  const error = errorOf(run.summary);

  return (
    <div className="rounded-lg border border-line bg-bg-base/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted shrink-0" />
        )}
        <span className="text-xs font-medium font-mono">c={run.concurrency}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 border text-[10px] uppercase tracking-wide",
            STATE_TONE[run.state],
          )}
        >
          {busy && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {run.state}
        </span>
        <span className="ml-auto text-[10px] text-muted whitespace-nowrap">
          {run.started_at ? new Date(run.started_at).toLocaleString() : "—"}
        </span>
      </button>

      {run.state === "error" && error && (
        <div className="px-3 pb-2.5 -mt-1 flex items-start gap-1.5 text-[11px] text-[color:var(--critical)]">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="font-mono break-words">{error}</span>
        </div>
      )}

      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div className="text-[11px] text-muted font-mono break-all">
            {run.model} → {run.target_url} · {run.request_count} req/level · out{" "}
            {run.output_tokens}
          </div>
          {levels.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-muted text-left">
                    <th className="font-normal py-1 pr-3">Concurrency</th>
                    {CURVE_COLS.map(([, label]) => (
                      <th key={label} className="font-normal py-1 pr-3 text-right">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {levels.map((lv, i) => (
                    <tr key={i} className="border-t border-line/60">
                      <td className="py-1 pr-3">{lv.concurrency ?? "—"}</td>
                      {CURVE_COLS.map(([key]) => (
                        <td key={key} className="py-1 pr-3 text-right">
                          {fmt(lv.metrics?.[key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
