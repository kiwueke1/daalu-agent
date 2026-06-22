#!/usr/bin/env bash
# =============================================================================
#  Daalu agent — teardown / uninstaller
# -----------------------------------------------------------------------------
#  Removes everything the project's installers put on this machine, and ONLY
#  that. The reverse of install.sh / scripts/install-inference.sh /
#  scripts/install-gpu-k3s.sh / demo/up.sh. Re-runnable and idempotent — each
#  step is best-effort and skips cleanly when there's nothing to undo.
#
#  It is split into four independent sections so you can remove just what you
#  want. With no flags it runs interactively and asks before each section.
#
#    stack       the local docker compose stack (containers, volumes, the two
#                locally-built images). Mirrors install.sh.
#    inference   laptop inference: Ollama (and the IPEX-LLM build on Intel Arc)
#                installed by scripts/install-inference.sh.
#    demo        the kind demo lab (cluster + the kind docker network).
#                Mirrors demo/up.sh / demo/down.sh.
#    k3s         the single-node k3s cluster + GPU Operator + Prometheus/Loki
#                installed by scripts/install-gpu-k3s.sh. Needs root.
#
#  Usage:
#     ./teardown.sh                  # interactive: choose each section
#     ./teardown.sh --all            # everything (still confirms; add -y to skip)
#     ./teardown.sh --stack --demo   # only those sections
#     ./teardown.sh --all -y         # non-interactive, assume yes
#     ./teardown.sh --all --dry-run  # print what it WOULD do, change nothing
#
#  Section flags:  --stack  --inference  --demo  --k3s   (or --all)
#  Modifiers:
#     -y, --yes        don't prompt — assume yes to every selected section
#     --dry-run        show the commands without running them
#     --purge-models   also delete downloaded model weights (Ollama/HF caches).
#                      Off by default: those are multi-GB and may predate Daalu.
#     --remove-env     also delete the local .env (your config). Off by default.
#     --remove-images  also remove the public base images (postgres/redis/ollama).
#                      Off by default: they're shared and cheap to re-pull.
# =============================================================================
set -euo pipefail

# ── pretty output (degrades when not a TTY) ──────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; BLU=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi
say()  { printf "%s\n" "${BLU}▶${RST} $*"; }
ok()   { printf "%s\n" "${GRN}✔${RST} $*"; }
warn() { printf "%s\n" "${YLW}!${RST} $*"; }
die()  { printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; }
hr()   { printf "%s\n" "${DIM}────────────────────────────────────────────────────────${RST}"; }

cd "$(dirname "$0")"   # always operate from the repo root

# ── argument parsing ─────────────────────────────────────────────────────────
DO_STACK=0; DO_INFER=0; DO_DEMO=0; DO_K3S=0
ASSUME_YES=0; DRY_RUN=0; PURGE_MODELS=0; REMOVE_ENV=0; REMOVE_IMAGES=0
ANY_SECTION=0; MENU=0
for arg in "$@"; do
  case "$arg" in
    --all)            DO_STACK=1; DO_INFER=1; DO_DEMO=1; DO_K3S=1; ANY_SECTION=1 ;;
    --stack)          DO_STACK=1; ANY_SECTION=1 ;;
    --inference|--inf) DO_INFER=1; ANY_SECTION=1 ;;
    --demo)           DO_DEMO=1;  ANY_SECTION=1 ;;
    --k3s|--k8s)      DO_K3S=1;   ANY_SECTION=1 ;;
    -y|--yes)         ASSUME_YES=1 ;;
    --dry-run|-n)     DRY_RUN=1 ;;
    --purge-models)   PURGE_MODELS=1 ;;
    --remove-env)     REMOVE_ENV=1 ;;
    --remove-images)  REMOVE_IMAGES=1 ;;
    -h|--help)        awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

# ── run-or-show helper: every mutating command goes through this ─────────────
# Prints the command, then runs it unless --dry-run. Failures are non-fatal so
# one missing artifact never aborts the rest of a section.
run() {
  printf "    %s%s%s\n" "$DIM" "$*" "$RST"
  [ "$DRY_RUN" -eq 1 ] && return 0
  "$@" || warn "  (command above failed or had nothing to do — continuing)"
}
# Same, but for a shell pipeline / redirection passed as a single string.
run_sh() {
  printf "    %s%s%s\n" "$DIM" "$1" "$RST"
  [ "$DRY_RUN" -eq 1 ] && return 0
  bash -c "$1" || warn "  (command above failed or had nothing to do — continuing)"
}

