#!/usr/bin/env bash
# =============================================================================
#  Break a demo app on purpose, so Daalu has something to discover and fix.
# -----------------------------------------------------------------------------
#  Default scenario (oom): checkout-api's in-memory working set grows past its
#  memory limit, so the container is OOMKilled and crash-loops — a natural,
#  common production failure. The fix is to give it more memory (patch the
#  deployment's memory request/limit), which is exactly what you approve in
#  Daalu. This is NOT a bad rollout, so a rollback isn't the right answer —
#  the agent should reason from the OOMKilled signal to a memory increase.
#
#  Other scenarios push a bad rollout that takes an app DOWN; the fix there is a
#  rollback.
#
#  Usage:
#     ./demo/break.sh                # default: oom (checkout-api out of memory)
#     ./demo/break.sh oom            # checkout-api: working set exceeds memory limit → OOMKilled
#     ./demo/break.sh bad-image      # dummy-app: image tag that doesn't exist
#     ./demo/break.sh crashloop      # dummy-app: container crashes on startup
#     ./demo/break.sh errors         # metrics-app: error RATE climbs (metrics alert)
# =============================================================================
set -euo pipefail
# Find kubectl whether system-installed or fetched by up.sh into BINDIR.
export PATH="$PATH:${DAALU_DEMO_BINDIR:-$HOME/.daalu/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Shared helpers — resolve which cluster up.sh used (kind vs your current
# context) so we break the app on the right one.
. "${HERE}/lib-cluster.sh"
NS="daalu-demo"
GRN=$'\033[32m'; BLU=$'\033[36m'; YLW=$'\033[33m'; RST=$'\033[0m'
say(){ printf "%s\n" "${BLU}▶${RST} $*"; }
ok(){ printf "%s\n" "${GRN}✔${RST} $*"; }

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not found"; exit 1; }
# Target the same cluster up.sh used. kind mode: pin the dedicated kubeconfig and
# re-select the kind context (cheap, and recovers if the kubeconfig was removed
# but the cluster is still up). current mode: use your ambient kubectl/context —
# the cluster the demo app was deployed to.
demo_resolve_mode
demo_kube_setup
if [ "$DEMO_MODE" = "kind" ]; then
  kind export kubeconfig --name "$DEMO_CLUSTER" >/dev/null 2>&1 || true
  kubectl config use-context "kind-${DEMO_CLUSTER}" >/dev/null 2>&1 || true
fi

scenario="${1:-oom}"
case "$scenario" in
  oom)
    DEP="checkout-api"; ALERT="CheckoutApiCrashLooping (the container is OOMKilled)"
    say "Scenario: oom — growing checkout-api's working set past its memory limit"
    # The service now needs ~350Mi but is capped at 256Mi → OOMKilled on start,
    # so the new pod never becomes ready and the deployment crash-loops.
    kubectl -n "$NS" set env "deploy/$DEP" WORKINGSET_MB=350
    ;;
  bad-image)
    DEP="dummy-app"; ALERT="DummyAppDown (the app goes down)"
    say "Scenario: bad-image — pointing dummy-app at an image tag that doesn't exist"
    kubectl -n "$NS" set image "deploy/$DEP" dummy=nginx:this-tag-does-not-exist-9.9.9
    ;;
  crashloop)
    DEP="dummy-app"; ALERT="DummyAppDown (the app goes down)"
    say "Scenario: crashloop — overriding the container command so it exits immediately"
    kubectl -n "$NS" patch "deploy/$DEP" --type=json \
      -p='[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["sh","-c","echo starting; sleep 2; echo crashing; exit 1"]}]'
    ;;
  errors)
    DEP="metrics-app"; ALERT="HighErrorRate (a metrics-based alert)"
    say "Scenario: errors — flipping metrics-app into error mode (its error rate climbs)"
    kubectl -n "$NS" set env "deploy/$DEP" ERROR_MODE=true
    ;;
  *)
    echo "unknown scenario: $scenario (use 'oom', 'bad-image', 'crashloop', or 'errors')" >&2; exit 1 ;;
esac

ok "broken: $DEP. Alert to expect: $ALERT"
if [ "$scenario" = "oom" ]; then
cat <<EOF

  What to expect:
    • ~1–2 min: checkout-api's new pod is OOMKilled on startup and crash-loops.
    • ~2–3 min: the CheckoutApiCrashLooping alert shows up in Daalu → Alerts.
    • Open the alert in Daalu and let the agent investigate — it will inspect the
      pod/events, find the container is OOMKilled because its memory limit is too
      low, and propose increasing the memory (a deployment patch) to approve.

  Watch it happen:
    ./demo/status.sh
    kubectl -n $NS get pods -w

  Fix it yourself (instead of via Daalu):
    kubectl -n $NS patch deploy $DEP --type=strategic \\
      -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"requests":{"memory":"256Mi"},"limits":{"memory":"512Mi"}}}]}}}}'
EOF
else
cat <<EOF

  What to expect:
    • ~1–2 min: the alert fires in Alertmanager.
    • ~2–3 min: it shows up in Daalu → Alerts.
    • Open the alert in Daalu and let the agent investigate — it will inspect the
      workload, find the bad rollout, and propose a rollback to approve.

  Watch it happen:
    ./demo/status.sh
    kubectl -n $NS get pods -w

  Fix it yourself (instead of via Daalu):
    kubectl -n $NS rollout undo deploy/$DEP
EOF
fi
