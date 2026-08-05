# ──────────────────────────────────────────────────────────
# zeros-engine-v0 — cloud-workspace validation Dockerfile
# ──────────────────────────────────────────────────────────
#
# image.ts is the CANONICAL build spec (the bake script consumes it via the
# Daytona SDK's declarative Image builder). This Dockerfile is the portable
# equivalent — for `Image.fromDockerfile()`, a local `docker build` sanity check,
# or porting the validation harness to another sandbox provider.
#
# Build args mirror config.ts. The native bindings compile against THIS image's
# Node ABI — there is no Electron in a cloud sandbox, so the electron-rebuild ABI
# trap does not apply.
# ──────────────────────────────────────────────────────────
FROM node:22-bookworm

ARG ZEROS_REPO_URL=https://github.com/withso/zeros.git
ARG ZEROS_REPO_REF=main
ARG PNPM_VERSION=10.28.0
ARG MUTAGEN_VERSION=0.18.1

ENV DEBIAN_FRONTEND=noninteractive \
    ZEROS_DATA_DIR=/home/daytona/.zeros-data \
    ZEROS_WORKSPACES_DIR=/home/daytona/.zeros-data/workspaces \
    ZEROS_PTY_HOST_RUNTIME=/usr/local/bin/node \
    ZEROS_PTY_HOST_SCRIPT=/home/daytona/zeros/apps/desktop/src/engine/pty/pty-host.cjs \
    ZEROS_CURSOR_HOST_SCRIPT=/home/daytona/zeros/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs

# 1. OS toolchain (node-gyp + ssh for Mutagen + curl/unzip for bun/mutagen).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client curl ca-certificates python3 make g++ unzip xz-utils procps \
 && rm -rf /var/lib/apt/lists/*

# 2. bun (eventual engine runtime) + pnpm (matches packageManager).
RUN curl -fsSL https://bun.sh/install | bash \
 && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
 && npm install -g pnpm@${PNPM_VERSION}

# 3. Mutagen + agent bundle for file-mirroring experiments — best-effort.
RUN curl -fsSL -o /tmp/mutagen.tar.gz \
      "https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_linux_amd64_v${MUTAGEN_VERSION}.tar.gz" || true \
 && tar -xzf /tmp/mutagen.tar.gz -C /usr/local/bin 2>/dev/null || true \
 && rm -f /tmp/mutagen.tar.gz

# 4. Clone + build the engine (compiles native bindings for THIS Node ABI).
RUN git clone --depth 1 --branch ${ZEROS_REPO_REF} ${ZEROS_REPO_URL} /home/daytona/zeros
WORKDIR /home/daytona/zeros
RUN pnpm install --frozen-lockfile \
 && pnpm build:engine \
 && pnpm rebuild better-sqlite3 \
 && mkdir -p ${ZEROS_DATA_DIR}/workspaces

# 5. In-box launcher + egress probe.
COPY sandbox/start-engine.sh /usr/local/bin/start-engine.sh
COPY sandbox/egress-probe.sh /usr/local/bin/egress-probe.sh
RUN chmod +x /usr/local/bin/start-engine.sh /usr/local/bin/egress-probe.sh

# Keep the container alive; the engine is started as a managed process post-create.
ENTRYPOINT ["sleep", "infinity"]
