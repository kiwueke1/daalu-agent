#!/usr/bin/env bash
# =============================================================================
#  Deploy an open-weights model as a sovereign inference server (vLLM on k8s).
# -----------------------------------------------------------------------------
#  This is the "make my GPU serve a model" step. It deploys vLLM
#  (vllm/vllm-openai — public, Apache-2.0, no NVIDIA entitlement) into your
#  Kubernetes cluster, serving an OpenAI-compatible /v1 API on a NodePort, and
#  prints the exact LLM_BASE_URL to put in Daalu's .env.
#
#  Prereqs: a cluster with NVIDIA GPUs schedulable (run
#  scripts/install-gpu-k3s.sh first if you don't have one) and kubectl pointed
#  at it. The default model (Qwen2.5-7B-Instruct) is OPEN — no Hugging Face
#  token required. ~16 GB VRAM is comfortable; smaller cards: set MODEL/MAX_LEN.
#
#  Usage:
#     ./scripts/serve-model.sh                      # deploy the default model
#     MODEL=Qwen/Qwen2.5-14B-Instruct SERVED_NAME=qwen2.5-14b ./scripts/serve-model.sh
#     HF_TOKEN=hf_xxx MODEL=meta-llama/Llama-3.1-8B-Instruct ./scripts/serve-model.sh
#     PRINT_ONLY=1 ./scripts/serve-model.sh         # print the manifest, don't apply
# =============================================================================
set -euo pipefail

# ── Tunables (override via env) ──────────────────────────────────────────────
MODEL="${MODEL:-Qwen/Qwen2.5-7B-Instruct}"   # HF repo id (open weights by default)
SERVED_NAME="${SERVED_NAME:-qwen2.5-7b}"     # the name Daalu's LLM_MODEL must match
NAMESPACE="${NAMESPACE:-daalu}"
NODEPORT="${NODEPORT:-30800}"                 # host port the API is exposed on
MAX_LEN="${MAX_LEN:-8192}"                    # context window (lower = less VRAM)
GPU_COUNT="${GPU_COUNT:-1}"
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.90}"
HF_TOKEN="${HF_TOKEN:-}"                      # only needed for GATED models (e.g. Llama)
PRINT_ONLY="${PRINT_ONLY:-0}"

GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; BLU=$'\033[36m'; DIM=$'\033[2m'; RST=$'\033[0m'
say()  { printf "%s\n" "${BLU}▶${RST} $*"; }
ok()   { printf "%s\n" "${GRN}✔${RST} $*"; }
warn() { printf "%s\n" "${YLW}!${RST} $*"; }
die()  { printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; }

command -v kubectl >/dev/null 2>&1 || die "kubectl not found — install it, or run scripts/install-gpu-k3s.sh first"

# Optional HF token secret (only referenced by the pod when the model is gated).
HF_ENV=""
if [ -n "$HF_TOKEN" ]; then
  HF_ENV=$'            - name: HUGGING_FACE_HUB_TOKEN\n              valueFrom:\n                secretKeyRef:\n                  name: hf-token\n                  key: token'
fi

# ── Render the manifest ──────────────────────────────────────────────────────
read -r -d '' MANIFEST <<YAML || true
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-model
  namespace: ${NAMESPACE}
  labels: { app: vllm-model }
spec:
  replicas: 1
  strategy: { type: Recreate }   # VRAM-bound; don't double the model during rollout
  selector:
    matchLabels: { app: vllm-model }
  template:
    metadata:
      labels: { app: vllm-model }
    spec:
      tolerations:
        # Single-node clusters often run workloads on the control-plane node.
        - { key: node-role.kubernetes.io/control-plane, operator: Exists, effect: NoSchedule }
      containers:
        - name: vllm
          image: vllm/vllm-openai:latest   # public, Apache-2.0; pin a version in prod
          args:
            - --model=${MODEL}
            - --served-model-name=${SERVED_NAME}
            - --max-model-len=${MAX_LEN}
            - --gpu-memory-utilization=${GPU_MEM_UTIL}
            - --host=0.0.0.0
            - --port=8000
          env:
            - { name: HF_HOME, value: /var/cache/huggingface }
