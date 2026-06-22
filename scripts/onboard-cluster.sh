#!/usr/bin/env bash
# =============================================================================
#  Onboard this GPU + Kubernetes cluster into a running Daalu stack — one shot.
# -----------------------------------------------------------------------------
#  Automates every manual step from docs/04-deployment.md Part 2B.4 so the AI
#  Factory lights up with the live GPU view (not the "no GPU" placeholder) and
#  the agent can read the cluster, its metrics, and its logs. Run it once, on
#  the node, AFTER:
#     • Part 1   — Daalu itself is up   (docker compose up -d)
#     • Part 2B.2 — the cluster is up   (./scripts/install-gpu-k3s.sh)
#     • Part 2B.3 — a model is serving  (./scripts/serve-model.sh)
#
#  What it wires (all idempotent — safe to re-run):
#     (a) a tenant-labelled DCGM ServiceMonitor so Prometheus scrapes the GPU
#     (b) the gpu_tenants row that flips AI Factory to the live owner view
#     (c) PROMETHEUS_BASE_URL in .env (the AI Factory metrics source)
#     (d) the Kubernetes integration (kubeconfig → the agent's kubectl tools)
#     (e) the Prometheus + Loki integrations (the agent's query_* tools)
#
#  Override any default inline, e.g.:
#     GPU_CLASS=ada-16 SERVED_MODEL=qwen2.5-7b ./scripts/onboard-cluster.sh
#
#  Usage:   ./scripts/onboard-cluster.sh        (run from the repo root or anywhere)
# =============================================================================
set -euo pipefail

GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; BLU=$'\033[36m'; RST=$'\033[0m'
say()  { printf "%s\n" "${BLU}▶${RST} $*"; }
ok()   { printf "%s\n" "${GRN}✔${RST} $*"; }
warn() { printf "%s\n" "${YLW}!${RST} $*"; }
die()  { printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; }

# Run from the repo root (where docker-compose.yml lives) regardless of cwd.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f docker-compose.yml ] || die "run this from the Daalu repo (docker-compose.yml not found)"

# ── Tunables (override via env) ──────────────────────────────────────────────
GPU_CLASS="${GPU_CLASS:-ada-48}"               # display class shown in AI Factory
SERVED_MODEL="${SERVED_MODEL:-qwen3-coder-30b}"  # served model id (== your LLM_MODEL)
PROM_NODEPORT="${PROM_NODEPORT:-30090}"        # Prometheus NodePort (2B.2)
LOKI_NODEPORT="${LOKI_NODEPORT:-30310}"        # Loki NodePort       (2B.2)
VLLM_NODEPORT="${VLLM_NODEPORT:-30800}"        # vLLM NodePort       (2B.3)
DCGM_NAMESPACE="${DCGM_NAMESPACE:-gpu-operator}"
DC="docker compose"
API="http://localhost:8000"

command -v kubectl >/dev/null 2>&1 || die "kubectl not found — run ./scripts/install-gpu-k3s.sh first"
command -v python3 >/dev/null 2>&1 || die "python3 is required (used to JSON-encode the kubeconfig)"
$DC ps >/dev/null 2>&1 || die "docker compose stack not found here — start Daalu first (docker compose up -d)"

# ── 0. Preconditions: stack + cluster reachable ──────────────────────────────
say "Checking the Daalu stack is up"
$DC exec -T postgres psql -U daalu -d daalu_agent -c '\q' >/dev/null 2>&1 \
  || die "postgres isn't ready — is the stack up? (docker compose up -d)"
kubectl get nodes >/dev/null 2>&1 || die "kubectl can't reach the cluster — check 2B.2"
ok "stack + cluster reachable"

# Tenant id (the single self-hosted tenant) and this node's first IPv4.
TENANT_ID="$($DC exec -T postgres psql -U daalu -d daalu_agent -tA \
  -c 'select id from tenants order by created_at limit 1;' | tr -d '[:space:]')"
[ -n "$TENANT_ID" ] || die "no tenant found — has the API booted at least once?"
NODE_IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null \
  | tr ' ' '\n' | grep -vF ':' | head -1 || true)"
[ -n "$NODE_IP" ] || NODE_IP="$(hostname -I | awk '{print $1}')"
ok "tenant ${TENANT_ID}  @  node ${NODE_IP}"

# ── (a) Tenant-labelled DCGM ServiceMonitor ──────────────────────────────────
say "(a) Scraping GPU/DCGM metrics, tenant-labelled"
if kubectl apply -f - >/dev/null 2>&1 <<YAML
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nvidia-dcgm-exporter
  namespace: ${DCGM_NAMESPACE}
  labels: { release: kube-prometheus-stack }
spec:
  selector: { matchLabels: { app: nvidia-dcgm-exporter } }
  endpoints:
    - port: gpu-metrics
      interval: 15s
      relabelings:
        - { targetLabel: tenant,    replacement: "${TENANT_ID}" }
        - { targetLabel: gpu_class, replacement: "${GPU_CLASS}" }
YAML
then ok "ServiceMonitor applied (tenant=${TENANT_ID}, gpu_class=${GPU_CLASS})"
else warn "couldn't apply the ServiceMonitor — is the Prometheus Operator installed? (2B.2 TELEMETRY=true)"; fi

# ── (b) gpu_tenants row → AI Factory owner view ──────────────────────────────
say "(b) Marking the GPU as this tenant's (owner)"
$DC exec -T postgres psql -U daalu -d daalu_agent >/dev/null <<SQL && ok "gpu_tenants row upserted" || warn "gpu_tenants upsert failed"
INSERT INTO gpu_tenants (id, tenant_id, state, namespace, gpu_class, model_classifier,
                         shared, service_url, created_at, updated_at)
