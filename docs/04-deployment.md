# Deploying Daalu

Daalu is a self-hosted AI agent for infrastructure and operations. Deployment is
**two parts, and you install Daalu first**:

1. **[Part 1 — Install Daalu](#part-1-install-daalu).** Stand up the agent + UI on
   Docker Compose (a laptop, a VM, or a server). Daalu boots immediately.
2. **[Part 2 — Give it inference (and, optionally, a GPU cluster)](#part-2-inference--gpu).**
   Daalu's "brain" is an OpenAI-compatible LLM endpoint. Point it at one — either a
   **minimal laptop model** for a quick feel, or a **production GPU cluster** that
   Daalu also operates and uses as its inference source.

> **Why Daalu first?** `install.sh` stands up the whole stack and the UI right away
> — you can click around, wire integrations, and watch the services boot before any
> GPU exists. The agent simply can't *reason* until you give it an inference endpoint
> in Part 2. So install Daalu, then attach inference.

| Your situation | Path |
|----------------|------|
| I just want to try Daalu on my laptop | **Part 1** → **[Part 2A](#2a-minimal-laptop-inference-for-a-feel)** (minimal local model) |
| I already have an OpenAI-compatible endpoint (Ollama, vLLM, …) | **Part 1** → **[Part 2C](#2c-point-daalu-at-an-existing-endpoint)** |
| I want a production AI/GPU setup | **Part 1** → **[Part 2B](#2b-production-a-gpu-kubernetes-cluster)** (k8s + GPU + onboarding) |

---

## Part 1: Install Daalu

- [1.1 Prerequisites](#11-prerequisites)
- [1.2 What gets deployed](#12-what-gets-deployed)
- [1.3 Where to install it](#13-where-to-install-it)
- [1.4 Install — Docker Compose](#14-install--docker-compose)
- [1.5 Configuration reference](#15-configuration-reference)
- [1.6 Exposing Daalu to others (authentication)](#16-exposing-daalu-to-others-authentication)
- [1.7 Running Daalu on Kubernetes](#17-running-daalu-on-kubernetes)
- [1.8 Upgrades, backups, troubleshooting](#18-upgrades-backups-troubleshooting)

### 1.1 Prerequisites

To run **Daalu itself** you need:

- **Docker** with the Compose v2 plugin, and ~4 GB free RAM (the simplest path), **or**
- **Python 3.10+**, **PostgreSQL 14+**, and **Redis 6+** if you run it natively.
- *Optional now, required for the agent to reason:* an **OpenAI-compatible inference
  endpoint** — you attach one in [Part 2](#part-2-inference--gpu).
- *Optional:* a **kubeconfig** for a cluster you want the agent to operate (you can
  add this from the UI later — see [Part 2B](#2b-production-a-gpu-kubernetes-cluster)).

### 1.2 What gets deployed

Daalu is a small set of processes that all share one image and one database:

| Service | Command | Role |
|---------|---------|------|
| **api** | `daalu server` | FastAPI HTTP API (UI talks to this), serves `/docs`, `/metrics` |
| **worker** | `daalu worker` | Celery tasks: alert ingest, monitoring polls, briefings |
| **beat** | `daalu beat` | Scheduler that fires the periodic tasks |
| **agents** | `daalu agents` | The event-driven InfraAgent loop (consumes events, proposes) |
| **executor** | `daalu executor` | The **only** process that applies approved changes (own queue) |
| **frontend** | `node server.js` | Next.js Ops UI |
| **postgres** | — | System of record |
| **redis** | — | Event bus + Celery broker |

The `executor` is deliberately a separate process on a dedicated queue — see
[the guardrail model](02-agent-and-guardrails.md). You can run everything on one
host; at scale you'd split `agents`/`worker`/`executor` onto their own nodes.

### 1.3 Where to install it

Pick based on who will use it:

| You want… | Run it on | Auth |
|-----------|-----------|------|
| A personal trial / single operator | your laptop or a workstation | `LOCAL_NO_AUTH=true` (default) |
| A shared instance for your team | a small VM/server on your LAN/VPN | front it with an auth proxy ([1.6](#16-exposing-daalu-to-others-authentication)) |
| Production alongside your workloads | your Kubernetes cluster | auth proxy ([1.6](#16-exposing-daalu-to-others-authentication)) + real Postgres ([1.7](#17-running-daalu-on-kubernetes)) |

> ⚠️ `LOCAL_NO_AUTH=true` disables **all** authentication and runs as one
> built-in operator. It's perfect for a laptop and unsafe on anything another
> person can reach over the network. See [1.6](#16-exposing-daalu-to-others-authentication)
> before exposing Daalu.

### 1.4 Install — Docker Compose

**Clone the repo and run the installer.** `install.sh` is the one-command path —
run it from the repo root.

```bash
git clone <this-repo> daalu && cd daalu
./install.sh
```

`install.sh` checks Docker is present, creates `.env`, **asks for your inference
URL** (you can accept the default now and set it in Part 2), builds images, starts
the stack, waits for the API to be healthy, and seeds the default tenant. Flags:
`--yes` (non-interactive), `--no-seed`.

**Verify the stack is healthy.** All services should be `Up`, the API should answer,
and the UI should load.

```bash
docker compose ps                         # every service should be "Up" (api/worker/…)
curl http://localhost:8000/health         # should return an OK/healthy response
curl -sf http://localhost:8000/docs >/dev/null && echo "API docs reachable"
# then open the UI in a browser:  http://localhost:3000
```

> **Docker port already in use?** If another tool (e.g. VS Code's port forwarding)
> holds `3000`/`8000`/`5432`, either free it or publish Daalu's ports on a specific
> address (e.g. `172.17.0.1:`) in `docker-compose.yml` so they don't collide.

**Manual equivalent**, if you'd rather drive it yourself:

```bash
cp .env.example .env          # then edit .env (set LLM_* in Part 2)
docker compose up --build -d
docker compose exec api daalu seed         # ensure the default tenant
# UI: http://localhost:3000   API: http://localhost:8000/docs
```

Useful commands:

```bash
docker compose logs -f agents     # watch the agent reason
docker compose ps                 # service health
docker compose down               # stop (keeps data)
docker compose down -v            # stop and WIPE the database
```

Daalu is now running. The agent won't reason yet — give it an endpoint in
**[Part 2](#part-2-inference--gpu)**.

### 1.5 Configuration reference

All configuration is environment variables (read from `.env`). Defaults are
fine for local use; the ones you'll touch are marked **★**.

#### Mode & security
| Variable | Default | Meaning |
|----------|---------|---------|
| `ENVIRONMENT` | `development` | `development` enables `/docs`; use `production` when exposed |
| `LOG_LEVEL` | `INFO` | `DEBUG` for verbose logs |
| `LOCAL_NO_AUTH` | `true` | **★** Skip all auth; run as one local operator. See [1.6](#16-exposing-daalu-to-others-authentication) |
| `SECRET_KEY` | `change-me` | **★** Signs personal-access-tokens + encrypts stored secrets. Set a long random value |
| `INGEST_API_KEY` | _(empty)_ | Shared secret for the `X-Daalu-Key` webhook header (`openssl rand -hex 32`) |

#### Datastores
| Variable | Default (compose) | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql+asyncpg://daalu:daalu_password@postgres:5432/daalu_agent` | **★** Async Postgres URL |
| `REDIS_URL` | `redis://redis:6379/0` | Redis for the event bus |
| `CELERY_BROKER_URL` | `redis://redis:6379/0` | Celery broker |
| `CELERY_RESULT_BACKEND` | `redis://redis:6379/1` | Celery results |

#### Inference (see [Part 2](#part-2-inference--gpu))
| Variable | Default | Meaning |
|----------|---------|---------|
| `LLM_BASE_URL` | `http://host.docker.internal:11434/v1` | **★** Your OpenAI-compatible endpoint |
| `LLM_API_KEY` | `ollama` | Any non-empty string for local servers |
| `LLM_MODEL` | `qwen2.5:14b` | **★** Model name as your server advertises it |
| `LLM_MODEL_CLASSIFIER` | `qwen2.5:14b` | Cheaper model for routing/classification |
| `ANTHROPIC_API_KEY` | _(empty)_ | Opt-in public provider (Anthropic). **Data leaves your network** if set |
| `ANTHROPIC_MODEL` | _(empty)_ | Set to an Anthropic model id to enable the tier |

#### Cluster & frontend
| Variable | Default | Meaning |
|----------|---------|---------|
| `KUBECONFIG` | `/home/daalu/.kube/config` | In-container path to the kubeconfig the kubectl tools use (you can instead add a cluster from the UI — [Part 2B](#2b-production-a-gpu-kubernetes-cluster)) |
| `DAILY_BRIEFING_CRON` | `30 6 * * *` | UTC cron for the daily AI infra briefing |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8000` | **★** URL the browser uses to reach the API |

> Additional advanced settings live in `src/daalu_automation/config.py`. The tables
> above are everything a normal install needs.

### 1.6 Exposing Daalu to others (authentication)

This open-source build is **single-operator**: it ships no login screen, user
management, or SSO. `LOCAL_NO_AUTH=true` runs it as one built-in operator. So if
more than one person — or the open internet — can reach it, put authentication **in
front of it**:

1. Keep Daalu bound to localhost / a private network (don't publish 8000/3000 to the world).
2. Put it behind an **authenticating reverse proxy** (e.g. [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) in front of your IdP, or Caddy/nginx basic-auth for a small team).
3. Terminate **TLS** at that proxy — never serve Daalu plaintext over a network.

### 1.7 Running Daalu on Kubernetes

For production, run the same image as Deployments (one per role: api, worker, beat,
agents, executor) against a managed PostgreSQL and Redis, and run migrations as an
init container:

```bash
daalu migrate         # apply Alembic migrations (run once per upgrade)
```

Minimum viable shape: a `Deployment` per role using `image: daalu-agent` with the
role's command; a `Secret` holding `DATABASE_URL`, `SECRET_KEY`, `LLM_*`; a
`Service` + `Ingress` (with TLS) in front of `api` and `frontend`; a kubeconfig (or
in-cluster ServiceAccount RBAC) so the kubectl tools can operate the target cluster;
and `LOCAL_NO_AUTH=false` fronted per [1.6](#16-exposing-daalu-to-others-authentication).

> This is about running **Daalu** in Kubernetes. Running your **GPU model server**
> in Kubernetes is [Part 2B](#2b-production-a-gpu-kubernetes-cluster).

### 1.8 Upgrades, backups, troubleshooting

- **Upgrade:** pull, rebuild, restart, then migrate:
  ```bash
  git pull && docker compose build && docker compose up -d
  docker compose exec api daalu migrate
  ```
  Verify: `docker compose ps` (all `Up`) and `curl http://localhost:8000/health`.
- **Backup:** it's just Postgres — `pg_dump` the `daalu_agent` database. Redis is ephemeral.
- **API won't come up:** `docker compose logs api` — usually a bad `DATABASE_URL` or an unreachable `LLM_BASE_URL`.
- **Agent does nothing:** `docker compose logs -f agents`; confirm events exist and the model name is correct.

---

## Part 2: Inference & GPU

Daalu speaks the OpenAI Chat Completions API, so **any** server that exposes it
works. Pick the route that fits:

- **[2A — Minimal laptop inference](#2a-minimal-laptop-inference-for-a-feel)** for a quick feel (CPU-friendly, no GPU).
- **[2B — A production GPU Kubernetes cluster](#2b-production-a-gpu-kubernetes-cluster)** that Daalu operates *and* uses as its inference source.
- **[2C — Point Daalu at an endpoint you already run](#2c-point-daalu-at-an-existing-endpoint).**

### 2A. Minimal laptop inference (for a feel)

Enough to see the agent reason on your own machine — no GPU required (it'll just be
slow on CPU). Install Ollama and pull a small model:

```bash
curl -fsSL https://ollama.com/install.sh | sh   # Linux/macOS
ollama pull qwen2.5:7b                           # small; CPU-friendly. 14b if you have the RAM/GPU
```

> **Have a GPU?** `./scripts/install-inference.sh` auto-detects it and installs
> the right runtime: an **NVIDIA** GPU is used automatically by stock Ollama
> (CUDA); an **Intel Arc** GPU needs Intel's IPEX-LLM build (stock Ollama can't
> use Intel GPUs and falls back to CPU), which the script sets up; otherwise it
> installs CPU Ollama. It then pulls a right-sized model and prints the `LLM_*`
> lines for your `.env`.

**Verify Ollama is serving:**

```bash
ollama --version
systemctl status ollama                          # Linux: "active (running)"
curl http://localhost:11434/v1/models            # should list the model
```

Then set in Daalu's `.env` and restart (`docker compose up -d`):

```ini
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:7b
LLM_MODEL_CLASSIFIER=qwen2.5:7b
```

> **Daalu runs in Docker, so Ollama must listen on all interfaces** — its default
> `127.0.0.1` bind is unreachable from containers via `host.docker.internal`. Fix:
> ```bash
> sudo mkdir -p /etc/systemd/system/ollama.service.d
> printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' | \
>   sudo tee /etc/systemd/system/ollama.service.d/override.conf
> sudo systemctl daemon-reload && sudo systemctl restart ollama   # after any pull finishes
> ```
> Verify: `sudo ss -ltnp 'sport = :11434'` shows `0.0.0.0:11434`.

CPU inference is **slow** — fine for a first look, not real use. For production, use
[2B](#2b-production-a-gpu-kubernetes-cluster).

> **See it in AI Factory.** Once `LLM_BASE_URL` points at a live endpoint, the
> **AI Factory** page surfaces your local brain even without a GPU cluster: the
> serving model, the endpoint's reachability and latency, and the models it
> advertises on `/v1/models`. Admins also get an **endpoint self-check** and a
> small **benchmark** (a concurrency sweep measuring TTFT / inter-token latency /
> throughput, run by the worker straight against the endpoint — no GPU needed).
> On a laptop this is the AI Factory floor; the NVIDIA hardware metrics
> (utilisation, thermals, DCGM health) only appear on the GPU path ([2B](#2b-production-a-gpu-kubernetes-cluster)).

### 2B. Production: a GPU Kubernetes cluster

The full flow for infra teams: stand up a **GPU Kubernetes cluster** with scripts,
then **onboard it from the Daalu UI** — add the cluster to Managed Infra, register
the GPU's vLLM endpoint in AI Factory as Daalu's inference source, and wire in
telemetry. After this, Daalu both *operates* the cluster and *thinks* on it.

**2B.1 — Prerequisites.** A **Linux machine with an NVIDIA GPU** (Ubuntu 22.04/24.04
preferred), `root`/`sudo`, and outbound internet. No pre-installed GPU driver needed
(the GPU Operator installs it; set `DRIVER=host` to reuse one you have).

**2B.2 — Stand up the cluster (one script).** This installs k3s, the NVIDIA GPU
Operator (driver + container toolkit + device plugin + DCGM GPU-metrics exporter),
and **Prometheus + Loki** for telemetry.

```bash
sudo ./scripts/install-gpu-k3s.sh        # add TELEMETRY=false to skip Prometheus/Loki
```

Verify the node is Ready and the GPU is schedulable:

```bash
sudo cp /etc/rancher/k3s/k3s.yaml $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
kubectl get nodes                                # Ready
kubectl -n gpu-operator get pods                 # Running/Completed
kubectl get nodes -o json | grep nvidia.com/gpu  # allocatable GPU present
```

The script prints the **Prometheus** (`:30090`) and **Loki** (`:30310`) NodePort
URLs — keep them for 2B.4.

**2B.3 — Serve a model on the GPU (one script).** Deploys vLLM serving an open model,
exposing an OpenAI-compatible `/v1` API on a NodePort.

```bash
./scripts/serve-model.sh        # default Qwen2.5-7B-Instruct; MODEL=… SERVED_NAME=… to change
```

Verify it's serving (it prints the exact endpoint):

```bash
kubectl -n daalu rollout status deploy/vllm-model
curl http://<node-ip>:30800/v1/models           # lists the served model
```

**2B.4 — Onboard from the Daalu UI.** With the cluster + model up, finish in the UI:

1. **Managed infra → Clusters & observability** — add the cluster by pasting its
   **kubeconfig** (`$HOME/.kube/config`). Daalu's kubectl tools can now read pods,
   events, and propose changes through the approve-before-execute pipeline.
2. **AI Factory** — onboard the GPU and set the vLLM endpoint
   (`http://<node-ip>:30800/v1`) as Daalu's **inference source**. AI Factory then
   surfaces GPU telemetry, diagnostics, AIPerf benchmarks, and reliability.
3. **Managed infra → Observability** — add the **Prometheus** and **Loki** URLs from
   2B.2 so the agent can query metrics and logs during triage.

> Prefer config files? You can instead set `LLM_BASE_URL`/`LLM_MODEL` in `.env`
> (see [2C](#2c-point-daalu-at-an-existing-endpoint)) and mount the kubeconfig at
> `KUBECONFIG` — but the UI flow above is the recommended path.

**Multi-node?** Add GPU workers by installing the k3s **agent** on each, pointed at
the control node — the GPU Operator extends to new nodes automatically:

```bash
# on the control node: get the join token + IP
sudo cat /var/lib/rancher/k3s/server/node-token
hostname -I | awk '{print $1}'
# on each GPU worker:
curl -sfL https://get.k3s.io | K3S_URL=https://<control-ip>:6443 K3S_TOKEN=<token> sh -
```

### 2C. Point Daalu at an existing endpoint

Already have an OpenAI-compatible server (Ollama, vLLM, a hosted gateway)? Just set
these in `.env` and `docker compose up -d`:

```ini
LLM_BASE_URL=http://<host>:<port>/v1     # or host.docker.internal if same host
LLM_API_KEY=<any-non-empty-for-local-servers>
LLM_MODEL=<the served model name>
LLM_MODEL_CLASSIFIER=<same or a cheaper model>
```

Check the endpoint is live before wiring it up: `curl http://<host>:<port>/v1/models`.
Full detail and the routing logic: [03-llm-and-sovereignty.md](03-llm-and-sovereignty.md).

---

## Wiring real sources

In the UI under **Integrations** and **Managed infra**, add the systems Daalu should
watch and act on:

- **Prometheus / Alertmanager** — Daalu pulls firing alerts and emits events the agent triages. (Or push to `POST /api/v1/events` with the `X-Daalu-Key` header.)
- **AWS / GCP / Azure** — read-only credentials; the agent pulls instance state, logs, and metrics during investigation.
- **Linux / network devices** — SSH or NETCONF credentials; changes flow through the approve-before-execute pipeline.

See [05-tools.md](05-tools.md) for what the agent can do with each.

---

## Try it end-to-end — the demo lab

Want to *see* the whole loop — monitor → detect → investigate → propose → approve →
fix — without wiring up real infrastructure? The [`demo/`](../demo) folder stands up
a throwaway, fully-monitored Kubernetes cluster (a local [kind](https://kind.sigs.k8s.io)
cluster with Prometheus/Alertmanager/Grafana + Loki and two sample apps), hands it to
Daalu, and lets you break things on purpose.

**Prerequisites:** Daalu already running (Part 1), plus `kind`, `kubectl`, `helm` on the host.

```bash
./demo/up.sh          # create the cluster, deploy the apps, onboard it to Managed Infra
./demo/break.sh       # take an app down on purpose (a bad image rollout)
./demo/status.sh      # watch the alert + app state
# → open the UI → Alerts: the DummyAppDown alert appears and the agent triages it.
./demo/down.sh        # tear the whole lab down
```

`up.sh` registers the cluster's **Kubernetes**, **Prometheus**, and **Loki**
integrations automatically (the same Managed-Infra onboarding you'd do by hand for a
real cluster), so within a few minutes of `break.sh` the agent raises an Alert and
reasons about the fix. Full walkthrough, break scenarios, and the networking details
are in [demo/README.md](../demo/README.md).

> **Laptop notes.** First run pulls several images (give it ~10–15 min). Agent
> *reasoning* runs on your inference model — on a CPU-only box with a 14B model it's
> slow (minutes per alert); use a smaller model or a GPU/hosted endpoint for a snappy
> demo. If your API isn't on `localhost:8000` or the monitoring host-ports
> (`9090/9093/3001`) are taken, set `DAALU_API` / `DEMO_BIND_ADDR` — see
> [demo/README.md](../demo/README.md#environment-overrides).
