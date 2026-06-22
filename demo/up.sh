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
# Host address the monitoring NodePorts are published on (browser access only;
# Daalu reaches the cluster over the kind network, not these). Default 0.0.0.0.
# Override when localhost ports are taken (e.g. a VS Code remote forwarding the
# ports, or another tool) — e.g. DEMO_BIND_ADDR=172.17.0.1 to bind the Docker
# bridge IP instead. Then browse the stack at http://<DEMO_BIND_ADDR>:<port>.
BIND_ADDR="${DEMO_BIND_ADDR:-0.0.0.0}"
BROWSE_HOST="$BIND_ADDR"; [ "$BIND_ADDR" = "0.0.0.0" ] && BROWSE_HOST="localhost"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Where Daalu (on the kind network) reaches the in-cluster services:
# The Prometheus/Alertmanager integration points at PROMETHEUS (not Alertmanager):
# Prometheus serves both the PromQL API the Observability page needs AND firing
# alerts via /api/v1/alerts (the adapter falls back to it when /api/v2/alerts is
# absent). Pointing it at Alertmanager (:30903) makes alerts work but 404s the
# metrics page — so we use :30909, matching scripts/onboard-cluster.sh.
PROMETHEUS_URL="http://${NODE}:30909"
ALERTMANAGER_URL="http://${NODE}:30903"
LOKI_URL="http://${NODE}:30100"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; BLU=$'\033[36m'; RST=$'\033[0m'
say(){ printf "%s\n" "${BLU}▶${RST} $*"; }
ok(){ printf "%s\n" "${GRN}✔${RST} $*"; }
warn(){ printf "%s\n" "${YLW}!${RST} $*"; }
die(){ printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; }

# ── CLI bootstrap (prebuilt binaries — no brew, no sudo) ──────────────────────
# kind/kubectl/helm are single static Go binaries. Where they're already on PATH
# (e.g. a Linux server) the system copies are used and nothing downloads. When
# missing — notably macOS 13 / any non-Tier-1 macOS, where `brew install` builds
# them from source (slow, disk-hungry, often fails) — we fetch the official
# prebuilt binary into BINDIR instead. Override the location with
# DAALU_DEMO_BINDIR; set DAALU_DEMO_NO_AUTOINSTALL=1 to require manual installs.
BINDIR="${DAALU_DEMO_BINDIR:-$HOME/.daalu/bin}"
export PATH="$PATH:$BINDIR"

# Shared kind-vs-current-cluster helpers. The dedicated-kubeconfig override is
# applied later by demo_kube_setup, once the mode is known — current-cluster
# mode must keep using your ambient kubectl/context (notably a k3s box that is
# already connected to Daalu), so we deliberately don't pin KUBECONFIG up front.
. "${HERE}/lib-cluster.sh"

dl(){ curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"; }

detect_platform(){
  case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) die "unsupported OS $(uname -s) — install kind/kubectl/helm manually" ;; esac
  case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; arm64|aarch64) ARCH=arm64 ;; *) die "unsupported arch $(uname -m) — install kind/kubectl/helm manually" ;; esac
}
gh_latest(){ curl -fsSL "https://api.github.com/repos/$1/releases/latest" 2>/dev/null | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4; }

install_kubectl(){
  local ver; ver="$(curl -fsSL https://dl.k8s.io/release/stable.txt || true)"
  [ -n "$ver" ] || die "couldn't resolve the kubectl stable version (no network?)"
  say "  fetching kubectl ${ver} (${OS}/${ARCH})"
  dl "https://dl.k8s.io/release/${ver}/bin/${OS}/${ARCH}/kubectl" "$BINDIR/kubectl"; chmod +x "$BINDIR/kubectl"
}
install_kind(){
  local ver; ver="$(gh_latest kubernetes-sigs/kind || true)"; [ -n "$ver" ] || ver="v0.27.0"
  say "  fetching kind ${ver} (${OS}/${ARCH})"
  dl "https://kind.sigs.k8s.io/dl/${ver}/kind-${OS}-${ARCH}" "$BINDIR/kind"; chmod +x "$BINDIR/kind"
}
install_helm(){
  local ver tmp; ver="$(gh_latest helm/helm || true)"; [ -n "$ver" ] || ver="v3.16.4"
  tmp="$(mktemp -d)"
  say "  fetching helm ${ver} (${OS}/${ARCH})"
  dl "https://get.helm.sh/helm-${ver}-${OS}-${ARCH}.tar.gz" "$tmp/helm.tgz"
  tar -xzf "$tmp/helm.tgz" -C "$tmp"; mv "$tmp/${OS}-${ARCH}/helm" "$BINDIR/helm"; chmod +x "$BINDIR/helm"; rm -rf "$tmp"
}
ensure_cli(){ # ensure_cli <name> <installer-fn>
  command -v "$1" >/dev/null 2>&1 && return 0
  [ "${DAALU_DEMO_NO_AUTOINSTALL:-0}" = "1" ] && die "missing '$1' and auto-install is off (DAALU_DEMO_NO_AUTOINSTALL=1) — install it manually and retry."
  mkdir -p "$BINDIR"; detect_platform; "$2"; hash -r
  command -v "$1" >/dev/null 2>&1 || die "fetched '$1' into $BINDIR but it isn't runnable"
  ok "  installed $1 → $BINDIR/$1"
}

