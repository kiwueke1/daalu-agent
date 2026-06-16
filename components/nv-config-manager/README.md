# NVIDIA Config Manager (optional component)

This directory bundles [NVIDIA Config Manager](https://github.com/NVIDIA/nv-config-manager)
(NV-CM) — NVIDIA's **open-source, Apache-2.0** platform for managing
infrastructure through a [Nautobot](https://github.com/nautobot/nautobot)-based
source-of-truth, device workflows, and config rendering. Daalu can drive it as a
managed source-of-truth and execution backend for infra changes.

**It is entirely optional.** The Daalu agent runs without it. Use it only if you
want a Nautobot-backed inventory + NV-CM's workflow/config-management features.

## What's here

| Path | What it is | Authorship / license |
|------|------------|----------------------|
| `installer/` | Vendored NV-CM installer/deployer | NVIDIA, Apache-2.0 |
| `nautobot-jobs/` | Vendored NV-CM Nautobot jobs + bootstrap data | NVIDIA, Apache-2.0 |
| `chart/` | Vendored NV-CM Helm chart | NVIDIA, Apache-2.0 |
| `scripts/` | Build/mirror helpers | Daalu, Apache-2.0 |
| `NVIDIA-LICENSE`, `NVIDIA-NOTICE` | Upstream attribution | NVIDIA |
| `VENDORED.md` | What was vendored and any modifications | — |

The Daalu-authored integration glue lives in the main package:
`src/daalu_automation/config_manager_controller/`,
`src/daalu_automation/nautobot_controller/`, and
`src/daalu_automation/core/configmgr/`.

## Licensing

Both the vendored NVIDIA code and the Daalu glue are Apache-2.0. The NVIDIA
copyright notices and SPDX headers are preserved in the vendored files, and
NVIDIA's `LICENSE`/`NOTICE` are reproduced here. See the repository-root
[`NOTICE`](../../NOTICE) for the consolidated attribution. Redistribution here is
permitted under Apache-2.0 §4 as long as those notices are kept intact — please
keep them if you fork.

## Important: container images

The vendored chart and installer **default to image references in an
NVIDIA-internal registry namespace** (`nvcr.io/nvidian/cfa/...`) that the public
cannot pull. Because the upstream project is public and Apache-2.0, the intended
path is to **build the images from source and mirror them to your own registry**,
then override the image references — no NGC, NIM, or NVIDIA AI Enterprise
entitlement is required. See `scripts/` for build/mirror helpers, and the
upstream repo for source. Running NV-CM also requires a Kubernetes cluster.

## Status

This component is provided for users who want the NV-CM capability and are
comfortable building/mirroring the images and deploying it on their own cluster.
It is more involved than the core agent quickstart; it is not wired into
`docker compose up`. Treat it as an advanced add-on.
