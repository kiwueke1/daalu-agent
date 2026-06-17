"use client";

/**
 * Per-cluster detail page (/clusters/[slug]).
 *
 * Two surfaces against a customer cluster reached over the WireGuard mesh:
 *  - Overview: server version, node inventory, namespace count.
 *  - kubectl console: tick one or more read-only commands from the
 *    server's allowlist, choose an output format (json / yaml / cli
 *    table), and run them through the tunnel.
 *
 * This is the first instance of a pattern we intend to reuse for other
 * managed infra (Prometheus, logs, cloud): a detail page + an
 * allowlisted, format-selectable command runner. See the engineer book
 * chapter "The managed-infra console pattern".
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Boxes,
  Copy,
  Cpu,
  Layers,
  Play,
  Server,
  Terminal,
} from "lucide-react";
import {
  api,
  type ClusterStatus,
  type KubectlCommandSpec,
  type KubectlOutput,
  type KubectlResult,
} from "@/lib/api";

const STATUS_BADGE: Record<ClusterStatus, { dot: string; label: string }> = {
  pending: { dot: "bg-muted/60", label: "pending" },
  awaiting_handshake: { dot: "bg-accent-amber", label: "awaiting handshake" },
  connected: { dot: "bg-accent-emerald", label: "connected" },
  degraded: { dot: "bg-accent-amber", label: "degraded" },
  error: { dot: "bg-red-500", label: "error" },
};

const OUTPUT_OPTIONS: { id: KubectlOutput; label: string }[] = [
  { id: "cli", label: "CLI table" },
  { id: "json", label: "JSON" },
  { id: "yaml", label: "YAML" },
];

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function nodeAge(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor(
    (Date.now() - new Date(iso).getTime()) / 86_400_000
  );
  if (days >= 1) return `${days}d`;
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return `${hours}h`;
}

export default function ClusterDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const { data: cluster, isLoading: clusterLoading } = useQuery({
    queryKey: ["cluster", slug],
    queryFn: () => api.clusters.get(slug),
    enabled: !!slug,
    refetchInterval: 30_000,
  });

  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ["cluster-overview", slug],
    queryFn: () => api.clusters.overview(slug),
    enabled: !!slug,
    refetchInterval: 60_000,
  });

  if (clusterLoading) {
    return <div className="p-6 text-sm text-muted">Loading cluster…</div>;
  }
  if (!cluster) {
    return (
      <div className="p-6 text-sm text-muted">
        Cluster not found.{" "}
        <Link href="/managed-infra" className="underline">
          Back to managed infra
        </Link>
      </div>
    );
  }

  const badge = STATUS_BADGE[cluster.status];

  return (
    <div className="space-y-6 max-w-[1100px]">
      <div>
        <Link
          href="/managed-infra"
          className="text-xs text-muted hover:text-fg inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Managed infra
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <Boxes className="h-5 w-5 text-accent-cyan" />
          <h1 className="text-2xl font-semibold">{cluster.name}</h1>
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted">
            <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
            {badge.label}
          </span>
        </div>
        <div className="text-xs text-muted mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            slug <span className="font-mono">{cluster.slug}</span>
          </span>
          {cluster.tunnel_ip && (
            <span>
              tunnel IP <span className="font-mono">{cluster.tunnel_ip}</span>
            </span>
          )}
          <span>last checked {timeAgo(cluster.last_handshake_at)}</span>
        </div>
      </div>

      {/* ── Overview ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        {overviewLoading && (
          <div className="text-sm text-muted">Reading cluster…</div>
        )}
        {overview && !overview.reachable && (
          <div className="rounded-2xl border border-accent-amber/40 bg-accent-amber/5 p-4 text-sm">
            <div className="font-medium text-accent-amber">
              Cluster not reachable
            </div>
            <p className="text-xs text-muted mt-1">
              {overview.error ||
                "No Kubernetes credentials are linked to this cluster yet. Add a Kubernetes integration whose kubeconfig points at the tunnel IP, then reload."}
            </p>
          </div>
        )}
        {overview && overview.reachable && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatCard
                icon={Server}
                label="Server version"
                value={overview.server_version || "—"}
              />
              <StatCard
                icon={Cpu}
                label="Nodes"
                value={String(overview.node_count)}
              />
              <StatCard
                icon={Layers}
                label="Namespaces"
                value={String(overview.namespace_count)}
              />
            </div>
            <NodesTable nodes={overview.nodes} />
          </>
        )}
      </section>

      {/* ── kubectl console ──────────────────────────────────────────── */}
      <KubectlConsole slug={slug} reachable={overview?.reachable ?? false} />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Server;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-bg-card p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-1.5 text-lg font-mono">{value}</div>
    </div>
  );
}