# ── 0. Prerequisites ─────────────────────────────────────────────────────────
say "Checking prerequisites"
# Can't safely auto-install these (Docker Desktop / system packages):
for bin in docker curl python3; do
  command -v "$bin" >/dev/null 2>&1 || die "missing '$bin'. Install it and retry. (docker: Docker Desktop; python3: Xcode CLT or Homebrew)"
done
docker info >/dev/null 2>&1 || die "the docker daemon isn't running"
# kubectl is needed in both modes; fetch it if absent (see CLI bootstrap above).
ensure_cli kubectl install_kubectl
# Now that kubectl exists, decide which cluster to use. Auto-detect inspects your
# CURRENT context (see lib-cluster.sh): if it already runs the Prometheus
# operator we reuse it and install nothing; otherwise we fall back to a kind
# cluster. kind + helm are only needed when we actually create one.
demo_resolve_mode
if [ "$DEMO_MODE" = "kind" ]; then
  ensure_cli kind install_kind
  ensure_cli helm install_helm
fi
# Low-disk heads-up — the monitoring images need a few GB.
AVAIL_KB="$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}' || true)"
if [ -n "${AVAIL_KB:-}" ] && [ "$AVAIL_KB" -lt 5242880 ]; then
  warn "low free disk on / (~$((AVAIL_KB/1024/1024)) GB). Monitoring images need a few GB — if pulls fail with 'no space left on device', free space (brew cleanup -s; docker image prune -af) and re-run."
fi
ok "tooling present"

# Daalu must be up so we can register integrations against its API.
if ! curl -fsS "${DAALU_API}/health" >/dev/null 2>&1; then
  die "Daalu isn't reachable at ${DAALU_API}. Start it first (./install.sh in the repo root), then re-run."
fi
ok "Daalu API healthy at ${DAALU_API}"

# ── 1. Cluster ───────────────────────────────────────────────────────────────
demo_kube_setup   # pins the dedicated kubeconfig in kind mode; a no-op otherwise
if [ "$DEMO_MODE" = "current" ]; then
  # Reuse the cluster your kubectl already points at — create nothing.
  demo_detect_release
  CTX="$(kubectl config current-context 2>/dev/null || echo '?')"
  ok "Using your current cluster (context '${CTX}') — no kind cluster created."
  say "  demo alert rules will be labelled ${BLU}release=${DEMO_RULE_RELEASE}${RST} so your Prometheus operator adopts them"
else
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    ok "kind cluster '${CLUSTER}' already exists"
  else
    say "Creating kind cluster '${CLUSTER}'"
    # Render the kind config with the chosen bind address (the committed config
    # uses 0.0.0.0; DEMO_BIND_ADDR swaps it without editing the tracked file).
    RENDERED_CFG="$(mktemp)"
    trap 'rm -f "$RENDERED_CFG"' EXIT
    sed "s/listenAddress: \"0.0.0.0\"/listenAddress: \"${BIND_ADDR}\"/" \
      "${HERE}/kind-config.yaml" > "$RENDERED_CFG"
    kind create cluster --name "$CLUSTER" --config "$RENDERED_CFG"
    ok "cluster created"
  fi
  # Write kind's context into our KUBECONFIG and select it. Doing this for the
  # already-exists branch too makes re-runs work even when the context isn't yet
  # in this kubeconfig (e.g. first run after switching to the dedicated file).
  kind export kubeconfig --name "$CLUSTER" >/dev/null 2>&1
  kubectl config use-context "kind-${CLUSTER}" >/dev/null
fi

