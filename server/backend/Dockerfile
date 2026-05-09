# =============================================================================
# SayIt Backend — GPU Docker Image
# =============================================================================
# Layer strategy:
#   1. CUDA base + system deps        (rarely changes)
#   2. Python dependencies             (changes on pip update)
#   3. ASR model (Qwen3-ASR-1.7B)     (rarely changes, ~4.4GB)
#   4. Application code + prompts      (changes often, ~few MB)
# =============================================================================

# --- Layer 1: CUDA base ---
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/models

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-dev python3-pip \
        ffmpeg build-essential curl openssl sox libsox-dev && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Layer 2: Python dependencies ---
COPY backend/requirements.txt /tmp/requirements.txt
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124
RUN python -m pip install --upgrade pip && \
    pip install torch torchaudio --index-url ${TORCH_INDEX_URL} && \
    pip install numpy && \
    pip install --no-build-isolation -r /tmp/requirements.txt && \
    rm /tmp/requirements.txt

# --- Layer 3: ASR model + VAD model (cached in /app/models, readable by all users) ---
RUN mkdir -p /app/models && \
    python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-ASR-1.7B')" && \
    python -c "from modelscope.hub.snapshot_download import snapshot_download; snapshot_download('iic/speech_fsmn_vad_zh-cn-16k-common-pytorch')" && \
    chmod -R a+rwX /app/models /root /root/.cache 2>/dev/null; true

# --- Layer 4: Application code + built-in defaults ---
RUN useradd -m -s /bin/bash sayit && \
    mkdir -p /app/runtime /app/certs && \
    chown -R sayit:sayit /app/runtime && \
    chmod -R a+rX /root/.cache 2>/dev/null; true
COPY --chown=sayit:sayit backend/app /app/backend/app
COPY --chown=sayit:sayit web /app/web
COPY --chown=sayit:sayit prompts /app/prompts
COPY --chown=sayit:sayit config.example.yaml /app/config.yaml

# Generate self-signed TLS certificate (for browser microphone API over HTTPS)
RUN openssl req -x509 -newkey rsa:2048 -keyout /app/certs/dev.key \
    -out /app/certs/dev.crt -days 3650 -nodes \
    -subj "/CN=sayit-local" 2>/dev/null && \
    chown -R sayit:sayit /app/certs

USER sayit
EXPOSE 8000 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -sf http://localhost:8000/healthz || exit 1

WORKDIR /app/backend
COPY --chown=sayit:sayit backend/entrypoint.sh /app/backend/entrypoint.sh
ENTRYPOINT ["/bin/bash", "/app/backend/entrypoint.sh"]
