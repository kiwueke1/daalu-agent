"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Gauge,
  Loader2,
  Play,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  ShieldAlert,
  Download,
} from "lucide-react";
import {
  api,
  type AiFactoryAiperfRun,
  type AiFactoryAiperfState,
  type AiFactoryAiperfArtifact,
  type AiFactoryAiperfLevel,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * AIPerf — load-test / SLO benchmarking. Access is gated server-side:
 *  · site superuser — benchmarks the shared serving stack; free target choice;
 *    sees every run.
 *  · GPU owner / provider — benchmarks ONLY their own endpoint; sees own runs.
 * The page renders this panel for either; the backend enforces both the gate
 * and the per-scope target restriction. A sweep IS load, so it carries a hazard
 * banner. See docs/plans/nvidia-ai-factory/04-aiperf.md.
 */
type Target = "vllm" | "gateway";

export function AiperfPanel() {
  const qc = useQueryClient();
  const [target, setTarget] = useState<Target>("vllm");
  const [concurrency, setConcurrency] = useState("1,2,4,8,16,32");
  const [requestCount, setRequestCount] = useState(200);
  const [err, setErr] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ["aiFactory", "aiperf"],
    queryFn: api.aiFactory.aiperfRuns,
    refetchInterval: (q) => {
      const data = q.state.data as
        | { runs?: AiFactoryAiperfRun[] }
        | undefined;
      const busy = (data?.runs ?? []).some(
        (r) => r.state === "pending" || r.state === "running"
      );
      return busy ? 5_000 : 30_000;
    },
  });

  const execEnabled = runs.data?.exec_enabled ?? false;
  const scope = runs.data?.scope ?? "site";
  // Only a site operator picks the target; an owner/provider always benchmarks
  // their own endpoint, so the selector is hidden for them.
  const isSite = scope === "site";

  const run = useMutation({
    mutationFn: () =>
      api.aiFactory.runAiperf({
        concurrency,
        request_count: requestCount,
        via_gateway: isSite && target === "gateway",
      }),
    onMutate: () => setErr(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["aiFactory", "aiperf"] });
    },
    onError: (e: unknown) =>
      setErr(e instanceof Error ? e.message : "failed to start benchmark"),
  });

  return (
    <section className="rounded-xl border border-line bg-[color:var(--bg-elevated)]/40 p-5">
      <h3 className="text-sm font-medium flex items-center gap-1.5">
        <Gauge className="h-4 w-4 text-accent-cyan" /> Performance benchmarking
        <span className="text-[10px] text-muted font-normal ml-1 uppercase tracking-wide">
          {isSite ? "site admin" : "your endpoint"}
        </span>
      </h3>
      <p className="text-xs text-muted mt-1 max-w-[620px]">
        Run an AIPerf concurrency sweep to measure TTFT, inter-token latency and
        throughput — the SLO curve behind capacity planning and the pricing
        model.{" "}
        {isSite
          ? "This load-tests the shared serving stack: run it off-peak."
          : "This benchmarks your own GPU endpoint."}
      </p>

      {/* Load-test hazard banner. */}
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/5 px-3 py-2 text-[11px] text-[color:var(--warning)]">
        <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          A full-concurrency sweep is real load on the endpoint under test — it
          will spike latency while it runs. Prefer off-peak, or a candidate node
          before the router is flipped to it.
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {isSite && (
          <Field label="Target">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as Target)}
              className="rounded-md border border-line bg-bg-base px-2 py-1.5 text-xs"
            >
              <option value="vllm">vLLM (llm-classifier)</option>
              <option value="gateway">Gateway (front door)</option>
            </select>
          </Field>
        )}
        <Field label="Concurrency sweep">
          <input
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            className="rounded-md border border-line bg-bg-base px-2 py-1.5 text-xs w-40 font-mono"
            placeholder="1,2,4,8,16,32"
          />
        </Field>
        <Field label="Requests / level">
          <input
            type="number"
            min={1}
            max={2000}
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

      {!execEnabled && (
        <div className="mt-3 text-[11px] text-muted">
          Note: AIPerf execution is disabled on this deployment
          (<span className="font-mono">gpu_aiperf_exec_enabled=false</span>).
          You can queue a run, but it will be marked errored until an operator
          enables it. This is off by default so a sweep can&apos;t accidentally
          load the shared prod card.
        </div>
      )}

      {err && (
        <div className="mt-3 text-[11px] text-[color:var(--critical)] flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3" /> {err}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {(runs.data?.runs ?? []).length === 0 ? (
          <div className="text-xs text-muted">No benchmark runs yet.</div>
        ) : (
          (runs.data?.runs ?? []).map((r) => <AiperfRow key={r.id} run={r} />)
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

function metricsOf(
  summary: Record<string, unknown> | null
): Record<string, number> | null {
  const m = summary?.["metrics"];
  if (m && typeof m === "object" && !Array.isArray(m)) {
    return m as Record<string, number>;
  }
  return null;
}

function levelsOf(
  summary: Record<string, unknown> | null
): AiFactoryAiperfLevel[] {
  const l = summary?.["concurrency_levels"];
  return Array.isArray(l) ? (l as AiFactoryAiperfLevel[]) : [];
}

function errorOf(summary: Record<string, unknown> | null): string | null {
  const e = summary?.["error"];
  return typeof e === "string" ? e : null;
}

const METRIC_LABEL: Record<string, [string, string]> = {
  ttft_ms: ["TTFT", "ms"],
  itl_ms: ["ITL", "ms"],
  tpot_ms: ["TPOT", "ms"],
  request_latency_ms: ["Req latency", "ms"],
  output_token_throughput: ["Output tok/s", ""],
  request_throughput: ["Req/s", ""],
};

// The columns of the per-concurrency SLO curve table, in display order.
const CURVE_COLS: [string, string][] = [
  ["ttft_ms", "TTFT (ms)"],
  ["itl_ms", "ITL (ms)"],
  ["output_token_throughput", "Output tok/s"],
  ["request_throughput", "Req/s"],
];

function fmt(v: number | undefined): string {
  return typeof v === "number" ? v.toFixed(1) : "—";
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ConcurrencyCurve({ levels }: { levels: AiFactoryAiperfLevel[] }) {
  if (levels.length === 0) return null;
  return (
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
            <tr key={lv.path ?? i} className="border-t border-line/60">
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
  );
}

function ArtifactList({ runId }: { runId: string }) {
  const q = useQuery({
    queryKey: ["aiFactory", "aiperfArtifacts", runId],
    queryFn: () => api.aiFactory.aiperfArtifacts(runId),
  });
  const artifacts: AiFactoryAiperfArtifact[] = q.data?.artifacts ?? [];
  if (q.isLoading) {
    return <div className="text-[11px] text-muted">Loading artifacts…</div>;
  }
  if (q.data?.artifacts_error) {
    return (
      <div className="text-[11px] text-[color:var(--warning)]">
        Artifacts unavailable: {q.data.artifacts_error}
      </div>
    );
  }
  if (artifacts.length === 0) {
    return (
      <div className="text-[11px] text-muted">
        No downloadable artifacts for this run.
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted">
        Artifacts ({artifacts.length})
      </div>
      <ul className="space-y-0.5">
        {artifacts.map((a) => (
          <li key={a.path} className="flex items-center gap-2 text-[11px]">
            <a
              href={api.aiFactory.aiperfArtifactUrl(runId, a.path)}
              download
              className="inline-flex items-center gap-1 text-accent-cyan hover:underline font-mono break-all"
            >
              <Download className="h-3 w-3 shrink-0" />
              {a.path}
            </a>
            <span className="text-muted whitespace-nowrap">{bytes(a.size)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AiperfRow({ run }: { run: AiFactoryAiperfRun }) {
  const [open, setOpen] = useState(false);
  const busy = run.state === "pending" || run.state === "running";
  const done = run.state === "passed" || run.state === "failed";
  const metrics = metricsOf(run.summary);
  const levels = levelsOf(run.summary);
  const error = errorOf(run.summary);

  const detail = useQuery({
    queryKey: ["aiFactory", "aiperfRun", run.id],
    queryFn: () => api.aiFactory.aiperfRun(run.id),
    enabled: open,
    refetchInterval: open && busy ? 5_000 : false,
  });

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
        <span className="text-xs font-medium">
          {run.via_gateway ? "Gateway" : "vLLM"} · c={run.concurrency}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 border text-[10px] uppercase tracking-wide",
            STATE_TONE[run.state]
          )}
        >
          {busy && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {run.state}
        </span>
        <span className="ml-auto text-[10px] text-muted whitespace-nowrap">
          {run.started_at ? new Date(run.started_at).toLocaleString() : "—"}
        </span>
      </button>

      {/* Headline metrics inline when the run produced them. */}
      {metrics && (
        <div className="px-3 pb-2.5 -mt-1 flex flex-wrap gap-2">
          {Object.entries(metrics).map(([k, v]) => {
            const meta = METRIC_LABEL[k] ?? [k, ""];
            return (
              <span
                key={k}
                className="text-[11px] rounded border border-line px-1.5 py-0.5 font-mono"
              >
                <span className="text-muted">{meta[0]}</span>{" "}
                {typeof v === "number" ? v.toFixed(1) : String(v)}
                {meta[1]}
              </span>
            );
          })}
        </div>
      )}

      {run.state === "error" && error && (
        <div className="px-3 pb-2.5 -mt-1">
          <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--critical)]">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span className="font-mono break-words">{error}</span>
          </div>
        </div>
      )}

      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div className="text-[11px] text-muted font-mono break-all">
            {run.model} → {run.target_url} · {run.endpoint_type} ·{" "}
            {run.request_count} req/level · in {run.input_tokens} / out{" "}
            {run.output_tokens}
          </div>

          {/* Per-concurrency SLO curve, parsed from the artifact JSONs. */}
          {levels.length > 0 && <ConcurrencyCurve levels={levels} />}

          {/* Downloadable structured artifacts (CSV/JSON/logs). */}
          {done && <ArtifactList runId={run.id} />}

          {detail.isLoading ? (
            <div className="text-[11px] text-muted">Loading output…</div>
          ) : (
            <pre className="text-[11px] font-mono bg-black/30 rounded-md p-3 overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto">
              {detail.data?.output ||
                error ||
                (run.summary
                  ? JSON.stringify(run.summary, null, 2)
                  : "(no output)")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
