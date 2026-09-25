---
title: "Docker Ollama setup"
description: "Run Ollama locally via Docker Compose for development, with an optional Caddy reverse proxy for API key authentication testing."
sidebar:
  order: 13
---

The `config/` directory at the repository root contains Docker Compose files for running Ollama during development. An optional Caddy reverse proxy lets you test API key authentication.

## Ports

| Port | Service | Authentication | Use case |
|---|---|---|---|
| 11430 | Caddy then Ollama | Bearer token required | Testing API key auth behind a reverse proxy |
| 11431 | Ollama direct | None | Standard local development |

## Start the services

Run from the repository root with an explicit compose file:

```bash
docker compose -f config/docker-compose.yml up -d
```

For Linux with NVIDIA GPU support:

```bash
docker compose -f config/docker-compose.yml -f config/docker-compose.linux-gpu.yaml up -d
```

## Pull a model

```bash
docker compose -f config/docker-compose.yml exec ollama ollama pull llama3.2:1b
```

Browse all available models at [ollama.com/library](https://ollama.com/library).

### Model recommendations

| Model | Size | Speed | Quality | Best for |
|---|---|---|---|---|
| `llama3.2:1b` | ~2 GB | Fast | Good | Quick testing, light post-processing |
| `llama3.2:3b` | ~4 GB | Medium | Better | General use |
| `llama3.1:8b` | ~8 GB | Slower | Best | High-quality post-processing |
| `mistral:7b` | ~7 GB | Medium | Great | Alternative to Llama |
| `phi3:mini` | ~2 GB | Fast | Good | Lightweight alternative |

## Configure mausVoice

In mausVoice settings, add an Ollama API key with:

- **URL:** `http://localhost:11430` (with auth) or `http://localhost:11431` (no auth)
- **API Key:** `test-api-key-12345` (only needed for port 11430)
- **Model:** select from the dropdown after the service is running

## Verify the setup

```bash
# Direct access (no auth)
curl http://localhost:11431/api/tags

# Through Caddy (requires auth)
curl -H "Authorization: Bearer test-api-key-12345" http://localhost:11430/api/tags
```

## Manage models

```bash
# List installed models
docker compose -f config/docker-compose.yml exec ollama ollama list

# Remove a model
docker compose -f config/docker-compose.yml exec ollama ollama rm <model-name>
```

## Change the API key

Edit the `API_KEY` environment variable in `config/docker-compose.yml`, then restart:

```bash
docker compose -f config/docker-compose.yml down && docker compose -f config/docker-compose.yml up -d
```

The Caddy config at `config/ollama/Caddyfile` accepts both `Authorization: Bearer <key>` and `X-API-Key: <key>` headers.

## Persistent data

Model data is stored in a Docker volume (`ollama_data`) and persists across container restarts. To delete everything and start over:

```bash
docker compose -f config/docker-compose.yml down -v
```

## Troubleshooting

**"Unable to connect to Ollama"** Check containers: `docker compose -f config/docker-compose.yml ps`. Check logs: `docker compose -f config/docker-compose.yml logs ollama`.

**Model not appearing in the dropdown.** Verify the model is pulled with `ollama list` inside the container. Try refreshing the model picker in mausVoice.

**GPU not used on Linux.** Use the GPU compose file and verify NVIDIA Container Toolkit is installed: `docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi`.

**Slow inference on macOS.** Docker on macOS runs in a Linux VM and cannot access Apple Silicon GPU acceleration. For best performance on Mac, run Ollama natively (`brew install ollama && ollama serve`) and point mausVoice to `http://localhost:11434`.

## Stop the services

```bash
# Stop containers (keeps data)
docker compose -f config/docker-compose.yml down

# Stop and remove volumes (deletes downloaded models)
docker compose -f config/docker-compose.yml down -v
```
