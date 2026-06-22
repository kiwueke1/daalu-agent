"use client";

/**
 * General onboarding wizard.
 *
 * A guided, step-by-step walk through every integration the operator
 * normally sets up by hand via `PUT /integrations/config/{provider}`
 * (see docs/user-guide-integrations.md), plus an optional cluster
 * tunnel (VPN) step that delegates to the dedicated workflow at
 * `/onboarding/cluster` via the shared <ClusterWorkflow /> component.
 *
 * Server contract:
 *
 *   • GET  /onboarding/status            — per-step "already done?" map
 *   • POST /onboarding/test/{provider}   — verify creds before saving
 *   • POST /onboarding/validate/{provider} — schema preflight
 *   • PUT  /integrations/config/{prov}   — actual save (per step)
 *   • POST /clusters                     — VPN step, owned by <ClusterWorkflow />
 *
 * The wizard owns no server-side state. Quitting mid-flow leaves
 * already-saved steps intact; re-running pre-fills from
 * GET /onboarding/status + /integrations/config.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  Loader2,
  Workflow,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { ClusterWorkflow } from "@/components/onboarding/cluster-workflow";
import {
  IntegrationStep,
  STEPS,
  StepState,
  StepView,
  emptyState,
  emptyValues,
  payloadFromValues,
} from "@/components/integrations/steps";

const TOTAL_STEPS = STEPS.length + 1;

export default function OnboardingPage() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["onboarding", "status"],
    queryFn: () => api.onboarding.status(),
  });
  const { data: existingConfigs } = useQuery({
    queryKey: ["integrations", "config"],
    queryFn: () => api.integrations.listConfig(),
  });

  const [stepIdx, setStepIdx] = useState<number>(-1);
  const [states, setStates] = useState<Record<string, StepState>>(() =>
    Object.fromEntries(STEPS.map((s) => [s.id, emptyState(s)]))
  );

  // Pre-seed enabled state from /integrations/config + /onboarding/status.
  useEffect(() => {
    if (!existingConfigs) return;
    setStates((prev) => {
      const next = { ...prev };
      for (const cfg of existingConfigs) {
        const step = STEPS.find((s) => s.provider === cfg.provider);
        if (!step) continue;
        if (next[step.id].enabled) continue; // user has typed something
        const merged: Record<string, string> = { ...emptyValues(step) };
        for (const [k, v] of Object.entries(cfg.config || {})) {
          if (typeof v === "string") merged[k] = v;
          else if (typeof v === "number") merged[k] = String(v);
        }
        next[step.id] = {
          ...next[step.id],
          enabled: true,
          values: merged,
          saved: true,
          clusterTunnelId: cfg.cluster_tunnel_id ?? null,
        };
      }
      return next;
    });
  }, [existingConfigs]);

  // Status drives the welcome screen — but also auto-marks the cluster
  // step as configured if there's any cluster_tunnel row on the tenant.
  useEffect(() => {
    if (!status) return;
    const clusterStep = status.steps.find((s) => s.id === "cluster");
    if (clusterStep?.configured) {
      setStates((prev) => ({
        ...prev,
        cluster: { ...prev.cluster, enabled: true, saved: true },
      }));
    }
  }, [status]);

  const { data: clusters } = useQuery({
    queryKey: ["clusters"],
    queryFn: () => api.clusters.list(),
  });

  const putIntegration = useMutation({
    mutationFn: async (input: {
      provider: string;
      config: Record<string, unknown>;
      cluster_tunnel_id: string | null;
    }) =>
      api.integrations.putConfig(input.provider, {
        config: input.config,
        cluster_tunnel_id: input.cluster_tunnel_id,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "config"] });
      qc.invalidateQueries({ queryKey: ["onboarding", "status"] });
    },
  });

  const testIntegration = useMutation({
    mutationFn: async (input: {
      provider: string;
      config: Record<string, unknown>;
      cluster_tunnel_id: string | null;
    }) =>
      api.onboarding.test(input.provider, input.config, input.cluster_tunnel_id),
  });

  function update(stepId: string, patch: Partial<StepState>) {
    setStates((prev) => ({ ...prev, [stepId]: { ...prev[stepId], ...patch } }));
  }

  function updateValue(stepId: string, key: string, value: string) {
    setStates((prev) => ({
      ...prev,
      [stepId]: {
        ...prev[stepId],
        values: { ...prev[stepId].values, [key]: value },
        saved: false,
        test: null,
      },
    }));
  }

  function payloadFor(step: IntegrationStep) {
    return payloadFromValues(step, states[step.id].values);
  }

  async function runTest() {
    if (stepIdx < 0 || stepIdx >= STEPS.length) return;
    const step = STEPS[stepIdx];
    if (!step.provider) return;
    const { config } = payloadFor(step);
    try {
      const result = await testIntegration.mutateAsync({
        provider: step.provider,
        config,
        cluster_tunnel_id: states[step.id].clusterTunnelId,
      });
      update(step.id, { test: result, error: result.ok ? null : result.message });
    } catch (e) {
      update(step.id, { error: (e as Error).message });
    }
  }

  async function saveCurrentStep(): Promise<boolean> {
    if (stepIdx < 0 || stepIdx >= STEPS.length) return true;
    const step = STEPS[stepIdx];
    const state = states[step.id];

    if (!state.enabled) return true;

    // Cluster step is handled by <ClusterWorkflow /> — saving here is a
    // no-op; the workflow component does its own POST /clusters.
    if (step.id === "cluster") return true;

    const { config, missing } = payloadFor(step);
    if (missing.length > 0) {
      update(step.id, { error: `Required: ${missing.join(", ")}` });
      return false;
    }
    try {
      await putIntegration.mutateAsync({
        provider: step.provider!,
        config,
        cluster_tunnel_id: state.clusterTunnelId,
      });
      update(step.id, { saved: true, error: null });
      return true;
    } catch (e) {
      update(step.id, { error: (e as Error).message });
      return false;
    }
  }

  async function goNext() {
    const ok = await saveCurrentStep();
    if (!ok) return;
    setStepIdx((i) => Math.min(i + 1, STEPS.length));
  }

  function goBack() {
    setStepIdx((i) => Math.max(i - 1, -1));
  }

  const progress = stepIdx < 0 ? 0 : (stepIdx + 1) / TOTAL_STEPS;

  return (
    <div className="space-y-6 max-w-[860px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Workflow className="h-5 w-5 text-accent-cyan" /> Onboarding
          </h1>
          <p className="text-muted text-sm mt-1">
            Wire up notifications, observability, and the cluster tunnel in one
            sequence. Skip any step you don't need — Slack-only is a valid path.
          </p>
        </div>
        <a
          href="/integrations"
          className="text-xs h-9 px-3 rounded-lg border border-line text-muted hover:text-fg flex items-center gap-1"
        >
          <HelpCircle className="h-3.5 w-3.5" /> Manage individually
        </a>
      </div>

      <div className="h-1.5 rounded-full bg-bg-elevated/60 overflow-hidden">
        <div
          className="h-full bg-accent-cyan transition-all"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      {stepIdx === -1 && (
        <WelcomeStep onStart={() => setStepIdx(0)} states={states} />
      )}

      {stepIdx >= 0 && stepIdx < STEPS.length && (
        <>
          {STEPS[stepIdx].id === "cluster" ? (
            <ClusterStepView
              state={states["cluster"]}
              onToggle={(enabled) => update("cluster", { enabled })}
              onComplete={() => {
                update("cluster", { saved: true });
                setStepIdx((i) => Math.min(i + 1, STEPS.length));
              }}
            />
          ) : (
            <StepView
              step={STEPS[stepIdx]}
              state={states[STEPS[stepIdx].id]}
              existing={existingConfigs?.find(
                (c) => c.provider === STEPS[stepIdx].provider
              )}
              onToggle={(enabled) => update(STEPS[stepIdx].id, { enabled })}
              onChange={(key, val) => updateValue(STEPS[stepIdx].id, key, val)}
              onTest={runTest}
              testing={testIntegration.isPending}
              clusters={clusters ?? []}
              onClusterChange={(id) =>
                update(STEPS[stepIdx].id, { clusterTunnelId: id, test: null })
              }
            />
          )}
        </>
      )}

      {stepIdx === STEPS.length && <DoneStep states={states} />}

      {stepIdx >= 0 && (
        <div className="flex items-center justify-between gap-2 pt-2">
          <button
            type="button"
            onClick={goBack}
            disabled={stepIdx < 0}
            className="text-xs h-9 px-3 rounded-lg border border-line text-muted hover:text-fg disabled:opacity-50 flex items-center gap-1.5"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Back
          </button>
          <div className="text-[11px] text-muted">
            {stepIdx < STEPS.length
              ? `Step ${stepIdx + 1} of ${STEPS.length}`
              : "All done"}
          </div>
          {stepIdx < STEPS.length ? (
            STEPS[stepIdx].id === "cluster" ? (
              // The cluster step advances itself via onComplete on the
              // <ClusterWorkflow />. Offer a "Skip" affordance so users
              // who don't want the VPN can move on.
              !states.cluster.enabled || states.cluster.saved ? (
                <button
                  type="button"
                  onClick={() => setStepIdx((i) => Math.min(i + 1, STEPS.length))}
                  className="text-xs h-9 px-3 rounded-lg bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan flex items-center gap-1.5"
                >
                  {states.cluster.saved ? "Continue" : "Skip cluster tunnel"}
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              ) : (
                <div className="text-[11px] text-muted">
                  Finish the cluster workflow above, or untick the toggle to skip.
                </div>
              )
            ) : (
              <button
                type="button"
                onClick={goNext}
                disabled={putIntegration.isPending || testIntegration.isPending}
                className="text-xs h-9 px-3 rounded-lg bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan disabled:opacity-50 flex items-center gap-1.5"
              >
                {putIntegration.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {states[STEPS[stepIdx].id].enabled
                  ? "Save & continue"
                  : "Skip & continue"}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )
          ) : (
            <a
              href="/"
              className="text-xs h-9 px-3 rounded-lg bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan flex items-center gap-1.5"
            >
              Go to dashboard <ChevronRight className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Welcome step ────────────────────────────────────────────────────────

function WelcomeStep({
  onStart,
  states,
}: {
  onStart: () => void;
  states: Record<string, StepState>;
}) {
  // Pull live "is configured?" from the server so the screen still
  // says "done" for steps the user set up via /integrations directly,
  // without going through this wizard.
  const { data: status } = useQuery({
    queryKey: ["onboarding", "status"],
    queryFn: () => api.onboarding.status(),
  });
  const configuredIds = useMemo(
    () => new Set(status?.steps.filter((s) => s.configured).map((s) => s.id) ?? []),
    [status]
  );
  return (
    <div className="rounded-2xl border border-line bg-bg-card p-6 space-y-4">
      <div className="text-base font-medium">What you'll set up</div>
      <p className="text-sm text-muted">
        Each step is independent. Toggle each on or off; for the ones you turn
        on, fill in just the fields you have. The cluster tunnel step launches
        the dedicated VPN workflow — you can also run that alone at
        <a href="/onboarding/cluster" className="underline ml-1">/onboarding/cluster</a>.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        {STEPS.map((step) => {
          const Icon = step.icon;
          const done = configuredIds.has(step.id) || states[step.id].saved;
          return (
            <div
              key={step.id}
              className="flex items-center gap-2 rounded-lg border border-line bg-bg-elevated/30 px-3 py-2"
            >
              <Icon className="h-4 w-4 text-accent-cyan" />
              <span className="flex-1">{step.title}</span>
              {done && (
                <span className="text-[10px] uppercase tracking-wider text-accent-emerald flex items-center gap-1">
                  <Check className="h-3 w-3" /> done
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between pt-2">
        <div className="text-[11px] text-muted">
          {status
            ? `${status.completed} of ${status.total} configured.`
            : "Loading…"}
        </div>
        <button
          onClick={onStart}
          className="text-xs h-9 px-3 rounded-lg bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan flex items-center gap-1.5"
        >
          Begin <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Cluster step — delegates to the shared workflow ─────────────────────

function ClusterStepView({
  state,
  onToggle,
  onComplete,
}: {
  state: StepState;
  onToggle: (enabled: boolean) => void;
  onComplete: () => void;
}) {
  return (
    <div className="rounded-2xl border border-line bg-bg-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div
          className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: "color-mix(in srgb, var(--accent) 14%, transparent)",
          }}
        >
          <Boxes className="h-4 w-4 text-accent-cyan" />
        </div>
        <div className="flex-1">
          <div className="text-base font-medium">Cluster tunnel (VPN)</div>
          <p className="text-sm text-muted mt-0.5">
            Optional WireGuard tunnel from a customer cluster back to the
            operator. Enabling this step launches the dedicated VPN workflow
            inline; you can also visit{" "}
            <a href="/onboarding/cluster" className="underline">
              /onboarding/cluster
            </a>{" "}
            to run it standalone.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-4 w-4 accent-accent-cyan"
          />
          <span className="text-muted">
            {state.enabled ? "Enabled" : "Skipped"}
          </span>
        </label>
      </div>

      {state.enabled ? (
        <ClusterWorkflow onComplete={onComplete} allowAnother={false} />
      ) : (
        <div className="text-xs text-muted">
          Leave unchecked to skip the cluster tunnel for now. You can always
          set one up later from <a href="/clusters" className="underline">/clusters</a>.
        </div>
      )}
    </div>
  );
}

// ── Done step ───────────────────────────────────────────────────────────

function DoneStep({ states }: { states: Record<string, StepState> }) {
  const enabled = STEPS.filter((s) => states[s.id].enabled);
  const skipped = STEPS.filter((s) => !states[s.id].enabled);
  return (
    <div className="rounded-2xl border border-line bg-bg-card p-6 space-y-4">
      <div className="text-base font-medium flex items-center gap-2">
        <Check className="h-4 w-4 text-accent-emerald" /> Onboarding complete
      </div>
      <p className="text-sm text-muted">
        Daalu can re-run any of these from /integrations, /clusters, or
        /onboarding/cluster at any time.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        {enabled.length > 0 && (
          <div className="rounded-lg border border-line bg-bg-elevated/30 p-3 space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-muted">
              Configured
            </div>
            {enabled.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <Check className="h-3 w-3 text-accent-emerald" /> {s.title}
              </div>
            ))}
          </div>
        )}
        {skipped.length > 0 && (
          <div className="rounded-lg border border-line bg-bg-elevated/30 p-3 space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-muted">
              Skipped
            </div>
            {skipped.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 text-sm text-muted"
              >
                <X className="h-3 w-3" /> {s.title}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
