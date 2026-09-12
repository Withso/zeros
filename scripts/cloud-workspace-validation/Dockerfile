# ──────────────────────────────────────────────────────────
# zeros-engine-v1 — cloud-workspace validation Dockerfile
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
ARG ZEROS_NODE_BASE_IMAGE=node:22.23.1-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37
FROM ${ZEROS_NODE_BASE_IMAGE}

ARG ZEROS_NODE_BASE_IMAGE
ARG ZEROS_REPO_URL=https://github.com/withso/zeros.git
ARG ZEROS_REPO_REF=main
ARG ZEROS_REPO_COMMIT=
ARG PNPM_VERSION=10.28.0
ARG ZEROS_IMAGE_CONTRACT_SHA256=0000000000000000000000000000000000000000000000000000000000000000

ENV DEBIAN_FRONTEND=noninteractive \
    ZEROS_DATA_DIR=/var/lib/zeros \
    ZEROS_WORKSPACES_DIR=/var/lib/zeros/workspaces \
    ZEROS_REPO_DIR=/workspace/zeros \
    ZEROS_ENGINE_LOG=/var/log/zeros/engine.log \
    HOME=/home/zeros-agent \
    USER=zeros-agent \
    LOGNAME=zeros-agent \
    SHELL=/bin/bash \
    ZEROS_PTY_HOST_RUNTIME=/usr/local/bin/node \
    ZEROS_PTY_HOST_SCRIPT=/opt/zeros/apps/desktop/src/engine/pty/pty-host.cjs \
    ZEROS_CURSOR_HOST_SCRIPT=/opt/zeros/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs

# 1. OS toolchain and ZSR helpers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      acl bubblewrap busybox-static ca-certificates curl file g++ git git-lfs gnupg \
      inotify-tools make openssh-client podman procps python3 ripgrep \
      slirp4netns uidmap unzip util-linux xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 zeros-agent \
 && useradd --uid 10001 --gid 10001 --create-home \
      --home-dir /home/zeros-agent --shell /bin/bash zeros-agent \
 && usermod --add-subuids 100000-165535 --add-subgids 100000-165535 zeros-agent

# 2. Exact pnpm; no curl-piped installer or unattested optional runtime.
RUN npm install -g pnpm@${PNPM_VERSION}

# 3. Clone + build the engine (compiles native bindings for THIS Node ABI).
RUN if [ -n "$ZEROS_REPO_COMMIT" ]; then \
      case "$ZEROS_REPO_COMMIT" in \
        *[!0-9a-f]*) echo "invalid ZEROS_REPO_COMMIT" >&2; exit 1 ;; \
      esac; \
      if [ "${#ZEROS_REPO_COMMIT}" -ne 40 ] && [ "${#ZEROS_REPO_COMMIT}" -ne 64 ]; then \
        echo "ZEROS_REPO_COMMIT must be a full SHA-1 or SHA-256 id" >&2; exit 1; \
      fi; \
      git init /opt/zeros; \
      git -C /opt/zeros remote add origin "$ZEROS_REPO_URL"; \
      git -C /opt/zeros fetch --depth 1 origin "$ZEROS_REPO_COMMIT"; \
      git -C /opt/zeros checkout --detach "$ZEROS_REPO_COMMIT"; \
    else \
      git clone --depth 1 --branch "$ZEROS_REPO_REF" -- "$ZEROS_REPO_URL" /opt/zeros; \
    fi
WORKDIR /opt/zeros
RUN pnpm install --frozen-lockfile \
 && pnpm build:engine \
 && pnpm rebuild better-sqlite3 \
 && chmod -R go-w /opt/zeros \
 && git clone --no-hardlinks /opt/zeros /workspace/zeros \
 && git -C /workspace/zeros remote set-url origin "$ZEROS_REPO_URL" \
 && chown -R 10001:10001 /workspace/zeros \
 && find /workspace/zeros -type d -exec setfacl \
      -m u:zeros-agent:rwx,d:u:zeros-agent:rwx,d:m:rwx {} + \
 && find /workspace/zeros -type f -exec setfacl -m u:zeros-agent:rw- {} + \
 && mkdir -p /var/lib/zeros/workspaces /var/log/zeros /etc/zeros \
 && chown -R root:10001 /var/lib/zeros /var/log/zeros \
 && chmod 0750 /var/lib/zeros /var/lib/zeros/workspaces /var/log/zeros

