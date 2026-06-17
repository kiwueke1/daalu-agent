#!/usr/bin/env bash
# =============================================================================
#  Daalu laptop inference installer — auto-detect the GPU and serve a local,
#  OpenAI-compatible model the agent can think on.
# -----------------------------------------------------------------------------
#  Picks the right runtime for the hardware it finds:
#
#    • macOS (Apple Silicon) → Ollama, which uses the Metal GPU automatically.
#                    The simplest + fastest laptop path; no GPU runtime to set up.
#    • NVIDIA GPU  → stock Ollama. Ollama auto-detects CUDA and uses the GPU
#                    with no extra config (driver + a recent Ollama is enough).
#    • Intel Arc   → IPEX-LLM's Ollama (SYCL/oneAPI). Stock Ollama has no Intel
#                    backend and silently falls back to CPU, so on Arc we install
#                    Intel's GPU compute runtime + the IPEX-LLM Ollama build.
#    • AMD GPU     → stock Ollama (ROCm; auto-detected like CUDA).
#    • none/other  → stock Ollama on CPU.
#
#  Then it pulls a model sized for the target (7B on a laptop/iGPU, 14B when a
#  roomy discrete GPU is present) and prints the LLM_* lines to put in Daalu's
#  .env.
#
#  Usage:
#     ./scripts/install-inference.sh                  # auto-detect
#     ACCEL=nvidia|intel|amd|cpu ./scripts/install-inference.sh   # force a path
#     MODEL=qwen2.5:7b ./scripts/install-inference.sh             # override model
#
#  Re-runnable. Needs sudo for driver/runtime packages.
# =============================================================================
set -euo pipefail

GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; BLU=$'\033[36m'; BOLD=$'\033[1m'; RST=$'\033[0m'
say(){ printf "%s\n" "${BLU}▶${RST} $*"; }
ok(){ printf "%s\n" "${GRN}✔${RST} $*"; }
warn(){ printf "%s\n" "${YLW}!${RST} $*"; }
die(){ printf "%s\n" "${RED}✘ $*${RST}" >&2; exit 1; }

OLLAMA_PORT="${OLLAMA_PORT:-11434}"

# ── 0. macOS — Apple Silicon uses Metal automatically (no runtime to install) ──
if [ "$(uname -s)" = "Darwin" ]; then
  ARCH="$(uname -m)"
  if [ "$ARCH" = "arm64" ]; then
    say "macOS on Apple Silicon — Ollama uses the GPU automatically via Metal (no extra runtime)."
    # Unified memory lets the GPU use most of system RAM, so a 14B is fine on
    # a roomy Mac; default to 7B and let the operator bump it.
    MODEL="${MODEL:-qwen2.5:7b}"
  else
    warn "macOS on Intel — no Metal LLM acceleration; Ollama runs on CPU. A 7B model is the practical ceiling."
    MODEL="${MODEL:-qwen2.5:7b}"
  fi
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama already installed ($(ollama --version 2>&1 | head -1))"
  elif command -v brew >/dev/null 2>&1; then
    say "Installing Ollama via Homebrew"; brew install ollama || true
  else
    warn "Install the Ollama app from https://ollama.com/download (or 'brew install ollama'), start it, then re-run."
  fi
  if command -v ollama >/dev/null 2>&1; then
    say "Pulling ${BOLD}${MODEL}${RST}"; ollama pull "$MODEL" && ok "model ready"
  fi
  cat <<EOF

${GRN}✔ Inference ready (macOS / ${ARCH}).${RST}

  Make sure Ollama is running (the menu-bar app, or ${BOLD}ollama serve${RST}), then
  put these in Daalu's .env and ${BOLD}docker compose up -d${RST}:

     LLM_BASE_URL=http://host.docker.internal:${OLLAMA_PORT}/v1
     LLM_API_KEY=ollama
     LLM_MODEL=${MODEL}
     LLM_MODEL_CLASSIFIER=${MODEL}

  Docker Desktop on macOS provides host.docker.internal automatically — no
  extra host mapping or 0.0.0.0 bind needed (unlike Linux).
EOF
  exit 0
fi