# ── confirm helper ───────────────────────────────────────────────────────────
# Returns 0 to proceed. In --yes mode always yes; otherwise prompts (default no).
confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf "  %s%s%s [y/N]: " "$BOLD" "$1" "$RST"
  # Read straight from the controlling terminal so a prompt is never thrown off
  # by typeahead or anything else on stdin. Fall back to stdin when there's no
  # tty (piped answers, CI) — opening fd 3 is the real test of usability.
  local reply=""
  if { exec 3</dev/tty; } 2>/dev/null; then
    read -r reply <&3 || reply=""
    exec 3<&-
  else
    read -r reply || reply=""
  fi
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Top-level gate for a section. When the interactive menu was used the section
# was already chosen there, so don't ask a second, redundant time (that double
# prompt was easy to desync); in flag mode (e.g. --stack), confirm once here.
section_ok() {
  [ "$MENU" -eq 1 ] && return 0
  confirm "Proceed with the ${1} teardown?"
}

# Privilege helper, same convention as the installers.
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
OS="$(uname -s)"

printf "\n%s\n" "${BOLD}Daalu agent — teardown${RST}"
printf "%s\n" "${DIM}Removes what Daalu's installers added to this machine. Nothing else is touched.${RST}"
[ "$DRY_RUN" -eq 1 ] && warn "DRY RUN — no changes will be made; commands are only printed."

# Interactive section selection when nothing was requested on the command line.
if [ "$ANY_SECTION" -eq 0 ]; then
  MENU=1
  printf "\n%sChoose what to remove%s (answer each):\n" "$BOLD" "$RST"
  confirm "Remove the local docker compose stack (containers + volumes + built images)?" && DO_STACK=1
  confirm "Uninstall laptop inference (Ollama / IPEX-LLM)?"                                && DO_INFER=1
  confirm "Tear down the kind demo lab (cluster + kind network)?"                          && DO_DEMO=1
  confirm "Uninstall the k3s GPU cluster (k3s + GPU Operator + Prometheus/Loki)?"          && DO_K3S=1
  if [ $((DO_STACK + DO_INFER + DO_DEMO + DO_K3S)) -eq 0 ]; then
    warn "Nothing selected — exiting."; exit 0
  fi
fi

# =============================================================================
#  Section 1 — local docker compose stack
# =============================================================================
teardown_stack() {
  hr; say "${BOLD}Stack${RST} — local docker compose services, volumes, and built images"

  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not found — skipping the stack section."; return 0
  fi
  if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
  else warn "docker compose not available — skipping the stack section."; return 0; fi

  printf "  This removes ONLY this project's compose objects:\n"
  printf "    • containers: postgres, redis, api, worker, beat, agents, executor, frontend, ollama\n"
  printf "    • named volumes: ${BOLD}pgdata${RST} (database) and ${BOLD}ollama${RST} (model cache) — data is destroyed\n"
  printf "    • the locally-built images: ${BOLD}daalu-agent:local${RST}, ${BOLD}daalu-agent-ui:local${RST}\n"
  section_ok stack || { warn "skipped stack"; return 0; }

  # `down -v` is project-scoped: it only touches services/volumes/networks
  # declared in THIS compose file, never unrelated containers. --profile ollama
  # ensures the optional Ollama service container is included; --remove-orphans
  # sweeps any renamed leftovers.
  run_sh "$COMPOSE --profile ollama down -v --remove-orphans"

  # Remove the two images we built locally (public base images are left alone
  # unless --remove-images). `docker image rm` no-ops cleanly if already gone.
  say "Removing locally-built images"
  run docker image rm daalu-agent:local daalu-agent-ui:local

  if [ "$REMOVE_IMAGES" -eq 1 ]; then
    say "Removing pulled base images (--remove-images)"
    run docker image rm postgres:16-alpine redis:7-alpine ollama/ollama:latest
  else
    printf "  %skept base images postgres/redis/ollama (pass --remove-images to drop them)%s\n" "$DIM" "$RST"
  fi

  # .env is the operator's configuration (inference URL, secrets) — keep it
  # unless explicitly asked, so a re-install doesn't lose settings.
  if [ -f .env ]; then
    if [ "$REMOVE_ENV" -eq 1 ]; then
      say "Removing .env (--remove-env)"; run rm -f .env
    else
      printf "  %skept .env (your config) — pass --remove-env to delete it%s\n" "$DIM" "$RST"
    fi
  fi
  ok "stack section done"
}