${HF_ENV}
          ports:
            - { containerPort: 8000, name: http }
          resources:
            limits: { nvidia.com/gpu: ${GPU_COUNT}, memory: 24Gi }
            requests: { nvidia.com/gpu: ${GPU_COUNT}, memory: 12Gi, cpu: 2 }
          volumeMounts:
            - { name: hf-cache, mountPath: /var/cache/huggingface }
            - { name: dshm, mountPath: /dev/shm }
          startupProbe:        # first start downloads weights + compiles graphs
            httpGet: { path: /health, port: http }
            failureThreshold: 90
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /health, port: http }
            initialDelaySeconds: 30
            periodSeconds: 10
      volumes:
        - name: hf-cache
          hostPath: { path: /var/lib/daalu/hf-cache, type: DirectoryOrCreate }
        - name: dshm
          emptyDir: { medium: Memory, sizeLimit: 8Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: vllm-model
  namespace: ${NAMESPACE}
spec:
  type: NodePort   # reachable from outside the cluster (e.g. the Compose stack)
  selector: { app: vllm-model }
  ports:
    - { name: http, port: 80, targetPort: 8000, nodePort: ${NODEPORT} }
YAML

if [ "$PRINT_ONLY" = "1" ]; then
  printf "%s\n" "$MANIFEST"
  exit 0
fi

# ── Apply ────────────────────────────────────────────────────────────────────
say "Deploying vLLM serving ${BLU}${MODEL}${RST} (served as ${SERVED_NAME}) to namespace ${NAMESPACE}"
kubectl get nodes >/dev/null 2>&1 || die "kubectl can't reach a cluster — check your kubeconfig / current-context"
kubectl create namespace "$NAMESPACE" >/dev/null 2>&1 || true
if [ -n "$HF_TOKEN" ]; then
  kubectl -n "$NAMESPACE" create secret generic hf-token \
    --from-literal=token="$HF_TOKEN" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  ok "stored Hugging Face token (for gated model access)"
fi
printf "%s" "$MANIFEST" | kubectl apply -f - >/dev/null
ok "manifest applied"

say "Waiting for the model to load (first run downloads weights — can take several minutes)"
if ! kubectl -n "$NAMESPACE" rollout status deploy/vllm-model --timeout=20m; then
  warn "rollout didn't complete in time. Inspect with:"
  warn "  kubectl -n $NAMESPACE get pods"
  warn "  kubectl -n $NAMESPACE logs deploy/vllm-model"
  die "model server not ready yet"
fi
ok "model server is ready"

# ── Tell the user exactly how to point Daalu at it ───────────────────────────
NODE_IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"
cat <<EOF

${GRN}✔ Sovereign inference is live.${RST}

  Endpoints (OpenAI-compatible):
    • In-cluster:  http://vllm-model.${NAMESPACE}.svc.cluster.local/v1
    • NodePort:    http://${NODE_IP:-<node-ip>}:${NODEPORT}/v1

  Put this in Daalu's .env (the NodePort URL is what the Compose stack uses):
    ${DIM}# if Daalu runs on the same host as the cluster:${RST}
    LLM_BASE_URL=http://host.docker.internal:${NODEPORT}/v1
    ${DIM}# otherwise use the node IP shown above:${RST}
    LLM_BASE_URL=http://${NODE_IP:-<node-ip>}:${NODEPORT}/v1
    LLM_API_KEY=novllmkeyneeded
    LLM_MODEL=${SERVED_NAME}
    LLM_MODEL_CLASSIFIER=${SERVED_NAME}

  Quick test:
    curl http://${NODE_IP:-<node-ip>}:${NODEPORT}/v1/models

  Then run ./install.sh from the repo root (or restart: docker compose up -d).
EOF
