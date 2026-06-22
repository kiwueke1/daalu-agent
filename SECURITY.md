# Security Policy

Daalu is an AI agent that can read from and (after explicit approval) make
changes to real infrastructure. We take its security model seriously and
welcome reports from the community.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Instead, use one of:

- **GitHub private vulnerability reporting** — on
  [github.com/kiwueke1/daalu-agent](https://github.com/kiwueke1/daalu-agent),
  go to **Security → Report a vulnerability**.
- **Email** — `kaiwueke@gmail.com` with `SECURITY` in the subject.

Please include:

- a description of the issue and its impact,
- the version / commit you tested,
- reproduction steps or a proof of concept, and
- any suggested remediation.

We aim to acknowledge a report within **5 business days** and to agree on a
disclosure timeline with you. Please give us a reasonable window to ship a fix
before any public disclosure.

## Supported versions

This project is pre-1.0 and moves quickly. Security fixes are applied to the
`main` branch; there is no long-term support branch yet. Run a recent `main`.

## Security model — what you need to know to run it safely

Daalu is designed as a **single-operator, self-hosted** tool. The defaults are
tuned for a local install on a trusted machine, and exposing it safely is the
operator's responsibility.

- **Authentication is disabled by default.** The quickstart ships
  `LOCAL_NO_AUTH=true`, which resolves every request to one built-in local
  operator with no login. This build has **no login UI / SSO**. To serve more
  than one person — or anything network-reachable — put Daalu behind an
  authenticating reverse proxy (and TLS). See
  [docs/04-deployment.md §1.6](docs/04-deployment.md#16-exposing-daalu-to-others-authentication).
- **Bound to loopback by default.** `docker compose` publishes ports on
  `BIND_ADDR=127.0.0.1`, so a fresh no-auth install is reachable only from the
  host. Do not set `BIND_ADDR=0.0.0.0` (or a public IP) until an auth proxy is in
  front.
- **`SECRET_KEY` matters even with auth off.** It signs auth tokens **and**
  derives the key that encrypts stored credentials (kubeconfigs, SSH keys) at
  rest. `install.sh` generates a unique value automatically; the app **refuses to
  start** with the placeholder default when `LOCAL_NO_AUTH=false` or
  `ENVIRONMENT=production`.
- **Write actions are gated behind explicit approval.** The agent investigates
  with read-only tools and can only *propose* changes. Mutating actions run
  exclusively through the dedicated executor queue after a human approves a
  Change Proposal — the LLM cannot apply changes on its own.
- **Scope the agent's blast radius.** Give the kubectl / cloud credentials it
  uses only the permissions you want it to have (namespace-scoped RBAC, a
  least-privilege cloud role). See [docs/05-tools.md](docs/05-tools.md).
- **Untrusted inputs reach the model.** Alert payloads, logs, and webhook
  bodies are attacker-influenceable and become part of the prompt. Treat the
  agent as you would any system that processes untrusted input: keep its
  credentials least-privilege and keep the approval gate in place.

## Scope

In scope: the agent, API, workers, and the deployment tooling in this
repository. Out of scope: third-party inference providers you point Daalu at,
your own cluster/cloud misconfiguration, and the vendored NVIDIA Config Manager
chart (report those upstream).
