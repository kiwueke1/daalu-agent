"use client";

/**
 * GpuOnboardWizard — the UI "Add GPU" flow for a self-hosted cluster.
 *
 * Mirrors the observability connect-modal: it discovers the GPUs the connected
 * cluster advertises (via /ai-factory/gpu/discover), pre-fills a small form
 * (GPU class, served model, namespace, endpoint), and on submit calls
 * /ai-factory/gpu/onboard — which stamps the tenant-labelled DCGM ServiceMonitor
 * and writes the gpu_tenants owner row. On success the AI Factory overview is
 * invalidated and the page flips to the live GPU view. This is the UI
 * equivalent of scripts/onboard-cluster.sh (a)+(b).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  Server,
  X,
} from "lucide-react";
import { api, type GpuOnboardResult } from "@/lib/api";

export function GpuOnboardWizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();

  const discover = useQuery({
    queryKey: ["aiFactory", "gpuDiscover"],
    queryFn: api.aiFactory.discoverGpu,
    refetchOnWindowFocus: false,
  });

  const [gpuClass, setGpuClass] = useState("");
  const [model, setModel] = useState("");
  const [namespace, setNamespace] = useState("daalu");
  const [serviceUrl, setServiceUrl] = useState("");
  const [result, setResult] = useState<GpuOnboardResult | null>(null);

  // Pre-fill from discovery once it lands (only if the user hasn't typed).
  const d = discover.data;
  useEffect(() => {
    if (!d) return;
    setGpuClass((v) => v || d.suggested_gpu_class || "");
    setModel((v) => v || d.suggested_model || "");
    setServiceUrl((v) => v || d.suggested_service_url || "");
  }, [d]);

  const onboard = useMutation({
    mutationFn: () =>
      api.aiFactory.onboardGpu({
        gpu_class: gpuClass.trim(),
        model_classifier: model.trim(),
        namespace: namespace.trim() || "daalu",
        service_url: serviceUrl.trim() || null,
      }),
    onSuccess: (res) => {
      setResult(res);
      qc.invalidateQueries({ queryKey: ["aiFactory", "overview"] });
      qc.invalidateQueries({ queryKey: ["aiFactory", "summary"] });
    },
  });

  const reachable = d?.reachable ?? false;
  const hasGpus = (d?.total_gpus ?? 0) > 0;
  const canSubmit =
    reachable && hasGpus && gpuClass.trim() !== "" && model.trim() !== "";

  return (
    <div
      className="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm flex items-start justify-center p-4 pt-16 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[640px] rounded-2xl border border-line bg-bg-card p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Cpu className="h-5 w-5 text-accent-cyan" /> Add GPU
            </h2>
            <p className="text-xs text-muted mt-1 max-w-[480px]">
              Daalu inspects the connected cluster, then onboards the GPU for
              this tenant — it stamps the DCGM metrics with your tenant and
              lights up the AI Factory floor. No CLI required.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-fg p-1 -m-1"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Result view ─────────────────────────────────────────────── */}
        {result ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-accent-emerald/40 bg-accent-emerald/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-accent-emerald">
                <CheckCircle2 className="h-4 w-4" /> GPU onboarded
              </div>
              <p className="text-xs text-muted mt-1">
                Role is now <span className="font-mono">{result.role}</span>.{" "}
                {result.metrics_available && result.dcgm_scrapeable
                  ? "Live metrics are flowing — the factory floor will populate momentarily."
                  : "Metrics will appear within ~30s once Prometheus scrapes the tenant-labelled DCGM series."}
              </p>
            </div>
            {result.warnings.length > 0 && (
              <ul className="space-y-1.5">
                {result.warnings.map((w, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-xs text-accent-amber"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="h-9 px-4 rounded-lg bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan text-sm"
              >
                Done
              </button>
            </div>
          </div>
        ) : discover.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted py-6 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Discovering GPUs on the
            cluster…
          </div>
        ) : !reachable ? (
          <div className="rounded-xl border border-accent-amber/40 bg-accent-amber/5 p-4 text-sm">
            <div className="font-medium text-accent-amber flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Cluster not reachable
            </div>
            <p className="text-xs text-muted mt-1">
              {d?.error ||
                "Daalu can't read the cluster yet."}{" "}
              Add it under{" "}
              <Link href="/managed-infra" className="underline">
                Managed infra → Kubernetes
              </Link>{" "}
              first, then reopen this wizard.
            </p>
          </div>
        ) : !hasGpus ? (
          <div className="rounded-xl border border-accent-amber/40 bg-accent-amber/5 p-4 text-sm">
            <div className="font-medium text-accent-amber flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> No GPUs found
            </div>
            <p className="text-xs text-muted mt-1">
              The cluster is reachable but advertises no{" "}
              <code className="font-mono">nvidia.com/gpu</code> capacity. Make
              sure the NVIDIA GPU Operator is installed and the node is Ready.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Discovered GPUs */}
            <div className="rounded-xl border border-line bg-bg-elevated/40 p-3 space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-muted">
                Discovered — {d?.total_gpus} GPU
                {(d?.total_gpus ?? 0) === 1 ? "" : "s"}
              </div>
              {d?.nodes.map((n) => (
                <div
                  key={n.name}
                  className="flex items-center gap-2 text-sm"
                >
                  <Server className="h-3.5 w-3.5 text-accent-cyan shrink-0" />
                  <span className="font-medium">{n.name}</span>
                  <span className="text-muted text-xs">
                    {n.gpu_count}× {n.gpu_product || "GPU"}
                    {n.gpu_memory ? ` · ${n.gpu_memory}` : ""}
                    {n.ready ? "" : " · NotReady"}
                  </span>
                </div>
              ))}
            </div>

            {/* Prometheus warning */}
            {d && !d.prometheus_connected && (
              <p className="flex items-start gap-2 text-xs text-accent-amber">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                No Prometheus integration is connected — add one under{" "}
                <Link href="/managed-infra" className="underline">
                  Managed infra → Observability
                </Link>{" "}
                so the metric cards can populate. You can still onboard now.
              </p>
            )}

            {/* Form */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                label="GPU class"
                value={gpuClass}
                onChange={setGpuClass}
                placeholder="ada-48"
                help="A display label for this card class."
              />
              <Field
                label="Served model"
                value={model}
                onChange={setModel}
                placeholder="qwen3-coder-30b"
                help="The model the agent reasons on."
              />
              <Field
                label="Namespace"
                value={namespace}
                onChange={setNamespace}
                placeholder="daalu"
              />
              <Field
                label="Inference endpoint"
                value={serviceUrl}
                onChange={setServiceUrl}
                placeholder="http://host.docker.internal:30800/v1"
              />
            </div>

            {onboard.error && (
              <p className="text-[11px] text-red-500">
                {String(
                  (onboard.error as Error)?.message || onboard.error
                )}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="h-9 px-4 rounded-lg border border-line text-sm text-muted hover:text-fg"
              >
                Cancel
              </button>
              <button
                disabled={!canSubmit || onboard.isPending}
                onClick={() => onboard.mutate()}
                className="h-9 px-4 rounded-lg bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan text-sm disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {onboard.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Onboarding…
                  </>
                ) : (
                  <>
                    <Cpu className="h-3.5 w-3.5" /> Onboard GPU
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  help?: string;
}) {
  return (
    <label className="text-xs space-y-1 block">
      <div className="text-muted uppercase tracking-wider">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 px-3 rounded-lg bg-bg-elevated/60 border border-line text-sm w-full font-mono"
      />
      {help && <div className="text-[10px] text-muted normal-case">{help}</div>}
    </label>
  );
}