# ── 1. Detect the accelerator (Linux) ────────────────────────────────────────
detect_accel() {
  if [ -n "${ACCEL:-}" ]; then echo "$ACCEL"; return; fi
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    echo nvidia; return
  fi
  if lspci 2>/dev/null | grep -qiE "NVIDIA"; then echo nvidia; return; fi
  # Intel Arc / Xe discrete or integrated (Lunar Lake / Meteor Lake / Arc A-series)
  if lspci 2>/dev/null | grep -iE "VGA|Display|3D" | grep -qiE "Intel.*(Arc|Xe|Graphics)"; then
    echo intel; return
  fi
  if lspci 2>/dev/null | grep -qiE "Advanced Micro Devices.*(VGA|Display)"; then
    echo amd; return
  fi
  echo cpu
}

ACCEL_DETECTED="$(detect_accel)"
say "Detected accelerator: ${BOLD}${ACCEL_DETECTED}${RST}"

# Default model: 7B fits a laptop / iGPU comfortably; a discrete NVIDIA/AMD GPU
# can take the 14B.
case "$ACCEL_DETECTED" in
  nvidia|amd) DEFAULT_MODEL="qwen2.5:14b" ;;
  *)          DEFAULT_MODEL="qwen2.5:7b" ;;
esac
MODEL="${MODEL:-$DEFAULT_MODEL}"

need_sudo() { if [ "$(id -u)" -ne 0 ]; then echo sudo; fi; }
SUDO="$(need_sudo)"

install_stock_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama already installed ($(ollama --version 2>&1 | head -1))"
  else
    say "Installing Ollama"
    curl -fsSL https://ollama.com/install.sh | sh
  fi
}

# ── 2. Install per accelerator ───────────────────────────────────────────────
case "$ACCEL_DETECTED" in
  nvidia)
    say "NVIDIA path — stock Ollama auto-detects CUDA."
    command -v nvidia-smi >/dev/null 2>&1 || warn "nvidia-smi not found — install the NVIDIA driver first, or Ollama will run on CPU."
    install_stock_ollama
    ok "On a machine with the NVIDIA driver, Ollama uses the GPU automatically — no flags needed."
    ;;

  amd)
    say "AMD path — stock Ollama uses ROCm (auto-detected)."
    install_stock_ollama
    warn "AMD acceleration needs a ROCm-supported GPU + drivers; otherwise Ollama falls back to CPU."
    ;;

  intel)
    say "Intel Arc path — installing the GPU compute runtime + IPEX-LLM's Ollama (SYCL/oneAPI)."
    warn "Stock Ollama has no Intel backend; this path uses Intel's IPEX-LLM build so the Arc GPU is actually used."
    # 2a. Intel GPU compute runtime (OpenCL + Level-Zero). Package names vary by
    #     distro/age; install what's available and continue on misses.
    if command -v apt-get >/dev/null 2>&1; then
      $SUDO apt-get update -y || true
      # Install per-package (names vary by distro/silicon) so one miss doesn't
      # abort the rest. These four cover OpenCL + Level-Zero on recent Ubuntu
      # (verified on 26.04 / Lunar Lake Arc 140V with the kernel `xe` driver).
      for p in intel-opencl-icd clinfo libze1 libze-intel-gpu1; do
        $SUDO apt-get install -y "$p" >/dev/null 2>&1 && ok "  runtime: $p" \
          || warn "  runtime pkg '$p' not found — on very new silicon add Intel's graphics APT repo (https://dgpu-docs.intel.com) and re-run."
      done
      if command -v clinfo >/dev/null 2>&1 && clinfo -l 2>/dev/null | grep -qi "Arc\|Intel.*Graphics"; then
        ok "Intel GPU visible to the compute runtime: $(clinfo -l 2>/dev/null | grep -i Device | head -1 | sed 's/^[^A-Za-z]*//')"
      else
        warn "Intel GPU NOT yet visible to the OpenCL/Level-Zero runtime — IPEX-LLM will fall back to CPU until the runtime sees it (newer kernel / Intel graphics repo may be needed)."
      fi
    else
      warn "Non-apt distro — install Intel's compute runtime (intel-opencl-icd, level-zero) by hand per https://dgpu-docs.intel.com"
    fi
    # 2b. IPEX-LLM Ollama. Intel ships it via the ipex-llm[cpp] wheel which lays
    #     down an Ollama that links the SYCL backend.
    if ! command -v python3 >/dev/null 2>&1; then die "python3 required for the IPEX-LLM install"; fi
    PYVER="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
    case "$PYVER" in
      3.9|3.10|3.11) : ;;  # IPEX-LLM publishes wheels for these
      *) warn "Python ${PYVER} detected — IPEX-LLM's pip wheels lag new Python (3.9–3.11). On a too-new distro (e.g. Ubuntu 26.04 / Python 3.14) the pip install below will FAIL. Prefer Intel's IPEX-LLM 'Ollama Portable Zip' (no Python needed) from https://github.com/intel/ipex-llm/releases, or install Python 3.11 first (miniforge/conda)." ;;
    esac
    IPEX_DIR="${IPEX_DIR:-$HOME/.daalu-ipex-ollama}"
    say "Setting up IPEX-LLM Ollama in ${IPEX_DIR} (needs the python3-venv package)"
    python3 -m venv "$IPEX_DIR/venv" || die "venv creation failed — install python${PYVER}-venv (apt) and retry, or use the Portable Zip above."
    # shellcheck disable=SC1091
    . "$IPEX_DIR/venv/bin/activate"
    pip install --upgrade pip >/dev/null
    pip install --pre --upgrade "ipex-llm[cpp]" || {
      warn "pip install ipex-llm[cpp] failed (often: Python too new for the wheels). Use Intel's 'Ollama Portable Zip' from https://github.com/intel/ipex-llm/releases — it bundles the SYCL Ollama with no Python dependency. The OpenCL runtime + GPU are already set up by this script."
      exit 1
    }
    mkdir -p "$IPEX_DIR/ollama" && cd "$IPEX_DIR/ollama"
    # init-ollama symlinks the IPEX-LLM-built ollama binary into this dir.
    init-ollama || init-ollama.bat || warn "init-ollama not found on PATH — it ships with ipex-llm[cpp]; activate the venv and run it manually."
    cat > "$IPEX_DIR/serve.sh" <<EOF
