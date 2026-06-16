#!/usr/bin/env bash
# Tear down the Daalu demo lab: delete the kind cluster (and disconnect Daalu
# from the kind network). Daalu's own integrations rows are left in place;
# they simply point at a cluster that no longer exists until you re-run up.sh.
#   ./demo/down.sh
set -euo pipefail
CLUSTER="daalu-demo"; KIND_NET="kind"
GRN=$'\033[32m'; BLU=$'\033[36m'; YLW=$'\033[33m'; RST=$'\033[0m'
say(){ printf "%s\n" "${BLU}▶${RST} $*"; }
ok(){ printf "%s\n" "${GRN}✔${RST} $*"; }
warn(){ printf "%s\n" "${YLW}!${RST} $*"; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"

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

cat <<EOF

${GRN}✔ Demo lab torn down.${RST}
  Daalu is still running. Its prometheus/loki/kubernetes integration rows remain
  but point at the deleted cluster — re-run ./demo/up.sh to bring it all back, or
  remove them in the UI → Integrations.
EOF
