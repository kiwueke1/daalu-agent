#!/usr/bin/env bash
# =============================================================================
#  Daalu agent — installer
# -----------------------------------------------------------------------------
#  Brings up the full local stack (Postgres, Redis, API, workers, UI) with one
#  command, points the agent at YOUR inference endpoint, seeds demo data, and
#  waits until everything is healthy. Re-runnable and idempotent.
#
#  Usage:
#     ./install.sh                 # interactive: asks for your inference URL
#     ./install.sh --yes           # non-interactive: uses .env / defaults
#     ./install.sh --no-seed       # skip the synthetic demo events
#
#  Requirements: docker (with the compose plugin) and ~4 GB free RAM.
# =============================================================================
set -euo pipefail

# ── pretty output ────────────────────────────────────────────────────────────
# Colours degrade gracefully when stdout is not a TTY (e.g. piped to a file).
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; BLU=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi
say()  { printf "%s\n" "${BLU}▶${RST} $*"; }            # step
ok()   { printf "%s\n" "${GRN}✔${RST} $*"; }            # success
warn() { printf "%s\n" "${YLW}!${RST} $*"; }            # warning
die()  { printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; } # fatal
hr()   { printf "%s\n" "${DIM}────────────────────────────────────────────────────────${RST}"; }

ASSUME_YES=0
DO_SEED=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y)   ASSUME_YES=1 ;;
    --no-seed)  DO_SEED=0 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20; exit 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

cd "$(dirname "$0")"   # always operate from the repo root

printf "\n%s\n" "${BOLD}Daalu agent — installer${RST}"
printf "%s\n\n" "${DIM}A self-hosted AI agent for infra/ops. Runs on your own inference.${RST}"

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
say "Step 1/6  Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker is not installed — see https://docs.docker.com/get-docker/"
# Compose v2 ships as a docker subcommand; fall back to the legacy binary.
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "docker compose plugin not found — install Docker Compose v2"
fi
docker info >/dev/null 2>&1 || die "the docker daemon is not running — start Docker and retry"
ok "docker + compose detected  ${DIM}($COMPOSE)${RST}"

# ── 2. Configuration (.env) ──────────────────────────────────────────────────
say "Step 2/6  Configuration"
if [ ! -f .env ]; then
  cp .env.example .env
  ok "created .env from .env.example"
else
  ok ".env already present — leaving it untouched"
fi

# Offer to set the inference endpoint, the one value that actually matters.
if [ "$ASSUME_YES" -eq 0 ]; then
  current_url="$(grep -E '^LLM_BASE_URL=' .env | head -1 | cut -d= -f2- || true)"
  printf "\n  The agent needs an OpenAI-compatible inference endpoint.\n"
  printf "  %sNothing leaves your network when this points at your own server.%s\n" "$DIM" "$RST"
  printf "  Examples:  http://host.docker.internal:11434/v1   (Ollama on this host)\n"
  printf "             http://10.0.0.5:8000/v1                 (a vLLM box)\n"
  printf "  Inference URL [%s]: " "${current_url:-skip}"
  read -r answer || answer=""
  if [ -n "$answer" ]; then
    # Portable in-place edit (works on both GNU and BSD sed).
    tmp="$(mktemp)"; sed "s#^LLM_BASE_URL=.*#LLM_BASE_URL=${answer}#" .env > "$tmp" && mv "$tmp" .env
    ok "set LLM_BASE_URL=${answer}"
    printf "  Model name to use (must exist on that server) [skip]: "
    read -r model || model=""
    if [ -n "$model" ]; then
      tmp="$(mktemp)"; sed "s#^LLM_MODEL=.*#LLM_MODEL=${model}#; s#^LLM_MODEL_CLASSIFIER=.*#LLM_MODEL_CLASSIFIER=${model}#" .env > "$tmp" && mv "$tmp" .env
      ok "set LLM_MODEL=${model}"
    fi
  else
    warn "left inference settings at their current value — edit .env later if needed"
  fi
fi

# Friendly heads-up if the kubeconfig we mount doesn't exist.
if [ ! -e "${HOME}/.kube/config" ]; then
  warn "no ~/.kube/config found — the Kubernetes tools will be inert until you add one."
  warn "No cluster yet? See scripts/install-gpu-k3s.sh (optional)."
fi

# ── 3. Build images ──────────────────────────────────────────────────────────
say "Step 3/6  Building images  ${DIM}(first run downloads base layers — a few minutes)${RST}"
$COMPOSE build
ok "images built"

# ── 4. Start the stack ───────────────────────────────────────────────────────
say "Step 4/6  Starting services"
$COMPOSE up -d
ok "containers started"

# ── 5. Wait for the API to become healthy ────────────────────────────────────
say "Step 5/6  Waiting for the API to come up"
deadline=$(( $(date +%s) + 120 ))
until curl -fsS http://localhost:8000/health >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    warn "API did not report healthy within 120s. Recent logs:"
    $COMPOSE logs --tail=40 api || true
    die "startup timed out — fix the error above and re-run ./install.sh"
  fi
  printf "."; sleep 3
done
printf "\n"; ok "API healthy at http://localhost:8000"

# ── 6. Seed demo data ────────────────────────────────────────────────────────
if [ "$DO_SEED" -eq 1 ]; then
  say "Step 6/6  Seeding a wave of synthetic events so the UI isn't empty"
  # `seed` ensures the default tenant; `seed-demo` generates fake infra events
  # that the agent will triage — handy for a first look with no real wiring.
  $COMPOSE exec -T api daalu seed       >/dev/null 2>&1 || warn "seed step skipped/failed (non-fatal)"
  $COMPOSE exec -T api daalu seed-demo  >/dev/null 2>&1 || warn "seed-demo step skipped/failed (non-fatal)"
  ok "demo data seeded"
else
  say "Step 6/6  Skipping demo seed (--no-seed)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
hr
ok "${BOLD}Daalu is up.${RST}"
printf "\n"
printf "   %sUI:%s        http://localhost:3000\n" "$BOLD" "$RST"
printf "   %sAPI docs:%s  http://localhost:8000/docs\n" "$BOLD" "$RST"
printf "\n"
printf "   %sNext:%s\n" "$BOLD" "$RST"
printf "     • Open the UI and watch the agent triage the seeded alerts.\n"
printf "     • Wire a real source (Prometheus/Alertmanager, AWS, SSH) under Integrations.\n"
printf "     • Logs:   %s logs -f agents\n" "$COMPOSE"
printf "     • Stop:   %s down        (add -v to wipe the database)\n" "$COMPOSE"
hr