# =============================================================================
#  Section 2 — laptop inference (Ollama / IPEX-LLM)
# =============================================================================
teardown_inference() {
  hr; say "${BOLD}Inference${RST} — Ollama and the IPEX-LLM build installed for the laptop path"

  # Stop any server we started (install-inference serves on 0.0.0.0:11434).
  if pgrep -x ollama >/dev/null 2>&1; then
    say "Stopping running Ollama server(s)"
    run_sh "pkill -x ollama || true"
  fi

  if [ "$OS" = "Darwin" ]; then
    # macOS: CLI-only install — a wrapper on PATH execs a binary under
    # ~/.daalu-ollama (OLLAMA_HOME). Remove both.
    OLL_HOME="${OLLAMA_HOME:-$HOME/.daalu-ollama}"
    printf "  Will remove: the %s/usr/local/bin/ollama%s wrapper and %s%s%s\n" \
      "$BOLD" "$RST" "$BOLD" "$OLL_HOME" "$RST"
    section_ok inference || { warn "skipped inference"; return 0; }
    if [ -e /usr/local/bin/ollama ]; then
      MAC_SUDO=""; [ -w /usr/local/bin ] || MAC_SUDO="sudo"
      run ${MAC_SUDO} rm -f /usr/local/bin/ollama
    fi
    run rm -rf "$OLL_HOME"
    if [ "$PURGE_MODELS" -eq 1 ]; then
      say "Purging downloaded models (--purge-models)"
      run rm -rf "$HOME/Library/Ollama" "${OLLAMA_MODELS:-$HOME/.ollama}"
    else
      printf "  %skept model weights in ~/Library/Ollama (pass --purge-models to delete)%s\n" "$DIM" "$RST"
    fi
  else
    # Linux: stock Ollama is installed by `curl ollama.com/install.sh | sh`,
    # which lays down a systemd service + an `ollama` user. Undo per Ollama's
    # own uninstall docs. The IPEX-LLM path instead lives entirely under
    # ~/.daalu-ipex-ollama (a venv) with nothing system-wide.
    printf "  Will remove (Linux): the ollama systemd service + /usr/local/bin/ollama,\n"
    printf "  the IPEX-LLM dir %s~/.daalu-ipex-ollama%s, and the 'ollama' service user.\n" "$BOLD" "$RST"
    section_ok inference || { warn "skipped inference"; return 0; }

    if [ -e /etc/systemd/system/ollama.service ] || systemctl list-unit-files 2>/dev/null | grep -q '^ollama\.service'; then
      say "Stopping and removing the ollama systemd service"
      run ${SUDO} systemctl stop ollama
      run ${SUDO} systemctl disable ollama
      run ${SUDO} rm -f /etc/systemd/system/ollama.service
      run ${SUDO} systemctl daemon-reload
    fi
    # The official installer drops the binary at /usr/local/bin/ollama.
    if [ -e /usr/local/bin/ollama ]; then
      run ${SUDO} rm -f /usr/local/bin/ollama
    fi
    # Service user/group + its model store under /usr/share/ollama.
    if id ollama >/dev/null 2>&1; then
      say "Removing the 'ollama' service user and its data dir"
      run ${SUDO} rm -rf /usr/share/ollama
      run_sh "${SUDO} userdel ollama 2>/dev/null || true"
      run_sh "${SUDO} groupdel ollama 2>/dev/null || true"
    fi
    # IPEX-LLM build (Intel Arc) — self-contained venv dir.
    run rm -rf "${IPEX_DIR:-$HOME/.daalu-ipex-ollama}"
    if [ "$PURGE_MODELS" -eq 1 ]; then
      say "Purging downloaded models (--purge-models)"
      run rm -rf "${OLLAMA_MODELS:-$HOME/.ollama}"
    else
      printf "  %skept model weights in ~/.ollama (pass --purge-models to delete)%s\n" "$DIM" "$RST"
    fi
    # Intel GPU compute runtime (apt packages) is intentionally NOT removed: it
    # is a system graphics runtime other software may rely on. Remove by hand if
    # you're sure: sudo apt-get remove intel-opencl-icd clinfo libze1 libze-intel-gpu1
    printf "  %snote: Intel GPU runtime apt packages left in place (system graphics; remove manually if desired)%s\n" "$DIM" "$RST"
  fi
  ok "inference section done"
}

