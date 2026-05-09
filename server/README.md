<div align="center">

# 🎙️ SayIt

**开口即成稿 — 用说话代替打字，AI 实时把口语变成书面表达。**

Self-hosted speech-to-text server with real-time ASR + LLM polishing.

[Quick Start](#quick-start) · [Architecture](#architecture) · [Configuration](#configuration) · [Deployment](#deployment) · [License](#license)

</div>

---

## What is SayIt?

SayIt is a self-hosted speech-to-text service that combines real-time ASR (Qwen3-ASR) with LLM text polishing. It provides:

- **Browser Demo** — Record and transcribe directly in the browser, no install needed
- **Windows Desktop App** — Push-to-talk with automatic paste into any application
- **Admin Dashboard** — Monitor sessions, performance metrics, GPU/CPU usage
- **REST & WebSocket API** — Integrate speech-to-text into your own applications

Everything runs on a single server with one GPU.

## Features

- 🎯 **Real-time ASR** — Qwen3-ASR-1.7B with vLLM acceleration, <2s latency
- ✨ **LLM Polishing** — Converts spoken language to written text (Azure OpenAI / Groq / Ollama)
- 🔥 **Hotword Boosting** — Custom vocabulary for domain-specific terms
- 📊 **Admin Dashboard** — Session analytics, performance percentiles, system monitoring
- 🐳 **Docker Ready** — `docker compose up` with GPU support, model baked into image
- 🔒 **Security** — Rate limiting, WebSocket connection limits, admin path isolation
- 📦 **SQLite / PostgreSQL** — SQLite for single-node, PostgreSQL for cluster deployment

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │            ALB (HTTPS 443)           │
                    │         ACM TLS termination          │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │         FastAPI Backend (:8000)       │
                    │                                      │
                    │  /              Landing page + demo   │
                    │  /api/*         REST APIs             │
                    │  /ws/transcribe WebSocket streaming   │
                    │  /admin/*       Dashboard (blocked    │
                    │                 on public, SSH only)  │
                    │                                      │
                    │  ┌────────┐  ┌─────┐  ┌──────────┐  │
                    │  │Qwen3   │  │ LLM │  │Telemetry │  │
                    │  │ASR+vLLM│  │proxy│  │ SQLite/  │  │
                    │  │ (GPU)  │  │     │  │   PG     │  │
                    │  └────────┘  └─────┘  └──────────┘  │
                    └─────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- NVIDIA GPU with ≥16GB VRAM (e.g., A10G, L4, RTX 4090)
- Docker with [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- An LLM API key (Azure OpenAI, OpenAI, Groq, or local Ollama)

### 1. Clone and configure

```bash
git clone https://github.com/your-org/SayIt.git
cd SayIt
cp .env.example .env
cp config.example.yaml config.yaml
```

Edit `.env` — fill in your API keys:
```bash
SAYIT_OPENAI_API_KEY=sk-...        # or SAYIT_AZURE_API_KEY
SAYIT_ADMIN_PASSWORD=your-password
```

Edit `config.yaml` — adjust LLM provider if needed (default: Azure OpenAI).

### 2. Start

```bash
docker compose up -d --build
```

First build takes ~15 minutes (downloads model + builds image).
Subsequent starts take ~60 seconds (model loading).

### 3. Access

| URL | Description |
|-----|-------------|
| `https://your-server/` | Landing page + browser demo |
| `https://your-server/healthz` | Health check |
| `http://localhost:8000/admin` | Admin dashboard (via SSH tunnel) |

Admin access: `ssh -L 8000:localhost:8000 your-server` then open `http://localhost:8000/admin`

## Project Layout

```
SayIt/
├── backend/              # FastAPI backend
│   ├── app/
│   │   ├── main.py       # Routes, WebSocket handler
│   │   ├── config.py     # Nested config dataclasses
│   │   ├── asr.py        # Qwen3-ASR engine + VAD
│   │   ├── llm.py        # LLM polishing (multi-provider)
│   │   ├── admin.py      # Admin API endpoints
│   │   ├── telemetry.py  # Usage tracking + analytics
│   │   ├── db.py         # SQLite / PostgreSQL abstraction
│   │   └── ratelimit.py  # Token-bucket rate limiter
│   ├── tests/
│   ├── Dockerfile
│   └── requirements.txt
├── gateway/              # HTTPS reverse proxy (Node.js)
├── web/                  # Landing page, browser demo, admin UI
├── prompts/              # System prompt + hotword files
├── config.example.yaml   # Configuration template
├── .env.example          # Secrets template
├── docker-compose.yml
└── LICENSE               # AGPL-3.0
```

## Configuration

Configuration is split into two files:

| File | Contains | Committed to git? |
|------|----------|-------------------|
| `config.yaml` | All settings (ASR, LLM, ports, logging, etc.) | Yes (template) |
| `.env` | Secrets only (API keys, passwords) | **No** |

All environment variables use the `SAYIT_` prefix. See [config.example.yaml](./config.example.yaml) for full documentation.

### Key settings

```yaml
asr:
  engine: "qwen3"                    # or "firered"
  model: "Qwen/Qwen3-ASR-1.7B"
  device: "cuda:0"

llm:
  enabled: true
  provider: "openai"                 # azure / openai / groq / ollama

web_demo:
  enabled: true
  max_duration_sec: 600              # Max recording per session
  max_concurrency_per_ip: 3

admin:
  enabled: true
```

### Database

Default: SQLite (zero config). For multi-node deployment:

```yaml
telemetry:
  db_backend: "postgresql"
  db_path: "postgresql://user:pass@host:5432/sayit"
```

Or via environment variable: `SAYIT_DB_URL=postgresql://...`

## Deployment

### Single server (recommended for most users)

```bash
docker compose up -d --build
```

### With ALB (AWS)

1. Request ACM certificate for your domain
2. Create ALB with HTTPS listener + ACM certificate
3. Target group → EC2:8000, health check `/healthz`
4. Block `/admin/*` at ALB level (fixed 404 response)
5. Access admin via SSH tunnel

See [docs/deployment.md](./docs/deployment.md) for details.

## Development

```bash
# Create virtualenv
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# Run backend directly
cd backend
uvicorn app.main:app --host 0.0.0.0 --port 8000

# Run tests
python -m pytest backend/tests/ -v
```

## API

### WebSocket `/ws/transcribe`

```json
// → Client sends
{"cmd": "start", "client_meta": {"user_id": "..."}, "app_context": {"process_name": "..."}}
// → Client sends PCM audio frames (16kHz, 16-bit, mono)
{"cmd": "stop", "usage_meta": {"ptt_hold_ms": 1500}}

// ← Server responds
{"type": "asr", "text": "你好世界", "asr_ms": 450}
{"type": "final", "asr_text": "你好世界", "llm_text": "你好，世界。", "asr_ms": 450, "llm_ms": 320}
{"type": "done"}
```

### REST

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Health check |
| GET | `/api/public/config` | Public site configuration |
| GET | `/api/hotwords` | Current hotword list |
| PUT | `/api/hotwords` | Update hotwords |
| GET | `/admin/api/overview` | Dashboard metrics (auth required) |
| GET | `/admin/api/sessions` | Session list (auth required) |

See [docs/api.md](./docs/api.md) for full API reference.

## License

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE).

You are free to self-host and modify SayIt. If you distribute a modified version or run it as a network service, you must make your source code available under the same license.

For commercial licensing inquiries, please contact the maintainers.