VALUES (gen_random_uuid(), '${TENANT_ID}', 'active', 'daalu', '${GPU_CLASS}', '${SERVED_MODEL}',
        false, 'http://host.docker.internal:${VLLM_NODEPORT}/v1', now(), now())
ON CONFLICT (tenant_id) DO UPDATE
  SET state='active', gpu_class=EXCLUDED.gpu_class, model_classifier=EXCLUDED.model_classifier,
      service_url=EXCLUDED.service_url, updated_at=now();
SQL

# ── (c) PROMETHEUS_BASE_URL in .env (AI Factory metrics source) ───────────────
say "(c) Pointing Daalu at the cluster Prometheus"
PROM_ENV="http://host.docker.internal:${PROM_NODEPORT}"
touch .env
if grep -q '^PROMETHEUS_BASE_URL=' .env; then
  # Replace in place (portable: rewrite the line).
  python3 - "$PROM_ENV" <<'PY'
import re, sys
val = sys.argv[1]
txt = open(".env").read()
txt = re.sub(r'^PROMETHEUS_BASE_URL=.*$', f'PROMETHEUS_BASE_URL={val}', txt, flags=re.M)
open(".env", "w").write(txt)
PY
else
  printf '\n# cluster Prometheus — AI Factory live GPU view (onboard-cluster.sh)\nPROMETHEUS_BASE_URL=%s\n' "$PROM_ENV" >> .env
fi
ok "PROMETHEUS_BASE_URL=${PROM_ENV}"

say "Recreating api/worker/agents/beat so they re-read .env"
$DC up -d --force-recreate api worker agents beat >/dev/null 2>&1 && ok "services recreated" || warn "recreate failed — run: docker compose up -d --force-recreate api worker agents beat"

say "Waiting for the API to come back"
for _ in $(seq 1 30); do curl -fsS -m 2 "$API/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 2 "$API/health" >/dev/null 2>&1 && ok "API healthy" || warn "API not healthy yet — give it a few more seconds"

# ── Register integrations via the local REST API (LOCAL_NO_AUTH) ──────────────
# Self-hosted runs with LOCAL_NO_AUTH=true, so these need no token. config{}
# fully replaces the stored row, so re-running just refreshes the URL/kubeconfig.
reg() { # reg <provider> <json-config>
  curl -fsS -X PUT "$API/api/v1/integrations/config/$1" \
    -H 'content-type: application/json' -d "{\"config\": $2}" >/dev/null 2>&1 \
    && ok "  registered '$1'" \
    || warn "  failed to register '$1' (add it by hand in the UI → Managed infra)"
}

# ── (d) Kubernetes integration (the agent's kubectl tools) ────────────────────
say "(d) Attaching the cluster for kubectl"
# Take the live kubeconfig and point its server at the node IP (the k3s API
# cert already lists the node IP as a SAN) so the containers can reach it.
KCFG="$(kubectl config view --raw --minify 2>/dev/null | sed -E "s#server: https://[^[:space:]]+#server: https://${NODE_IP}:6443#")"
if [ -n "$KCFG" ]; then
  K8S_PAYLOAD="$(printf '%s' "$KCFG" | python3 -c 'import json,sys; print(json.dumps({"kubeconfig": sys.stdin.read()}))')"
  reg kubernetes "$K8S_PAYLOAD"
else
  warn "  couldn't read the kubeconfig — add it by hand in Managed infra → Kubernetes"
fi

# ── (e) Prometheus + Loki integrations (the agent's query_* tools) ────────────
say "(e) Wiring the agent's metric + log query tools"
reg prometheus "{\"url\": \"http://host.docker.internal:${PROM_NODEPORT}\"}"
reg loki       "{\"url\": \"http://host.docker.internal:${LOKI_NODEPORT}\"}"

# ── Verify + report ──────────────────────────────────────────────────────────
say "Verifying AI Factory resolves to the owner view"
OVERVIEW="$(curl -fsS -m 5 "$API/api/v1/ai-factory/overview" 2>/dev/null || true)"
case "$OVERVIEW" in
  *'"role":"owner"'*'"metrics_available":true'*|*'"metrics_available":true'*'"role":"owner"'*)
    ok "AI Factory: owner view, metrics available" ;;
  *'"role":"owner"'*)
    warn "AI Factory shows the owner view but metrics aren't flowing yet — DCGM series take ~30s after (a); reload shortly." ;;
  *)
    warn "couldn't confirm the owner view via the API yet — give it a few seconds and reload the UI." ;;
esac

cat <<EOF

${GRN}✔ Cluster onboarded.${RST}  Open the UI:  ${BLU}http://${NODE_IP}:3000${RST}

  What's now live (integration status flips to "connected" within ~60s, after
  the first health probe — reload if it still says pending):

   • ${GRN}AI Factory${RST}            http://${NODE_IP}:3000/ai-factory
       Live GPU utilisation / thermals / VRAM + the AIPerf launcher.

   • ${GRN}Managed infra → Kubernetes${RST}    (Overview & kubectl console)
       Click in to browse nodes/pods and run read-only kubectl commands.

   • ${GRN}Managed infra → Observability${RST} (Prometheus + Loki, now connected)
       Click "Open" on Prometheus or Loki for ready-made metric / log queries.

  Nothing showed up? Re-run this script — it's idempotent — or see
  docs/04-deployment.md Part 2B.4 for the manual equivalent of each step.
EOF
