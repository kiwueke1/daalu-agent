<h1 align="center">Daalu</h1>
<p align="center"><b>A self-hosted AI agent for infrastructure &amp; ops teams.</b><br/>
It investigates, proposes changes, and executes only after you approve — running entirely on <i>your</i> infrastructure and <i>your</i> inference.</p>

<p align="center">
<a href="#quickstart">Quickstart</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#what-makes-it-different">Why Daalu</a> ·
<a href="docs/">Docs</a> ·
<a href="#license">License</a>
</p>

<!-- TODO before publishing: replace this line with a 60–90s demo GIF/asciinema:
     a real alert → the agent investigates → proposes a fix → you approve → resolved. -->
<p align="center"><i>(demo GIF goes here)</i></p>

---

Every "AI for ops" tool is SaaS. To use one you ship your cluster topology, logs,
and secrets to someone else's cloud. For most infra teams that's a non-starter.

**Daalu runs in your own environment, on your own GPUs.** Point it at any
OpenAI-compatible endpoint — vLLM or Ollama with open weights — and no prompt or
piece of code ever leaves your network. It's an agent that works *with* your team:
it triages alerts, pulls the evidence, drafts the fix, and waits for a human to
approve before it touches anything.

## What makes it different

- **Sovereign by default.** Bring your own inference. With a local model, nothing
  leaves your network — no OpenAI, no Anthropic, no telemetry. (A managed public
  provider, Anthropic, is opt-in, not the default.)
- **It proposes, you approve.** Read-only investigation tools run freely; anything
  that mutates state is a `ChangeProposal` that a human must approve. A dedicated,
  separately-scoped executor is the *only* code path that can apply a change —
  prompt injection on the agent cannot smuggle execute rights. See
  [the guardrail model](docs/02-agent-and-guardrails.md).
- **Operates real infrastructure.** First-class tools for Kubernetes (kubectl),
  AWS / GCP / Azure (read-only), and Linux / network devices over SSH/NETCONF.
- **Self-hostable, event-driven.** Ingests alerts (Alertmanager, PagerDuty,
  CloudWatch…), reasons over them, emits triage, root-cause, recommendations, and
  a daily AI briefing.
- **Open core.** This repo is the full single-tenant agent under Apache-2.0.

## Quickstart

You need Docker (with the Compose plugin) and ~4 GB RAM, plus somewhere to run a
model. Pick your starting point:

**Already have an OpenAI-compatible endpoint** (Ollama, vLLM, …)?

```bash
git clone <this-repo> daalu && cd daalu
./install.sh                         # asks for your inference URL, brings up the stack
```

**Just have a Linux machine with an NVIDIA GPU?** The repo sets up inference too —
cluster, GPU, and an open-weights model server:

```bash
git clone <this-repo> daalu && cd daalu
sudo ./scripts/install-gpu-k3s.sh    # 1. k3s + GPU Operator (installs the GPU driver too)
./scripts/serve-model.sh             # 2. deploy vLLM + an open model → prints the URL
./install.sh                         # 3. start Daalu, paste that URL
```

Either way, `install.sh` builds the images, starts the stack, and seeds demo
data. Then open:

- **UI** → http://localhost:3000
- **API docs** → http://localhost:8000/docs

Full walkthrough (including the bare-GPU path and bringing your own inference):
[docs/04-deployment.md](docs/04-deployment.md).

### See it in action (demo lab)

Want to watch Daalu actually detect and fix something? The
[`demo/`](demo/) lab spins up a small monitored kind cluster (Prometheus,
Alertmanager, Loki, and a dummy app), connects Daalu to it, and lets you break
the app on purpose:

```bash
./demo/up.sh        # monitored cluster + wire Daalu to it
./demo/break.sh     # take the app down on purpose
# → open Daalu → Alerts, watch it investigate and propose a rollback to approve
./demo/down.sh      # tear it all down
```

See [demo/README.md](demo/README.md) for the full runbook.

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

1. **Ingest** — alerts/events land on an internal event bus.
2. **Investigate** — the agent calls read-only tools (pod logs, k8s events,
   Prometheus, cloud state) using your chosen model.
3. **Propose** — for anything that changes state, it opens a `ChangeProposal`
   with a rendered diff.
4. **Approve** — a human reviews and approves in the UI.
5. **Execute** — a dedicated executor (its own queue + token scope) applies the
   change and records the result.

Full detail in [docs/01-architecture.md](docs/01-architecture.md).

## What's in this repo (and what isn't)

**Open-source (here):** the event-driven agent runtime, the Infra/SRE module, the
Kubernetes / cloud / device tools, the change-proposal approve-before-execute
engine, provider-agnostic LLM routing, the Ops UI, and the optional
[NVIDIA Config Manager](components/nv-config-manager/) component (Nautobot-based
source-of-truth + workflows; Apache-2.0).

**Not here (commercial hub):** multi-tenancy, SSO/RBAC, usage billing, the
WireGuard fleet that reaches many customer clusters, and managed GPU
provisioning. This repo is single-tenant and self-hosted.

## Documentation

| Doc | What |
|-----|------|
| [docs/04-deployment.md](docs/04-deployment.md) | **Install everything** — every variable, where to run it, Docker / k8s |
| [docs/01-architecture.md](docs/01-architecture.md) | How the pieces fit together |
| [docs/02-agent-and-guardrails.md](docs/02-agent-and-guardrails.md) | The approve-before-execute safety model |
| [docs/05-tools.md](docs/05-tools.md) | The tool catalog (kubectl, cloud, devices) |
| [docs/03-llm-and-sovereignty.md](docs/03-llm-and-sovereignty.md) | Pointing Daalu at your own inference |
| [docs/06-extending.md](docs/06-extending.md) | Add a module, integration, or agent |
| [components/nv-config-manager/](components/nv-config-manager/) | Optional NVIDIA Config Manager component |

## License

[Apache-2.0](LICENSE). Includes vendored Apache-2.0 components from NVIDIA — see
[NOTICE](NOTICE).
