# Daalu agent — API + worker image (open-source single-tenant build).
#
# This is the lean core image: it serves the API and runs the Celery
# agents/executor. It does NOT bundle helm/kubectl or the vendored NV-CM
# chart — those are only needed by the optional config-manager-controller,
# which has its own deploy path (see components/nv-config-manager/).
FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer first so a source change doesn't bust the cache.
# Install from the fully-pinned lock (requirements.lock), NOT the open
# ">=" ranges in pyproject — a rebuild can then never silently float a
# transitive dep.
COPY pyproject.toml requirements.lock ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.lock

COPY src/ src/
# --no-deps: deps are already satisfied by the lock above; this only
# installs the daalu package itself, without letting pip re-resolve.
RUN pip install --no-cache-dir --no-deps -e .

COPY alembic.ini ./
COPY migrations/ migrations/

RUN useradd -m -u 1000 daalu && chown -R daalu:daalu /app
USER daalu

# Build identity — surfaced by GET /version.
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["daalu", "server", "--host", "0.0.0.0", "--port", "8000"]