# =============================================================================
#  Section 3 — kind demo lab
# =============================================================================
teardown_demo() {
  hr; say "${BOLD}Demo${RST} — the kind demo cluster and its docker network"

  export PATH="$PATH:${DAALU_DEMO_BINDIR:-$HOME/.daalu/bin}"
  CLUSTER="daalu-demo"; KIND_NET="kind"

  if ! command -v kind >/dev/null 2>&1; then
    warn "kind not found on PATH — the demo cluster is likely already gone."
  fi
  section_ok demo || { warn "skipped demo"; return 0; }

  # Disconnect Daalu containers from the kind network first (best-effort), the
  # same order demo/down.sh uses, then delete the cluster (which removes the
  # network too).
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    say "Disconnecting Daalu containers from '${KIND_NET}'"
    run_sh "while read -r cid; do [ -n \"\$cid\" ] && docker network disconnect $KIND_NET \"\$cid\" 2>/dev/null || true; done < <(docker compose ps -q 2>/dev/null || true)"
  fi
  if command -v kind >/dev/null 2>&1 && kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    say "Deleting kind cluster '${CLUSTER}'"
    run kind delete cluster --name "$CLUSTER"
  else
    warn "no kind cluster named '${CLUSTER}' — nothing to delete"
  fi
  # Sweep the kind network if it lingers with no cluster attached.
  run_sh "docker network rm $KIND_NET 2>/dev/null || true"

  # The demo auto-fetched kind/kubectl/helm into ~/.daalu/bin when missing.
  # That directory is ours — offer to remove it.
  BINDIR="${DAALU_DEMO_BINDIR:-$HOME/.daalu/bin}"
  if [ -d "$BINDIR" ]; then
    if confirm "Remove the auto-installed CLI binaries in ${BINDIR} (kind/kubectl/helm)?"; then
      run rm -rf "$BINDIR"
      # Drop the now-empty ~/.daalu if nothing else lives there.
      run_sh "rmdir \"$HOME/.daalu\" 2>/dev/null || true"
    fi
  fi
  ok "demo section done"
}

# =============================================================================
#  Section 4 — k3s GPU cluster
# =============================================================================
teardown_k3s() {
  hr; say "${BOLD}k3s${RST} — single-node cluster, GPU Operator, and Prometheus/Loki"

  if ! command -v k3s >/dev/null 2>&1 && [ ! -x /usr/local/bin/k3s-uninstall.sh ]; then
    warn "no k3s install found — skipping the k3s section."; return 0
  fi
  printf "  This runs k3s's own uninstaller, which removes the cluster and EVERYTHING\n"
  printf "  in it (GPU Operator, kube-prometheus-stack, Loki, any vLLM deployment),\n"
  printf "  the systemd service, /var/lib/rancher/k3s, and the k3s binary.\n"
  section_ok k3s || { warn "skipped k3s"; return 0; }

  # The get.k3s.io installer drops these uninstall scripts. Server node uses
  # k3s-uninstall.sh; an agent-only node uses k3s-agent-uninstall.sh.
  if [ -x /usr/local/bin/k3s-uninstall.sh ]; then
    run ${SUDO} /usr/local/bin/k3s-uninstall.sh
  elif [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then
    run ${SUDO} /usr/local/bin/k3s-agent-uninstall.sh
  else
    warn "k3s-uninstall.sh not found — k3s may have been installed another way."
    warn "Manual cleanup: sudo systemctl stop k3s; sudo rm -rf /var/lib/rancher/k3s /etc/rancher/k3s; sudo rm -f /usr/local/bin/k3s*"
  fi

  # vLLM's weights cache is a hostPath the uninstaller doesn't touch.
  if [ -d /var/lib/daalu/hf-cache ]; then
    if confirm "Remove the vLLM model cache at /var/lib/daalu (can be many GB)?"; then
      run ${SUDO} rm -rf /var/lib/daalu
    fi
  fi

  # The installer copied the cluster kubeconfig to ~/.kube/config. Offer to drop
  # it since it now points at a deleted cluster — but only if it's the k3s one.
  if [ -f "$HOME/.kube/config" ] && grep -q '127.0.0.1:6443\|default' "$HOME/.kube/config" 2>/dev/null; then
    printf "  %sNote: ~/.kube/config may be the k3s copy now pointing at a deleted cluster.%s\n" "$DIM" "$RST"
    if confirm "Remove ~/.kube/config?"; then run rm -f "$HOME/.kube/config"; fi
  fi
  ok "k3s section done"
}

# ── run the selected sections ────────────────────────────────────────────────
[ "$DO_STACK" -eq 1 ] && teardown_stack
[ "$DO_INFER" -eq 1 ] && teardown_inference
[ "$DO_DEMO"  -eq 1 ] && teardown_demo
[ "$DO_K3S"   -eq 1 ] && teardown_k3s

hr
if [ "$DRY_RUN" -eq 1 ]; then
  ok "${BOLD}Dry run complete${RST} — nothing was changed. Re-run without --dry-run to apply."
else
  ok "${BOLD}Teardown complete.${RST}"
fi
printf "\n  Reinstall anytime:\n"
printf "    • Stack:      %s./install.sh%s\n" "$BOLD" "$RST"
printf "    • Inference:  %s./scripts/install-inference.sh%s\n" "$BOLD" "$RST"
printf "    • Demo lab:   %s./demo/up.sh%s\n" "$BOLD" "$RST"
printf "    • GPU k3s:    %ssudo ./scripts/install-gpu-k3s.sh%s\n" "$BOLD" "$RST"
hr
