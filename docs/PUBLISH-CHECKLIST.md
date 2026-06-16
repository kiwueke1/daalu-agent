# Pre-publish checklist

This carve was built from a private monorepo. It's runnable today, but do these
before making the repo public / posting it.

## Must-do (correctness & hygiene)

- [ ] **Test the quickstart from clean.** `./install.sh` on a fresh machine,
      pointed at a real Ollama/vLLM, and click through the UI. The first
      command a stranger runs must work.
- [ ] **Test the bare-GPU path on real GPU hardware.** `scripts/install-gpu-k3s.sh`
      then `scripts/serve-model.sh` — confirm the GPU Operator schedules, vLLM
      loads the default open model, and the printed `LLM_BASE_URL` is reachable
      from the Compose stack. (Authored against the standard vLLM/k3s pattern but
      not run on GPU hardware in this environment.)
- [ ] **Test the demo lab end-to-end** (`demo/up.sh` → `break.sh` → approve fix →
      `down.sh`). It needs docker/kind/helm and ~6 GB Docker RAM. Verify the
      kind-network connect finds the Compose containers, the integration
      auto-registration succeeds, and the `DummyAppDown` alert reaches Daalu.
      (Authored against the standard kind/kube-prometheus-stack pattern but not
      run in this environment.)
- [x] **Frontend trim (done).** Removed the commercial/auth page routes
      (`billing/`, `ai-factory/`, `managed-infra/`, `clusters/`, `onboarding/`,
      `workspace/`, `network/`, `settings/`, `login/`, `signup/`,
      `accept-invite/`, `verify-email/`, `cli/`), the orphaned
      `components/onboarding/`, fixed all dangling links, removed dead nav
      entries, and made the integrations connect-modal use only kept endpoints.
      **Still TODO:** run `cd frontend && npm install && npm run build` once to
      confirm the production build is green — it could not be run in the authoring
      environment. The `lib/api.ts` client still defines unused methods for
      removed endpoints (harmless; prune if you want a tidier client).
- [ ] **Set the real GitHub org/repo.** The help page uses a `DOCS_BASE`
      constant (`frontend/app/help/page.tsx`) pointing at a placeholder
      `daalu-io/daalu` repo — set it to the actual public repo.
- [ ] **Add a demo GIF** to the README (the `(demo GIF goes here)` marker): a
      60–90s real alert → investigate → propose → approve → resolve.
- [ ] **Rotate nothing-secret check.** `.env` is gitignored; only `.env.example`
      ships. Confirm no real `.env`, kubeconfig, or secret is committed.

## Should-do (polish)

- [ ] **Admin CLI trim.** `src/daalu_automation/cli.py` still defines commands for
      removed services (`inference-gateway`, `gpu-controller`,
      `workspace-controller`, `chat`, `workspace-mint-token`, the keycloak
      commands). They import lazily so they don't break startup, but they'll
      error if invoked. Remove them for a clean `daalu --help`.
- [ ] **Closed-feature models/migrations.** All ORM models + Alembic migrations
      were carried over, including hub-only tables (cluster_tunnel, billing
      skus, gpu_pool…). Harmless (the agent ignores them) but you may want to
      drop them for tidiness. Note `core/cluster_proxy.py` imports
      `ClusterTunnel`, so removing that model needs the stub adjusted.
- [ ] **NV-CM images.** The vendored chart defaults to an NVIDIA-internal
      registry namespace users can't pull. Document/automate the
      build-from-source + mirror flow (see `components/nv-config-manager/`).

## Decisions already made

- **License:** Apache-2.0 (`LICENSE`). NV-CM is vendored Apache-2.0 with NVIDIA
  attribution preserved (`NOTICE`, `components/nv-config-manager/NVIDIA-*`).
- **Auth:** single-operator. `LOCAL_NO_AUTH=true` runs with no login; there is no
  built-in login UI/SSO in this build. Shared/networked installs go behind an
  authenticating reverse proxy (see [04-deployment.md](04-deployment.md) §A9).
- **Scope:** the single-player infra agent. The multi-tenant hub (SSO, billing,
  WireGuard fleet, GPU provisioning) is intentionally excluded.
