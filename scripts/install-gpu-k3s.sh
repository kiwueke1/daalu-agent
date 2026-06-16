#!/usr/bin/env bash
# =============================================================================
#  OPTIONAL — install a single-node Kubernetes (k3s) with NVIDIA GPU support.
# -----------------------------------------------------------------------------
#  For users who have a Linux box with an NVIDIA GPU but no cluster yet, and
#  want one to (a) run open-weights inference (vLLM) the agent can talk to, and
#  (b) have a real cluster for the agent's kubectl tools to operate on.
#
#  This installs:
#     • k3s            — a lightweight, single-binary Kubernetes
#     • NVIDIA GPU Operator — drivers/runtime/device-plugin so pods see the GPU
#
#  It does NOT install Daalu itself — run ./install.sh for that. The two are
#  independent: Daalu can point at any cluster/inference; this just gives you
#  one quickly. Tested on Ubuntu 22.04/24.04.
#
#  Usage:   sudo ./scripts/install-gpu-k3s.sh
# =============================================================================
set -euo pipefail

GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; BLU=$'\033[36m'; RST=$'\033[0m'
say()  { printf "%s\n" "${BLU}▶${RST} $*"; }
ok()   { printf "%s\n" "${GRN}✔${RST} $*"; }
warn() { printf "%s\n" "${YLW}!${RST} $*"; }
die()  { printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "please run as root (sudo $0)"

GPU_OPERATOR_VERSION="${GPU_OPERATOR_VERSION:-v25.3.0}"  # 25.3+ parses containerd 2.x config
# Driver mode:
#   operator (default) — the GPU Operator INSTALLS and manages the NVIDIA driver
#                        for you. You do NOT need a driver pre-installed; just the
#                        GPU hardware.
#   host               — you already installed the NVIDIA driver on this machine;
#                        the operator uses it and only manages the toolkit/plugin.
DRIVER="${DRIVER:-operator}"
case "$DRIVER" in
  operator) DRIVER_ENABLED=true ;;
  host)     DRIVER_ENABLED=false ;;
  *) printf '%s\n' "DRIVER must be 'operator' or 'host' (got: $DRIVER)" >&2; exit 1 ;;
esac

# ── 1. Sanity: is there an NVIDIA GPU? ───────────────────────────────────────
say "Checking for an NVIDIA GPU"
if ! lspci 2>/dev/null | grep -qi nvidia; then
  warn "no NVIDIA GPU detected via lspci — continuing anyway, but the GPU Operator may not schedule."
else
  ok "NVIDIA GPU present"
fi

# ── 2. Install k3s (single node, no traefik to keep it minimal) ──────────────
say "Installing k3s (single-node)"
if command -v k3s >/dev/null 2>&1; then
  ok "k3s already installed — skipping"
else
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
  ok "k3s installed"
fi

# Make kubectl usable for the invoking user.
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
say "Waiting for the node to become Ready"
until k3s kubectl get nodes 2>/dev/null | grep -q " Ready "; do printf "."; sleep 3; done
printf "\n"; ok "node Ready"

# ── 3. Install Helm (needed for the GPU Operator) ────────────────────────────
if ! command -v helm >/dev/null 2>&1; then
  say "Installing Helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  ok "Helm installed"
fi

# ── 4. Install the NVIDIA GPU Operator ───────────────────────────────────────
# The operator installs the container toolkit + device plugin, and (when
# DRIVER=operator, the default) the NVIDIA driver itself — so a bare GPU machine
# with no driver works out of the box. Set DRIVER=host to reuse a driver you
# already installed.
if [ "$DRIVER" = "operator" ]; then
  say "Installing NVIDIA GPU Operator ${GPU_OPERATOR_VERSION} (operator will install the GPU driver)"
else
  say "Installing NVIDIA GPU Operator ${GPU_OPERATOR_VERSION} (using the host's existing GPU driver)"
fi
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install gpu-operator nvidia/gpu-operator \
  --version "${GPU_OPERATOR_VERSION}" \
  --namespace gpu-operator --create-namespace \
  --set driver.enabled=${DRIVER_ENABLED} \
  --set toolkit.env[0].name=CONTAINERD_CONFIG \
  --set toolkit.env[0].value=/var/lib/rancher/k3s/agent/etc/containerd/config.toml \
  --set toolkit.env[1].name=CONTAINERD_SOCKET \
  --set toolkit.env[1].value=/run/k3s/containerd/containerd.sock \
  --wait --timeout 15m
ok "GPU Operator installed"

# ── Done ─────────────────────────────────────────────────────────────────────
cat <<EOF

${GRN}✔ Cluster ready.${RST}

  Use it from your user account:
     mkdir -p \$HOME/.kube
     sudo cp /etc/rancher/k3s/k3s.yaml \$HOME/.kube/config
     sudo chown \$(id -u):\$(id -g) \$HOME/.kube/config
     kubectl get nodes

  Verify the GPU is schedulable:
     kubectl -n gpu-operator get pods
     kubectl get nodes -o json | grep nvidia.com/gpu

  Next, serve a model on this GPU (one command):
     sudo cp /etc/rancher/k3s/k3s.yaml \$HOME/.kube/config    # if you haven't yet
     ./scripts/serve-model.sh        # deploys vLLM + an open-weights model

  That prints the LLM_BASE_URL to drop into Daalu's .env. Then run ./install.sh.
  Details: docs/03-llm-and-sovereignty.md.
EOF