# ── 2 + 3. Monitoring + logging stacks ───────────────────────────────────────
# Only in kind mode: a fresh kind cluster has no monitoring, so we install our
# own Prometheus operator + Loki. In current mode we reuse what's already on
# your cluster (that's how Daalu is reading it), so we install nothing here.
if [ "$DEMO_MODE" = "current" ]; then
  ok "Reusing the monitoring + logging already on your cluster (no install)."
else
  # ── 2. Monitoring stack (Prometheus + Alertmanager + Grafana) ──────────────
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

  # ── 3. Loki + Promtail ─────────────────────────────────────────────────────
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
fi

# ── 4. Demo apps + their alerts ──────────────────────────────────────────────
# checkout-api is the primary scenario: a realistic memory-bound service that
# the break grows out of its memory limit (OOMKilled → crash-loop), fixed by
# patching it more memory. dummy-app/metrics-app remain for the rollback and
# metrics scenarios.
say "Deploying the demo apps and alert rules"
# demo_apply applies verbatim in kind mode; in current mode it retargets the
# PrometheusRule/ServiceMonitor at your cluster's operator (release label +
# namespace) so the alerts are adopted and clean up with the namespace.
demo_apply "${HERE}/manifests/checkout-api.yaml" >/dev/null
demo_apply "${HERE}/manifests/checkout-api-alerts.yaml" >/dev/null
demo_apply "${HERE}/manifests/dummy-app.yaml" >/dev/null
demo_apply "${HERE}/manifests/dummy-app-alerts.yaml" >/dev/null
demo_apply "${HERE}/manifests/metrics-app.yaml" >/dev/null
kubectl -n daalu-demo rollout status deploy/checkout-api --timeout=3m
kubectl -n daalu-demo rollout status deploy/dummy-app --timeout=3m
kubectl -n daalu-demo rollout status deploy/metrics-app --timeout=3m
ok "checkout-api + dummy-app + metrics-app running (healthy)"

# ── 5 + 6. Wire Daalu to the cluster ─────────────────────────────────────────
if [ "$DEMO_MODE" = "current" ] && [ "${DEMO_MANUAL_ONBOARD:-0}" = "1" ]; then
  # Existing cluster, manual onboarding: register NOTHING. Write a kubeconfig to
  # paste into the UI and compute the Prometheus/Loki URLs the Daalu containers
  # use to reach THIS cluster — the node's telemetry NodePorts via
  # host.docker.internal, matching scripts/install-gpu-k3s.sh /
  # scripts/onboard-cluster.sh (override with PROM_NODEPORT / LOKI_NODEPORT).
  say "Manual onboarding mode — integrations NOT auto-registered (existing cluster)"
  CUR_PROM_URL="http://host.docker.internal:${PROM_NODEPORT:-30090}"
  CUR_LOKI_URL="http://host.docker.internal:${LOKI_NODEPORT:-30310}"
  # First IPv4 InternalIP of the node — the k3s API cert lists it as a SAN, so
  # the containers can reach the API server there (the raw kubeconfig usually
  # says 127.0.0.1:6443, which is wrong from inside a container).
  NODE_IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null \
    | tr ' ' '\n' | grep -vF ':' | head -1 || true)"
  [ -n "$NODE_IP" ] || NODE_IP="$(hostname -I | awk '{print $1}')"
  ONBOARD_KCFG="$(dirname "$BINDIR")/daalu-demo-onboard.kubeconfig"
  KCFG="$(kubectl config view --raw --minify 2>/dev/null \
    | sed -E "s#server: https://[^[:space:]]+#server: https://${NODE_IP}:6443#")"
  if [ -n "$KCFG" ]; then
    printf '%s\n' "$KCFG" > "$ONBOARD_KCFG"
    chmod 600 "$ONBOARD_KCFG"
    ok "  kubeconfig written for the Kubernetes integration → ${ONBOARD_KCFG}"
  else
    warn "  couldn't read your kubeconfig — copy it by hand for the Kubernetes integration"
  fi
elif [ "$DEMO_MODE" = "current" ]; then
  # Your cluster is already connected to Daalu (that's how auto-detect found its
  # Prometheus operator), so there is nothing to network-connect or register:
  # Daalu already reaches it through your existing kubernetes/prometheus/loki
  # integrations, and the alert rule we just deployed is read by the same
  # Prometheus. We reuse all of it.
  ok "Reusing your existing Daalu integrations for this cluster (nothing re-registered)."
