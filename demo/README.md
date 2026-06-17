# Daalu demo lab

A self-contained local lab that stands up a small, **monitored** Kubernetes
cluster, hands it to Daalu, and lets you **break things on purpose** and watch
Daalu discover the issue and propose the fix.

It deploys, in a throwaway [kind](https://kind.sigs.k8s.io) cluster:

- **kube-prometheus-stack** — Prometheus, Alertmanager, Grafana, kube-state-metrics
- **Loki + Promtail** — log aggregation
- **dummy-app** — a trivial nginx app you can take down → fires **`DummyAppDown`**
  (an availability alert from kube-state-metrics)
- **metrics-app** — a tiny app that emits its own Prometheus metrics; flip it into
  error mode → fires **`HighErrorRate`** (a *metrics-based* alert on
  `rate(app_errors_total[2m])`, scraped via a ServiceMonitor)

…and wires Daalu's **Prometheus**, **Loki**, and **Kubernetes** integrations to
it automatically.

The two apps give you two different alert shapes to demo: a hard **down/rollback**
and a softer **degradation (rising error rate)** — both resolved the same way, by
rolling back the bad change.

> This is a demo/learning lab, not production. It runs everything on one machine
> and uses a disposable cluster you can delete at any time.

## Prerequisites

- A running **Daalu** (`./install.sh` in the repo root — see
  [../docs/04-deployment.md](../docs/04-deployment.md)).
- **docker**, **[kind](https://kind.sigs.k8s.io/docs/user/quick-start/)**,
  **kubectl**, **helm**, **curl**, **python3**.
- Give Docker **~6 GB RAM** — the monitoring stack is the heavy part.

## Run it

```bash
./demo/up.sh        # build the lab + connect Daalu (a few minutes the first time)
./demo/break.sh     # introduce an issue
./demo/status.sh    # check app + alert state
./demo/down.sh      # tear it all down
```

Optional browser access (published by the kind cluster):

| | |
|-|-|
| Grafana | http://localhost:3001 (admin / admin) |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |

### Environment overrides

The scripts work out of the box on a clean laptop. Two env vars cover the
common exceptions:

| Variable | When to set it |
|----------|----------------|
| `DAALU_API` | Your Daalu API isn't on `http://localhost:8000` — e.g. you published the API on a different host/port. Set it to the API base, e.g. `DAALU_API=http://172.17.0.1:18000`. |
| `DEMO_BIND_ADDR` | The host ports `9090` / `9093` / `3001` are already taken (e.g. a VS Code remote session forwards them on `localhost`). Set `DEMO_BIND_ADDR=172.17.0.1` to publish the monitoring NodePorts on the Docker bridge IP instead — then browse the stack at `http://172.17.0.1:<port>`. |

```bash
# Example: API remapped + localhost monitoring ports busy (e.g. VS Code remote):
DAALU_API=http://172.17.0.1:18000 DEMO_BIND_ADDR=172.17.0.1 ./demo/up.sh
```

## The demo, step by step

1. **`./demo/up.sh`** — creates the cluster, installs monitoring + Loki, deploys
   `dummy-app` (healthy), connects Daalu, and registers the integrations.
2. **`./demo/break.sh`** — pushes a bad rollout to `dummy-app` (by default, a
   container image tag that doesn't exist). Because the Deployment uses
   `strategy: Recreate`, the running pod is torn down and the app goes **down**.
3. **Watch it propagate** (~2–3 minutes total):
   - the `DummyAppDown` alert fires in Alertmanager (rule waits `for: 1m`),
   - Daalu's `prometheus` integration polls Alertmanager and raises an **Alert**,
   - the InfraAgent triages it (you'll see it in **Daalu → Alerts**).
4. **Let Daalu investigate.** Open the alert in Daalu. The agent uses its
   read-only Kubernetes tools (`describe_pod`, `get_pod_events`, `get_pod_logs`)
   to find the cause — a failed rollout — and **proposes a fix** (a rollback) as a
   **Change Proposal**. Nothing is applied yet.
5. **Approve the fix.** Approve the proposal in the UI. Daalu's executor runs the
   rollback, `dummy-app` comes back up, available replicas return to 1, and the
   alert **resolves**.

That's the whole loop: **monitor → detect → investigate → propose → you approve →
fix**, on infrastructure you can see and poke.

> Model quality matters for steps 4–5: a capable instruction model (≥14B) does a
> much better job investigating and proposing than a tiny one. See
> [../docs/03-llm-and-sovereignty.md](../docs/03-llm-and-sovereignty.md). If you
> want to fix it by hand instead, run
> `kubectl -n daalu-demo rollout undo deploy/dummy-app`.

### Break scenarios

```bash
./demo/break.sh bad-image    # (default) dummy-app: image tag that doesn't exist → ImagePullBackOff
./demo/break.sh crashloop    # dummy-app: container command exits on startup → CrashLoopBackOff
./demo/break.sh errors       # metrics-app: error rate climbs → HighErrorRate (metrics-based)
```

`bad-image` / `crashloop` take **dummy-app** down (the `DummyAppDown` availability
alert). `errors` flips **metrics-app** into a failing mode so its
`app_errors_total` rate rises and the `HighErrorRate` **metrics-based** alert
fires. All three are fixed the same way — roll back the last change
(`kubectl -n daalu-demo rollout undo deploy/<app>`) — which is what you approve in
Daalu; only the root cause the agent reports differs.

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
- **Reset the app to healthy** — `kubectl -n daalu-demo rollout undo deploy/dummy-app`
  (or `./demo/down.sh && ./demo/up.sh`).

## Cleanup

```bash
./demo/down.sh
```

Deletes the kind cluster (and the kind network). Daalu keeps running; its
integration rows remain but point at the now-deleted cluster until you re-run
`up.sh` or remove them in the UI.
