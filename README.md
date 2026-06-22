<h1 align="center">Daalu</h1>
<p align="center"><b>A self-hosted AI agent for infrastructure &amp; ops teams.</b><br/>
It investigates, proposes changes, and executes only after you approve — running entirely on <i>your</i> infrastructure and <i>your</i> inference.</p>

<p align="center">
<a href="#install">Install</a> ·
<a href="#what-it-is-in-60-seconds">What it is</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#uninstall--teardown">Uninstall</a> ·
<a href="docs/">Docs</a> ·
<a href="#license">License</a>
</p>

---

Today, most "AI for ops" tools are SaaS: to use one you ship your cluster topology, logs, and
secrets to someone else's cloud — and pay per seat or per host. **Daalu runs in your own
environment, on your own CPUs/GPUs, powered by open-source models — so you can run the whole
thing for free.** Point it at any OpenAI-compatible endpoint (vLLM or Ollama, open weights)
and nothing leaves your network — it triages alerts, gathers evidence, drafts the fix, and
waits for your approval before touching anything.

## What it is in 60 seconds

- **Turns alerts into diagnosed fixes** — an alert comes in; Daalu's agent investigates it
  (pod logs, k8s events, Prometheus, cloud state), pins the likely root cause, and drafts the
  remediation — the on-call first-responder work, done for you. → [01-architecture.md](docs/01-architecture.md)
