#!/usr/bin/env bash
# =============================================================================
#  Daalu demo lab — stand up a small, monitored cluster for Daalu to watch.
# -----------------------------------------------------------------------------
#  Creates a local kind cluster and installs:
#    • kube-prometheus-stack  (Prometheus + Alertmanager + Grafana + kube-state-metrics)
#    • Loki + Promtail        (log aggregation)
#    • dummy-app              (a trivial nginx app we will break on purpose)
#    • a fast-firing alert    (DummyAppDown) for the dummy app
#  …then connects your running Daalu to the cluster and registers the
#  Prometheus, Loki, and Kubernetes integrations so Daalu can see + fix issues.
#
#  Prereqs: docker, kind, kubectl, helm, curl, python3 — and Daalu already
#  running (./install.sh in the repo root). ~6 GB of Docker RAM recommended.
#
#  Usage:   ./demo/up.sh
#  Teardown: ./demo/down.sh
# =============================================================================
set -euo pipefail

CLUSTER="daalu-demo"
NODE="${CLUSTER}-control-plane"          # kind names the node container this
KIND_NET="kind"                           # docker network kind uses
DAALU_API="${DAALU_API:-http://localhost:8000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Where Daalu (on the kind network) reaches the in-cluster services:
ALERTMANAGER_URL="http://${NODE}:30903"
LOKI_URL="http://${NODE}:30100"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; BLU=$'\033[36m'; RST=$'\033[0m'
say(){ printf "%s\n" "${BLU}▶${RST} $*"; }
ok(){ printf "%s\n" "${GRN}✔${RST} $*"; }
warn(){ printf "%s\n" "${YLW}!${RST} $*"; }
die(){ printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; }

# ── 0. Prerequisites ─────────────────────────────────────────────────────────
say "Checking prerequisites"
for bin in docker kind kubectl helm curl python3; do
  command -v "$bin" >/dev/null 2>&1 || die "missing '$bin'. Install it and retry. (kind: https://kind.sigs.k8s.io, helm: https://helm.sh)"
done
docker info >/dev/null 2>&1 || die "the docker daemon isn't running"
ok "tooling present"

# Daalu must be up so we can register integrations against its API.
if ! curl -fsS "${DAALU_API}/health" >/dev/null 2>&1; then
  die "Daalu isn't reachable at ${DAALU_API}. Start it first (./install.sh in the repo root), then re-run."
fi
ok "Daalu API healthy at ${DAALU_API}"

# ── 1. kind cluster ──────────────────────────────────────────────────────────
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  ok "kind cluster '${CLUSTER}' already exists"
else
  say "Creating kind cluster '${CLUSTER}'"
  kind create cluster --name "$CLUSTER" --config "${HERE}/kind-config.yaml"
  ok "cluster created"
fi
kubectl config use-context "kind-${CLUSTER}" >/dev/null

# ── 2. Monitoring stack (Prometheus + Alertmanager + Grafana) ────────────────
say "Installing kube-prometheus-stack (this pulls several images — a few minutes)"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set prometheus.service.type=NodePort --set prometheus.service.nodePort=30909 \
  --set alertmanager.service.type=NodePort --set alertmanager.service.nodePort=30903 \
  --set grafana.service.type=NodePort --set grafana.service.nodePort=30300 \
  --set grafana.adminPassword=admin \
  --set defaultRules.create=false \
  --set prometheus.prometheusSpec.retention=3h \
  --set prometheus.prometheusSpec.resources.requests.memory=256Mi \
  --wait --timeout 12m
ok "monitoring stack up"

# ── 3. Loki + Promtail ───────────────────────────────────────────────────────
say "Installing Loki + Promtail"
helm upgrade --install loki grafana/loki-stack \
  --namespace monitoring \
  --set promtail.enabled=true \
  --wait --timeout 8m
# Make Loki reachable on a fixed NodePort regardless of chart version.
kubectl -n monitoring patch svc loki -p \
  '{"spec":{"type":"NodePort","ports":[{"name":"http-metrics","port":3100,"targetPort":3100,"nodePort":30100}]}}' >/dev/null 2>&1 || \
  warn "couldn't patch the loki service to NodePort — the Loki integration may be unreachable (non-fatal)."
