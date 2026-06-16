/**
 * Typed fetch helpers for the Daalu Automation API.
 * The Next dev server proxies /api/* to the backend (see next.config.js),
 * so the browser sees a single origin.
 */

const BASE = "/api/v1";

export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Multipart uploads: let the browser set the Content-Type (with boundary)
  // by *not* injecting our JSON default.
  const isMultipart = init.body instanceof FormData;
  const headers = isMultipart
    ? (init.headers ?? {})
    : { "Content-Type": "application/json", ...(init.headers || {}) };
  const res = await fetch(`${BASE}${path}`, {
    headers,
    cache: "no-store",
    credentials: "include",
    ...init,
  });
  if (res.status === 401) {
    // /login, /accept-invite, /signup and /verify-email handle their own auth
    // lifecycle. Bouncing them to /login on a 401 would break those flows
    // (invite redemption + self-service signup are used by logged-out users).
    if (
      typeof window !== "undefined"
      && !window.location.pathname.startsWith("/login")
      && !window.location.pathname.startsWith("/accept-invite")
      && !window.location.pathname.startsWith("/signup")
      && !window.location.pathname.startsWith("/verify-email")
    ) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/login?next=${next}`);
    }
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body || path}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type RoutingPolicy =
  | "local_first"
  | "hybrid"
  | "external_only"
  | "sovereign";

export type InferenceTier =
  | "local"
  | "external_classifier"
  | "external_quality"
  | "sovereign";

export interface Sku {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  routing_policy: RoutingPolicy;
  monthly_base_usd: number;
  included_events_per_month: number;
  price_local_in_per_mtok: number;
  price_local_out_per_mtok: number;
  price_external_classifier_in_per_mtok: number;
  price_external_classifier_out_per_mtok: number;
  price_external_quality_in_per_mtok: number;
  price_external_quality_out_per_mtok: number;
  monthly_soft_cap_usd: number;
  is_active: boolean;
  display_order: number;
}

export interface PeriodTotals {
  period_start: string;
  period_end: string;
  events: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  base_usd: number;
  included_events: number;
  included_events_used: number;
}

export interface BreakdownRow {
  key: string;
  events: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

export interface DailyPoint {
  day: string;
  events: number;
  cost_usd: number;
}

export interface LocalGpuStatus {
  configured: boolean;
  healthy: boolean;
  base_url: string;
  model_classifier: string;
  model_quality: string;
  source?: "sovereign" | "local" | "none";
  state?: string | null;
}

export interface GpuCluster {
  cluster_tunnel_id: string;
  slug: string;
  name: string;
  tunnel_ip: string;
  suggested_base_url: string;
}

export interface GpuStatus {
  configured: boolean;
  state?: string | null;
  healthy?: boolean;
  base_url?: string | null;
  model_classifier?: string | null;
  source?: string;
  cluster_tunnel_id?: string | null;
  last_error?: string | null;
}

export interface GpuOnboardBody {
  target_cluster_tunnel_id?: string | null;
  gpu_node?: string | null;
  gpu_class?: string;
  hf_token?: string | null;
  model_classifier?: string;
  model_quality?: string | null;
  base_url?: string | null;
  endpoint_token?: string | null;
}

export interface GpuNode {
  name: string;
  gpu_class?: string | null;
  allocatable_gpus?: string | null;
  ready?: boolean;
}

export const api = {
  events: {
    list: (params: { module?: string; since_hours?: number; limit?: number } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)])
      );
      return request<Event[]>(`/events?${qs}`);
    },
  },
  briefings: {
    latest: (channel: string) =>
      request<Briefing>(`/briefings/latest?channel=${channel}`),
    list: (channel?: string) =>
      request<Briefing[]>(`/briefings${channel ? `?channel=${channel}` : ""}`),
    get: (id: string) => request<Briefing>(`/briefings/${id}`),
    generate: (channel: string) =>
      request<Briefing>(`/briefings/${channel}/generate`, { method: "POST" }),
  },
  alerts: {
    list: (params: { module?: string; status?: string; severity?: string } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)])
      );
      return request<Alert[]>(`/alerts?${qs}`);
    },
    get: (id: string) => request<Alert>(`/alerts/${id}`),
    occurrences: (id: string) =>
      request<AlertOccurrence[]>(`/alerts/${id}/occurrences`),
    acknowledge: (id: string) => request<Alert>(`/alerts/${id}/acknowledge`, { method: "POST" }),
    resolve: (id: string) => request<Alert>(`/alerts/${id}/resolve`, { method: "POST" }),
    chat: {
      list: (alertId: string) =>
        request<AlertChatMessage[]>(`/alerts/${alertId}/chat`),
      send: (alertId: string, content: string) =>
        request<AlertChatMessage[]>(`/alerts/${alertId}/chat`, {
          method: "POST",
          body: JSON.stringify({ content }),
        }),
      triage: (alertId: string, opts: { force?: boolean } = {}) =>
        request<AlertChatMessage[]>(
          `/alerts/${alertId}/triage${opts.force ? "?force=true" : ""}`,
          { method: "POST" }
        ),
      approve: (alertId: string, actionId: string) =>
        request<AlertChatMessage[]>(
          `/alerts/${alertId}/actions/${actionId}/approve`,
          { method: "POST" }
        ),
      reject: (alertId: string, actionId: string) =>
        request<AlertChatMessage[]>(
          `/alerts/${alertId}/actions/${actionId}/reject`,
          { method: "POST" }
        ),
    },
  },
  recommendations: {
    list: (params: { module?: string; status?: string } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)])
      );
      return request<Recommendation[]>(`/recommendations?${qs}`);
    },
    approve: (id: string) =>
      request<Recommendation>(`/recommendations/${id}/approve`, { method: "POST" }),
    dismiss: (id: string) =>
      request<Recommendation>(`/recommendations/${id}/dismiss`, { method: "POST" }),
  },
  agents: {
    list: () => request<AgentDescriptor[]>("/agents"),
    runs: (agent_name?: string) =>
      request<AgentRun[]>(`/agents/runs${agent_name ? `?agent_name=${agent_name}` : ""}`),
  },
  workflows: {
    list: () => request<WorkflowDescriptor[]>("/workflows"),
    runs: (module?: string) =>
      request<WorkflowRun[]>(`/workflows/runs${module ? `?module=${module}` : ""}`),
    run: (name: string, input: Record<string, unknown> = {}) =>
      request<{ run_id: string }>("/workflows/run", {
        method: "POST",
        body: JSON.stringify({ name, input }),
      }),
  },
  integrations: {
    list: () => request<IntegrationDescriptor[]>("/integrations"),
    ingest: (provider: string) =>
      request<{ events_emitted: number }>(`/integrations/${provider}/ingest`, {
        method: "POST",
      }),
    listConfig: () =>
      request<IntegrationConfig[]>("/integrations/config"),
    putConfig: (
      provider: string,
      payload: {
        config: Record<string, unknown>;
        name?: string;
        // Omit to leave whatever's stored; pass `null` to detach; pass a
        // UUID to attach/move. Matches the backend's
        // ``model_fields_set`` semantics so the wizard can edit
        // credentials without forgetting which cluster they belong to.
        cluster_tunnel_id?: string | null;
      }
    ) =>
      request<IntegrationConfig>(`/integrations/config/${provider}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    deleteConfig: (provider: string) =>
      request<void>(`/integrations/config/${provider}`, { method: "DELETE" }),
  },
  infra: {
    incidents: (params: { status?: string; severity?: string } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)])
      );
      return request<Incident[]>(`/infra/incidents?${qs}`);
    },
    promoteAlertToIncident: (
      alertId: string,
      payload: { title: string; severity?: string; summary?: string }
    ) =>
      request<Incident>(`/infra/incidents/from-alert/${alertId}`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  },
  copilot: {
    ask: (query: string) =>
      request<{ answer: string; references: { id: string; summary: string }[] }>(
        "/copilot/ask",
        {
          method: "POST",
          body: JSON.stringify({ query }),
        }
      ),
  },
  reports: {
    schema: () => request<ReportsSchema>("/reports/query/schema"),
    runQuery: (payload: ReportsQueryRequest) =>
      request<ReportsQueryResponse>("/reports/query", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    translate: (payload: { question: string; entity_hint?: string | null }) =>
      request<ReportsTranslateResponse>("/reports/query/translate", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    saved: {
      list: () => request<SavedReport[]>("/reports/saved"),
      create: (payload: { name: string; definition: ReportsQueryRequest; pinned?: boolean }) =>
        request<SavedReport>("/reports/saved", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      get: (id: string) => request<SavedReport>(`/reports/saved/${id}`),
      update: (
        id: string,
        payload: { name?: string; definition?: ReportsQueryRequest; pinned?: boolean }
      ) =>
        request<SavedReport>(`/reports/saved/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      remove: (id: string) =>
        request<void>(`/reports/saved/${id}`, { method: "DELETE" }),
    },
    export: (payload: ReportsQueryRequest, format: "csv" | "json") => {
      // Returns a Blob the caller can save / link to.
      return fetch(`/api/v1/reports/query/export?format=${format}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (res) => {
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
        }
        return res.blob();
      });
    },
    schedules: {
      list: () => request<ReportSchedule[]>("/reports/schedules"),
      create: (payload: {
        name: string;
        saved_report_id: string;
        cron: string;
        destination: "slack" | "email";
        recipient?: string;
        format?: "markdown" | "csv";
      }) =>
        request<ReportSchedule>("/reports/schedules", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (
        id: string,
        payload: {
          name?: string;
          cron?: string;
          destination?: "slack" | "email";
          recipient?: string;
          format?: "markdown" | "csv";
          enabled?: boolean;
        }
      ) =>
        request<ReportSchedule>(`/reports/schedules/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      remove: (id: string) =>
        request<void>(`/reports/schedules/${id}`, { method: "DELETE" }),
    },
    dashboards: {
      list: () => request<Dashboard[]>("/reports/dashboards"),
      get: (id: string) => request<Dashboard>(`/reports/dashboards/${id}`),
      create: (payload: { name: string; tiles?: DashboardTile[]; home_pinned?: boolean }) =>
        request<Dashboard>("/reports/dashboards", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (
        id: string,
        payload: { name?: string; tiles?: DashboardTile[]; home_pinned?: boolean }
      ) =>
        request<Dashboard>(`/reports/dashboards/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      remove: (id: string) =>
        request<void>(`/reports/dashboards/${id}`, { method: "DELETE" }),
    },
  },
  ide: {
    eligibility: () =>
      request<{ eligible: boolean; reason: string }>("/ide/eligibility"),
    models: () => request<CodingModelView[]>("/ide/models"),
    me: () =>
      request<WorkspaceView | null>("/ide/sessions/me").catch(() => null),
    create: (spec: {
      profile: "small" | "medium" | "large";
      model?: string | null;
      git_repo_url?: string | null;
      git_branch?: string;
      // Personal-access-token for a private repo. Write-only — never
      // returned. Omit/null for a public repo or an empty workspace.
      git_token?: string | null;
    }) =>
      request<WorkspaceView>("/ide/sessions", {
        method: "POST",
        body: JSON.stringify({ git_branch: "main", ...spec }),
      }),
    destroy: () =>
      request<{ status: string }>("/ide/sessions/me", { method: "DELETE" }),
  },
  cli: {
    // Mint a one-time `daalu login --code …` command for the express flow.
    loginCommand: () =>
      request<{ command: string; device_code: string; expires_in: number }>(
        "/cli/login-command",
        { method: "POST" },
      ),
    // The /cli/activate device-approval page.
    devicePending: (userCode: string) =>
      request<{
        user_code: string;
        client_name: string | null;
        status: string;
        expires_at: string;
      }>(`/cli/device/pending?user_code=${encodeURIComponent(userCode)}`),
    deviceApprove: (userCode: string) =>
      request<{ status: string }>("/cli/device/approve", {
        method: "POST",
        body: JSON.stringify({ user_code: userCode }),
      }),
    deviceDeny: (userCode: string) =>
      request<void>("/cli/device/deny", {
        method: "POST",
        body: JSON.stringify({ user_code: userCode }),
      }),
  },
  onboarding: {
    status: () => request<OnboardingStatus>("/onboarding/status"),
    test: (
      provider: string,
      config: Record<string, unknown>,
      cluster_tunnel_id?: string | null,
    ) =>
      request<OnboardingTestResult>(`/onboarding/test/${provider}`, {
        method: "POST",
        body: JSON.stringify({ config, cluster_tunnel_id }),
      }),
    validate: (provider: string, config: Record<string, unknown>) =>
      request<{ ok: boolean; missing: string[] }>(
        `/onboarding/validate/${provider}`,
        {
          method: "POST",
          body: JSON.stringify({ config }),
        }
      ),
    // Provision the per-tenant NV-CM (network/server config-management) stack.
    // The backend installs the chart and polls to `active` (can take several
    // minutes on first run), then writes Integration(provider=config_manager).
    provisionConfigManager: (body: {
      components?: Record<string, boolean>;
      size_profile?: string;
      base_hostname?: string | null;
    }) =>
      request<ProvisionConfigManagerResult>(
        "/onboarding/config-manager/provision",
        { method: "POST", body: JSON.stringify(body) },
      ),
    // Local-GPU onboarding: deploy the vLLM stack onto a joined cluster
    // over the tunnel + register it as the tenant's SOVEREIGN tier.
    gpu: {
      status: () => request<GpuStatus>("/onboarding/gpu"),
      clusters: () => request<GpuCluster[]>("/onboarding/gpu/clusters"),
      nodes: (clusterTunnelId?: string | null) =>
        request<GpuNode[]>(
          `/onboarding/gpu/nodes${clusterTunnelId ? `?cluster_tunnel_id=${clusterTunnelId}` : ""}`,
        ),
      // POST polls to `active` server-side (first boot can take minutes).
      provision: (body: GpuOnboardBody) =>
        request<GpuStatus>("/onboarding/gpu/provision", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      remove: () =>
        request<GpuStatus>("/onboarding/gpu", { method: "DELETE" }),
    },
  },
  clusters: {
    list: () => request<Cluster[]>("/clusters"),
    get: (slug: string) => request<Cluster>(`/clusters/${slug}`),
    onboard: (payload: { slug: string; name: string }) =>
      request<ClusterCreate>("/clusters", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    remove: (slug: string) =>
      request<void>(`/clusters/${slug}`, { method: "DELETE" }),
    overview: (slug: string) =>
      request<ClusterOverview>(`/clusters/${slug}/overview`),
    kubectlCatalog: () =>
      request<KubectlCommandSpec[]>("/clusters/kubectl/catalog"),
    runKubectl: (slug: string, body: KubectlRunRequest) =>
      request<{ results: KubectlResult[] }>(`/clusters/${slug}/kubectl`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  changeProposals: {
    list: (
      params: { status?: string; device_id?: string; kind?: string; limit?: number } = {},
    ) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)]),
      );
      return request<ChangeProposal[]>(`/change-proposals?${qs}`);
    },
    get: (id: string) => request<ChangeProposal>(`/change-proposals/${id}`),
    approve: (id: string) =>
      request<ChangeProposal>(`/change-proposals/${id}/approve`, { method: "POST" }),
    reject: (id: string) =>
      request<ChangeProposal>(`/change-proposals/${id}/reject`, { method: "POST" }),
  },
  sot: {
    hostedStatus: () =>
      request<{ hosted_available: boolean; detail: string }>(
        "/onboarding/nautobot/hosted-status",
      ),
    provisionNautobot: () =>
      request<{
        ok: boolean;
        message: string;
        url: string;
        nautobot_tenant_slug: string;
        nautobot_tenant_id: string;
      }>("/onboarding/nautobot/provision", { method: "POST" }),
    devices: {
      list: (params: { platform?: string } = {}) => {
        const qs = new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => [k, String(v)]),
        );
        return request<SotDevice[]>(`/sot/devices?${qs}`);
      },
      get: (id: string) => request<SotDevice>(`/sot/devices/${id}`),
      intent: (id: string) => request<SotIntent>(`/sot/devices/${id}/intent`),
      catalog: () => request<SotCatalog>("/sot/devices/_catalog/list"),
      create: (payload: SotDeviceCreate) =>
        request<SotDevice>("/sot/devices", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      updateIntent: (id: string, facts: Record<string, unknown>) =>
        request<SotIntent>(`/sot/devices/${id}/intent`, {
          method: "PUT",
          body: JSON.stringify({ facts }),
        }),
      remove: (id: string) =>
        request<void>(`/sot/devices/${id}`, { method: "DELETE" }),
      bulkImport: (file: File, dryRun: boolean) => {
        const fd = new FormData();
        fd.append("file", file);
        return request<SotBulkImportResult>(
          `/sot/devices/bulk-import?dry_run=${dryRun ? "true" : "false"}`,
          { method: "POST", body: fd },
        );
      },
      reconcile: (id: string) =>
        request<SotReconcileResult>(`/sot/devices/${id}/reconcile`, {
          method: "POST",
        }),
    },
  },
  auth: {
    me: () => request<CurrentUser>("/auth/me"),
    // Public: which login mode the hub is in ("password" | "oidc") and the
    // path to start SSO. Used by the login page to render the form or
    // bounce straight to Keycloak.
    config: () => request<AuthConfig>("/auth/config"),
    login: (email: string, password: string) =>
      request<LoginResult>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    logout: () => request<void>("/auth/logout", { method: "POST" }),
    // Public: create a local account. Always resolves 202 with a neutral body
    // (no account enumeration) — the user is told to check their email.
    signup: (payload: {
      email: string;
      password: string;
      full_name?: string | null;
      organization?: string | null;
    }) =>
      request<{ status: string }>("/auth/signup", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    // Public: redeem the email-verification token. On success the account is
    // activated and the session cookie is set, so the caller is logged in.
    verifyEmail: (token: string) =>
      request<LoginResult>("/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    // Public: re-send a verification link. Neutral 204/202 regardless.
    resendVerification: (email: string) =>
      request<void>("/auth/verify-email/resend", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    updateMe: (payload: {
      full_name?: string | null;
      preferences?: Record<string, unknown>;
    }) =>
      request<CurrentUser>("/auth/me", {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
    changePassword: (current_password: string, new_password: string) =>
      request<void>("/auth/password", {
        method: "POST",
        body: JSON.stringify({ current_password, new_password }),
      }),
    tokens: {
      list: () => request<PersonalAccessToken[]>("/auth/tokens"),
      create: (name: string, expires_in_days?: number | null) =>
        request<PersonalAccessTokenCreated>("/auth/tokens", {
          method: "POST",
          body: JSON.stringify({ name, expires_in_days: expires_in_days ?? null }),
        }),
      revoke: (id: string) =>
        request<void>(`/auth/tokens/${id}`, { method: "DELETE" }),
    },
    // Invite-side of auth — unauthenticated calls used by the
    // accept-invite page. Note these are under /api/v1/auth/* on the
    // backend so they bypass the AuthGate middleware naturally.
    previewInvite: (token: string) =>
      request<InvitePreview>(`/auth/invite/${encodeURIComponent(token)}`),
    redeemInvite: (payload: {
      token: string;
      full_name?: string | null;
      password: string;
    }) =>
      request<LoginResult>("/auth/redeem-invite", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  },
  invites: {
    list: (include_terminal = false) =>
      request<Invite[]>(
        `/invites${include_terminal ? "?include_terminal=true" : ""}`,
      ),
    create: (payload: { email: string; role: "admin" | "user"; message?: string | null }) =>
      request<Invite>("/invites", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    resend: (id: string) =>
      request<Invite>(`/invites/${id}/resend`, { method: "POST" }),
    revoke: (id: string) =>
      request<void>(`/invites/${id}`, { method: "DELETE" }),
  },
  feedback: {
    send: (payload: { message: string; category?: string; page_url?: string }) =>
      request<{ id: string; created_at: string }>("/feedback", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  },
  meta: {
    version: () =>
      // Lives at /version (no API prefix). Use absolute path so the
      // shared request() wrapper's `${BASE}${path}` doesn't apply.
      fetch("/version", { credentials: "include", cache: "no-store" }).then(
        (r) => r.json() as Promise<BuildInfo>,
      ),
  },
  aiFactory: {
    // Role + capability probe — drives which panels the page renders.
    overview: () => request<AiFactoryOverview>("/ai-factory/overview"),
    // owner/provider get a per-GPU hardware summary; consumer gets a
    // usage-centric summary instead. The page picks the shape by role.
    gpuSummary: () => request<AiFactoryGpuSummary>("/ai-factory/gpu/summary"),
    // `card` (the GPU's stable id = its DCGM UUID) scopes the series to a
    // single physical card for the detail view; omit it for the tenant-wide
    // aggregate. Scoping by UUID — not the gpu index — keeps two single-GPU
    // cards (both gpu="0") distinct.
    timeseries: (metric: AiFactoryMetric, range: AiFactoryRange, card?: string) =>
      request<AiFactoryTimeseries>(
        `/ai-factory/gpu/timeseries?metric=${metric}&range=${range}` +
          (card != null ? `&card=${encodeURIComponent(card)}` : ""),
      ),
    events: (card?: string) =>
      request<{ events: AiFactoryGpuEvent[] }>(
        "/ai-factory/gpu/events" +
          (card != null ? `?card=${encodeURIComponent(card)}` : ""),
      ),
    alerts: (card?: string) =>
      request<{ alerts: AiFactoryAlert[] }>(
        "/ai-factory/alerts" +
          (card != null ? `?card=${encodeURIComponent(card)}` : ""),
      ),
    // ── Admin-only ──
    validateObservability: () =>
      request<AiFactoryValidateResult>("/ai-factory/observability/validate", {
        method: "POST",
      }),
    // Returns a typed union: a stressful run (dcgmi -r2/-r3, NCCL) without
    // `acknowledged` comes back as { requiresAck, warning } (HTTP 412) so the
    // UI can show the warning and re-submit with acknowledged=true.
    runDiagnostic: async (body: {
      kind: AiFactoryDiagKind;
      level?: 1 | 2 | 3;
      acknowledged?: boolean;
    }): Promise<AiFactoryDiagStart> => {
      const res = await fetch(`${BASE}/ai-factory/gpu/diagnostics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify(body),
      });
      if (res.status === 412) {
        const data = (await res.json().catch(() => ({}))) as {
          detail?: { warning?: string };
        };
        return {
          requiresAck: true,
          warning: data.detail?.warning ?? "This diagnostic needs confirmation.",
        };
      }
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
      }
      const data = (await res.json()) as { id: string; state: "pending" };
      return { requiresAck: false, id: data.id, state: data.state };
    },
    diagnostics: () =>
      request<{ runs: AiFactoryDiagRun[] }>("/ai-factory/gpu/diagnostics"),
    diagnostic: (id: string) =>
      request<AiFactoryDiagRunDetail>(`/ai-factory/gpu/diagnostics/${id}`),
    // ── Reliability (NVSentinel + cuda-checkpoint), read-only, owner/provider ──
    reliability: () =>
      request<AiFactoryReliability>("/ai-factory/reliability"),
    // ── AIPerf (load-test / SLO benchmarking) ──
    // Access is gated server-side to a site superuser (free target choice, sees
    // every run) OR a GPU owner/provider (own endpoint only, own runs only).
    // Everyone else gets 403. `scope` echoes which the caller is.
    aiperfRuns: () =>
      request<{
        runs: AiFactoryAiperfRun[];
        exec_enabled: boolean;
        scope: string;
      }>("/ai-factory/aiperf/runs"),
    aiperfRun: (id: string) =>
      request<AiFactoryAiperfRunDetail>(`/ai-factory/aiperf/runs/${id}`),
    runAiperf: (body: AiFactoryAiperfRunRequest) =>
      request<{ id: string; state: "pending" }>("/ai-factory/aiperf/runs", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    aiperfArtifacts: (id: string) =>
      request<{
        run_id: string;
        artifacts: AiFactoryAiperfArtifact[];
        artifacts_error: string | null;
      }>(`/ai-factory/aiperf/runs/${id}/artifacts`),
    // A same-origin URL the browser can download directly (cookie-authed).
    aiperfArtifactUrl: (id: string, path: string) =>
      `${BASE}/ai-factory/aiperf/runs/${id}/artifacts/` +
      path.split("/").map(encodeURIComponent).join("/"),
  },
  billing: {
    skus: () => request<Sku[]>("/billing/skus"),
    current: () =>
      request<{ sku: Sku | null; totals: PeriodTotals }>("/billing/current"),
    breakdown: () =>
      request<{ by_tier: BreakdownRow[]; by_source: BreakdownRow[] }>(
        "/billing/breakdown"
      ),
    daily: (days = 30) =>
      request<DailyPoint[]>(`/billing/daily?days=${days}`),
    localGpu: () => request<LocalGpuStatus>("/billing/local-gpu"),
    changeSku: (sku_slug: string) =>
      request<{ id: string }>("/billing/sku", {
        method: "PUT",
        body: JSON.stringify({ sku_slug }),
      }),
  },
};

// ── AI Factory (GPU observability + diagnostics) ─────────────────────
//
// Mirrors the /ai-factory/* router. Tenant-scoped server-side; the role
// the backend computes (owner / provider / consumer / none) decides which
// panels the page shows and which summary shape /gpu/summary returns.

export type AiFactoryRole = "owner" | "provider" | "consumer" | "none";
export type AiFactoryMetric = "util" | "temp" | "mem" | "power";
export type AiFactoryRange = "1h" | "6h" | "24h" | "7d";
export type AiFactoryHealth = "ok" | "warn" | "crit";
export type AiFactoryDiagKind = "dcgmi_diag" | "nccl_test";

export interface AiFactoryOverview {
  role: AiFactoryRole;
  has_gpu: boolean;
  gpu_class: string | null;
  metrics_available: boolean;
  // Which UI sections apply for this tenant — the page treats this as
  // advisory and still gates by role, but it lets the backend hide a
  // panel (e.g. diagnostics) without a frontend change.
  panels: string[];
}

export interface AiFactoryGpu {
  // Stable, globally-unique selection key (the card's DCGM UUID, or
  // host:index fallback). Use this — not `gpu` — to deep-link a card.
  id: string;
  gpu: string;
  uuid: string;
  model: string;
  hostname: string;
  gpu_class: string;
  temp_c: number;
  util_pct: number;
  mem_used_gb: number;
  mem_total_gb: number;
  mem_pct: number;
  power_w: number;
  sm_active_pct: number;
  health: AiFactoryHealth;
  xid_errors: number;
  ecc_dbe: number;
}

export interface AiFactoryConsumerSummary {
  tokens_prompt: number;
  tokens_completion: number;
  requests: number;
  quota_used: number;
  quota_limit: number;
  avg_latency_ms: number;
  pool_util_pct: number | null;
}

// owner/provider → { gpus, updated_at }; consumer → { consumer }.
// Both keys are optional so a single typed response covers every role.
export interface AiFactoryGpuSummary {
  gpus?: AiFactoryGpu[];
  updated_at?: string;
  consumer?: AiFactoryConsumerSummary;
}

export interface AiFactoryTimeseries {
  metric: string;
  series: { ts: number; value: number }[];
}

export interface AiFactoryGpuEvent {
  ts: string;
  gpu: string;
  kind: "xid" | "ecc_dbe" | "ecc_sbe";
  detail: string;
}

export interface AiFactoryAlert {
  name: string;
  gpu?: string | null;
  severity: "info" | "warning" | "critical";
  state: "firing" | "pending";
  summary: string;
  since: string;
}

export interface AiFactoryValidateCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface AiFactoryValidateResult {
  run_id: string;
  checks: AiFactoryValidateCheck[];
  passed: boolean;
}

export type AiFactoryDiagStart =
  | { requiresAck: true; warning: string }
  | { requiresAck: false; id: string; state: "pending" };

export type AiFactoryDiagState =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "error";

export interface AiFactoryDiagRun {
  id: string;
  kind: AiFactoryDiagKind;
  level: number | null;
  state: AiFactoryDiagState;
  summary: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface AiFactoryDiagRunDetail extends AiFactoryDiagRun {
  output: string;
}

// ── Reliability (NVSentinel auto-remediation + cuda-checkpoint) ──────
export type AiFactorySignalLevel = "ok" | "warn" | "crit";

export interface AiFactoryReliabilitySignal {
  name: string;
  value: number;
  unit: string;
  level: AiFactorySignalLevel;
}

export interface AiFactoryReliability {
  // "ok" | "warn" | "crit" for an owned card; "n/a" (no card) | "unknown"
  // (no metrics source) otherwise.
  status: "ok" | "warn" | "crit" | "n/a" | "unknown";
  has_gpu: boolean;
  metrics_available?: boolean;
  signals: AiFactoryReliabilitySignal[];
  nvsentinel: { active: boolean; remediations?: number; mode?: string };
  cuda_checkpoint: { enabled: boolean; status: "gated" | "enabled"; note: string };
  updated_at?: string;
}

// ── AIPerf (load-test / SLO benchmarking) — superuser only ──────────
export type AiFactoryAiperfState =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "error";

export interface AiFactoryAiperfRunRequest {
  model?: string;
  concurrency?: string;
  request_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  endpoint_type?: string;
  streaming?: boolean;
  via_gateway?: boolean;
  target_url?: string;
}

export interface AiFactoryAiperfRun {
  id: string;
  state: AiFactoryAiperfState;
  model: string;
  target_url: string;
  via_gateway: boolean;
  endpoint_type: string;
  concurrency: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  summary: Record<string, unknown> | null;
  requested_by: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface AiFactoryAiperfRunDetail extends AiFactoryAiperfRun {
  output: string | null;
}

// One downloadable file the uploader pushed to object storage, e.g.
// "ISL200_OSL200/CON10/profile_export_aiperf.json".
export interface AiFactoryAiperfArtifact {
  path: string;
  size: number;
}

// One point on the SLO curve, parsed from a per-concurrency
// profile_export_aiperf.json. Lives inside run.summary.concurrency_levels.
export interface AiFactoryAiperfLevel {
  concurrency: number | null;
  isl: number | null;
  osl: number | null;
  metrics: Record<string, number>;
  path: string;
}

export interface CurrentUser {
  id: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
  // Platform operator — gates site-wide tools (AI-factory AIPerf benchmarking).
  // Distinct from is_admin (tenant admin).
  is_superuser: boolean;
  tenant_id: string;
  // Free-form JSON blob set by /settings — theme, density, accent,
  // per-channel notification toggles. Server merges PATCH payloads so
  // a partial update from one tab doesn't blow away others.
  preferences: Record<string, unknown>;
}

export interface LoginResult {
  token: string;
  expires_at: string;
  user: CurrentUser;
}

export interface SSOProvider {
  // Keycloak IdP alias, sent as `idp` to the SSO start path. e.g. "google".
  id: string;
  label: string;
}

export interface AuthConfig {
  // "password" → local email+password form; "oidc" → Daalu-branded SSO buttons.
  mode: "password" | "oidc";
  sso_login_path: string;
  // In "oidc" mode, the providers Daalu brokers on the user's behalf. The
  // login page renders a button per provider that deep-links to
  // `${sso_login_path}?idp=${id}` so the user goes straight to Google.
  sso_providers?: SSOProvider[];
  // Visitors may create a local account → show the "Create an account" link.
  self_signup_enabled?: boolean;
  // Show the local email+password form (always in password mode; also in oidc
  // mode once self-signup is on, so local accounts log in beside the SSO buttons).
  password_login_enabled?: boolean;
}

export interface PersonalAccessToken {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface PersonalAccessTokenCreated extends PersonalAccessToken {
  // Cleartext token, returned exactly once by POST /auth/tokens. Client
  // must show it and discard — there is no way to recover the value
  // server-side.
  token: string;
}

export interface BuildInfo {
  version: string;
  commit_sha: string;
  built_at: string;
}

// ── Invites ─────────────────────────────────────────────────────────
//
// `token` + `invite_url` only appear on create/resend responses,
// where the cleartext is returned exactly once.

export type InviteStatus = "pending" | "expired" | "revoked" | "accepted";

export interface Invite {
  id: string;
  email: string;
  role: "admin" | "user";
  status: InviteStatus;
  invited_by_user_id: string | null;
  inviter_name: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  // Cleartext, present only on create/resend responses.
  token: string | null;
  invite_url: string | null;
  // True iff the backend actually delivered the invite via SMTP. False
  // means SMTP isn't configured for the tenant — the UI then shows the
  // "copy the link manually" fallback. Present only on create/resend.
  delivered?: boolean | null;
}

export interface InvitePreview {
  email: string;
  role: "admin" | "user";
  tenant_name: string;
  inviter_name: string | null;
  message: string | null;
  expires_at: string;
}

// ── Types — kept aligned with `src/daalu_automation/api/schemas` ─────────
export interface Event {
  id: string;
  type: string;
  module: string;
  source: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface Briefing {
  id: string;
  channel: string;
  status: string;
  coverage_date: string;
  title: string;
  summary: string;
  body_markdown: string;
  metrics: Record<string, number | string>;
  source_event_ids: string[];
  created_at: string;
}

export interface Alert {
  id: string;
  module: string;
  severity: "info" | "warning" | "critical";
  status: "open" | "acknowledged" | "resolved" | "suppressed";
  title: string;
  body: string;
  ai_confidence: number;
  metadata_json: Record<string, unknown>;
  fingerprint: string | null;
  occurrence_count: number;
  last_seen_at: string | null;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface AlertOccurrence {
  id: string;
  alert_id: string;
  occurred_at: string;
  source_event_id: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface AlertAction {
  id: string;
  message_id: string;
  tool_call_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  requires_approval: boolean;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  result_output: string;
  result_error: string;
  approved_at: string | null;
  executed_at: string | null;
  created_at: string;
}

export interface AlertChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls_json: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  tool_call_id: string | null;
  created_at: string;
  actions: AlertAction[];
}

export interface Recommendation {
  id: string;
  module: string;
  status: "pending" | "approved" | "dismissed" | "executed";
  title: string;
  rationale: string;
  suggested_action: string;
  confidence: number;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AgentDescriptor {
  name: string;
  module: string;
  description: string;
  subscribed_event_types: string[];
}

export interface AgentRun {
  id: string;
  agent_name: string;
  module: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  activity: string;
  metrics: Record<string, unknown>;
  error_message: string | null;
}

export interface WorkflowDescriptor {
  name: string;
  module: string;
}

export interface WorkflowRun {
  id: string;
  workflow_name: string;
  module: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  input_payload: Record<string, unknown>;
  output_payload: Record<string, unknown>;
  error_message: string | null;
}

export type ClusterStatus =
  | "pending"
  | "awaiting_handshake"
  | "connected"
  | "degraded"
  | "error";

export interface Cluster {
  id: string;
  slug: string;
  name: string;
  status: ClusterStatus;
  tunnel_ip: string;
  operator_pubkey: string;
  customer_pubkey: string | null;
  customer_endpoint: string | null;
  last_handshake_at: string | null;
  last_error: string | null;
}

export interface ClusterNode {
  name: string;
  status: string;
  roles: string[];
  version: string;
  internal_ip: string | null;
  os_image: string | null;
  cpu: string | null;
  memory: string | null;
  created_at: string | null;
}

export interface ClusterOverview {
  reachable: boolean;
  server_version: string | null;
  node_count: number;
  namespace_count: number;
  nodes: ClusterNode[];
  error: string | null;
}

export interface KubectlCommandSpec {
  id: string;
  label: string;
  kubectl: string;
  group: string;
  namespaced: boolean;
  supports_selector: boolean;
}

export type KubectlOutput = "json" | "yaml" | "cli";

export interface KubectlRunRequest {
  command_ids: string[];
  namespace?: string | null;
  label_selector?: string | null;
  output: KubectlOutput;
}

export interface KubectlResult {
  id: string;
  command: string;
  ok: boolean;
  output: string;
  error: string | null;
}

export interface ClusterCreate extends Cluster {
  // Shown exactly once on POST /clusters; subsequent GETs do not echo
  // these fields. The UI must present a "copy and store somewhere safe"
  // affordance — if lost, the operator has to re-onboard the cluster.
  invite_token: string;
  install_snippet: string;
}

export interface OnboardingStepStatus {
  id: string;
  provider: string | null;
  configured: boolean;
  status: string;
  count: number;
  missing: string[];
}

export interface OnboardingStatus {
  steps: OnboardingStepStatus[];
  completed: number;
  total: number;
}

export interface OnboardingTestResult {
  ok: boolean;
  message: string;
  latency_ms: number;
}

export interface ProvisionConfigManagerResult {
  ok: boolean;
  message: string;
  base_hostname: string;
  components: Record<string, boolean>;
  urls: Record<string, string>;
}

export interface IntegrationConfig {
  id: string;
  provider: string;
  module: string;
  name: string;
  status: string;
  // Sensitive fields (webhook_url, password, api_token, kubeconfig)
  // are echoed back as "***" — see _REDACT_FIELDS in
  // src/daalu_automation/api/routers/integrations.py. Treat any
  // string that equals "***" as "set on the server, unknown to me".
  config: Record<string, unknown>;
  // When set, the backend routes this integration's HTTP calls through
  // the named cluster's daalu-edge proxy — required for in-cluster URLs
  // like `http://prometheus.monitoring.svc.cluster.local:9090`. Null
  // means: dial the URL directly from the hub (legacy / public URL).
  cluster_tunnel_id: string | null;
}

export interface IntegrationDescriptor {
  provider: string;
  module: string;
  display_name: string;
  description: string;
  required_settings: string[];
  configured: boolean;
}

export interface Incident {
  id: string;
  title: string;
  summary: string;
  severity: string;
  status: string;
  started_at: string;
  resolved_at: string | null;
  ai_root_cause: string;
  ai_remediation: string;
  evidence: Record<string, unknown>[];
}

export type ChangeProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "failed"
  | "stale";

export type ChangeProposalKind = "drift" | "manual" | "intended_change";

export interface ChangeProposal {
  id: string;
  device_id: string;
  kind: ChangeProposalKind;
  status: ChangeProposalStatus;
  intended_config: string;
  observed_config: string;
  diff: string;
  renderer_version: string;
  // Evidence is open-ended; the engine writes
  // { triggered_by, llm_reasoning, llm_model, evidence_events, evidence_alerts, evidence_metrics, confidence }
  // and the reconciler writes { triggered_by: "reconciler", facts_changed, confidence }.
  // The detail page renders well-known keys with labels and dumps the rest as JSON.
  evidence: Record<string, unknown>;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  executed_at: string | null;
  executor_result: Record<string, unknown>;
  created_at: string;
}

// ── SoT device-management ─────────────────────────────────────────────

export type SotTransport =
  | "linux_ssh"
  | "redfish"
  | "junos"
  | "iosxr"
  | "eos"
  | "unknown";

export interface SotDevice {
  id: string;
  name: string;
  primary_ip: string | null;
  platform: string;
  transport: SotTransport;
  tags: string[];
  // Nautobot custom_field_data — operator-defined fields the editor
  // surfaces verbatim (daalu_transport, ssh_user, *_credentials_ref, …)
  extra: Record<string, unknown>;
}

export interface SotIntent {
  device_id: string;
  revision: string;
  transport: SotTransport;
  // Shape depends on transport — LinuxFacts / RedfishFacts / NetworkFacts.
  // The detail page picks the right form based on transport.
  facts: Record<string, unknown>;
  fetched_at: string;
}

export interface SotCatalogItem {
  id: string;
  name: string;
  slug: string | null;
}

export interface SotCatalog {
  sites: SotCatalogItem[];
  device_types: SotCatalogItem[];
  device_roles: SotCatalogItem[];
  platforms: SotCatalogItem[];
}

export interface SotDeviceCreate {
  name: string;
  primary_ip: string;
  site_id: string;
  device_type_id: string;
  device_role_id: string;
  platform_id?: string | null;
  transport: SotTransport;
}

export type SotBulkRowStatus = "valid" | "error" | "created";

export interface SotBulkRow {
  row: number;
  name: string;
  primary_ip: string;
  transport: string;
  site: string;
  device_type: string;
  role: string;
  platform: string | null;
  status: SotBulkRowStatus;
  error: string | null;
  device_id: string | null;
}

export interface SotBulkImportResult {
  dry_run: boolean;
  summary: { total: number; valid: number; errors: number; created: number };
  rows: SotBulkRow[];
}

export type SotReconcileStatus = "in_sync" | "drift" | "skipped" | "error";

export interface SotReconcileResult {
  device_id: string;
  status: SotReconcileStatus;
  detail: string | null;
  proposal_id: string | null;
}

// ── Reports query API ────────────────────────────────────────────────

export interface ReportsQueryColumn {
  key: string;
  label: string;
}

export interface ReportsEntityDescriptor {
  name: string;
  columns: ReportsQueryColumn[];
  filter_fields: string[];
  time_field: string | null;
}

export interface ReportsSchema {
  entities: ReportsEntityDescriptor[];
}

export interface ReportsQueryRequest {
  entity: string;
  filters?: Record<string, string | number | null>;
  since_hours?: number | null;
  limit?: number;
  display?: "table" | "count";
}

export interface ReportsQueryResponse {
  entity: string;
  display: "table" | "count";
  columns: ReportsQueryColumn[];
  rows: Array<Record<string, unknown> & { id: string }>;
  total: number;
}

export interface ReportsTranslateResponse {
  query: ReportsQueryRequest & {
    entity: string;
    filters: Record<string, string>;
    since_hours: number | null;
    limit: number;
    display: "table" | "count";
  };
  rationale: string;
}

export interface SavedReport {
  id: string;
  name: string;
  definition: ReportsQueryRequest;
  owner_user_id: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface DashboardTile {
  saved_report_id: string;
  render: "table" | "number" | "line" | "bar" | "pie";
  title?: string | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface Dashboard {
  id: string;
  name: string;
  tiles: DashboardTile[];
  owner_user_id: string | null;
  home_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReportSchedule {
  id: string;
  name: string;
  saved_report_id: string;
  cron: string;
  destination: "slack" | "email";
  recipient: string;
  format: "markdown" | "csv";
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceView {
  id: string;
  state: "provisioning" | "active" | "paused" | "destroyed" | "error";
  profile: "small" | "medium" | "large";
  model: string;
  git_repo_url: string | null;
  git_branch: string;
  // True when a PAT is stored for private-repo auth. The token itself is
  // never returned by the API.
  git_authenticated: boolean;
  ide_url: string;
}

export interface CodingModelView {
  id: string;
  label: string;
  description: string;
  gpu_class: string;
  vram_gb: number;
  available: boolean;
  default: boolean;
}
