# Daalu demo lab

A self-contained local lab that stands up a small, **monitored** Kubernetes
cluster, hands it to Daalu, and lets you **break things on purpose** and watch
Daalu discover the issue and propose the fix.

It deploys, in a throwaway [kind](https://kind.sigs.k8s.io) cluster:

- **kube-prometheus-stack** — Prometheus, Alertmanager, Grafana, kube-state-metrics
- **Loki + Promtail** — log aggregation
- **checkout-api** — a small memory-bound service; grow its working set past its
  memory limit → the container is **OOMKilled** and crash-loops → fires
  **`CheckoutApiCrashLooping`**. This is the **default** scenario, and its fix is a
  **memory increase** (a deployment patch), *not* a rollback.
- **dummy-app** — a trivial nginx app you can take down → fires **`DummyAppDown`**
  (an availability alert from kube-state-metrics)
- **metrics-app** — a tiny app that emits its own Prometheus metrics; flip it into
  error mode → fires **`HighErrorRate`** (a *metrics-based* alert on
  `rate(app_errors_total[2m])`, scraped via a ServiceMonitor)

…and wires Daalu's **Prometheus**, **Loki**, and **Kubernetes** integrations to
it automatically.

The three apps give you different alert shapes to demo: a **resource exhaustion**
(OOMKilled, fixed by adding memory), a hard **down** (fixed by a rollback), and a
softer **degradation (rising error rate)** — so the agent has to reason its way to
the right fix rather than always rolling back.

> This is a demo/learning lab, not production. It runs everything on one machine
> and uses a disposable cluster you can delete at any time.

## Which cluster does it run on?

The scripts pick one of two targets automatically — you normally just run
`./demo/up.sh` and don't think about it:

- **kind mode** (the default on a laptop): creates a throwaway
  [kind](https://kind.sigs.k8s.io) cluster and installs its **own**
  Prometheus/Loki into it. Zero prerequisites — good when you have nothing set
  up. This is what the rest of this README describes.
- **current-cluster mode**: if your `kubectl` already points at a cluster that
  runs the Prometheus operator (e.g. a k3s/GPU node with **kube-prometheus-stack**
  that's **already connected to Daalu**), the demo **reuses it** and installs
  **nothing** extra. It only deploys the demo app + alert rules into a
  `daalu-demo` namespace — no kind cluster, no `helm install`, no Docker-network
  step, no re-registering integrations. Teardown just deletes that namespace.

**How it decides:** auto-detect uses the current cluster when it's reachable
*and* runs the Prometheus operator; otherwise it falls back to kind. Force it
either way:

| `DEMO_USE_CURRENT_CONTEXT` | Behaviour |
|----------------------------|-----------|
| *(unset)* / `auto` | Auto-detect (default). |
| `1` | Force current-cluster mode (use your `kubectl` context as-is). |
| `0` | Force kind mode (always create a throwaway cluster). |

In current-cluster mode the demo's `PrometheusRule`/`ServiceMonitor` are
**relabelled** to match your operator's `ruleSelector` (auto-detected from the
live Prometheus CR; override with `DEMO_RULE_RELEASE=<label>`), so your existing
Prometheus adopts them. Run the scripts in the same shell where `kubectl`
already reaches your cluster.

> **On a box like cp03 (k3s + kube-prometheus-stack + Loki, already connected to
> Daalu):** just run `./demo/up.sh`. It detects your cluster, skips all the
> install/kind/network steps, deploys the demo app, and `./demo/down.sh` removes
> only the `daalu-demo` namespace. The kind-specific prerequisites and
> networking notes below don't apply.

## Prerequisites

- A running **Daalu** (`./install.sh` in the repo root — see
  [../docs/04-deployment.md](../docs/04-deployment.md)).
- **docker**, **curl**, **python3** — these you provide.
- **[kind](https://kind.sigs.k8s.io/docs/user/quick-start/)**, **kubectl**,
  **helm** — `up.sh` **auto-installs** these as official prebuilt binaries into
  `~/.daalu/bin` if they're not already on your `PATH` (no `brew`, no `sudo`).
  Override the location with `DAALU_DEMO_BINDIR`, or set
  `DAALU_DEMO_NO_AUTOINSTALL=1` to require they already be installed.
- Give Docker **~6 GB RAM** — the monitoring stack is the heavy part.

### On macOS (Docker Desktop)

The demo runs **unchanged** on a Mac (Apple Silicon or Intel). `up.sh` reaches
the cluster over the shared `kind` Docker network, which behaves the same under
Docker Desktop's Linux VM as it does on native Linux — so the same
`./demo/up.sh` → `break.sh` → `down.sh` flow applies.

**Run this preflight in order — each must pass before `./demo/up.sh`, or the
demo stalls or the agent can't reason about what it finds:**

```bash
# 1. docker + curl ship with Docker Desktop / macOS; python3 comes with the
#    Xcode Command Line Tools or Homebrew. kind/kubectl/helm are NOT needed
#    up front — up.sh fetches them as prebuilt binaries if missing. (Do NOT
#    `brew install` them on macOS 13: brew compiles them from source — slow,
#    disk-hungry, and it fails on a full disk. The prebuilt binaries up.sh
#    fetches sidestep all of that.)

# 2. Docker Desktop has the RAM: Settings → Resources → Memory ≥ 6 GB (8 is
#    comfier). The monitoring stack is the heavy part — with less, the
#    kube-prometheus-stack pods sit Pending and up.sh stalls.

# 3. Daalu is up and healthy:
curl -fsS http://localhost:8000/health && echo " OK"

# 4. Inference is running AND reachable from inside Daalu's containers.
#    up.sh does NOT check this, but the agent needs it for steps 4–5 below.
#    Laptop/Ollama path — the serve command must bind 0.0.0.0 so containers
#    can reach it:   OLLAMA_HOST=0.0.0.0:11434 ollama serve   # keep this running
#    (GPU/cluster deploys serve inference elsewhere, e.g. vLLM on a NodePort.
#    The check below reads whatever LLM_BASE_URL is set to, so it works for
#    either path — no need to edit the port.)
cd ~/Documents/daalu-agent
docker compose exec -T api sh -lc 'curl -fsS "$LLM_BASE_URL/models"' \
  && echo " inference reachable"

# 5. The demo ports are free (the lab publishes 3001/9090/9093/3100;
#    these don't clash with Daalu's 3000/8000/5432/6379/11434):
for p in 3001 9090 9093 3100; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 \
  && echo "port $p BUSY — free it or set DEMO_BIND_ADDR" || echo "port $p free"; done
```

If step 4 fails, the demo will still come up and the alert will still appear in
Daalu — but the agent's **investigate → propose** step will produce nothing
useful (no inference). Bring your inference endpoint up — laptop: `ollama serve`
(bound to `0.0.0.0`); GPU/cluster: your vLLM service — and re-check before running
the demo. See the inference setup in `scripts/install-inference.sh`.

A couple of Mac specifics worth knowing:

- **No `host.docker.internal` host-mapping needed for the demo.** Docker Desktop
  provides it automatically; it matters for your *inference* endpoint (Ollama on
  the host), not for the demo cluster, which is reached over the `kind` network.
- **Stock bash is fine.** `up.sh` runs under the `/bin/bash` 3.2 that ships with
  macOS — you do **not** need to install a newer bash.

> **Model speed & quality on a laptop:** the investigate→propose steps (4–5
> below) lean on your local model. The `qwen2.5:7b` from
> `scripts/install-inference.sh` is a good size for a snappy demo on Apple
> Silicon; a tiny model will struggle to produce a clean rollback proposal, and
> a 7B in Ollama's "low VRAM mode" (small Macs) will be slower. Keep
> `ollama serve` running the whole time.

## Run it

```bash
./demo/up.sh        # build the lab + connect Daalu (a few minutes the first time)
./demo/break.sh     # introduce an issue
./demo/status.sh    # check app + alert state
./demo/down.sh      # tear it all down
```

> Running against your **existing** cluster (current-cluster mode, see above)?
> The same four commands apply — `up.sh` just deploys the app + rules instead of
> building a lab, and `down.sh` removes only the `daalu-demo` namespace. The
> browser ports and networking notes below are kind-mode only.

Optional browser access (published by the kind cluster):

| | |
|-|-|
| Grafana | http://localhost:3001 (admin / admin) |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |

### Environment overrides

The scripts work out of the box on a clean laptop. These env vars cover the
common exceptions:

| Variable | When to set it |
|----------|----------------|
| `DAALU_API` | Your Daalu API isn't on `http://localhost:8000` — e.g. you published the API on a different host/port. Set it to the API base, e.g. `DAALU_API=http://172.17.0.1:18000`. |
| `DEMO_BIND_ADDR` | The host ports `9090` / `9093` / `3001` are already taken (e.g. a VS Code remote session forwards them on `localhost`). Set `DEMO_BIND_ADDR=172.17.0.1` to publish the monitoring NodePorts on the Docker bridge IP instead — then browse the stack at `http://172.17.0.1:<port>`. |
| `DAALU_DEMO_BINDIR` | Where `up.sh` drops the prebuilt `kind`/`kubectl`/`helm` it fetches when they're missing. Default `~/.daalu/bin`. The other demo scripts add the same dir to `PATH`, so they find what `up.sh` installed. |
| `DAALU_DEMO_NO_AUTOINSTALL` | Set to `1` to disable the prebuilt-binary fetch — `up.sh` then fails fast if `kind`/`kubectl`/`helm` aren't already installed, instead of downloading them. |

```bash
# Example: API remapped + localhost monitoring ports busy (e.g. VS Code remote):
DAALU_API=http://172.17.0.1:18000 DEMO_BIND_ADDR=172.17.0.1 ./demo/up.sh
```

## The demo, step by step

1. **`./demo/up.sh`** — creates the cluster, installs monitoring + Loki, deploys
   `checkout-api` (healthy), connects Daalu, and registers the integrations.
2. **`./demo/break.sh`** — by default runs the **`oom`** scenario: it grows
   `checkout-api`'s working set past its memory limit, so the new pod is
   **OOMKilled** on startup and the deployment crash-loops (0 available replicas).
   This is a resource problem, not a bad rollout — so the right fix is *more
   memory*, not a rollback.
3. **Watch it propagate** (~2–3 minutes total):
   - the `CheckoutApiCrashLooping` alert fires in Alertmanager (rule waits `for: 1m`),
   - Daalu's `prometheus` integration polls Alertmanager and raises an **Alert**,
   - the InfraAgent triages it (you'll see it in **Daalu → Alerts**).
4. **Let Daalu investigate.** Open the alert in Daalu. The agent uses its
   read-only Kubernetes tools (`describe_pod`, `get_pod_events`, `get_pod_logs`)
   to find the cause — the container is **OOMKilled** because its memory limit is
   too low — and **proposes a fix** (a deployment patch that raises the memory
   request/limit) as a **Change Proposal**. Nothing is applied yet.
5. **Approve the fix.** Approve the proposal in the UI. Daalu's executor applies
   the memory increase, `checkout-api`'s pod becomes ready, available replicas
   return to 1, and the alert **resolves**.

That's the whole loop: **monitor → detect → investigate → propose → you approve →
fix**, on infrastructure you can see and poke.

> Model quality matters for steps 4–5: a capable instruction model (≥14B) does a
> much better job investigating and proposing than a tiny one. See
> [../docs/03-llm-and-sovereignty.md](../docs/03-llm-and-sovereignty.md). If you
> want to fix it by hand instead, run the memory patch that `./demo/break.sh`
> prints (`kubectl -n daalu-demo patch deploy checkout-api …`).

### Break scenarios

```bash
./demo/break.sh              # (default) oom — checkout-api OOMKilled → CheckoutApiCrashLooping
./demo/break.sh oom          # same as the default
./demo/break.sh bad-image    # dummy-app: image tag that doesn't exist → ImagePullBackOff
./demo/break.sh crashloop    # dummy-app: container command exits on startup → CrashLoopBackOff
./demo/break.sh errors       # metrics-app: error rate climbs → HighErrorRate (metrics-based)
```

`oom` (the default) drives **checkout-api** out of memory (the
`CheckoutApiCrashLooping` alert); its fix is a **memory increase**, not a rollback.
`bad-image` / `crashloop` take **dummy-app** down (the `DummyAppDown` availability
alert) and `errors` flips **metrics-app** into a failing mode so its
`app_errors_total` rate rises (the `HighErrorRate` **metrics-based** alert) — those
three are fixed by rolling back the last change
(`kubectl -n daalu-demo rollout undo deploy/<app>`). In every case the fix the
agent proposes from the root cause is what you approve in Daalu.

## How it's wired (networking)

The one non-obvious bit. Daalu runs in Docker Compose; the lab runs in kind
(also Docker). For Daalu to reach the cluster, `up.sh` connects Daalu's
containers to the **`kind` Docker network**. That lets Daalu:

- talk to the Kubernetes API using kind's **internal kubeconfig** (its server is
  the node's container name, so TLS verifies cleanly), and
- reach Prometheus/Alertmanager/Loki by the node's container name on their
  **NodePorts** (e.g. `http://daalu-demo-control-plane:30903`).

The `localhost:9090/9093/3001` ports are separate, published by kind for **your**
browser; Daalu doesn't use them.

## Troubleshooting

- **`up.sh` says Daalu isn't reachable** — start Daalu first (`./install.sh`),
  confirm `curl localhost:8000/health` works, then re-run. If you published the
  API on a different host/port, set `DAALU_API` (see *Environment overrides*).
- **`failed to create cluster: … host port … already in use`** — something else
  holds `9090`/`9093`/`3001` (often a VS Code remote forwarding them). Re-run
  with `DEMO_BIND_ADDR=172.17.0.1 ./demo/up.sh` (see *Environment overrides*).
- **`kind … config.lock: permission denied`** — your `~/.kube` is root-owned
  (e.g. a kubeconfig copied with `sudo` earlier). Fix:
  `sudo chown -R "$USER":"$USER" ~/.kube`, then re-run.
- **No alert in Daalu after a few minutes** — check it's firing upstream first:
  `./demo/status.sh` (or open http://localhost:9093). If it's firing there but not
  in Daalu, confirm the `prometheus` integration exists (UI → Integrations) and
  that Daalu's containers are on the kind network (`docker network inspect kind`).
- **Alert is firing in Alertmanager but never appears in Daalu** — first give it
  a full cycle: Daalu polls Alertmanager every ~2 min. If after ~4 min
  `./demo/status.sh` shows it firing upstream but Daalu → Alerts is still empty,
  nudge the event consumer: `docker compose restart agents`, then wait one more
  poll. (The agent then drains any pending alert events.)
- **Agent reasoning is very slow** — on a CPU-only laptop a 14B model triages at
  roughly a token/second, so the agent's investigate→propose step can take
  *many minutes* per alert. That's expected; for a snappy demo point Daalu at a
  smaller local model (e.g. `qwen2.5:7b`) or a GPU/hosted endpoint
  (see [../docs/03-llm-and-sovereignty.md](../docs/03-llm-and-sovereignty.md)).
- **Agent can't act on the cluster** — verify the `kubernetes` integration is
  registered and that the connect step found your containers
  (`cd <repo> && docker compose ps`).
- **Re-register integrations** — just re-run `./demo/up.sh`; it's idempotent.
- **Reset the app to healthy** — `./demo/down.sh && ./demo/up.sh` always works; for
  a rollout-based scenario you can instead `kubectl -n daalu-demo rollout undo deploy/<app>`.

### macOS (Docker Desktop)

- **`up.sh` hangs at "Installing kube-prometheus-stack" / pods stuck `Pending`** —
  Docker Desktop is starved for memory. Raise it to ≥ 6 GB
  (**Settings → Resources → Memory**), then `./demo/down.sh && ./demo/up.sh`.
  Check with `kubectl -n monitoring get pods` — `Pending` with
  `Insufficient memory` events confirms it.
- **`command not found: kind` (or `helm`/`kubectl`)** — `up.sh` normally fetches
  these prebuilt into `~/.daalu/bin`. You'll only see this if you set
  `DAALU_DEMO_NO_AUTOINSTALL=1` (then install them yourself — prefer the official
  prebuilt binaries over `brew install`, which compiles from source on macOS 13)
  or if `~/.daalu/bin` isn't on `PATH` in a shell where you run `kubectl` by
  hand (`export PATH="$PATH:$HOME/.daalu/bin"`).
- **Alert reaches Daalu but the agent never proposes a fix** — the inference
  endpoint isn't reachable from the containers. Verify (this reads your configured
  `LLM_BASE_URL`, so it works for both the Ollama and vLLM paths):
  `docker compose exec -T api sh -lc 'curl -fsS "$LLM_BASE_URL/models"'`.
  This is preflight step 4 above — `up.sh` doesn't check it for you.
- **`./demo/up.sh: line …: mapfile: command not found`** — you're on an old copy
  predating the macOS fix; `git pull` to get a version that runs under the stock
  `/bin/bash` (3.2).

## Cleanup

```bash
./demo/down.sh
```

- **kind mode:** deletes the kind cluster (and the kind network). Daalu keeps
  running; its integration rows remain but point at the now-deleted cluster
  until you re-run `up.sh` or remove them in the UI.
- **current-cluster mode:** deletes only the `daalu-demo` namespace (the demo app
  and the alert rules added to it). Your monitoring, logging, and Daalu
  integrations are left untouched.
