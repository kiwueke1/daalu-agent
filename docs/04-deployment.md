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
git clone https://github.com/kiwueke1/daalu-agent.git daalu && cd daalu
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
| `SECRET_KEY` | `change-me` | **★** Signs personal-access-tokens + encrypts stored secrets. `install.sh` generates one; the app **refuses to start** with the placeholder when `LOCAL_NO_AUTH=false` or `ENVIRONMENT=production` |
| `BIND_ADDR` | `127.0.0.1` | Host address the compose ports publish on. Loopback by default so a no-auth install isn't network-reachable; set to `0.0.0.0`/a host IP only behind an auth proxy |
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

1. Keep Daalu bound to localhost — the default: compose publishes its ports on `BIND_ADDR=127.0.0.1`. Don't set `BIND_ADDR=0.0.0.0` (or a public IP) until an auth proxy is in front.
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

> **Have a GPU? (or a Mac?)** `./scripts/install-inference.sh` auto-detects the
> platform and installs the right runtime:
> - **macOS (Apple Silicon)** — Ollama uses the **Metal** GPU automatically; the
>   simplest and fastest laptop path, nothing extra to install.
> - **NVIDIA** — used automatically by stock Ollama (CUDA).
> - **Intel Arc** — needs Intel's IPEX-LLM build (stock Ollama can't use Intel
>   GPUs and falls back to CPU); the script sets up the runtime.
> - otherwise — CPU Ollama.
>
> It then pulls a right-sized model and prints the `LLM_*` lines for your `.env`.
> On **Linux** Ollama runs as a systemd service and must bind `0.0.0.0` so the
> containers can reach it; on **macOS** Docker Desktop's `host.docker.internal`
> handles that for you.

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
exposing an OpenAI-compatible `/v1` API on a NodePort (default `30800`).

For an *agent* model two flags matter: **`TOOL_PARSER`** (vLLM then parses tool calls
into OpenAI `tool_calls` — without it the agent never sees a tool call), and the
**`nvidia` RuntimeClass** (auto-detected by the script; on a GPU-Operator cluster a
pod without it boots with *no CUDA driver* — `Failed to infer device type`). Size the
model to the card:

```bash
# 48 GB card (e.g. RTX 6000 Ada) — a fast 30B MoE coder model, FP8, with tool-calling.
# Only ~3.3B params are active per token, so it's quick despite the 30B total.
MODEL=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 SERVED_NAME=qwen3-coder-30b \
  MAX_LEN=32768 MEM_LIMIT=64Gi TOOL_PARSER=qwen3_coder \
  ./scripts/serve-model.sh

# ≤16 GB card — the default open model, no flags needed:
./scripts/serve-model.sh        # Qwen2.5-7B-Instruct
```

Verify it's serving (first boot pulls the weights — ~29 GB for the 30B FP8 model, a
few minutes):

```console
$ kubectl -n daalu rollout status deploy/vllm-model
deployment "vllm-model" successfully rolled out
$ curl -s http://localhost:30800/v1/models | jq -r '.data[].id'   # NodePort answers on the node
qwen3-coder-30b
```

> The `SERVED_NAME` you pick **must** equal Daalu's `LLM_MODEL` (set in 2B.4).

**2B.4 — Onboard the GPU + cluster into Daalu.** The hosted product automates this; on
a **self-hosted single cluster** you wire it once.

> **The easiest path (UI):** once the cluster + Prometheus + Loki are connected under
> **Managed infra** (the wizards there, no CLI), open **AI Factory → Add GPU**. It
> discovers the cluster's GPU, pre-fills the class/model/endpoint, and on confirm stamps
> the tenant-labelled DCGM ServiceMonitor + writes the owner row — steps (a)+(b) below,
> done from the browser. AI Factory's metric cards read through the connected
> `prometheus` integration, so no `PROMETHEUS_BASE_URL`/restart is needed.
>
> **The one-shot path (CLI):** `./scripts/onboard-cluster.sh` performs every step in this
> section (a–e) idempotently and prints your UI URL — run it after the stack, cluster,
> and model are up.
>
> The manual steps below are the by-hand equivalent, kept for transparency and for
> tuning individual pieces (e.g. a different `GPU_CLASS` or model).