# 5. In-box launcher + egress probe.
COPY sandbox/start-engine.sh /usr/local/bin/start-engine.sh
COPY sandbox/egress-probe.sh /usr/local/bin/egress-probe.sh
COPY sandbox/cloud-worker.json /etc/zeros/cloud-worker.json
COPY sandbox/write-image-build-metadata.mjs /usr/local/lib/zeros/write-image-build-metadata.mjs
COPY sandbox/attest-cloud-worker.mjs /usr/local/lib/zeros/attest-cloud-worker.mjs
COPY sandbox/consume-cloud-admission.mjs /usr/local/lib/zeros/consume-cloud-admission.mjs
COPY sandbox/install-cloud-preview-links.mjs /usr/local/lib/zeros/install-cloud-preview-links.mjs
COPY sandbox/install-cloud-github-credential.mjs /usr/local/lib/zeros/install-cloud-github-credential.mjs
COPY sandbox/cloud-github-refresh-request.mjs /usr/local/lib/zeros/cloud-github-refresh-request.mjs
COPY sandbox/cloud-git-askpass.mjs /usr/local/lib/zeros/cloud-git-askpass.mjs
COPY sandbox/cloud-worker-supervisor.mjs /usr/local/lib/zeros/cloud-worker-supervisor.mjs
COPY sandbox/setup-cloud-workspace.mjs /usr/local/lib/zeros/setup-cloud-workspace.mjs
RUN chown root:root /usr/local/bin/start-engine.sh \
      /usr/local/bin/egress-probe.sh \
      /usr/local/lib/zeros/write-image-build-metadata.mjs \
      /usr/local/lib/zeros/attest-cloud-worker.mjs \
      /usr/local/lib/zeros/consume-cloud-admission.mjs \
      /usr/local/lib/zeros/install-cloud-preview-links.mjs \
      /usr/local/lib/zeros/install-cloud-github-credential.mjs \
      /usr/local/lib/zeros/cloud-github-refresh-request.mjs \
      /usr/local/lib/zeros/cloud-git-askpass.mjs \
      /usr/local/lib/zeros/cloud-worker-supervisor.mjs \
      /usr/local/lib/zeros/setup-cloud-workspace.mjs \
      /etc/zeros/cloud-worker.json \
 && chmod 0755 /usr/local/bin/start-engine.sh /usr/local/bin/egress-probe.sh \
 && chmod 0555 /usr/local/lib/zeros/write-image-build-metadata.mjs \
      /usr/local/lib/zeros/attest-cloud-worker.mjs \
      /usr/local/lib/zeros/consume-cloud-admission.mjs \
      /usr/local/lib/zeros/install-cloud-preview-links.mjs \
      /usr/local/lib/zeros/install-cloud-github-credential.mjs \
      /usr/local/lib/zeros/cloud-github-refresh-request.mjs \
      /usr/local/lib/zeros/cloud-git-askpass.mjs \
      /usr/local/lib/zeros/cloud-worker-supervisor.mjs \
      /usr/local/lib/zeros/setup-cloud-workspace.mjs \
 && chmod 0644 /etc/zeros/cloud-worker.json \
 && /usr/local/bin/node /usr/local/lib/zeros/write-image-build-metadata.mjs \
      /etc/zeros/image-build.json "$ZEROS_NODE_BASE_IMAGE" "$ZEROS_REPO_URL" \
      "$ZEROS_REPO_REF" /opt/zeros "$ZEROS_IMAGE_CONTRACT_SHA256"

WORKDIR /workspace/zeros

# Keep the sandbox alive and launch engines only through a one-use root session.
ENTRYPOINT ["/usr/local/bin/node", "/usr/local/lib/zeros/cloud-worker-supervisor.mjs"]