#!/usr/bin/env bash
# Start IPEX-LLM Ollama on the Intel GPU. Sources oneAPI so the SYCL backend
# finds the Level-Zero runtime, then serves on 0.0.0.0 so Daalu's containers
# can reach it via host.docker.internal.
set -e
. "$IPEX_DIR/venv/bin/activate"
[ -f /opt/intel/oneapi/setvars.sh ] && . /opt/intel/oneapi/setvars.sh >/dev/null 2>&1 || true
export OLLAMA_HOST=0.0.0.0:${OLLAMA_PORT}
export OLLAMA_NUM_GPU=999            # offload all layers to the GPU
export ZES_ENABLE_SYSMAN=1
export SYCL_CACHE_PERSISTENT=1
cd "$IPEX_DIR/ollama"
exec ./ollama serve
EOF
    chmod +x "$IPEX_DIR/serve.sh"
    ok "IPEX-LLM Ollama installed. Start it with:  ${BOLD}$IPEX_DIR/serve.sh${RST}"
    warn "Lunar Lake (Core Ultra series 2) is very new — if the SYCL backend reports no device, you likely need Intel's latest graphics APT repo + a recent kernel. The serve.sh prints the device it picked on startup."
    ;;

  cpu|*)
    say "No supported GPU detected — stock Ollama on CPU."
    install_stock_ollama
    warn "CPU inference is slow. A 7B model is the practical ceiling; expect ~seconds-per-token on a laptop CPU."
    ;;
esac

# ── 3. Pull the model (skip for the Intel path until its server is running) ──
if [ "$ACCEL_DETECTED" != "intel" ]; then
  say "Pulling ${BOLD}${MODEL}${RST} (first time downloads several GB)"
  ollama pull "$MODEL"
  ok "model ready"
fi

# ── 4. Tell the operator how to point Daalu at it ────────────────────────────
cat <<EOF

${GRN}✔ Inference ready (${ACCEL_DETECTED}).${RST}

  Put these in Daalu's .env, then ${BOLD}docker compose up -d${RST}:

     LLM_BASE_URL=http://host.docker.internal:${OLLAMA_PORT}/v1
     LLM_API_KEY=ollama
     LLM_MODEL=${MODEL}
     LLM_MODEL_CLASSIFIER=${MODEL}

  Make sure the server listens on all interfaces so Daalu's containers can
  reach it (stock Ollama: OLLAMA_HOST=0.0.0.0:${OLLAMA_PORT}; the Intel path's
  serve.sh already does this).

  For fast, tool-using triage at scale, use the GPU Kubernetes path
  (docs/04-deployment.md §2B) or a hosted provider — a laptop GPU helps but a
  large tool-calling model still wants real horsepower.
EOF