else
# ── 5. Connect Daalu to the cluster network ──────────────────────────────────
# Put Daalu's containers on the same docker network as the kind node so they can
# reach the API server (valid TLS via the internal kubeconfig) and the NodePort
# services by name.
say "Connecting Daalu's cluster-facing containers to the '${KIND_NET}' network"
# Only the services that actually reach the cluster need this: api + agents
# (kubectl tools), worker (polls the cluster's Alertmanager/Loki), executor
# (applies approved kubectl changes). Deliberately NOT the frontend — its
# Next.js server binds a single interface and a second Docker network breaks
# its published port (the UI goes unreachable) — nor postgres/redis (internal
# only). The frontend talks to the API over the default compose network.
# Portable container-id collection — works on bash 3.2 (stock macOS) too, where
# `mapfile`/`readarray` (bash 4+) isn't available.
DAALU_CIDS=()
while IFS= read -r cid; do
  [ -n "$cid" ] && DAALU_CIDS+=("$cid")
done < <(cd "$REPO" && docker compose ps -q api worker agents executor 2>/dev/null)
[ "${#DAALU_CIDS[@]}" -gt 0 ] || die "found no running Daalu containers (docker compose ps empty in $REPO)."
for cid in "${DAALU_CIDS[@]}"; do
  docker network connect "$KIND_NET" "$cid" >/dev/null 2>&1 || true
done
ok "connected ${#DAALU_CIDS[@]} container(s)"

# ── 6. Integrations ──────────────────────────────────────────────────────────
# The kubernetes integration carries the cluster's kubeconfig. Use kind's
# --internal kubeconfig: its server is the node's container name on the kind
# network (TLS-valid), which is exactly what our connected Daalu containers
# reach. The Prometheus/Alertmanager + Loki URLs are likewise the node's
# NodePorts as seen FROM those containers (not the host's localhost ports).
KCFG="$(kind get kubeconfig --internal --name "$CLUSTER")"

if [ "${DEMO_MANUAL_ONBOARD:-0}" = "1" ]; then
  # Demo-recording mode: do NOT auto-register. Drop the kubeconfig to a file
  # and let the final banner print exactly what to paste into the UI, so the
  # onboarding can be performed on camera. (Also sidesteps the host→:8000
  # publish-port quirk caused by joining the kind network — the UI registers
  # over the internal Docker network instead.)
  ONBOARD_KCFG="$(dirname "$BINDIR")/daalu-demo-onboard.kubeconfig"
  printf '%s\n' "$KCFG" > "$ONBOARD_KCFG"
  chmod 600 "$ONBOARD_KCFG"
  say "Manual onboarding mode — integrations NOT auto-registered"
  ok "  kubeconfig written for the Kubernetes integration → ${ONBOARD_KCFG}"
else
  say "Registering Daalu integrations (prometheus, loki, kubernetes)"
  reg() { # reg <provider> <json-config>
    curl -fsS -X PUT "${DAALU_API}/api/v1/integrations/config/$1" \
      -H 'content-type: application/json' \
      -d "{\"config\": $2}" >/dev/null \
      && ok "  registered '$1'" \
      || warn "  failed to register '$1' (you can add it by hand in the UI → Integrations)"
  }
  reg prometheus "{\"url\": \"${PROMETHEUS_URL}\"}"
  reg loki       "{\"url\": \"${LOKI_URL}\"}"
  K8S_PAYLOAD="$(printf '%s' "$KCFG" | python3 -c 'import json,sys; print(json.dumps({"kubeconfig": sys.stdin.read()}))')"
  curl -fsS -X PUT "${DAALU_API}/api/v1/integrations/config/kubernetes" \
    -H 'content-type: application/json' \
    -d "{\"config\": ${K8S_PAYLOAD}}" >/dev/null \
    && ok "  registered 'kubernetes' (kind cluster handed to Daalu)" \
    || warn "  failed to register 'kubernetes' (add the kubeconfig by hand in the UI)"
fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
if [ "$DEMO_MODE" = "current" ] && [ "${DEMO_MANUAL_ONBOARD:-0}" = "1" ]; then
cat <<EOF

