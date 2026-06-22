#!/usr/bin/env bash
# Tear down the Daalu demo lab.
#   • kind mode    — delete the kind cluster (and disconnect Daalu from the kind
#                    network). Daalu's integration rows are left in place; they
#                    just point at a cluster that no longer exists until up.sh.
#   • current mode — delete only the daalu-demo namespace (the demo app + the
#                    alert rules we added there). Your monitoring, logging and
#                    Daalu integrations are left untouched.
#   ./demo/down.sh
set -euo pipefail
# Find kind/kubectl whether system-installed or fetched by up.sh into BINDIR.
export PATH="$PATH:${DAALU_DEMO_BINDIR:-$HOME/.daalu/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
. "${HERE}/lib-cluster.sh"
CLUSTER="daalu-demo"; KIND_NET="kind"
GRN=$'\033[32m'; BLU=$'\033[36m'; YLW=$'\033[33m'; RST=$'\033[0m'
say(){ printf "%s\n" "${BLU}▶${RST} $*"; }
ok(){ printf "%s\n" "${GRN}✔${RST} $*"; }
warn(){ printf "%s\n" "${YLW}!${RST} $*"; }

REPO="$(cd "$HERE/.." && pwd)"

# Decide which cluster the demo ran against (same auto-detect as up.sh).
demo_resolve_mode
demo_kube_setup

if [ "$DEMO_MODE" = "current" ]; then
  CTX="$(kubectl config current-context 2>/dev/null || echo '?')"
  say "Removing the demo from your current cluster (context '${CTX}')"
  # In current mode the app AND its alert rules live in the daalu-demo namespace,
  # so one namespace delete removes everything we added — nothing else is touched.
  if kubectl delete namespace "$DEMO_NS" --ignore-not-found >/dev/null 2>&1; then
    ok "deleted namespace '${DEMO_NS}' (demo app + alert rules)"
  else
    warn "couldn't delete namespace '${DEMO_NS}' — remove it by hand if it lingers"
  fi
  cat <<EOF

${GRN}✔ Demo removed from your cluster.${RST}
  Your monitoring, logging and Daalu integrations are untouched.
  Re-run ./demo/up.sh to redeploy the demo app.
EOF
  exit 0
fi

# ── kind mode ────────────────────────────────────────────────────────────────
# Disconnect Daalu containers from the kind network (best-effort) before the
# network is removed with the cluster.
if command -v docker >/dev/null 2>&1; then
  say "Disconnecting Daalu containers from '${KIND_NET}'"
  while read -r cid; do
    [ -n "$cid" ] && docker network disconnect "$KIND_NET" "$cid" >/dev/null 2>&1 || true
  done < <(cd "$REPO" && docker compose ps -q 2>/dev/null || true)
fi

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  say "Deleting kind cluster '${CLUSTER}'"
  kind delete cluster --name "$CLUSTER"
  ok "cluster deleted"
else
  warn "no kind cluster named '${CLUSTER}' found — nothing to delete"
fi

# Remove the demo's dedicated kubeconfig (written by up.sh; safe if absent).
rm -f "${DAALU_DEMO_KUBECONFIG:-$HOME/.daalu/daalu-demo.kubeconfig}"

cat <<EOF

${GRN}✔ Demo lab torn down.${RST}
  Daalu is still running. Its prometheus/loki/kubernetes integration rows remain
  but point at the deleted cluster — re-run ./demo/up.sh to bring it all back, or
  remove them in the UI → Integrations.
EOF
