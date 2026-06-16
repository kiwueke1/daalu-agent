# Deploying Daalu

This guide is in **two parts**, because there are two separate things you might
deploy:

- **[Part A — Install Daalu](#part-a-install-daalu).** Get the Daalu agent itself
  running (API, workers, UI, database). This uses the
  OpenAI-compatible inference endpoint which we set up in part B or you already have an OpenAI-compatible endpoint you already run, you can use that too.
- **[Part B — Deploy your own GPU inference server](#part-b-deploy-your-own-gpu-inference-server).**
  Stand up *sovereign* inference on your own NVIDIA hardware (single-node or a
  multi-node cluster), so prompts never leave your network. Do this if you don't
  already have a model server.

**Which parts do you need?**

| Your situation | Do this |
|----------------|---------|
| I already have an OpenAI-compatible endpoint (Ollama, vLLM, …) | **Part A only** |
| I have a machine/rack with NVIDIA GPU(s) but no model server | **Part B, then Part A** |
| I just want to try it on my laptop with a local model | **Part B → [B3](#b3-laptop-or-single-vm-no-kubernetes--simplest)** (laptop, no k8s), then **Part A** |

Each part has **its own prerequisites** — see [A1](#a1-prerequisites-for-daalu)
and [B1](#b1-prerequisites-for-the-gpu-server).

---

## Part A: Install Daalu

- [A1. Prerequisites (for Daalu)](#a1-prerequisites-for-daalu)
- [A2. What gets deployed](#a2-what-gets-deployed)
- [A3. Where to install it](#a3-where-to-install-it)
- [A4. Install — Docker Compose](#a4-install--docker-compose)
- [A5. Configuration reference (every variable)](#a5-configuration-reference-every-variable)
- [A6. Pointing Daalu at your inference](#a6-pointing-daalu-at-your-inference)
- [A7. Giving the agent a cluster to operate](#a7-giving-the-agent-a-cluster-to-operate)
- [A8. Wiring real sources](#a8-wiring-real-sources)
- [A9. Exposing Daalu to others (authentication)](#a9-exposing-daalu-to-others-authentication)
- [A10. Running Daalu on Kubernetes](#a10-running-daalu-on-kubernetes)
- [A11. Upgrades, backups, troubleshooting](#a11-upgrades-backups-troubleshooting)

### A1. Prerequisites (for Daalu)

To run **Daalu itself** you need:

- **Docker** with the Compose v2 plugin, and ~4 GB free RAM (the simplest path), **or**
- **Python 3.10+**, **PostgreSQL 14+**, and **Redis 6+** if you run it natively.
- **An OpenAI-compatible inference endpoint.** Don't have one? Either run a local
  [Ollama](https://ollama.com), or stand up your own GPU server in
  [Part B](#part-b-deploy-your-own-gpu-inference-server).
- *Optional:* a **kubeconfig** for the cluster you want the agent to operate (can
  be the same cluster from Part B).

> This is the prerequisite list for **Part A only**. Standing up your own GPU
> inference server has a separate list — see [B1](#b1-prerequisites-for-the-gpu-server).

### A2. What gets deployed

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

### A3. Where to install it

Pick based on who will use it:

| You want… | Run it on | Auth |
|-----------|-----------|------|
| A personal trial / single operator | your laptop or a workstation | `LOCAL_NO_AUTH=true` (default) |
| A shared instance for your team | a small VM/server reachable on your LAN/VPN | front it with an auth proxy ([A9](#a9-exposing-daalu-to-others-authentication)) |
| Production alongside your workloads | your Kubernetes cluster | auth proxy ([A9](#a9-exposing-daalu-to-others-authentication)) + real Postgres ([A10](#a10-running-daalu-on-kubernetes)) |

> ⚠️ `LOCAL_NO_AUTH=true` disables **all** authentication and runs as one
> built-in operator. It's perfect for a laptop and unsafe on anything another
> person can reach over the network. See [A9](#a9-exposing-daalu-to-others-authentication)
> before exposing Daalu.

### A4. Install — Docker Compose

```bash
git clone <this-repo> daalu && cd daalu
./install.sh
```

`install.sh` checks prerequisites, creates `.env`, asks for your inference URL,
builds images, starts the stack, waits for health, and seeds demo data. Flags:
`--yes` (non-interactive), `--no-seed`.

**Manual equivalent**, if you'd rather drive it yourself:

```bash
cp .env.example .env          # then edit .env (at least LLM_BASE_URL / LLM_MODEL)
docker compose up --build -d
docker compose exec api daalu seed         # ensure the default tenant
docker compose exec api daalu seed-demo    # optional synthetic events
# UI: http://localhost:3000   API: http://localhost:8000/docs
```

Useful commands:

```bash
docker compose logs -f agents     # watch the agent reason
docker compose ps                 # service health
docker compose down               # stop (keeps data)
docker compose down -v            # stop and WIPE the database
docker compose --profile ollama up -d   # also run a bundled CPU Ollama
```

### A5. Configuration reference (every variable)

All configuration is environment variables (read from `.env`). Defaults are
fine for local use; the ones you'll touch are marked **★**.

#### Mode & security
| Variable | Default | Meaning |
|----------|---------|---------|
| `ENVIRONMENT` | `development` | `development` enables `/docs`; use `production` when exposed |
| `LOG_LEVEL` | `INFO` | `DEBUG` for verbose logs |
| `LOCAL_NO_AUTH` | `true` | **★** Skip all auth; run as one local operator. See [A9](#a9-exposing-daalu-to-others-authentication) |
| `SECRET_KEY` | `change-me` | **★** Signs personal-access-tokens. Set a long random value if you mint any |
| `INGEST_API_KEY` | _(empty)_ | Shared secret for the `X-Daalu-Key` webhook header (`openssl rand -hex 32`) |

#### Datastores
| Variable | Default (compose) | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql+asyncpg://daalu:daalu_password@postgres:5432/daalu_agent` | **★** Async Postgres URL |
| `REDIS_URL` | `redis://redis:6379/0` | Redis for the event bus |
| `CELERY_BROKER_URL` | `redis://redis:6379/0` | Celery broker |
| `CELERY_RESULT_BACKEND` | `redis://redis:6379/1` | Celery results |

#### Inference (see [A6](#a6-pointing-daalu-at-your-inference))
| Variable | Default | Meaning |
|----------|---------|---------|
| `LLM_BASE_URL` | `http://host.docker.internal:11434/v1` | **★** Your OpenAI-compatible endpoint |
| `LLM_API_KEY` | `ollama` | Any non-empty string for local servers |
| `LLM_MODEL` | `qwen2.5:14b` | **★** Model name as your server advertises it |
| `LLM_MODEL_CLASSIFIER` | `qwen2.5:14b` | Cheaper model for routing/classification |
| `ANTHROPIC_API_KEY` | _(empty)_ | Opt-in public provider (Anthropic). **Data leaves your network** if set |
| `ANTHROPIC_MODEL` | _(empty)_ | Set to an Anthropic model id to enable the tier |

#### Cluster & schedules
| Variable | Default | Meaning |
|----------|---------|---------|
| `KUBECONFIG` | `/home/daalu/.kube/config` | Path (in-container) to the kubeconfig the kubectl tools use — see [A7](#a7-giving-the-agent-a-cluster-to-operate) |
| `DAILY_BRIEFING_CRON` | `30 6 * * *` | UTC cron for the daily AI infra briefing |

#### Frontend
| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8000` | **★** URL the browser uses to reach the API |

> There are additional advanced settings in `src/daalu_automation/config.py`
> (executor cadence, cloud price tracking, object storage). The table above is
> everything a normal install needs.

### A6. Pointing Daalu at your inference

Daalu speaks the OpenAI Chat Completions API, so anything that exposes it works.

- **Ollama on the same host:** `LLM_BASE_URL=http://host.docker.internal:11434/v1`,
  `LLM_API_KEY=ollama`, `LLM_MODEL=<a model you've pulled>` (e.g. `ollama pull qwen2.5:14b`).
- **A vLLM server on your network:** `LLM_BASE_URL=http://<host>:<port>/v1`,
  `LLM_MODEL=<the --served-model-name>`. This is what [Part B](#part-b-deploy-your-own-gpu-inference-server)
  gives you.
- **Anthropic (public, not sovereign):** set `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`.
  Leave them empty to guarantee nothing leaves your network.

Full detail and the routing logic: [03-llm-and-sovereignty.md](03-llm-and-sovereignty.md).

### A7. Giving the agent a cluster to operate

The Kubernetes tools use the kubeconfig at `KUBECONFIG`. With Docker Compose your
`~/.kube` is mounted read-only into the `api`, `worker`, `agents`, and `executor`
containers. Make sure the cluster API server is reachable **from inside the
containers** (a `127.0.0.1` server address in your kubeconfig won't be — use the
LAN IP or run with host networking).

This is the cluster the agent *operates* (reads pods, proposes changes). It can be
the same cluster you build in [Part B](#part-b-deploy-your-own-gpu-inference-server),
or a completely separate one — they're independent.

### A8. Wiring real sources

In the UI under **Integrations**, add the systems Daalu should watch and act on:

- **Prometheus / Alertmanager** — Daalu pulls firing alerts and emits events the
  agent triages. (Or push to `POST /api/v1/events` with the `X-Daalu-Key` header.)
- **AWS / GCP / Azure** — read-only credentials; the agent can pull instance
  state, logs, and metrics during investigation.
- **Linux / network devices** — SSH or NETCONF credentials; changes flow through
  the approve-before-execute pipeline.

See [05-tools.md](05-tools.md) for what the agent can do with each.

### A9. Exposing Daalu to others (authentication)

This open-source build is **single-operator**: it ships no login screen, user
management, or SSO (those live in the commercial hub). `LOCAL_NO_AUTH=true` runs
it as one built-in operator. So if more than one person — or the open internet —
can reach it, put authentication **in front of it**:

1. Keep Daalu bound to localhost / a private network (don't publish port 8000/3000
   directly).
2. Put it behind an **authenticating reverse proxy** that handles login and only
   forwards authenticated requests — e.g. [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/)
   in front of your IdP, or even Caddy/nginx basic-auth for a small team.
3. Terminate **TLS** at that proxy — never serve Daalu plaintext over a network.

In other words: Daalu trusts whoever can reach it, so control who can reach it.

> Built-in multi-user login, SSO/OIDC, RBAC, and multi-tenancy are intentionally
> not part of this repo — they're the commercial hub.

### A10. Running Daalu on Kubernetes

For production, run the same image as Deployments (one per role: api, worker,
beat, agents, executor) against a managed PostgreSQL and Redis, and run database
migrations as an init container:

```bash
daalu migrate         # apply Alembic migrations (run once per upgrade)
```

Minimum viable shape:

- A `Deployment` per role using `image: daalu-agent` with the role's command.
- A `Secret` holding `DATABASE_URL`, `SECRET_KEY`, `LLM_*`, etc.
- A `Service` + `Ingress` (with TLS) in front of the `api` and `frontend`.
- A `ConfigMap`/`projected` kubeconfig (or in-cluster ServiceAccount RBAC) so the
  kubectl tools can operate the target cluster.
- `LOCAL_NO_AUTH=false` and auth fronted per [A9](#a9-exposing-daalu-to-others-authentication).

Helm/manifests are not bundled in this open-source repo; the Compose file is the
canonical reference for the process topology and env wiring.

> Note: this is about running **Daalu** in Kubernetes. Running your **model
> server** in Kubernetes is a different thing — that's [Part B](#part-b-deploy-your-own-gpu-inference-server).

### A11. Upgrades, backups, troubleshooting

- **Upgrade:** `git pull && docker compose build && docker compose up -d`, then
  `docker compose exec api daalu migrate`.
- **Backup:** it's just Postgres — `pg_dump` the `daalu_agent` database. Redis is
  ephemeral (event bus only).
- **API won't come up:** `docker compose logs api` — most commonly a bad
  `DATABASE_URL` or an unreachable `LLM_BASE_URL`.
- **Agent does nothing:** check `docker compose logs -f agents`; confirm events
  exist (seed with `daalu seed-demo`) and your model name is correct.
- **kubectl tools error:** verify the kubeconfig path/reachability from inside the
  container ([A7](#a7-giving-the-agent-a-cluster-to-operate)).

---

## Part B: Deploy your own GPU inference server

This part is optional and independent of Part A. It stands up a **sovereign**
inference server — an open-weights model running on *your* hardware, exposed over
an OpenAI-compatible API — so no prompt or code ever leaves your network. Skip it
if you already have an endpoint.

It covers **two routes**, and [B2](#b2-which-approach-laptop-or-cluster) helps you
pick: a no-Kubernetes path for a single machine (your laptop, a VM, or one
workstation), and a k3s path for a real cluster (a dedicated GPU box, or several).

- [B1. Prerequisites (for the GPU server)](#b1-prerequisites-for-the-gpu-server)
- [B2. Which approach: laptop or cluster?](#b2-which-approach-laptop-or-cluster)
- [B3. Laptop or single VM (no Kubernetes — simplest)](#b3-laptop-or-single-vm-no-kubernetes--simplest)
- [B4. Single-node k3s (one GPU box or VM)](#b4-single-node-k3s-one-gpu-box-or-vm)
- [B5. Multi-node k3s (a control node + GPU workers)](#b5-multi-node-k3s-a-control-node--gpu-workers)
- [B6. Deploy a model on the cluster](#b6-deploy-a-model-on-the-cluster)
- [B7. Point Daalu at it](#b7-point-daalu-at-it)

### B1. Prerequisites (for the GPU server)

These are separate from Part A's prerequisites, and the exact list depends on the
route you pick in [B2](#b2-which-approach-laptop-or-cluster).

**Any route:**
- **A Linux machine** — Ubuntu 22.04 / 24.04 preferred. This can be your **laptop**,
  a **VM**, a **workstation**, or a **server**.
- **An NVIDIA GPU is strongly recommended.** ~16 GB VRAM comfortably runs a 7–8B
  model; more VRAM → bigger models. (Ollama can run CPU-only, but it's slow — fine
  for a quick look, not for real use.)
- **root / sudo** and **outbound internet** (to pull images + model weights).

**Laptop / single-VM route (B3) also needs:** either nothing beyond Ollama's
installer, or **Docker** + the **NVIDIA Container Toolkit** for the Docker-vLLM
option.

**k3s cluster route (B4/B5) also needs:** `helm` and `kubectl` (the script installs
them if missing); **no pre-installed GPU driver** (the GPU Operator installs it, or
set `DRIVER=host` to reuse one you have); and for **multi-node**, the machines must
reach each other on the network (k3s uses TCP 6443 for the API server and a flannel
VXLAN port — same LAN/VPC is simplest).

### B2. Which approach: laptop or cluster?

| You have… | Use | Why |
|-----------|-----|-----|
| A **laptop** or a single machine you just want to try Daalu on | **No Kubernetes** — Ollama or Docker vLLM ([B3](#b3-laptop-or-single-vm-no-kubernetes--simplest)) | Simplest; one binary/container, no cluster to run |
| A **dedicated GPU box or VM** you'll run as a server | **Single-node k3s** ([B4](#b4-single-node-k3s-one-gpu-box-or-vm)) | A real cluster you can grow; the agent can also operate it |
| **Several GPU machines**, or you want to scale capacity | **Multi-node k3s** ([B5](#b5-multi-node-k3s-a-control-node--gpu-workers)) | Add GPUs by joining nodes; the scheduler spreads models across them |

**Is Kubernetes the best way to do this on a laptop? No.** On a single dev machine,
k3s adds a cluster to babysit for zero benefit — run **Ollama** (or **vLLM in
Docker**) and you get the exact same OpenAI-compatible endpoint with none of the
overhead. Reach for k3s ([k3s](https://k3s.io) — a single ~70 MB binary, one
command, conformant Kubernetes) only when you want a **durable, scalable cluster**
or **more than one GPU node**. That's why both paths exist below.

### B3. Laptop or single VM (no Kubernetes — simplest)

You can do everything on one machine — even just your Ubuntu laptop — and end up
with a working sovereign endpoint for Daalu. Pick one option.

**Option 1 — Ollama (easiest).**

```bash
curl -fsSL https://ollama.com/install.sh | sh   # Linux/macOS
ollama pull qwen2.5:14b                          # smaller box? try qwen2.5:7b
# Ollama now serves an OpenAI-compatible API at http://localhost:11434/v1 and
# automatically uses your NVIDIA GPU if present (CPU otherwise — slower).
```

Then set in Daalu's `.env`:

```ini
# If Daalu runs via docker compose, use host.docker.internal; if you run Daalu
# natively on the same machine, use localhost.
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:14b
LLM_MODEL_CLASSIFIER=qwen2.5:14b
```

**Option 2 — vLLM in Docker (NVIDIA GPU, OpenAI-compatible).** Higher throughput
than Ollama; needs the NVIDIA Container Toolkit on the host.

```bash
docker run --gpus all -p 8000:8000 vllm/vllm-openai:latest \
  --model Qwen/Qwen2.5-7B-Instruct --served-model-name qwen2.5-7b
```

```ini
LLM_BASE_URL=http://host.docker.internal:8000/v1
LLM_API_KEY=novllmkeyneeded
LLM_MODEL=qwen2.5-7b
LLM_MODEL_CLASSIFIER=qwen2.5-7b
```

That's the whole inference setup for a single machine — **continue with
[Part A](#part-a-install-daalu)** and skip B4–B7 (those are the cluster routes).

### B4. Single-node k3s (one GPU box or VM)

Use this for a dedicated GPU box or VM you want to run as a real (single-node)
cluster — one machine that is both the control plane and the GPU worker:

```bash
# Installs k3s + the NVIDIA GPU Operator (which installs the GPU driver, container
# toolkit, and device plugin). DRIVER=operator (default) needs no host driver;
# DRIVER=host reuses a driver you already installed.
sudo ./scripts/install-gpu-k3s.sh

# Use the cluster as your user:
sudo cp /etc/rancher/k3s/k3s.yaml $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
kubectl get nodes
```

Then jump to [B6](#b6-deploy-a-model-on-the-cluster) to serve a model.

### B5. Multi-node k3s (a control node + GPU workers)

Use this when you have several machines — e.g. one control node plus a few GPU
boxes, or several GPU boxes for capacity. k3s makes the joins one command each.

**Step 1 — Create the cluster on the first node.** Run the same script on the node
you want as the control plane. It can itself have a GPU or not (if it's CPU-only,
the script's GPU check just warns — that's fine; the GPU Operator still rolls out
to the worker nodes you add next).

```bash
sudo ./scripts/install-gpu-k3s.sh        # installs k3s server + GPU Operator
```

**Step 2 — Get the join token + the server URL** (run on the control node):

```bash
sudo cat /var/lib/rancher/k3s/server/node-token     # the join token
hostname -I | awk '{print $1}'                       # the control node's IP
```

**Step 3 — Join each GPU worker node.** On every GPU machine, install the k3s
**agent** pointed at the control node:

```bash
curl -sfL https://get.k3s.io | \
  K3S_URL=https://<control-node-ip>:6443 \
  K3S_TOKEN=<token-from-step-2> sh -
```

That's the whole join. The GPU Operator installed in step 1 runs as DaemonSets, so
it automatically extends to each new node — installing the driver, container
toolkit, and device plugin there — and the node's GPUs become schedulable. No
extra GPU setup per worker.

**Step 4 — Verify** (from the control node):

```bash
kubectl get nodes                                            # all nodes Ready
kubectl get nodes -o custom-columns=NAME:.metadata.name,GPUs:.status.allocatable.'nvidia\.com/gpu'
```

You should see the GPU count populated on each GPU worker. Now serve a model — the
scheduler places it on a node that has a free GPU.

> **Driver mode on workers:** the operator manages drivers cluster-wide based on
> how you installed it in step 1. If you used `DRIVER=host` there, install the
> NVIDIA driver on each worker yourself too; with the default `DRIVER=operator`,
> workers need nothing but the GPU hardware.

### B6. Deploy a model on the cluster

This is the **k3s** model-deploy step (for B4 / B5). It works the same for
single-node and multi-node — Kubernetes schedules the model onto a node with a
free GPU:

```bash
./scripts/serve-model.sh
```

This deploys [vLLM](https://docs.vllm.ai) serving an **open** model
(`Qwen/Qwen2.5-7B-Instruct` by default — no Hugging Face token needed) and exposes
an OpenAI-compatible `/v1` endpoint on a NodePort. When it finishes it prints the
exact `LLM_BASE_URL` / `LLM_MODEL` to use.

Tuning (all optional env vars):

| Want | Set |
|------|-----|
| A bigger / smaller model | `MODEL=Qwen/Qwen2.5-14B-Instruct SERVED_NAME=qwen2.5-14b ./scripts/serve-model.sh` |
| A gated model (e.g. Llama) | `HF_TOKEN=hf_xxx MODEL=meta-llama/Llama-3.1-8B-Instruct ./scripts/serve-model.sh` |
| Less VRAM use | lower `MAX_LEN` (e.g. `MAX_LEN=4096`) or pick a quantized model |
| Just print the manifest | `PRINT_ONLY=1 ./scripts/serve-model.sh` (capture for `kubectl apply`) |

Scaling notes:
- **One model per GPU** is the simplest mental model — a vLLM pod takes a whole
  GPU. To serve more than one model, run `serve-model.sh` again with a different
  `SERVED_NAME`/`NODEPORT`; the scheduler spreads them across GPU nodes.
- The **NodePort is reachable on any node's IP** (`http://<any-node-ip>:30800/v1`),
  so it doesn't matter which worker the model landed on.

### B7. Point Daalu at it

(For the laptop route, the `.env` lines are in [B3](#b3-laptop-or-single-vm-no-kubernetes--simplest) instead.)

For the k3s routes, `serve-model.sh` prints the lines to drop into Daalu's `.env`:

```ini
LLM_BASE_URL=http://<node-ip>:30800/v1     # or host.docker.internal if same host
LLM_API_KEY=novllmkeyneeded
LLM_MODEL=qwen2.5-7b
LLM_MODEL_CLASSIFIER=qwen2.5-7b
```

Then do (or re-run) [Part A](#part-a-install-daalu). Quick check that the endpoint
is live before you wire it up:

```bash
curl http://<node-ip>:30800/v1/models
```
