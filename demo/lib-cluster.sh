#!/usr/bin/env bash
# =============================================================================
#  Shared cluster-mode helpers for the demo scripts (up / break / down / status).
# -----------------------------------------------------------------------------
#  The demo can run against one of two clusters:
#
#    • kind     — create a throwaway kind cluster and install its own monitoring
#                 (Prometheus operator + Loki). The zero-prerequisites default:
#                 good on a laptop with nothing set up.
#
#    • current  — reuse the cluster your kubectl already points at. For a box
#                 that already runs kube-prometheus-stack + Loki and is already
#                 connected to Daalu (e.g. a k3s GPU node), this installs and
#                 creates NOTHING extra: it just deploys the demo app + alert
#                 rule into a `daalu-demo` namespace and removes them again on
#                 teardown. No kind cluster, no docker-network juggling, no
#                 re-registering integrations.
#
#  Mode selection — DEMO_USE_CURRENT_CONTEXT:
#    auto (default) — use the current cluster when your kubectl can reach one
#                     AND it runs the Prometheus operator (so the alert can
#                     actually fire); otherwise fall back to kind.
#    1 / true       — force current-cluster mode.
#    0 / false      — force kind mode.
#
#  Everything is auto-detected so the common case is just `./demo/up.sh`.
# =============================================================================

# Shared identifiers (kept in sync across all demo scripts).
DEMO_CLUSTER="daalu-demo"   # kind cluster name (kind mode only)
DEMO_NS="daalu-demo"        # namespace the demo app lives in (both modes)
DEMO_KIND_NET="kind"        # docker network kind attaches containers to

_demo_have_current_cluster() {
  # True when your *ambient* kubectl can reach a cluster right now. Called
  # BEFORE any KUBECONFIG override so it sees the context you actually use.
  kubectl cluster-info >/dev/null 2>&1
}

_demo_have_prom_operator() {
  # True when that cluster runs the Prometheus operator, i.e. it understands the
  # PrometheusRule CRD the demo relies on. Without it the alert would never fire,
  # so auto-mode won't pick the current cluster.
  kubectl get crd prometheuses.monitoring.coreos.com >/dev/null 2>&1
}

demo_resolve_mode() {
  # Sets DEMO_MODE to "kind" or "current". Must run after kubectl is on PATH and
  # before any KUBECONFIG override (so auto-detect probes your real context).
  case "${DEMO_USE_CURRENT_CONTEXT:-auto}" in
    1|true|yes|current) DEMO_MODE=current ;;
    0|false|no|kind)    DEMO_MODE=kind ;;
    *)
      if _demo_have_current_cluster && _demo_have_prom_operator; then
        DEMO_MODE=current
      else
        DEMO_MODE=kind
      fi
      ;;
  esac
  export DEMO_MODE
}

demo_kube_setup() {
  # kind mode pins a dedicated kubeconfig so a host kubectl (notably k3s, which
  # defaults to /etc/rancher/k3s/k3s.yaml) can't hide the kind context and leave
  # us mutating the wrong cluster. current mode deliberately uses your ambient
  # kubectl/context — that IS the cluster we want to act on.
  if [ "${DEMO_MODE}" = "kind" ]; then
    export KUBECONFIG="${DAALU_DEMO_KUBECONFIG:-$HOME/.daalu/daalu-demo.kubeconfig}"
    mkdir -p "$(dirname "$KUBECONFIG")"
  fi
}

demo_detect_release() {
  # In current mode the demo's PrometheusRule/ServiceMonitor must carry the
  # release label THIS cluster's operator selects on (the committed manifests
  # use the kind demo's `release: monitoring`). Read it from the live Prometheus
  # CR's ruleSelector, fall back to an existing rule's label, then to the common
  # kube-prometheus-stack default. Override with DEMO_RULE_RELEASE.
  [ -n "${DEMO_RULE_RELEASE:-}" ] && { export DEMO_RULE_RELEASE; return 0; }
  local r
  r="$(kubectl get prometheuses.monitoring.coreos.com -A \
        -o jsonpath='{.items[0].spec.ruleSelector.matchLabels.release}' 2>/dev/null)"
  [ -n "$r" ] || r="$(kubectl get prometheusrules.monitoring.coreos.com -A \
        -o jsonpath='{.items[0].metadata.labels.release}' 2>/dev/null)"
  [ -n "$r" ] || r="kube-prometheus-stack"
  DEMO_RULE_RELEASE="$r"
  export DEMO_RULE_RELEASE
}

demo_apply() {
  # Apply a demo manifest. In kind mode it's applied verbatim. In current mode
  # we retarget the monitoring CRDs at THIS cluster's operator: move the two
  # alert rules out of the kind demo's `monitoring` namespace into `daalu-demo`
  # (so a single `kubectl delete ns daalu-demo` cleans everything up) and rewrite
  # the placeholder `release: monitoring` label to the detected release. The
  # alert PromQL (which references namespace="daalu-demo") is untouched — only
  # the YAML `namespace:` key and the `release` label are rewritten.
  local f="$1"
  if [ "${DEMO_MODE}" = "kind" ]; then
    kubectl apply -f "$f"
    return
  fi
  sed \
    -e "s/^\([[:space:]]*\)namespace: monitoring[[:space:]]*$/\1namespace: ${DEMO_NS}/" \
    -e "s/release: monitoring/release: ${DEMO_RULE_RELEASE}/g" \
    "$f" | kubectl apply -f -
}
