# RAM-fit measurement image for munin-memory
# Targets linux/arm64 (owner-desktop host).
# Build context: repo root (so COPY works from .)

FROM node:20-bookworm

# Build deps needed for native addons: better-sqlite3, sqlite-vec, onnxruntime-node
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first so npm ci layer is cached independently
COPY package.json package-lock.json ./

# Full install including devDeps (typescript, tsx needed for type-check)
# Native addons compile against the container's node/arch automatically.
RUN npm ci

# Copy the rest of the source
COPY . .

# Build TypeScript → dist/
RUN npm run build

# HF model cache is mounted at runtime from the host (~/munin-ramfit/hf-cache)
# so model files survive across runs. We create the expected mount point.
RUN mkdir -p /hf

# The measurement script is run directly with node at container startup.
# Entrypoint is set by run-config.sh via `docker run ... node benchmark/ramfit/measure.mjs`
CMD ["node", "benchmark/ramfit/measure.mjs"]
