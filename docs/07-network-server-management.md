# Using network & server management (NV-CM)

This walks through **using** Daalu to manage network devices and bare-metal servers once
the optional NV-CM add-on is installed. If the **Managed Infra → Network & server** page
still shows a "turned off" placeholder, do the install first:
[04-deployment.md → Part 3](04-deployment.md#part-3-optional-network--server-management-nv-cm).

NV-CM gives Daalu three things:

- **A source of truth (Nautobot)** — the inventory of your switches, routers, and
  servers, plus their topology, platforms, and intended state.
- **A render + workflow engine (Render + Temporal)** — turns intent into device config
  and orchestrates multi-step changes.
- **A config store** — versioned intended / running / backup configs with diffs.

Daalu sits on top: its agent reads the inventory, drafts changes, and pushes approved
ones to real devices — through the **same approve-before-execute pipeline** as
everything else (see [02-agent-and-guardrails.md](02-agent-and-guardrails.md)).

---

## 1. The Network & server page

Open **Managed Infra → Network & server**. Once provisioning reports `active` you'll see
links to the service consoles:

- **Nautobot** — the inventory UI. This is where devices live. For a local install the
  default login is `admin` / `admin` (or read the generated secret — see the NV-CM
  README).
- **Config Store** — browse versioned configs and diffs per device.
- **Temporal** — watch the workflows that render and apply changes.

These are NV-CM's own UIs, fronted by its gateway. Daalu drives the same APIs behind
them; you rarely need the consoles for day-to-day work, but they're there for deep dives.

---

## 2. Put your devices in the inventory

Daalu acts on what Nautobot knows. Add each device in Nautobot (or bulk-import / let ZTP
discover them) with, at minimum:

- a **name** and **primary IP**,
- a **platform** that maps to a Daalu transport (below),
- any per-device overrides (management user/port) as Nautobot **custom fields**.

The **transport** decides which adapter Daalu uses to talk to the device:

| Device | `transport` | Talks via |
|--------|-------------|-----------|
| Linux / bare-metal host | `linux_ssh` | SSH (port 22) |
| Arista switch | `eos` | SSH → NETCONF 830 |
| Juniper switch | `junos` | SSH → NETCONF 830 |
| Cisco switch | `iosxr` | SSH → NETCONF 830 |
| Server BMC | `redfish` | Redfish (HTTPS 443) |

(Full adapter details: [05-tools.md → Source-of-truth / device tools](05-tools.md#source-of-truth--device-tools).)

---

## 3. Wire device credentials

The inventory says *what* a device is; credentials say *how* to reach it. Add these once
under **Integrations** — they're stored encrypted at rest and resolved only at apply
time:

| Transport(s) | Credentials integration |
|--------------|-------------------------|
| `linux_ssh` | **`ssh_credentials`** — SSH user + key/password |
| `eos` / `junos` / `iosxr` | **`network_credentials`** — one shared shape for all three NOS families |
| `redfish` | **`redfish_credentials`** — BMC user + password |

Per-device overrides (a different user or port on one box) go on the Nautobot device as
custom fields and win over the integration defaults — Daalu resolves the most specific
credential it can find. Nothing reaches a device until **both** an approval *and* a
resolvable credential exist.

---

## 4. The change flow: draft → approve → push

This is the heart of it, and it's deliberately the same shape as a Kubernetes fix:

1. **Draft.** You (or the agent, during an investigation) call `propose_change` for a
   device. Daalu renders the device's current intent as the *observed* config and the
   proposed intent as the *intended* config, computes a unified **diff**, and writes a
   **`ChangeProposal`** row capturing the diff + the reasoning that produced it. Nothing
   touches the device yet.
2. **Review.** The proposal appears under **Operations → Change proposals** (and at
   `/proposals/<id>`). You see the **side-by-side diff**, the evidence (which alert /
   metrics / reasoning triggered it), and **Approve** / **Reject**.
3. **Approve.** On approve, Daalu's dedicated **executor** picks it up, **re-renders the
   intent and re-checks it against the snapshot** — if the device drifted since you
   reviewed, the proposal goes `stale` and asks for a fresh look rather than applying a
   stale change. Otherwise the matching **DeviceAdapter** pushes the config over
   SSH / NETCONF / Redfish.
4. **Result.** The proposal records `executed` (or `failed`, with the error) and the
   pushed config lands in the Config Store as a new version.

> **Why approval lives on the proposal, not the chat.** `propose_change` is *not* gated
> as a chat action — the `ChangeProposal` row **is** the approval surface, so authority
> isn't split across two UIs. The proposal is the single place a human says yes.

---

## 5. Let the agent do the work

The point isn't to hand-write proposals — it's to let the agent investigate and draft
them. Some ways it shows up:

- **From an alert.** When an alert references a device (a link down, a BGP session
  flapping, a server health event), the remediation copilot can pull device state from
  Nautobot / the config store, reason about the cause, and **propose a config change** as
  an approvable step — exactly like it proposes a `patch_resource` for Kubernetes.
- **From a question.** Ask the copilot "why is leaf-07 dropping its uplink?" and it can
  read the inventory + intended/running diff and explain, optionally drafting the fix.
- **Drift.** When a device's running config diverges from intent, that surfaces as a
  drift-kind `ChangeProposal` you can approve to reconcile.

Every one of these still stops at the **Approve** gate. The agent proposes; a human
disposes; the executor applies.

---

## 6. Going deeper

- **Workflows.** Multi-step operations (staged rollouts, ZTP onboarding, DHCP changes)
  run as **Temporal** workflows — watch them in the Temporal console.
- **Rendering & templates.** How intent becomes device config (Jinja templates, the
  render service) is NV-CM's domain — see the
  [NV-CM docs](https://github.com/NVIDIA/nv-config-manager) (`docs/render/`,
  `docs/nautobot/`, `docs/temporal/`).
- **The safety model.** The approve-before-execute guarantees, the executor's identity
  boundary, and the stale-check are covered in
  [02-agent-and-guardrails.md](02-agent-and-guardrails.md).

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Page still shows "turned off" | `config_manager_controller_url` not set / `api` not recreated after editing `.env`. |
| Provisioning stuck in `error` | Tier-A operators (Envoy Gateway / cert-manager / CNPG) missing, or images not pullable — check `CONFIG_MANAGER_HARBOR_REGISTRY` and that the mirror ran. |
| Service calls return 401 | Keycloak issuer/clients misconfigured — Daalu mints an OIDC token for every NV-CM call; the `KEYCLOAK_*` values must match the realm the installer created. |
| Service calls time out | The `svc-*` hostnames don't resolve to the gateway from the hub — confirm `CMTOOLS_BASE_DOMAIN` resolves to the node and the gateway is exposed (no tunnel needed for a co-located cluster). |
| Approved change never applies | The executor isn't running, or no credential resolves for the device's transport. |
