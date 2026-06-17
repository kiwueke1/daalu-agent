"use client";

/**
 * Network & Server Management — the tenant-facing surface for the NV-CM
 * (NVIDIA Config Manager) stack the operator provisions per tenant.
 *
 * Reads the `config_manager` row from /integrations/config (the controller
 * writes it on provision: status + the resolved service URLs + components).
 * If present, shows the live stack (status badge, per-service links derived
 * from base_hostname, enabled components) and points at Operations for the
 * inventory + change-proposal flow. If absent, shows a provisioning form
 * (POST /onboarding/config-manager/provision — admin only; the backend
 * installs the chart and polls to `active`, which can take a few minutes).
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Network,
  ExternalLink,
  CheckCircle2,
  Server,
  ArrowRight,
} from "lucide-react";
import { api, IntegrationConfig } from "@/lib/api";

// Daalu components → label. `ui` has no upstream service of its own (it rides
// config-store), so it isn't a provisionable toggle here.
const COMPONENTS: { key: string; label: string; help: string }[] = [
  { key: "render", label: "Render service", help: "Renders intended config to vendor syntax" },
  { key: "configStore", label: "Config store", help: "Stores intended config + serves the config API" },
  { key: "temporal", label: "Temporal", help: "Workflow engine that drives deploys" },
  { key: "nautobot", label: "Nautobot (Source of Truth)", help: "Inventory, IPAM, intended config" },
  { key: "ztp", label: "Zero-touch provisioning", help: "Onboard new switches automatically" },
  { key: "dhcp", label: "DHCP (Kea)", help: "Bundled DHCP for ZTP" },
];

// Per-service human (browser) URLs. These are flat, single-label hosts
// served *through the hub* over the WireGuard tunnel (the backend computes
// them in compute_urls() and stores them on the config_manager integration
// config). We read them explicitly rather than deriving from base_hostname,
// which used to resolve to an unreachable in-cluster gateway IP. The vendor
// UIs are optional/read-mostly — Daalu drives the stack for you.
function serviceLinks(
  config: Record<string, unknown>,
): { label: string; url: string }[] {
  const get = (k: string) => {
    const v = config?.[k];
    return typeof v === "string" && v ? v : "";
  };
  const entries = [
    { label: "Config browser (UI)", url: get("ui_human") || get("ui_url") },
    { label: "Nautobot", url: get("nautobot_human") },
    { label: "Render", url: get("render_human") },
    { label: "Workflow", url: get("workflow_human") },
    { label: "Config store", url: get("config_store_human") },
  ];
  return entries.filter((e) => e.url);
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    connected: ["text-accent-emerald", "bg-accent-emerald"],
    error: ["text-red-500", "bg-red-500"],
  };
  const [text, dot] = map[status] ?? ["text-accent-amber", "bg-accent-amber"];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider ${text}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {status || "provisioning"}
    </span>
  );
}

export default function NetworkServerManagementPage() {
  const qc = useQueryClient();
  const { data: configs, isLoading } = useQuery({
    queryKey: ["integrations", "config"],
    queryFn: () => api.integrations.listConfig(),
    refetchInterval: 15000,
  });

  const cm = useMemo(
    () => (configs ?? []).find((c) => c.provider === "config_manager"),
    [configs],
  );

  // NV-CM provisioning needs the config-manager-controller (Kubernetes
  // installs). On a laptop/Compose deploy it's unavailable, so we hide the
  // provision form and show a note rather than a button that 503s.
  const { data: onboarding } = useQuery({
    queryKey: ["onboarding", "status"],
    queryFn: () => api.onboarding.status(),
  });
  const cmAvailable = onboarding?.config_manager_available ?? false;

  // Provision form state (only shown when there's no stack yet).
  const [picked, setPicked] = useState<Record<string, boolean>>({
    render: true,
    configStore: true,
    temporal: true,
    nautobot: true,
    ztp: false,
    dhcp: false,
  });
  const [size, setSize] = useState("small");

  const provision = useMutation({
    mutationFn: () =>
      api.onboarding.provisionConfigManager({ components: picked, size_profile: size }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations", "config"] }),
  });

  return (
    <div className="space-y-8 max-w-[1100px]">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Network className="h-5 w-5 text-accent-cyan" /> Network &amp; server management
        </h1>
        <p className="text-muted text-sm mt-1">
          Daalu manages your network switches and bare-metal servers through a
          per-tenant NVIDIA Config Manager stack. Provision it once here; then
          work the inventory and approve changes in{" "}
          <a href="/operations" className="underline">Operations</a> — Daalu
          drives the underlying services for you.
        </p>
      </div>

      {isLoading ? (
        <div className="text-muted text-sm">Loading…</div>
      ) : cm ? (
        <ProvisionedView cm={cm} />
      ) : !cmAvailable ? (
        <section className="rounded-2xl border border-line bg-bg-card p-6 space-y-3">
          <h2 className="text-base font-medium flex items-center gap-2">
            <Server className="h-4 w-4 text-accent-cyan" /> Available on Kubernetes
            installs
          </h2>
          <p className="text-muted text-sm max-w-[640px]">
            The NVIDIA Config Manager stack (Nautobot, Render, Temporal, config
            store) is provisioned into a Kubernetes cluster by the
            config-manager-controller. This deployment doesn&apos;t have that
            controller configured — typical for a laptop / Docker Compose
            install — so network &amp; server management is turned off here.
          </p>
          <p className="text-muted text-sm max-w-[640px]">
            To enable it, run Daalu on Kubernetes, set{" "}
            <code className="font-mono text-xs">config_manager_controller_url</code>,
            and start the controller (
            <code className="font-mono text-xs">daalu config-manager-controller</code>
            ). The stack and its service consoles will then appear here.
          </p>
        </section>
      ) : (
        <section className="rounded-2xl border border-line bg-bg-card p-5 space-y-4">
          <div>
            <h2 className="text-base font-medium">Provision the management stack</h2>
            <p className="text-muted text-sm mt-1">
              Pick the components you need and a size. Daalu builds the stack in
              your environment — first run takes a few minutes.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {COMPONENTS.map((c) => (
              <label
                key={c.key}
                className="flex items-start gap-2 rounded-xl border border-line p-3 cursor-pointer hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={!!picked[c.key]}
                  onChange={(e) => setPicked((p) => ({ ...p, [c.key]: e.target.checked }))}
                />
                <span>
                  <span className="text-sm font-medium">{c.label}</span>
                  <span className="block text-xs text-muted">{c.help}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm text-muted">Size</label>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="rounded-lg border border-line bg-bg-card px-3 py-1.5 text-sm"
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </div>
          <button
            onClick={() => provision.mutate()}
            disabled={provision.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-accent-emerald/90 px-4 py-2 text-sm font-medium text-black hover:bg-accent-emerald disabled:opacity-60"
          >
            {provision.isPending ? "Provisioning… (this can take a few minutes)" : "Provision stack"}
          </button>
          {provision.isError && (
            <p className="text-red-500 text-sm">
              {(provision.error as Error)?.message || "Provisioning failed"}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function ProvisionedView({ cm }: { cm: IntegrationConfig }) {
  const baseHostname = String(cm.config?.base_hostname ?? "");
  const components = (cm.config?.components ?? {}) as Record<string, boolean>;
  const enabled = COMPONENTS.filter((c) => components[c.key]);
  const links = serviceLinks((cm.config ?? {}) as Record<string, unknown>);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-bg-card p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-medium flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-accent-emerald" />
              NVIDIA Config Manager
            </h2>
            <p className="text-muted text-sm mt-1">
              {baseHostname ? (
                <>Stack at <span className="text-fg">{baseHostname}</span></>
              ) : (
                "Per-tenant management stack"
              )}
            </p>
          </div>
          <StatusBadge status={cm.status} />
        </div>

        {enabled.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {enabled.map((c) => (
              <span
                key={c.key}
                className="text-[11px] rounded-full border border-line px-2 py-0.5 text-muted"
              >
                {c.label}
              </span>
            ))}
          </div>
        )}

        {links.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs uppercase tracking-wider text-muted">Service consoles</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {links.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm hover:bg-white/5"
                >
                  <span>{l.label}</span>
                  <ExternalLink className="h-3.5 w-3.5 text-muted" />
                </a>
              ))}
            </div>
            <p className="text-[11px] text-muted">
              Vendor consoles are optional and read-mostly — you log in with your
              org SSO. Day-to-day, drive changes from Operations.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-bg-card p-5">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Server className="h-4 w-4 text-accent-cyan" /> Inventory &amp; changes
        </h3>
        <p className="text-muted text-sm mt-1">
          Onboard switches and servers, review drift, and approve change
          proposals in Operations. Approved changes run through the stack with
          commit-confirm rollback.
        </p>
        <a
          href="/operations"
          className="mt-3 inline-flex items-center gap-1.5 text-sm text-accent-emerald hover:underline"
        >
          Open Operations <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </section>
    </div>
  );
}