function NodesTable({
  nodes,
}: {
  nodes: import("@/lib/api").ClusterNode[];
}) {
  return (
    <div className="rounded-2xl border border-line bg-bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg-elevated/40 text-[11px] uppercase tracking-wider text-muted">
          <tr>
            <th className="text-left px-4 py-2 font-normal">Node</th>
            <th className="text-left px-4 py-2 font-normal">Status</th>
            <th className="text-left px-4 py-2 font-normal">Roles</th>
            <th className="text-left px-4 py-2 font-normal">Version</th>
            <th className="text-left px-4 py-2 font-normal">Internal IP</th>
            <th className="text-left px-4 py-2 font-normal">CPU</th>
            <th className="text-left px-4 py-2 font-normal">Memory</th>
            <th className="text-left px-4 py-2 font-normal">Age</th>
          </tr>
        </thead>
        <tbody>
          {nodes.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-6 text-center text-muted">
                No nodes returned.
              </td>
            </tr>
          )}
          {nodes.map((n) => (
            <tr key={n.name} className="border-t border-line">
              <td className="px-4 py-3">
                <div className="font-medium">{n.name}</div>
                {n.os_image && (
                  <div className="text-[11px] text-muted">{n.os_image}</div>
                )}
              </td>
              <td className="px-4 py-3">
                <span
                  className={
                    n.status.startsWith("Ready")
                      ? "text-accent-emerald text-xs"
                      : "text-accent-amber text-xs"
                  }
                >
                  {n.status}
                </span>
              </td>
              <td className="px-4 py-3 text-xs">{n.roles.join(", ")}</td>
              <td className="px-4 py-3 font-mono text-xs">{n.version}</td>
              <td className="px-4 py-3 font-mono text-xs">
                {n.internal_ip || "—"}
              </td>
              <td className="px-4 py-3 font-mono text-xs">{n.cpu || "—"}</td>
              <td className="px-4 py-3 font-mono text-xs">
                {n.memory || "—"}
              </td>
              <td className="px-4 py-3 text-xs text-muted">
                {nodeAge(n.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── kubectl console ───────────────────────────────────────────────────

function KubectlConsole({
  slug,
  reachable,
}: {
  slug: string;
  reachable: boolean;
}) {
  const { data: catalog } = useQuery({
    queryKey: ["kubectl-catalog"],
    queryFn: () => api.clusters.kubectlCatalog(),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [namespace, setNamespace] = useState("");
  const [selector, setSelector] = useState("");
  const [output, setOutput] = useState<KubectlOutput>("cli");

  const run = useMutation({
    mutationFn: () =>
      api.clusters.runKubectl(slug, {
        command_ids: [...selected],
        namespace: namespace.trim() || null,
        label_selector: selector.trim() || null,
        output,
      }),
  });

  const grouped = useMemo(() => {
    const map: Record<string, KubectlCommandSpec[]> = {};
    for (const c of catalog ?? []) {
      (map[c.group] ??= []).push(c);
    }
    return map;
  }, [catalog]);

  const anyNamespaced = useMemo(
    () =>
      (catalog ?? []).some(
        (c) => selected.has(c.id) && c.namespaced
      ),
    [catalog, selected]
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-medium flex items-center gap-2">
          <Terminal className="h-4 w-4 text-accent-cyan" /> kubectl commands
        </h2>
        <p className="text-xs text-muted mt-0.5 max-w-[820px]">
          Pick one or more read-only commands, choose an output format, and
          Daalu runs them on the cluster over the tunnel. Everything here is
          read-only — there is no way to mutate the cluster from this panel.
        </p>
      </div>

      <div className="rounded-2xl border border-line bg-bg-card p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
          {Object.entries(grouped).map(([group, cmds]) => (
            <div key={group} className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-muted">
                {group}
              </div>
              {cmds.map((c) => (
                <label
                  key={c.id}
                  className="flex items-start gap-2 text-sm cursor-pointer hover:text-fg"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="mt-1 accent-[color:var(--accent)]"
                  />
                  <span>
                    <span>{c.label}</span>
                    <span className="block text-[11px] text-muted font-mono">
                      {c.kubectl}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <label className="text-xs space-y-1">
            <div className="text-muted uppercase tracking-wider">
              Namespace {anyNamespaced ? "" : "(n/a)"}
            </div>
            <input
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="all namespaces"
              className="h-9 px-3 rounded-lg bg-bg-elevated/60 border border-line text-sm w-48"
            />
          </label>
          <label className="text-xs space-y-1">
            <div className="text-muted uppercase tracking-wider">
              Label selector
            </div>
            <input
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              placeholder="app=checkout"
              className="h-9 px-3 rounded-lg bg-bg-elevated/60 border border-line text-sm w-56"
            />
          </label>
          <label className="text-xs space-y-1">
            <div className="text-muted uppercase tracking-wider">Output</div>
            <div className="flex rounded-lg border border-line overflow-hidden">
              {OUTPUT_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setOutput(o.id)}
                  className={
                    "h-9 px-3 text-xs " +
                    (output === o.id
                      ? "bg-accent-cyan/15 text-accent-cyan"
                      : "text-muted hover:text-fg")
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          </label>
          <button
            type="button"
            disabled={selected.size === 0 || !reachable || run.isPending}
            onClick={() => run.mutate()}
            className="h-9 px-4 rounded-lg bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan text-sm disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Play className="h-3.5 w-3.5" />
            {run.isPending
              ? "Running…"
              : `Run${selected.size ? ` (${selected.size})` : ""}`}
          </button>
        </div>
        {!reachable && (
          <p className="text-[11px] text-accent-amber">
            Cluster is not reachable — commands are disabled until the tunnel
            is connected and Kubernetes credentials are linked.
          </p>
        )}
        {run.error && (
          <p className="text-[11px] text-red-500">
            {String(run.error.message || run.error)}
          </p>
        )}
      </div>

      {run.data && (
        <div className="space-y-3">
          {run.data.results.map((r) => (
            <ResultBlock key={r.id} result={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function ResultBlock({ result }: { result: KubectlResult }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-2xl border border-line bg-bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-bg-elevated/40 border-b border-line">
        <code className="text-xs font-mono">
          {result.command}{" "}
          {!result.ok && <span className="text-red-500">— failed</span>}
        </code>
        {result.ok && result.output && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(result.output);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="text-[11px] h-7 px-2 rounded-md border border-line hover:bg-bg-elevated/60 inline-flex items-center gap-1"
          >
            <Copy className="h-3 w-3" /> {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <pre className="text-xs p-3 overflow-x-auto whitespace-pre">
        {result.ok ? result.output || "(empty)" : result.error}
      </pre>
    </div>
  );
}
