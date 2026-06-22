<h1 align="center">Daalu — Demo Guide</h1>
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

> **This is the demo-recording variant of the README.** It walks the **GPU node
> (Section B)** path end-to-end and uses the **manual onboarding** flow: you run
> a couple of scripts, then add the **Kubernetes / Prometheus / Loki**
> integrations yourself in the UI, spin up the demo app, and **break it by hand
> on camera** so Daalu picks up the alert and works it. If you just want the
> fastest non-recorded run, the one-command `./demo/up.sh` lab is described under
> [See it actually fix something](#see-it-actually-fix-something-demo-lab).

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
everywhere; what differs is *where the model runs*. **For the demo, follow Section B.**

### A) Laptop — macOS or Ubuntu (quick feel, CPU/Metal)

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

> CPU inference is slow — fine for a first look. For the demo, use a GPU node ↓.

### B) One GPU node — k3s + a served model, then the demo (manual onboarding) ★

This is the path for the demo. A single Linux box with an NVIDIA GPU runs everything: a
GPU-served model for the agent's reasoning, Daalu itself, and the breakable **demo app** —
deployed straight onto the same k3s cluster — that you onboard and break **live in the UI**.

> **One cluster.** k3s (step 1) hosts the **GPU-served model** (the agent's brain) *and* its
> own **Prometheus + Loki**. The demo (step 4) deploys the breakable **checkout-api** app into a
> `daalu-demo` namespace on that *same* cluster — **no separate `kind` cluster is created**. You
> onboard that cluster's Kubernetes / Prometheus / Loki into Daalu yourself (in the UI), and the
> agent reasons over it using the GPU model. *(On a laptop with no cluster, the same script
> falls back to a throwaway kind cluster instead — see [the auto lab](#see-it-actually-fix-something-demo-lab).)*

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

**2. Serve an open model on the GPU.** This 30B MoE coder fits a 48 GB card and is strong at tool-calling; on a ≤16 GB card run `./scripts/serve-model.sh` instead for the 7B default.

```bash
MODEL=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 SERVED_NAME=qwen3-coder-30b \
  MAX_LEN=32768 MEM_LIMIT=64Gi TOOL_PARSER=qwen3_coder \
  ./scripts/serve-model.sh
```

Confirm the model is serving — the `id` should come back as `qwen3-coder-30b`:

```bash
kubectl -n daalu get pods
curl -s http://$(hostname -I | awk '{print $1}'):30800/v1/models | grep -o '"id":"[^"]*"'
```

**3. Start Daalu.** At the two prompts, enter the inference URL `http://host.docker.internal:30800/v1` and the model name `qwen3-coder-30b`:

```bash
./install.sh
```

Confirm every service is up, the API is healthy, and the agent can actually reach the model
from **inside** the containers (this reads `$LLM_BASE_URL`, so it works for the vLLM NodePort,
not just Ollama's `:11434`):

```bash
docker compose ps
curl -s http://localhost:8000/health
docker compose exec -T api sh -lc 'curl -fsS "$LLM_BASE_URL/models"' && echo " inference reachable"
```

**4. Deploy the demo app onto your k3s cluster, manual-onboard mode.** Auto-detecting your
current kubectl context (the k3s cluster from step 1 — it already runs the Prometheus operator),
this deploys **checkout-api** into a `daalu-demo` namespace. It **creates no kind cluster**, and
— instead of auto-registering anything — **prints exactly what you'll paste into the UI**:

```bash
./demo/up-manual.sh
```

When it finishes, keep its output handy. It prints three things:

| Onboard in the UI | Value it prints |
|-------------------|-----------------|
| **Kubernetes** | a **kubeconfig file path**: `~/.daalu/daalu-demo-onboard.kubeconfig` |
| **Prometheus / Alertmanager** | `http://host.docker.internal:30090` |
| **Loki** | `http://host.docker.internal:30310` |

> ⚠️ Those URLs are the cluster's telemetry NodePorts **as seen from the Daalu containers**
> (reached via `host.docker.internal`) — **not** the `localhost`/node-IP ports you'd use in a
> browser. Enter them verbatim, hostname and all. They're the same values
> `scripts/onboard-cluster.sh` registers automatically. *(If you installed the cluster with a
> non-default `PROM_NODEPORT`/`LOKI_NODEPORT`, the script prints your actual ports — use those.)*

> **Why the Prometheus port (`:30090`) and not Alertmanager?** This one integration does double
> duty: it powers the **Observability metrics page** (which needs Prometheus' PromQL API,
> `/api/v1/query`) **and** ingests firing alerts (from Prometheus' own `/api/v1/alerts`, which
> the adapter falls back to). Prometheus serves both, so point this integration at **Prometheus**
> — not Alertmanager, which would make alerts work but **404 the metrics page**.

**5. Onboard the three integrations in the UI** (this is the part you demo on camera). Open
**http://localhost:3000 → Integrations** (or **Managed infra**) and add each:

- **Kubernetes** — paste the **full contents** of the kubeconfig file step 4 wrote:
  ```bash
  cat ~/.daalu/daalu-demo-onboard.kubeconfig   # copy all of it into the UI
  ```
  > **If that file isn't there** (you onboarded by hand, or an older script), generate a correct
  > kubeconfig from the live cluster. The critical part is rewriting the API `server:` to the
  > node's **InternalIP:6443** so the Daalu containers can reach it — a raw k3s kubeconfig says
  > `127.0.0.1:6443` and a kind one says `daalu-demo-control-plane:6443`, **neither of which
  > resolves from inside the containers** (that's the `NameResolutionError` you'll see if you
  > paste one of those). Copy this command's **entire output** into the UI:
  > ```bash
  > NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' \
  >   | tr ' ' '\n' | grep -vF ':' | head -1)
  > kubectl config view --raw --minify \
  >   | sed -E "s#server: https://[^[:space:]]+#server: https://${NODE_IP}:6443#"
  > ```
- **Prometheus / Alertmanager** — enter the URL `http://host.docker.internal:30090` (the
  **Prometheus** port — it serves both the metrics page and firing alerts; see the note above).
- **Loki** — enter the URL `http://host.docker.internal:30310`.

Each should flip to **connected** within ~60s, after the first health probe (reload if it
still says pending).

**6. Break the demo app — manually, on camera.** The app is already deployed and **healthy**;
nothing is broken until you run this. This is the line to narrate:

```bash
./demo/break.sh        # default: checkout-api outgrows its memory limit → OOMKilled → crash-loop
```

> Under the hood `break.sh` grows checkout-api's working set past its memory limit, so the
> container is **OOMKilled** on startup and the pod crash-loops (0 available replicas).

Within **~2–3 minutes** the **CheckoutApiDown** alert appears in Daalu → **Alerts**. Open it and
let the agent work: it inspects pods/events, finds the container is being **OOMKilled** because
its memory limit is too low, and proposes the fix — patching the deployment to request more
memory — as an action for you to **Approve**. Approving runs, through the gated executor, the
equivalent of:

```bash
kubectl -n daalu-demo patch deploy checkout-api --type=strategic \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"requests":{"memory":"256Mi"},"limits":{"memory":"512Mi"}}}]}}}}'
```

**Handy during the recording:**

```bash
./demo/status.sh       # app + alert state at any time
./demo/down.sh         # remove the demo app + alert rules (deletes the daalu-demo namespace)
```

> **Skip the manual UI clicks?** `./scripts/onboard-cluster.sh` registers the **same three
> integrations** (the same kubeconfig + Prometheus/Loki URLs) automatically, and also wires the
> GPU tenant that lights up **AI Factory** live metrics. It's the automated equivalent of
> steps 4–5 — use it instead when you don't need to demo the onboarding on camera. See
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

The fully-manual walkthrough above (Section B, steps 4–6) is the recommended demo. If you just
want the lab up fast with **everything auto-wired** (no UI clicks), use the one-command form:

```bash
./demo/up.sh        # monitored kind cluster (Prometheus/Alertmanager/Loki) + a dummy app, auto-onboarded to Daalu
./demo/break.sh     # take the app down on purpose
# → open Daalu → Alerts: watch it investigate and propose a rollback for you to approve
./demo/down.sh      # tear it all down
```

The recording variant — `./demo/up-manual.sh` — is identical except it does **not** auto-register
the integrations or break the app, so you can show the onboarding and trigger the incident live.

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
| `--demo` | `demo/up.sh` (and `demo/up-manual.sh`) | the `daalu-demo` kind cluster + the `kind` network |
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