The steps below are what make AI Factory show the live GPU view (not the "no GPU"
placeholder) and point the agent's brain at the GPU. Grab your tenant id first — every
command reuses it:

```bash
TENANT_ID=$(docker compose exec -T postgres psql -U daalu -d daalu_agent -tA \
  -c "select id from tenants order by created_at limit 1;")
NODE_IP=$(hostname -I | awk '{print $1}')          # this node's IP — reused below
echo "$TENANT_ID  @  $NODE_IP"        # e.g. 00000000-0000-0000-0000-000000000010  @  10.10.0.173
```

**(a) Scrape the GPU's DCGM metrics, tenant-labelled.** The GPU Operator ships a
dcgm-exporter but *no* ServiceMonitor, and AI Factory's queries are tenant-scoped — so
add a ServiceMonitor that stamps your `tenant` label onto the series. Without this the
factory floor stays dark even though the GPU is healthy:

```bash
kubectl apply -f - <<YAML
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nvidia-dcgm-exporter
  namespace: gpu-operator
  labels: { release: kube-prometheus-stack }
spec:
  selector: { matchLabels: { app: nvidia-dcgm-exporter } }
  endpoints:
    - port: gpu-metrics
      interval: 15s
      relabelings:                       # stamp a constant tenant (+ a display class)
        - { targetLabel: tenant,    replacement: "$TENANT_ID" }
        - { targetLabel: gpu_class, replacement: "ada-48" }
YAML
```

~30 s later the tenant-labelled series are queryable — this is exactly what the UI cards
read. (`-g` stops curl from treating the `{ }` as URL globbing, which would mangle the
query into a Prometheus error.)

```console
$ curl -gs "http://$NODE_IP:30090/api/v1/query?query=DCGM_FI_DEV_GPU_TEMP{tenant=\"$TENANT_ID\"}" \
    | jq -r '.data.result[0].value[1]'
50
```

**(b) Mark the GPU as this tenant's (owner role).** A `gpu_tenants` row is what flips
AI Factory from the placeholder to the live **owner** view:

```bash
docker compose exec -T postgres psql -U daalu -d daalu_agent <<SQL
INSERT INTO gpu_tenants (id, tenant_id, state, namespace, gpu_class, model_classifier,
                         shared, service_url, created_at, updated_at)
VALUES (gen_random_uuid(), '$TENANT_ID', 'active', 'daalu', 'ada-48', 'qwen3-coder-30b',
        false, 'http://host.docker.internal:30800/v1', now(), now())
ON CONFLICT (tenant_id) DO UPDATE
  SET state='active', service_url=EXCLUDED.service_url, updated_at=now();
SQL
```

**(c) Point Daalu at the cluster Prometheus + the GPU model** (`.env`, then recreate the
services so they re-read it):

```ini
PROMETHEUS_BASE_URL=http://host.docker.internal:30090   # cluster Prometheus (2B.2)
LLM_BASE_URL=http://host.docker.internal:30800/v1       # the vLLM endpoint (2B.3)
LLM_API_KEY=novllmkeyneeded
LLM_MODEL=qwen3-coder-30b
LLM_MODEL_CLASSIFIER=qwen3-coder-30b
```

```bash
docker compose up -d --force-recreate api worker agents beat
```

Confirm the containers actually picked up the Prometheus URL. This line is the one most
people miss — copy the **whole** block above, not just the `LLM_*` lines. A blank value
here is exactly what leaves AI Factory dark (`metrics_available=false`) even though the
GPU row from (b) is present:

```console
$ docker compose exec -T api printenv PROMETHEUS_BASE_URL
http://host.docker.internal:30090
```

> `host.docker.internal` resolves from the containers because Compose maps it to the
> host gateway (the bundled `extra_hosts: host-gateway`, needed on Linux). If Daalu
> runs on a **different host** than the cluster, use the node IP in both URLs instead.

**(d) Attach the cluster for kubectl.** In **Managed infra → Kubernetes**, paste a
kubeconfig whose `server:` is the **node IP** (`https://<node-ip>:6443`), *not* the
`https://127.0.0.1:6443` a raw k3s kubeconfig ships with — the loopback address isn't
reachable from inside the api container (you'd get a `NameResolutionError` /
connection failure). The k3s API cert already lists the node IP as a SAN, so generate
the corrected kubeconfig directly and copy its **entire output** into the UI:

