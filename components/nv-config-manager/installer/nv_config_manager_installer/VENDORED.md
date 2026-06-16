# Vendored: nv_config_manager_installer

This package is a **vendored copy** of NVIDIA's upstream NV-CM installer
(`installer/src/nv_config_manager_installer/`), Apache-2.0 licensed (SPDX
headers retained on every file).

Daalu's `config_manager_controller` drives the upstream `Deployer` directly
(import-as-library) to install the NV-CM Helm chart. A bare `helm upgrade
--install` deadlocks: the chart's `secret-assembler` pre-install hook waits on
secrets (`redis-password`, `nautobot-token`, `device-creds`, `cluster-*-app`,
…) that are only minted later in the same release. The `Deployer` pre-creates
those secrets (and the namespace) *before* helm runs, breaking the deadlock.

## What was changed vs upstream

- **`tui/` excluded** — the Textual TUI is interactive-only and pulls a
  `textual` dependency we don't want in a runtime container. Nothing on the
  `Deployer` code path imports it (`cli.py` imports it lazily inside `init`,
  which we never call).
- Everything else copied verbatim. Do **not** hand-edit these modules;
  Daalu-specific behaviour (shared GatewayClass, Harbor image overrides,
  skipping the NodePort gateway patch) lives in
  `daalu_automation.config_manager_controller.deployer_runner` /
  `deployer_config`, which subclass / configure the upstream `Deployer`
  rather than forking it.

## Upstream source

- Repo: `NVIDIA/nv-config-manager` (NVIDIA, Apache-2.0)
- Path: `installer/src/nv_config_manager_installer/`
- Matches vendored chart: `deploy/charts/nv-config-manager-1.2.2-rc.23`

## Re-vendoring

Copy the upstream `*.py` modules over these, excluding `tui/`, `tests/`,
`scripts/`. Re-run `tests/config_manager_controller/test_nvcm_vendor_import.py`
to confirm the `Deployer` import chain still loads against Daalu's pinned deps.