- **It proposes, you approve** — read-only investigation tools run freely; anything that
  mutates state becomes a `ChangeProposal` a human must approve, applied by a separately-
  scoped executor (prompt injection can't smuggle execute rights). → [02-agent-and-guardrails.md](docs/02-agent-and-guardrails.md)
- **Sovereign by default** — bring your own inference; with a local model nothing leaves
  your network (a public provider, Anthropic, is opt-in). → [03-llm-and-sovereignty.md](docs/03-llm-and-sovereignty.md)
- **Operates real infrastructure** — first-class tools for Kubernetes (kubectl),
  AWS/GCP/Azure (read-only), and Linux/network devices over SSH/NETCONF/Redfish. → [05-tools.md](docs/05-tools.md)
- **GPU-aware** — onboard a GPU cluster and the **AI Factory** shows live
  utilisation/thermals/health and runs benchmarks, with the agent reasoning on that same GPU.
- **Open core** — this repo is the full single-tenant agent, Apache-2.0.

## Install

You need **Docker** (with the Compose plugin) and ~4 GB RAM. Daalu runs the same way
everywhere; what differs is *where the model runs*. Pick a path:

### A) Laptop — macOS or Ubuntu (quick feel, CPU/Metal)
Running on a laptop is just for a demo and to get a feel for the product. For real use, we
recommend one or more servers or workstations, each with one or more NVIDIA GPUs.
```bash
git clone https://github.com/kiwueke1/daalu-agent.git daalu && cd daalu
./scripts/install-inference.sh    # installs Ollama + a small open model, prints the LLM_* lines
ollama --version                  # verify Ollama installed (works without a running server)

# Start the model server and LEAVE IT RUNNING (own terminal tab). It must bind
# 0.0.0.0 — not 127.0.0.1 — so Daalu's containers can reach it via
# host.docker.internal. The installer does NOT start a server for you.
OLLAMA_HOST=0.0.0.0:11434 ollama serve

# …then in a SECOND terminal, in the same repo dir:
./install.sh                      # builds + starts Daalu; accept the default inference URL
```

`install-inference.sh` auto-detects your machine — **macOS (Apple Silicon)** uses the
Metal GPU automatically (fastest laptop path); **NVIDIA** uses CUDA; **Intel Arc** gets
IPEX-LLM; otherwise CPU. It installs Ollama and pulls the model but **does not keep a
server running** — that's the `ollama serve` step above. Leave it running the whole time
you use Daalu (close that tab and the agent loses its model), and keep the `0.0.0.0` bind
so the containers can reach it. Then open **http://localhost:3000**.

> On **Ubuntu**, Ollama's installer may instead register a background service. If
> `ollama serve` reports the port is already in use, it's already running — just make sure
> it listens on all interfaces: `sudo systemctl edit ollama` and add
> `Environment=OLLAMA_HOST=0.0.0.0:11434`, then `sudo systemctl restart ollama`.

```bash
# verify
ollama list                                # your model is pulled (e.g. qwen2.5:7b)
docker compose ps                          # all services "Up"
curl http://localhost:8000/health          # OK
curl http://localhost:11434/v1/models      # your model is listed
```

> CPU inference is slow — fine for a first look. For real use, run a GPU node ↓.

### B) One GPU node — k3s plus a model the agent runs on

A single Linux box with an NVIDIA GPU runs the whole stack. It's a Kubernetes cluster that
Daalu manages, a model server that runs as pods on that cluster and serves the model over
HTTPS, and Daalu itself, which connects your infrastructure data to the AI agent.

Clone the repo and confirm you're on the latest commit:

```bash
git clone https://github.com/kiwueke1/daalu-agent.git daalu && cd daalu
git log --oneline -1
```

**1. Install the cluster** — k3s, the NVIDIA GPU Operator, and Prometheus/Loki:

```bash
sudo ./scripts/install-gpu-k3s.sh
```

Check the node is `Ready` and the GPU is schedulable (you should see `nvidia.com/gpu: "1"`):

```bash
kubectl get nodes
kubectl get nodes -o json | grep nvidia.com/gpu
```

**2. Serve an open model on the GPU.** Pick the model that fits your card.

**16 GB GPU** — the 7B default (Qwen2.5-7B). A solid first run on a smaller card; serves as `qwen2.5-7b`:

```bash
./scripts/serve-model.sh
```

**48 GB GPU** — a 30B MoE coder (Qwen3-Coder-30B). Stronger at tool-calling; serves as `qwen3-coder-30b`:

```bash
MODEL=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 SERVED_NAME=qwen3-coder-30b \
  MAX_LEN=32768 MEM_LIMIT=64Gi TOOL_PARSER=qwen3_coder \
  ./scripts/serve-model.sh
```

Confirm the model is serving — the `id` should come back as the name you served (`qwen2.5-7b` or `qwen3-coder-30b`):

```bash
kubectl -n daalu get pods
curl -s http://$(hostname -I | awk '{print $1}'):30800/v1/models | grep -o '"id":"[^"]*"'
```

**3. Start Daalu.** At the two prompts, enter the inference URL `http://host.docker.internal:30800/v1` and the name you served (`qwen2.5-7b` or `qwen3-coder-30b`):

```bash
./install.sh
```

Confirm every service is up and the API is healthy:

```bash
docker compose ps
curl -s http://localhost:8000/health
```

**4. Wire the GPU, cluster, Prometheus and Loki into Daalu.** Idempotent — it prints your UI URL when it finishes:

```bash
./scripts/onboard-cluster.sh
```

Optionally, see everything that got installed — the cluster side, then the Daalu side:

```bash
kubectl get pods -A
docker compose ps
```

**That's it — open the UI.** Step 4's `onboard-cluster.sh` does all of Part 2B.4 for you
(the tenant-labelled DCGM ServiceMonitor, the GPU owner row, and the Kubernetes +
Prometheus + Loki integrations), then prints your URL. In the UI you'll find: **AI Factory**
with live GPU metrics; **Managed infra → Kubernetes**, a read-only kubectl console; and
**Managed infra → Observability**, where **Open** on Prometheus or Loki gives ready-made
metric/log queries. It's idempotent — re-run it any time.

> Reaching the UI from another machine, or doing the onboarding by hand instead — see
> [**docs/04-deployment.md → Part 2B.4**](docs/04-deployment.md#2b-production-a-gpu-kubernetes-cluster).

### Already have an endpoint? (Ollama, vLLM, a hosted gateway)

```bash
git clone https://github.com/kiwueke1/daalu-agent.git daalu && cd daalu && ./install.sh   # paste your OpenAI-compatible URL when asked
```

Or set `LLM_BASE_URL` / `LLM_MODEL` in `.env` and `docker compose up -d` — see
[2C](docs/04-deployment.md#2c-point-daalu-at-an-existing-endpoint).

> **Auth:** the default `LOCAL_NO_AUTH=true` runs as one operator with no login — perfect
> for a laptop, **unsafe** on anything others can reach. Front it with an auth proxy before
> exposing it ([1.6](docs/04-deployment.md#16-exposing-daalu-to-others-authentication)).

### See it actually fix something (demo lab)

The demo lab spins up a small, self-contained Kubernetes cluster with real monitoring and a
sample app, then lets you break the app on purpose so you can watch Daalu notice the alert,
investigate it, and propose a fix you approve — an end-to-end run on throwaway infrastructure.

```bash
./demo/up.sh        # a monitored kind cluster (Prometheus/Alertmanager/Loki) + a dummy app, wired to Daalu
./demo/break.sh     # take the app down on purpose
# → open Daalu → Alerts: watch it investigate and propose a rollback for you to approve
./demo/down.sh      # tear it all down
```

Full runbook: [demo/README.md](demo/README.md).

## Uninstall / teardown

One script removes everything the installers added — and only that. It's the reverse of
`install.sh` / `install-inference.sh` / `install-gpu-k3s.sh` / `demo/up.sh`, split into four
independent sections. Run it with no flags to choose each section interactively:

```bash
./teardown.sh                  # interactive — asks before each section
./teardown.sh --all --dry-run  # print exactly what it would remove, change nothing
./teardown.sh --all -y         # remove everything, no prompts
./teardown.sh --stack --demo   # just those sections
```

| Section | Reverses | Removes |
|---------|----------|---------|
| `--stack` | `install.sh` | the compose services, the `pgdata`/`ollama` volumes, and the two locally-built images (project-scoped — never touches unrelated containers) |
| `--inference` | `install-inference.sh` | Ollama (on **macOS**: the `/usr/local/bin/ollama` wrapper + `~/.daalu-ollama`) and the Intel-Arc IPEX-LLM build |
| `--demo` | `demo/up.sh` | the `daalu-demo` kind cluster + the `kind` network |
| `--k3s` | `install-gpu-k3s.sh` | runs k3s's own uninstaller (cluster, GPU Operator, Prometheus/Loki, vLLM — all of it). Needs root |

Kept by default (opt in to remove): your `.env` (`--remove-env`), downloaded model weights
(`--purge-models`), and the public base images (`--remove-images`). The Intel GPU runtime apt
packages are left in place — they're system graphics other software may rely on.

## How it works

```
  sources                 Daalu                          you
  ───────                 ─────                          ───
  Alertmanager  ─┐                ┌── read tools ──► investigates (logs,
  PagerDuty      │                │   (auto-run)        events, metrics, cloud)
  CloudWatch     ├─► events ─► InfraAgent ─► drafts a ChangeProposal
  webhooks       │   (Redis)      │                         │
  SSH/NETCONF  ─┘                 │                         ▼
                                  └── write tools ◄── you APPROVE ─► executor applies
                                      (gated)                         (separate scope)
```

**Ingest** alerts/events → **investigate** with read-only tools → **propose** a diff for
anything that changes state → a human **approves** → a dedicated **executor** (own queue +
token scope) **applies** it and records the result. Architecture:
[01-architecture.md](docs/01-architecture.md).

## Documentation

| Doc | What |
|-----|------|
| [docs/04-deployment.md](docs/04-deployment.md) | **Install everything** in depth — Part 1 Daalu, Part 2 inference/GPU, Part 3 (optional) network & server management |
| [docs/01-architecture.md](docs/01-architecture.md) | How the pieces fit together |
| [docs/02-agent-and-guardrails.md](docs/02-agent-and-guardrails.md) | The approve-before-execute safety model |
| [docs/05-tools.md](docs/05-tools.md) | The tool catalog (kubectl, cloud, devices) |
| [docs/03-llm-and-sovereignty.md](docs/03-llm-and-sovereignty.md) | Pointing Daalu at your own inference |
| [docs/07-network-server-management.md](docs/07-network-server-management.md) | Managing physical switches/servers with the optional NV-CM add-on |
| [docs/06-extending.md](docs/06-extending.md) | Add a module, integration, or agent |

**Not in this repo (commercial hub):** multi-tenancy, SSO/RBAC, billing, the WireGuard
fleet for many customer clusters, managed GPU provisioning. This repo is single-tenant and
self-hosted.

## License

[Apache-2.0](LICENSE). Includes vendored Apache-2.0 components from NVIDIA — see [NOTICE](NOTICE).
