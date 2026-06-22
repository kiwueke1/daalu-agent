#!/usr/bin/env bash
# =============================================================================
#  Build NVIDIA Config Manager (NV-CM) images from source — for self-hosters.
# -----------------------------------------------------------------------------
#  NV-CM (https://github.com/NVIDIA/nv-config-manager, Apache-2.0) powers
#  Daalu's "Network & server management" (the NautobotConfig Manager stack:
#  Nautobot + Render + Temporal + Config Store + ZTP/DHCP). Daalu vendors its
#  Helm chart (components/nv-config-manager/chart/) but NOT its images — NVIDIA
#  publishes those only on its internal registry (nvcr.io/nvidian/...). Since
#  the source is Apache-2.0, external users can simply BUILD the six service
#  images themselves; that is what this script does.
#
#  It clones NV-CM at the version matching the vendored chart, builds the six
#  images, and tags them under a local source prefix. You then push them (plus
#  the public infra images) to a registry your cluster can pull from with the
#  existing mirror script, and point Daalu at that registry.
#
#  Full pipeline:
#    1) ./scripts/build-nvcm-images.sh
#    2) HARBOR=<registry-host> NVIDIA_SRC=nvcm-local \
#         ./components/nv-config-manager/scripts/mirror-images.sh
#    3) set CONFIG_MANAGER_HARBOR_REGISTRY=<registry-host> in the hub's .env,
#       then run the controller (`daalu config-manager-controller`) and
#       provision from the UI. See docs/04-deployment.md.
#
#  Tunables (env):
#    CHART_TAG        image tag the vendored chart pins (default: 1.2.2-rc.23)
#    NVCM_REF         git ref to build (default: v$CHART_TAG; try `main` if the
#                     tag is absent)
#    NVCM_REPO        source repo (default: NVIDIA/nv-config-manager on GitHub)
#    NVCM_SRC_DIR     build from an EXISTING checkout instead of cloning
#    NVCM_BUILD_SRC   local tag prefix for the built images (default: nvcm-local)
#                     — pass this as NVIDIA_SRC to mirror-images.sh
#    PLATFORM         build platform (default: linux/amd64)
#    ONLY             space-separated subset to build (default: all six)
# =============================================================================
set -euo pipefail

CHART_TAG="${CHART_TAG:-1.2.2-rc.23}"
NVCM_REF="${NVCM_REF:-v${CHART_TAG}}"
NVCM_REPO="${NVCM_REPO:-https://github.com/NVIDIA/nv-config-manager.git}"
NVCM_BUILD_SRC="${NVCM_BUILD_SRC:-nvcm-local}"
PLATFORM="${PLATFORM:-linux/amd64}"
CACHE_DIR="${CACHE_DIR:-$HOME/.cache/daalu-nvcm-src}"
LOCAL_TAG="${LOCAL_TAG:-nvcm-build}"

GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; BLU=$'\033[36m'; DIM=$'\033[2m'; RST=$'\033[0m'
say()  { printf "%s\n" "${BLU}▶${RST} $*"; }
ok()   { printf "%s\n" "${GRN}✔${RST} $*"; }
warn() { printf "%s\n" "${YLW}!${RST} $*"; }
die()  { printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found — required to build the images"
command -v git    >/dev/null 2>&1 || die "git not found — required to fetch the NV-CM source"

# ── target → built-image-name → chart basename ───────────────────────────────
# Make targets + their output image names come from the NV-CM Makefile; the
# chart basenames come from Daalu's config_manager_controller/values.py
# (_HARBOR_IMAGE_BASENAMES). These three columns MUST stay aligned on a bump.
MAP=(
  "docker-build-nv-config-manager|nv-config-manager|nv-config-manager"
  "docker-build-kea|nv-config-manager-kea|nv-config-manager-kea"
  "docker-build-kea-admin|nv-config-manager-kea-admin|nv-config-manager-kea-admin"
  "docker-build-ui|nv-config-manager-ui|nv-config-manager-ui"
  "docker-build-nb|nv-config-manager-nautobot|nv-config-manager-nautobot"
  "docker-build-nats-ready|nv-config-manager-nats-ready|nv-config-manager-nats-ready"
)

# ── resolve the source tree ──────────────────────────────────────────────────
if [ -n "${NVCM_SRC_DIR:-}" ]; then
  SRC="$NVCM_SRC_DIR"
  [ -f "$SRC/Makefile" ] || die "NVCM_SRC_DIR=$SRC has no Makefile — not an NV-CM checkout"
  say "using existing NV-CM checkout: ${DIM}$SRC${RST}"
else
  SRC="$CACHE_DIR"
  if [ -d "$SRC/.git" ]; then
    say "refreshing NV-CM checkout (${NVCM_REF}) in ${DIM}$SRC${RST}"
    git -C "$SRC" fetch --depth 1 origin "$NVCM_REF" \
      || die "git fetch of ref '$NVCM_REF' failed — set NVCM_REF to a valid tag/branch (e.g. main)"
    git -C "$SRC" checkout -q FETCH_HEAD
  else
    say "cloning ${NVCM_REPO} @ ${NVCM_REF}"
    mkdir -p "$(dirname "$SRC")"
    git clone --depth 1 --branch "$NVCM_REF" "$NVCM_REPO" "$SRC" 2>/dev/null \
      || die "clone of '$NVCM_REF' failed — that tag may not exist; retry with NVCM_REF=main"
  fi
fi
ok "NV-CM source ready ($(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?'))"

# ── build + retag ────────────────────────────────────────────────────────────
say "building NV-CM images for ${PLATFORM} ${DIM}(heavy — first run pulls base layers, ~10–20 min)${RST}"
built=()
for entry in "${MAP[@]}"; do
  IFS='|' read -r target built_name base <<<"$entry"
  if [ -n "${ONLY:-}" ] && [[ " $ONLY " != *" $base "* ]]; then
    continue
  fi
  say "→ make ${target}"
  make -C "$SRC" "$target" LOCAL_TAG="$LOCAL_TAG" PLATFORM="$PLATFORM" \
    || die "build of $target failed — see the NV-CM build output above"
  dest="${NVCM_BUILD_SRC}/${base}:${CHART_TAG}"
  docker tag "${built_name}:${LOCAL_TAG}" "$dest" \
    || die "could not tag ${built_name}:${LOCAL_TAG} (did the build produce it?)"
  ok "tagged ${dest}"
  built+=("$dest")
done

[ "${#built[@]}" -gt 0 ] || die "nothing built — check the ONLY filter"

cat <<EOF

${GRN}✔ Built ${#built[@]} NV-CM image(s) under ${NVCM_BUILD_SRC}/*:${CHART_TAG}${RST}

Next steps:
  ${DIM}# push these + the public infra images to a registry your cluster can pull from:${RST}
  HARBOR=<registry-host> NVIDIA_SRC=${NVCM_BUILD_SRC} \\
    ./components/nv-config-manager/scripts/mirror-images.sh

  ${DIM}# then point Daalu at it (.env on the hub) and run the controller:${RST}
  CONFIG_MANAGER_HARBOR_REGISTRY=<registry-host>

See docs/04-deployment.md → "Network & server management (NV-CM)" for the full
flow (Tier-A operators, Keycloak, cluster tunnel, controller, provisioning).
EOF