${GRN}✔ Demo app deployed to your existing cluster (manual-onboard mode — nothing auto-registered).${RST}

  Onboard these three in the UI to record the flow — open
  http://${BROWSE_HOST}:3000 → Integrations (or Managed infra):

   • Kubernetes               → paste the full contents of this file:
        ${ONBOARD_KCFG}
        ${DIM}(copy it:  cat ${ONBOARD_KCFG})${RST}
   • Prometheus / Alertmanager → URL:
        ${CUR_PROM_URL}
   • Loki                      → URL:
        ${CUR_LOKI_URL}

  ${YLW}Those URLs are the cluster's telemetry NodePorts as seen FROM the Daalu
  containers (via host.docker.internal) — not localhost.${RST} Enter them verbatim.
  Each integration flips to ${BOLD}connected${RST} within ~60s (reload if still pending).

  The demo app is deployed and healthy. Break it on camera when ready:
     ${BOLD}./demo/break.sh${RST}      # default: checkout-api runs out of memory (run this live)
     ${BOLD}./demo/status.sh${RST}     # app + alert state at any time
     ${BOLD}./demo/down.sh${RST}       # remove the demo app + rules (deletes the daalu-demo namespace)
EOF
elif [ "$DEMO_MODE" = "current" ]; then
cat <<EOF

${GRN}✔ Demo app deployed to your existing cluster.${RST}

  Nothing was created but the ${BOLD}daalu-demo${RST} namespace and a couple of alert
  rules (labelled ${BLU}release=${DEMO_RULE_RELEASE}${RST} so your Prometheus adopts them).
  Daalu watches this cluster through your existing integrations.

  Run the demo:
     ${BOLD}./demo/break.sh${RST}      # introduce an issue (default: checkout-api runs out of memory)
     # …then open Daalu → Alerts. Within ~2–3 min the CheckoutApiDown alert
     # appears; open it and let the agent investigate. It finds the container is
     # OOMKilled because its memory limit is too low and proposes a fix (patch
     # the deployment to request more memory) for you to approve.
     ${BOLD}./demo/status.sh${RST}     # app + alert state at any time
     ${BOLD}./demo/down.sh${RST}       # remove the demo app + rules (deletes the daalu-demo namespace)

  Manual fix (instead of via Daalu):
     kubectl -n daalu-demo patch deploy checkout-api --type=strategic \\
       -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"requests":{"memory":"256Mi"},"limits":{"memory":"512Mi"}}}]}}}}'
EOF
elif [ "${DEMO_MANUAL_ONBOARD:-0}" = "1" ]; then
cat <<EOF

${GRN}✔ Demo lab is up (manual-onboard mode — nothing auto-registered).${RST}

  Onboard these in the UI to record the flow — open
  http://${BROWSE_HOST}:3000 → Integrations:

   • Kubernetes               → paste the full contents of this file:
        ${ONBOARD_KCFG}
   • Prometheus / Alertmanager → URL:
        ${PROMETHEUS_URL}
   • Loki                      → URL:
        ${LOKI_URL}

  IMPORTANT: those URLs are the cluster NodePorts as seen FROM the Daalu
  containers (they sit on the kind network) — NOT the localhost ports below,
  which are for your browser only and won't work as integration URLs.

  Browse the stack (optional, from your browser):
     Grafana:       http://${BROWSE_HOST}:3001   (admin / admin)
     Prometheus:    http://${BROWSE_HOST}:9090
     Alertmanager:  http://${BROWSE_HOST}:9093

  The demo apps are deployed and healthy. Break one on camera when ready:
     ${BOLD}./demo/break.sh${RST}      # default: checkout-api runs out of memory (run this live)
     ${BOLD}./demo/status.sh${RST}     # app + alert state at any time
     ${BOLD}./demo/down.sh${RST}       # tear the whole lab down
EOF
else
cat <<EOF

${GRN}✔ Demo lab is up.${RST}

  Browse the stack (optional):
     Grafana:       http://${BROWSE_HOST}:3001   (admin / admin)
     Prometheus:    http://${BROWSE_HOST}:9090
     Alertmanager:  http://${BROWSE_HOST}:9093

  Daalu is now watching this cluster. To run the demo:
     ${BOLD}./demo/break.sh${RST}      # introduce an issue (default: checkout-api runs out of memory)
     # …then open Daalu (http://localhost:3000) → Alerts. Within ~2–3 min the
     # CheckoutApiCrashLooping alert appears; open it and let the agent
     # investigate. It will inspect the pod/events, find the container is being
     # OOMKilled because its memory limit is too low, and propose a fix
     # (patch the deployment to request more memory) for you to approve.
     ${BOLD}./demo/status.sh${RST}     # see app + alert state at any time
     ${BOLD}./demo/down.sh${RST}       # tear the whole lab down

  Manual fix (if you want to fix it yourself instead of via Daalu):
     kubectl -n daalu-demo patch deploy checkout-api --type=strategic \\
       -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"requests":{"memory":"256Mi"},"limits":{"memory":"512Mi"}}}]}}}}'
EOF
fi
