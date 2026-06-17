#!/usr/bin/env bash
# =============================================================================
#  Daalu laptop inference installer — auto-detect the GPU and serve a local,
#  OpenAI-compatible model the agent can think on.
# -----------------------------------------------------------------------------
#  Picks the right runtime for the hardware it finds:
#
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

# ── 1. Detect the accelerator ────────────────────────────────────────────────
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
      $SUDO apt-get install -y \
        intel-opencl-icd intel-level-zero-gpu level-zero \
        libze1 libze-intel-gpu1 clinfo 2>/dev/null || \
        warn "Some Intel GPU runtime packages weren't found in the default repos. For newest silicon (e.g. Lunar Lake) add Intel's graphics APT repo: https://dgpu-docs.intel.com — then re-run."
    else
      warn "Non-apt distro — install Intel's compute runtime (intel-opencl-icd, level-zero) by hand per https://dgpu-docs.intel.com"
    fi
    # 2b. IPEX-LLM Ollama. Intel ships it via the ipex-llm[cpp] wheel which lays
    #     down an Ollama that links the SYCL backend.
    if ! command -v python3 >/dev/null 2>&1; then die "python3 required for the IPEX-LLM install"; fi
    IPEX_DIR="${IPEX_DIR:-$HOME/.daalu-ipex-ollama}"
    say "Setting up IPEX-LLM Ollama in ${IPEX_DIR}"
    python3 -m venv "$IPEX_DIR/venv"
    # shellcheck disable=SC1091
    . "$IPEX_DIR/venv/bin/activate"
    pip install --upgrade pip >/dev/null
    pip install --pre --upgrade "ipex-llm[cpp]" || \
      die "pip install ipex-llm[cpp] failed — check https://github.com/intel/ipex-llm for current Arc/Lunar-Lake instructions."
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
