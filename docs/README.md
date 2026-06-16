# Daalu documentation

Start here, then dive into whichever area you need.

| Doc | What it covers |
|-----|----------------|
| [04-deployment.md](04-deployment.md) | **Install & run everything**, in two parts: **Part A** install Daalu (Compose, every config variable, auth, k8s); **Part B** deploy your own GPU inference server (k3s single- & multi-node) |
| [01-architecture.md](01-architecture.md) | How the system fits together and how an event flows end-to-end |
| [02-agent-and-guardrails.md](02-agent-and-guardrails.md) | The approve-before-execute safety model (read this if you're security-minded) |
| [05-tools.md](05-tools.md) | The tool catalog: Kubernetes, cloud, and device operations |
| [03-llm-and-sovereignty.md](03-llm-and-sovereignty.md) | Pointing Daalu at your own inference; what "sovereign" means |
| [06-extending.md](06-extending.md) | Adding a new module, integration adapter, or agent |

Hands-on:

| | |
|-|-|
| [../demo/](../demo/) | **Demo lab** — a monitored kind cluster + a breakable app, to watch Daalu detect and fix an issue end-to-end |

Optional component:

| | |
|-|-|
| [../components/nv-config-manager/](../components/nv-config-manager/) | NVIDIA Config Manager — Nautobot-based source-of-truth + workflows (Apache-2.0) |

New here? Read [../README.md](../README.md) for the one-paragraph pitch and the
quickstart, then [04-deployment.md](04-deployment.md) to install.
