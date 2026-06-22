#!/usr/bin/env bash
# =============================================================================
#  Demo-recording variant of ./demo/up.sh
# -----------------------------------------------------------------------------
#  Brings the lab up EXACTLY like up.sh — same cluster auto-detection — with two
#  differences tuned for a live demo:
#
#    • Integrations are NOT auto-registered. Instead the run prints the
#      kubeconfig file path (for the Kubernetes integration) and the
#      Prometheus/Alertmanager + Loki URLs, so you can onboard each one
#      yourself in the UI (Integrations) on camera.
#
#    • The demo app is deployed healthy and is NOT broken. Run ./demo/break.sh
#      live when you want to trigger the incident and narrate it.
#
#  Cluster: like up.sh, it AUTO-DETECTS. If your current kubectl context already
#  runs the Prometheus operator (e.g. the k3s GPU box), it deploys the demo app
#  onto THAT cluster and creates NO kind cluster — and prints that cluster's
#  kubeconfig path + Prometheus/Loki URLs to onboard. Only when no such cluster
#  is reachable does it fall back to a throwaway kind cluster. Force either way
#  with DEMO_USE_CURRENT_CONTEXT=1 (existing cluster) / =0 (kind).
#
#  It is simply up.sh with DEMO_MANUAL_ONBOARD=1 — all prep logic is shared, so
#  there is nothing to keep in sync.
#
#  Usage:   ./demo/up-manual.sh
#  Teardown: ./demo/down.sh   (same as the normal lab)
# =============================================================================
exec env DEMO_MANUAL_ONBOARD=1 "$(dirname "$0")/up.sh" "$@"
