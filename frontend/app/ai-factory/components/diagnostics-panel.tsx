"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Stethoscope,
  Loader2,
  Play,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import {
  api,
  type AiFactoryDiagKind,
  type AiFactoryDiagRun,
  type AiFactoryDiagState,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Admin-only GPU diagnostics. "Run dcgmi diag" (level 1/2/3) and "Run NCCL
 * test" (multi-GPU only). The runs table polls every ~4s while any run is
 * pending/running so freshly-kicked diagnostics surface their result
 * without a manual refresh.
 */
type RunBody = { kind: AiFactoryDiagKind; level?: 1 | 2 | 3; acknowledged?: boolean };

export function DiagnosticsPanel({ gpuClass }: { gpuClass: string | null }) {
  const qc = useQueryClient();
  const [level, setLevel] = useState<1 | 2 | 3>(1);
  const [err, setErr] = useState<string | null>(null);
  // When a stressful run needs confirmation, the backend returns the warning
  // and we hold the pending request here to re-submit on acknowledge.
  const [ackPrompt, setAckPrompt] = useState<{
    body: RunBody;
    warning: string;
  } | null>(null);

  const runs = useQuery({
    queryKey: ["aiFactory", "diagnostics"],
    queryFn: api.aiFactory.diagnostics,
    refetchInterval: (q) => {
      const data = q.state.data as { runs?: AiFactoryDiagRun[] } | undefined;
      const busy = (data?.runs ?? []).some(
        (r) => r.state === "pending" || r.state === "running"
      );
      return busy ? 4_000 : 30_000;
    },
  });

  const run = useMutation({
    mutationFn: (body: RunBody) => api.aiFactory.runDiagnostic(body),
    onMutate: () => setErr(null),
    onSuccess: (result, body) => {
      if (result.requiresAck) {
        // Surface the warning + hold the request for an explicit ack.
        setAckPrompt({ body, warning: result.warning });
        return;
      }
      setAckPrompt(null);
      qc.invalidateQueries({ queryKey: ["aiFactory", "diagnostics"] });
    },
    onError: (e: unknown) =>
      setErr(e instanceof Error ? e.message : "failed to start diagnostic"),
  });

  // NCCL is multi-GPU only. We can't always know the GPU count, but a
  // single-card class (anything not hinting "x2"/"x4"/"8x"/"multi") gets
  // the button disabled with an explanatory tooltip.
  const nccl = ncclEligible(gpuClass);

  return (
    <section className="rounded-xl border border-line bg-[color:var(--bg-elevated)]/40 p-5">
      <h3 className="text-sm font-medium flex items-center gap-1.5">
        <Stethoscope className="h-4 w-4 text-accent-emerald" /> Diagnostics
        <span className="text-[10px] text-muted font-normal ml-1 uppercase tracking-wide">
          admin
        </span>
      </h3>
      <p className="text-xs text-muted mt-1 max-w-[560px]">
        Run on-demand GPU diagnostics against the factory floor. dcgmi diag
        is a quick health pass; NCCL exercises multi-GPU interconnect.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-2">
          <label className="text-xs text-muted">Level</label>
          <select
            value={level}
            onChange={(e) => setLevel(Number(e.target.value) as 1 | 2 | 3)}
            className="rounded-md border border-line bg-bg-base px-2 py-1.5 text-xs"
          >
            <option value={1}>1 — quick</option>
            <option value={2}>2 — medium</option>
            <option value={3}>3 — long</option>
          </select>
          <button
            type="button"
            disabled={run.isPending}
            onClick={() => run.mutate({ kind: "dcgmi_diag", level })}
            className="text-xs h-8 px-3 rounded-lg bg-gradient-to-r from-accent-emerald to-accent-cyan text-bg-base inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            {run.isPending && run.variables?.kind === "dcgmi_diag" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run dcgmi diag
          </button>
        </div>

        <span title={nccl ? undefined : "multi-GPU only"} className="inline-flex">
          <button
            type="button"
            disabled={run.isPending || !nccl}
            onClick={() => run.mutate({ kind: "nccl_test" })}
            className={cn(
              "text-xs h-8 px-3 rounded-lg border inline-flex items-center gap-1.5 transition-colors",
              nccl
                ? "border-accent-emerald/60 text-[color:var(--text)] hover:bg-accent-emerald/15 disabled:opacity-60"
                : "border-line text-muted cursor-not-allowed opacity-60"
            )}
          >
            {run.isPending && run.variables?.kind === "nccl_test" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run NCCL test
          </button>
        </span>
      </div>

      {!nccl && (
        <div className="mt-2 text-[11px] text-muted">
          NCCL test is disabled — it measures the GPU-to-GPU interconnect, which
          needs more than one GPU. This node has a single card.
        </div>
      )}

      {err && (
        <div className="mt-3 text-[11px] text-[color:var(--critical)] flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3" /> {err}
        </div>
      )}

      {/* Runs table */}
      <div className="mt-4 space-y-2">
        {(runs.data?.runs ?? []).length === 0 ? (
          <div className="text-xs text-muted">No diagnostic runs yet.</div>
        ) : (
          (runs.data?.runs ?? []).map((r) => <DiagRow key={r.id} run={r} />)
        )}
      </div>

      {ackPrompt && (
        <AckModal
          warning={ackPrompt.warning}
          busy={run.isPending}
          onCancel={() => setAckPrompt(null)}
          onConfirm={() =>
            run.mutate({ ...ackPrompt.body, acknowledged: true })
          }
        />
      )}
    </section>
  );
}

function AckModal({
  warning,
  busy,
  onConfirm,
  onCancel,
}: {
  warning: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-xl border border-[color:var(--warning)]/40 bg-[color:var(--bg-elevated)] p-5 shadow-xl">
        <h4 className="text-sm font-semibold flex items-center gap-2 text-[color:var(--warning)]">
          <AlertTriangle className="h-4 w-4" /> This run stresses the GPU
        </h4>
        <p className="text-xs text-muted mt-3 leading-relaxed">{warning}</p>
        <p className="text-[11px] text-muted mt-3">
          This is a shared production card. Make sure you understand the impact
          before continuing.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs h-8 px-3 rounded-lg border border-line text-muted hover:text-[color:var(--text)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="text-xs h-8 px-3 rounded-lg bg-[color:var(--warning)]/90 text-bg-base font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            I understand — run it
          </button>
        </div>
      </div>
    </div>
  );
}

function ncclEligible(gpuClass: string | null): boolean {
  if (!gpuClass) return false;
  const c = gpuClass.toLowerCase();
  // Heuristic: a class that advertises a count > 1 or "multi". Single-card
  // classes (e.g. "ada-16", "a100-80") fall through to disabled.
  return /(?:^|[^0-9])(?:x|×)?(?:2|4|8)\b|multi|x2|x4|x8|8x/.test(c);
}

const STATE_TONE: Record<AiFactoryDiagState, string> = {
  pending: "border-line text-muted",
  running: "border-accent-emerald/40 text-[color:var(--text)]",
  passed: "border-accent-emerald/40 text-[color:var(--text)] bg-accent-emerald/10",
  failed: "border-[color:var(--critical)]/40 text-[color:var(--critical)] bg-[color:var(--critical)]/10",
  error: "border-[color:var(--warning)]/40 text-[color:var(--warning)] bg-[color:var(--warning)]/10",
};

function summaryString(
  summary: Record<string, unknown> | null,
  key: string
): string | null {
  const v = summary?.[key];
  return typeof v === "string" ? v : null;
}

function DiagRow({ run }: { run: AiFactoryDiagRun }) {
  const [open, setOpen] = useState(false);
  const busy = run.state === "pending" || run.state === "running";

  // Lazily fetch the full run (incl. output) only when expanded.
  const detail = useQuery({
    queryKey: ["aiFactory", "diagnostic", run.id],
    queryFn: () => api.aiFactory.diagnostic(run.id),
    enabled: open,
    refetchInterval: open && busy ? 4_000 : false,
  });

  const label =
    run.kind === "dcgmi_diag"
      ? `dcgmi diag${run.level ? ` · L${run.level}` : ""}`
      : "NCCL test";

  // The actual failure reason lives in summary.error (the run may carry no
  // stdout at all). Surface it directly so a failed run isn't a bare "error".
  const errorMsg = summaryString(run.summary, "error");
  const command = summaryString(run.summary, "command");
  const isBad = run.state === "error" || run.state === "failed";

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
        <span className="text-xs font-medium">{label}</span>
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

      {/* Always-visible failure reason (no need to expand). */}
      {isBad && errorMsg && (
        <div className="px-3 pb-2.5 -mt-1">
          <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--critical)]">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span className="font-mono break-words">{errorMsg}</span>
          </div>
        </div>
      )}

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {command && (
            <div className="text-[11px] text-muted font-mono">$ {command}</div>
          )}
          {detail.isLoading ? (
            <div className="text-[11px] text-muted">Loading output…</div>
          ) : (
            <pre className="text-[11px] font-mono bg-black/30 rounded-md p-3 overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto">
              {detail.data?.output ||
                errorMsg ||
                (run.summary ? JSON.stringify(run.summary, null, 2) : "(no output)")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
