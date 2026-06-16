#!/usr/bin/env bash
#
# build-push-images.sh — build the NV-CM service images from the upstream
# source repo and push them to daalu's Harbor.
#
# Engineer chapter 64 §64.2 step 2, "build it ourselves" variant. The
# upstream NVIDIA service images ship only as registry.example.com/nvidia
# placeholders, so instead of mirroring a vendor registry we build the six
# images from source (the open-source NVIDIA/nv-config-manager repo) and
# push them to <HARBOR>/<HARBOR_PROJECT>/<name>:<TAG> — the exact path
# render_values() repoints global.images.<key>.repository at.
#
# The upstream working tree's deploy/helm/Chart.yaml must match the chart
# vendored in daalu (deploy/charts/nv-config-manager-<TAG>): both pin the
# image tag. Default TAG=1.2.2-rc.23 matches the vendored chart.
#
# Toolchains live inside the Dockerfiles — the host only needs Docker
# (+ buildx for --push). The NGC base images (nvcr.io/nvidia/base/ubuntu,
# distroless/go) are public; no NGC login required.
#
#   Build only (no Harbor needed):
#     SRC_REPO=/path/to/nv-config-manager ./build-push-images.sh build
#
#   Build + push (after `docker login $HARBOR`):
#     SRC_REPO=/path/to/nv-config-manager HARBOR=host.example.com \
#       ./build-push-images.sh push
#
#   Push only (images already built locally):
#     HARBOR=host.example.com ./build-push-images.sh push-only
#
set -euo pipefail

MODE="${1:-build}"
SRC_REPO="${SRC_REPO:-/home/kez/Documents/python_projects/nvidia-tools/nv-config-manager}"
TAG="${TAG:-1.2.2-rc.23}"
HARBOR="${HARBOR:-}"
HARBOR_PROJECT="${HARBOR_PROJECT:-nv-config-manager}"
PLATFORM="${PLATFORM:-linux/amd64}"

# image name -> make target (local docker build, tags <name>:$TAG)
NAMES=(nv-config-manager nv-config-manager-kea nv-config-manager-kea-admin \
       nv-config-manager-ui nv-config-manager-nautobot nv-config-manager-nats-ready)
declare -A TARGET=(
  [nv-config-manager]=docker-build-nv-config-manager
  [nv-config-manager-kea]=docker-build-kea
  [nv-config-manager-kea-admin]=docker-build-kea-admin
  [nv-config-manager-ui]=docker-build-ui
  [nv-config-manager-nautobot]=docker-build-nb
  [nv-config-manager-nats-ready]=docker-build-nats-ready
)

build_all() {
  echo "building from $SRC_REPO at tag $TAG ($PLATFORM)"
  local fail=0
  for n in "${NAMES[@]}"; do
    echo "== build $n"
    if ! make -C "$SRC_REPO" "${TARGET[$n]}" LOCAL_TAG="$TAG"; then
      echo "  !! FAILED: $n" >&2; fail=1
    fi
  done
  return $fail
}

push_all() {
  [[ -z "$HARBOR" ]] && { echo "ERROR: set HARBOR for push" >&2; exit 2; }
  echo "pushing to $HARBOR/$HARBOR_PROJECT at tag $TAG"
  local fail=0
  for n in "${NAMES[@]}"; do
    local src="$n:$TAG"
    local dst="$HARBOR/$HARBOR_PROJECT/$n:$TAG"
    if ! docker image inspect "$src" >/dev/null 2>&1; then
      echo "  !! missing local image $src (build first)" >&2; fail=1; continue
    fi
    echo "== push $src -> $dst"
    docker tag "$src" "$dst"
    if ! docker push "$dst"; then echo "  !! push failed: $dst" >&2; fail=1; fi
  done
  return $fail
}

case "$MODE" in
  build)      build_all ;;
  push)       build_all && push_all ;;
  push-only)  push_all ;;
  *) echo "usage: $0 {build|push|push-only}" >&2; exit 2 ;;
esac

echo
echo "DONE ($MODE). Remember: set CONFIG_MANAGER_HARBOR_REGISTRY=$HARBOR"
echo "on the hub so render_values() repoints the chart at the mirror."
