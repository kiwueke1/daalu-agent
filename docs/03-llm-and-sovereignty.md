# LLM and sovereignty

Daalu is inference provider-agnostic. It can run entirely against a model **you**
host on **your** hardware, so that no prompt, no log line, and no source code ever
leaves your network. A public hosted option (Anthropic) is also available if you
explicitly opt in. This page explains how to point Daalu at your own inference and
how the router in `src/daalu_automation/core/llm.py` chooses.

See also: [01-architecture.md](01-architecture.md),
[02-agent-and-guardrails.md](02-agent-and-guardrails.md), [04-deployment.md](04-deployment.md).

## What "sovereign" means here

Sovereign means the model that answers a request runs on infrastructure you
control, reached over your own network, with no third party in the path.

**Daalu is not the model — Daalu is a client to it.** "The server" here is a
separate *inference server*: the process that loads the open-weights model and
exposes it over HTTP. Daalu makes calls to it.

**You don't need one already running — the scripts in this repo set it up for
you, from a bare GPU machine:**

```bash
sudo ./scripts/install-gpu-k3s.sh   # 1. machine with NVIDIA GPU → k8s + GPU ready
./scripts/serve-model.sh            # 2. deploy vLLM + an open-weights model
                                    #    → prints the LLM_BASE_URL to use
./install.sh                        # 3. start Daalu, paste that URL when asked
```

`serve-model.sh` deploys [vLLM](https://docs.vllm.ai) serving an open model
(Qwen2.5 by default — no Hugging Face token needed) onto your cluster and exposes
an OpenAI-compatible `/v1` endpoint. See
[Part B of 04-deployment.md](04-deployment.md#part-b-deploy-your-own-gpu-inference-server).

If you'd rather **bring your own** inference server, that's fully supported too —
anything OpenAI-compatible works (vLLM, [Ollama](https://ollama.com), TGI,
llama.cpp's server), running on a GPU box on your LAN, your workstation, or your
own cluster. Either way: you give Daalu the server's URL (`LLM_BASE_URL`, below),
and from then on the prompt and completion travel only between Daalu and your
server — they never leave your perimeter, full stop.

## The recommended setup (works for everything, including tool-calling)

Set these four variables to your own server. This is what `install.sh` and
`.env.example` configure, and it routes **both** the agent's reasoning and its
tool-calling investigation to your endpoint:

| Variable | Example | Meaning |
|----------|---------|---------|
| `LLM_BASE_URL` | `http://host.docker.internal:11434/v1` | Your OpenAI-compatible endpoint |
| `LLM_API_KEY` | `ollama` | Any non-empty string for local servers (sent as the bearer) |
| `LLM_MODEL` | `qwen2.5:14b` | Model id your server advertises (used for the "quality" calls) |
| `LLM_MODEL_CLASSIFIER` | `qwen2.5:14b` | Cheaper model id for routing/classification (can be the same) |

> Naming note: internally this is the router's "external OpenAI-compatible" tier.
> The label is just an internal tier name — the **network destination is your
> server**, so privacy is identical to any other local path. We recommend it
> because, unlike the alternate "local" tier below, it has no health-probe
> dependency and fully supports the agent's tool-calling loop
> (`chat_with_tools`).

### Ollama example

```bash
ollama pull qwen2.5:14b
# Ollama listens on :11434. From inside the compose containers it's reachable at
# host.docker.internal; on the host directly it's localhost.
```

```ini
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:14b
LLM_MODEL_CLASSIFIER=qwen2.5:14b
```

A capable instruction model (≥14B) makes the agent meaningfully better at
multi-step investigation; tiny models struggle with the tool-calling loop.

### vLLM example (open weights, GPU)

```bash
# bare metal
pip install vllm
vllm serve Qwen/Qwen2.5-14B-Instruct --served-model-name qwen2.5-14b --port 8000

# or docker
docker run --gpus all -p 8000:8000 vllm/vllm-openai:latest \
  --model Qwen/Qwen2.5-14B-Instruct --served-model-name qwen2.5-14b
```

```ini
LLM_BASE_URL=http://<your-vllm-host>:8000/v1
LLM_API_KEY=novvllmkeyneeded
LLM_MODEL=qwen2.5-14b
LLM_MODEL_CLASSIFIER=qwen2.5-14b
```

Other open-weights models work too — e.g. `meta-llama/Llama-3.1-8B-Instruct`
(lighter) or a 70B/Qwen-32B if your hardware allows. Match `LLM_MODEL` to the
`--served-model-name` exactly.

## Opt-in public option: Anthropic (NOT sovereign)

If you set `ANTHROPIC_API_KEY` (and `ANTHROPIC_MODEL`), Daalu can also use
Anthropic's hosted API — a different, public model — for text generation, instead
of (or alongside) your own server. This is an option, not an upgrade: pick it if
you prefer a managed public model for some calls. Leave it empty to keep
everything local.

> [!CAUTION]
> $\color{red}{\textsf{Choosing this option means data leaves your network: your prompts are sent to Anthropic.}}$

| Variable | Default | Meaning |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | _(empty)_ | Enables the Anthropic (public) option when set |
| `ANTHROPIC_MODEL` | _(empty)_ | Set to an Anthropic model id to use it (required to enable the tier) |

Note: the interactive tool-calling investigation (`chat_with_tools`) runs only on
OpenAI-compatible tiers, so the Anthropic tier covers plain text generation
(briefings, summaries) but not the tool loop. If you want the agent to *act*, you
need an OpenAI-compatible endpoint configured as above. In practice: configure
`LLM_BASE_URL` (your server) even if you also set an Anthropic key.

## How the router chooses (`core/llm.py`)

For each call the router builds an ordered plan of tiers and uses the first that
has credentials and answers:

1. **Sovereign/federated GPU** — used only by the commercial hub; irrelevant to a
   single-tenant self-host. Ignore.
2. **Local tier** (`LLM_LOCAL_BASE_URL`) — an operator-owned server, gated by a
   health probe (`LLM_LOCAL_HEALTH_PATH`, default `/health`). See the caveat below.
3. **OpenAI-compatible** (`LLM_BASE_URL` + `LLM_API_KEY`) — what we recommend you
   point at your own server.
4. **Anthropic** (`ANTHROPIC_API_KEY`) — opt-in, text-only.

The default routing policy in single-tenant mode is local-first; with no hosted
key set, calls simply use your `LLM_BASE_URL` server for everything.

### Caveat on the alternate "local" tier

There is a second set of variables — `LLM_LOCAL_BASE_URL`, `LLM_LOCAL_API_KEY`,
`LLM_LOCAL_MODEL_CLASSIFIER`, `LLM_LOCAL_MODEL_QUALITY` — that drive the router's
dedicated "local" tier. It works but has two sharp edges for self-hosters:

- It is gated by a health check at `LLM_LOCAL_HEALTH_PATH` (default `/health`).
  vLLM serves `/health`; **Ollama does not** — set `LLM_LOCAL_HEALTH_PATH=/` if
  you use Ollama, or the tier is treated as unhealthy and skipped.
- Under the default local-first policy, the "quality" path (and the tool-calling
  loop) may bypass this tier.

Unless you specifically want it, prefer the `LLM_BASE_URL` setup above — it's
simpler and avoids both issues.

## Verifying

```bash
docker compose logs -f api | grep -i llm     # the router logs which tier served
```

If calls fail: confirm the endpoint is reachable **from inside the container**
(`host.docker.internal` on the compose network, not `127.0.0.1`), and that
`LLM_MODEL` exactly matches a model your server serves.