```bash
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' \
  | tr ' ' '\n' | grep -vF ':' | head -1)
kubectl config view --raw --minify \
  | sed -E "s#server: https://[^[:space:]]+#server: https://${NODE_IP}:6443#"
```

The agent's kubectl tools can now read pods/events and propose changes through the
approve-before-execute pipeline.

**(e) Give the agent its log + metric query tools (Loki + Prometheus).** Steps (a)–(c)
light up the AI Factory *GPU view*; this wires the **agent's investigation tools** —
`query_loki` (LogQL) and `query_prometheus` (PromQL). These read **per-tenant integration
rows**, *not* the `.env` from (c), so they need to be onboarded separately. 2B.2 already
stood up Loki (`:30310`) and Prometheus (`:30090`) — this is what the "keep them for 2B.4"
note was for. In **Managed infra → Integrations**, add:

- **Loki (logs)** → URL `http://host.docker.internal:30310`
- **Prometheus** → URL `http://host.docker.internal:30090`

Saving runs a live connection test. Or script it against the API — the same
`PUT /integrations/config/<provider>` call the [demo lab](#try-it-end-to-end--the-demo-lab)
uses (`config` fully replaces the row; auth with an admin token, or just use the UI above
which needs none):

```bash
reg() { curl -fsS -X PUT "http://localhost:8000/api/v1/integrations/config/$1" \
  -H "Authorization: Bearer $DAALU_TOKEN" -H 'content-type: application/json' \
  -d "{\"config\": $2}"; }

reg loki       '{"url": "http://host.docker.internal:30310"}'
reg prometheus '{"url": "http://host.docker.internal:30090"}'
```

> Without the `loki` row, `query_loki` returns *"no Loki integration configured for this
> tenant"*. As in (c), if Daalu runs on a **different host** than the cluster, use the
> node IP instead of `host.docker.internal` in both URLs.

**Verify the whole thing.** The AI Factory `/overview` now resolves to the owner view —
`role=owner`, `has_gpu=true`, `metrics_available=true`, `panels=[metrics, events,
alerts, diagnostics, validate]` — so the page shows live utilisation/thermals/VRAM/
health + the AIPerf launcher instead of the local-endpoint placeholder. Open
**Managed infra → Kubernetes → your cluster** and the kubectl console lists the nodes
and namespaces. Break a workload (or run the [demo lab](#try-it-end-to-end--the-demo-lab))
and the agent raises an Alert with an AI root cause + remediation **generated on your
GPU**.

> **Reaching the UI from another machine.** Daalu binds the UI on `:3000` and the API
> on `:8000` on all interfaces of the host. From another machine just ensure the
> network path is open (firewall + routing) to `http://<node-ip>:3000`. If that
> machine is on a different subnet, add a route to the node's network via a host that
> can reach both (and, on that gateway, enable `ip_forward` + a NAT `MASQUERADE` for
> the return path).

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

---

## Part 3 (optional): Network & server management (NV-CM)

Parts 1–2 give you Daalu plus a GPU cluster it operates and thinks on. This part is a
separate **optional add-on**, layered on *after* that. It lights up the **Network &
server** page under Managed Infra, which drives
[**NVIDIA Config Manager**](https://github.com/NVIDIA/nv-config-manager) (NV-CM,
Apache-2.0) — a Nautobot source-of-truth + a render service + Temporal workflows + a
config store — so Daalu can inventory your **physical network switches and bare-metal
servers** and push configuration changes to them through the same
approve-before-execute pipeline it uses for Kubernetes.

> **Who needs this?**
> Only operators with a **real fleet of network devices** (switches/routers over
> SSH / NETCONF — Arista EOS, Juniper Junos, Cisco IOS-XR) **or bare-metal servers**
> (Redfish BMCs) that they want Daalu to manage. If you only run Kubernetes and cloud
> workloads, **skip this** — NV-CM is a heavy stack (Nautobot + Temporal + Postgres +
> an Envoy gateway) and brings nothing to a box with no device inventory. The page
> stays a harmless "turned off" placeholder until you complete the steps below.

NV-CM is its own platform with its own installer; Daalu *integrates* with it. The
simplest topology puts NV-CM in the **same k3s cluster you onboarded in Part 2** and
reaches it **directly from the Compose hub** — no WireGuard tunnel, because the hub and
the cluster share a host (see [the note](#why-no-tunnel-for-a-co-located-cluster)).

**1 — Build the NV-CM images.** Daalu vendors NV-CM's Helm chart
([`components/nv-config-manager/chart/`](../components/nv-config-manager/chart)) but not
its images (NVIDIA publishes those only on its internal registry). NV-CM is Apache-2.0,
so build them from source and push them to a registry your cluster can pull from — run a
tiny local one if you don't have one (`docker run -d -p 5000:5000 registry:2`, reachable
from k3s at `<node-ip>:5000`):

```bash
./scripts/build-nvcm-images.sh                                   # builds the 6 service images
HARBOR=<node-ip>:5000 NVIDIA_SRC=nvcm-local \
  ./components/nv-config-manager/scripts/mirror-images.sh        # + public infra images → registry
```

**2 — Stand up the NV-CM platform with its own installer.** NV-CM's installer does the
heavy lifting for you — it installs the required operators (Envoy Gateway, cert-manager,
CloudNativePG), a local **Keycloak** for OIDC, and the stack itself. Clone the repo and
follow its [install guide](https://github.com/NVIDIA/nv-config-manager) against your k3s
cluster (`make local-up`, or `make kind-up` to try it on a throwaway cluster first). Note
the Keycloak issuer URL and the two OIDC clients it creates (a machine-to-machine client
for the APIs, a UI client for the browser consoles) — Daalu reuses them.

**3 — Run the controller.** Daalu's lifecycle controller is a small HTTP service that
needs `helm` + a kubeconfig for the cluster:

```bash
daalu config-manager-controller --host 0.0.0.0 --port 8083      # KUBECONFIG → your k3s
```

**4 — Point Daalu at it** (`.env` on the hub), then recreate `api`:

```ini
CONFIG_MANAGER_CONTROLLER_URL=http://host.docker.internal:8083
CONFIG_MANAGER_HARBOR_REGISTRY=<node-ip>:5000          # from step 1
CONFIG_MANAGER_USE_DEPLOYER=true
# reuse the Keycloak the installer set up (step 2):
KEYCLOAK_ISSUER_URL=https://<keycloak-host>/realms/<realm>
KEYCLOAK_INTERNAL_ISSUER_URL=http://<keycloak-svc>.<ns>.svc.cluster.local/realms/<realm>
KEYCLOAK_UI_CLIENT_ID=nv-config-manager-ui
KEYCLOAK_UI_CLIENT_SECRET=<from the installer>
# resolve the svc-* hostnames straight to the node (wildcard DNS, no tunnel):
CMTOOLS_BASE_DOMAIN=<node-ip>.nip.io
```

**5 — Open the page.** Go to **Managed Infra → Network & server**. With the controller
reachable the page is now live; pick the components + size and submit. The controller
`helm upgrade --install`s the stack into `cm-<tenant>` (first boot ~5–10 min), then the
service consoles (Nautobot, Config Store, Temporal) appear and the agent can work the
inventory.

### Why no tunnel for a co-located cluster

The tunnel was never about *provisioning* — that's plain kubeconfig + `helm`. It's about
the **data plane**: once the stack is up, Daalu calls NV-CM's service HTTP APIs, which
are in-cluster Kubernetes Services (`svc-config-store…`). A kubeconfig gives you the
Kubernetes API, not a route to arbitrary in-cluster Services, so the *productized* answer
for a **remote** workload cluster is a WireGuard tunnel + edge-proxy. When the hub and
the cluster sit on the **same host**, you don't need it: expose NV-CM's Envoy gateway on
the node and let the `svc-*.<node-ip>.nip.io` hostnames resolve straight to it — Daalu
dials directly, exactly like it reaches Prometheus (`:30090`) and vLLM (`:30800`).

### Next: using it

Once the page is live, see **[07-network-server-management.md](07-network-server-management.md)**
— onboarding devices into the Nautobot source of truth, wiring SSH / NETCONF / Redfish
credentials, and the draft → approve → push flow for device configuration changes.