ok "logging stack up"

# ── 4. Dummy app + its alert ─────────────────────────────────────────────────
say "Deploying the demo apps and alert rules"
kubectl apply -f "${HERE}/manifests/dummy-app.yaml" >/dev/null
kubectl apply -f "${HERE}/manifests/dummy-app-alerts.yaml" >/dev/null
kubectl apply -f "${HERE}/manifests/metrics-app.yaml" >/dev/null
kubectl -n daalu-demo rollout status deploy/dummy-app --timeout=3m
kubectl -n daalu-demo rollout status deploy/metrics-app --timeout=3m
ok "dummy-app + metrics-app running (healthy)"

# ── 5. Connect Daalu to the cluster network ──────────────────────────────────
# Put Daalu's containers on the same docker network as the kind node so they can
# reach the API server (valid TLS via the internal kubeconfig) and the NodePort
# services by name.
say "Connecting Daalu's containers to the '${KIND_NET}' network"
mapfile -t DAALU_CIDS < <(cd "$REPO" && docker compose ps -q 2>/dev/null)
[ "${#DAALU_CIDS[@]}" -gt 0 ] || die "found no running Daalu containers (docker compose ps empty in $REPO)."
for cid in "${DAALU_CIDS[@]}"; do
  docker network connect "$KIND_NET" "$cid" >/dev/null 2>&1 || true
done
ok "connected ${#DAALU_CIDS[@]} container(s)"

# ── 6. Register integrations with Daalu ──────────────────────────────────────
say "Registering Daalu integrations (prometheus, loki, kubernetes)"

reg() { # reg <provider> <json-config>
  curl -fsS -X PUT "${DAALU_API}/api/v1/integrations/config/$1" \
    -H 'content-type: application/json' \
    -d "{\"config\": $2}" >/dev/null \
    && ok "  registered '$1'" \
    || warn "  failed to register '$1' (you can add it by hand in the UI → Integrations)"
}

reg prometheus "{\"url\": \"${ALERTMANAGER_URL}\"}"
reg loki       "{\"url\": \"${LOKI_URL}\"}"

# The kubernetes integration carries the cluster's kubeconfig. Use kind's
# --internal kubeconfig: its server is the node's container name on the kind
# network (TLS-valid), which is exactly what our connected Daalu containers can
# reach.
KCFG="$(kind get kubeconfig --internal --name "$CLUSTER")"
K8S_PAYLOAD="$(printf '%s' "$KCFG" | python3 -c 'import json,sys; print(json.dumps({"kubeconfig": sys.stdin.read()}))')"
curl -fsS -X PUT "${DAALU_API}/api/v1/integrations/config/kubernetes" \
  -H 'content-type: application/json' \
  -d "{\"config\": ${K8S_PAYLOAD}}" >/dev/null \
  && ok "  registered 'kubernetes' (kind cluster handed to Daalu)" \
  || warn "  failed to register 'kubernetes' (add the kubeconfig by hand in the UI)"

# ── Done ─────────────────────────────────────────────────────────────────────
cat <<EOF

${GRN}✔ Demo lab is up.${RST}

  Browse the stack (optional):
     Grafana:       http://localhost:3001   (admin / admin)
     Prometheus:    http://localhost:9090
     Alertmanager:  http://localhost:9093

  Daalu is now watching this cluster. To run the demo:
     ${BOLD}./demo/break.sh${RST}      # introduce an issue (default: a bad image)
     # …then open Daalu (http://localhost:3000) → Alerts. Within ~2–3 min the
     # DummyAppDown alert appears; open it and let the agent investigate. It will
     # inspect the pods/events, find the bad rollout, and propose a fix
     # (a rollback) as a Change Proposal for you to approve.
     ${BOLD}./demo/status.sh${RST}     # see app + alert state at any time
     ${BOLD}./demo/down.sh${RST}       # tear the whole lab down

  Manual fix (if you want to fix it yourself instead of via Daalu):
     kubectl -n daalu-demo rollout undo deploy/dummy-app
EOF
