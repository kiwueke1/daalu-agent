"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import { api, type IntegrationConfig } from "@/lib/api";
import { ConnectModal } from "@/components/integrations/connect-modal";
import { STEPS, type IntegrationStep } from "@/components/integrations/steps";

/**
 * The page renders two kinds of cards:
 *
 * 1. **Ingest adapters** — backed by the backend integration registry
 *    (`/integrations`). Each exposes a `Run ingest` button.
 * 2. **Channels** — config-only providers (SMTP, Slack) that don't have
 *    an ingest adapter; other code (notify.send_email,
 *    notify.send_slack) reads their config. These get a `Configure`
 *    button that opens the wizard step in a modal.
 */
const CHANNEL_STEP_IDS = ["email", "slack"];

export default function IntegrationsPage() {
  const qc = useQueryClient();
  const { data: adapters } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.integrations.list(),
  });
  const { data: tenantConfigs } = useQuery({
    queryKey: ["integrations", "config"],
    queryFn: () => api.integrations.listConfig(),
  });
  const ingest = useMutation({
    mutationFn: (provider: string) => api.integrations.ingest(provider),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["events"] }),
  });

  const [editing, setEditing] = useState<IntegrationStep | null>(null);

  const channelSteps = STEPS.filter((s) => CHANNEL_STEP_IDS.includes(s.id));
  const configByProvider: Record<string, IntegrationConfig> = {};
  for (const c of tenantConfigs ?? []) {
    configByProvider[c.provider] = c;
  }

  return (
    <div className="space-y-8 max-w-[1200px]">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Cable className="h-5 w-5 text-accent-cyan" /> Integrations
        </h1>
        <p className="text-muted text-sm mt-1">
          Connect a CRM, monitoring stack, ticketing system. The mock adapters
          generate synthetic data so the UI is meaningful before any external
          system is wired up.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider">
          Notification channels
        </h2>
        <p className="text-[12px] text-muted -mt-2">
          Outbound only — Daalu sends invites, briefings, and incident
          notifications through these. Required for the team-invite email path.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {channelSteps.map((step) => {
            const cfg = step.provider ? configByProvider[step.provider] : undefined;
            const configured = !!cfg;
            return (
              <div
                key={step.id}
                className="rounded-2xl border border-line bg-bg-card p-4"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium">{step.title}</span>
                      <span
                        className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${
                          configured
                            ? "bg-accent-emerald/15 text-accent-emerald"
                            : "bg-accent-amber/15 text-accent-amber"
                        }`}
                      >
                        {configured ? "configured" : "needs setup"}
                      </span>
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-muted mt-1">
                      channel · {step.provider}
                    </div>
                  </div>
                  <button
                    onClick={() => setEditing(step)}
                    className="text-xs h-8 px-3 rounded-lg border border-line hover:bg-bg-elevated/60 flex items-center gap-1"
                  >
                    <SettingsIcon className="h-3 w-3" />
                    {configured ? "Edit" : "Configure"}
                  </button>
                </div>
                <p className="text-sm text-[color:var(--text)]/70 mt-2">
                  {step.description}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider">
          Ingest sources
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(adapters ?? []).map((i) => (
            <div
              key={i.provider}
              className="rounded-2xl border border-line bg-bg-card p-4"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-medium">{i.display_name}</span>
                    <span
                      className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${
                        i.configured
                          ? "bg-accent-emerald/15 text-accent-emerald"
                          : "bg-accent-amber/15 text-accent-amber"
                      }`}
                    >
                      {i.configured ? "configured" : "needs setup"}
                    </span>
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-muted mt-1">
                    {i.module} · {i.provider}
                  </div>
                </div>
                <button
                  onClick={() => ingest.mutate(i.provider)}
                  className="text-xs h-8 px-3 rounded-lg border border-line hover:bg-bg-elevated/60 flex items-center gap-1"
                >
                  <RefreshCw
                    className={`h-3 w-3 ${ingest.isPending ? "animate-spin" : ""}`}
                  />
                  Run ingest
                </button>
              </div>
              <p className="text-sm text-[color:var(--text)]/70 mt-2">{i.description}</p>
              {i.required_settings.length > 0 && (
                <div className="text-[11px] text-muted mt-2">
                  Requires: {i.required_settings.join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {editing && (
        <ConnectModal
          step={editing}
          existing={editing.provider ? configByProvider[editing.provider] : undefined}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["integrations", "config"] });
          }}
        />
      )}
    </div>
  );
}
