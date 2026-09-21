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
    ZEROS_DATA_DIR=/srv/zeros/state \
    ZEROS_WORKSPACES_DIR=/srv/zeros/state/workspaces \
    ZEROS_REPO_DIR=/srv/zeros/workspace \
    ZEROS_ENGINE_LOG=/srv/zeros/log/engine.log \
    HOME=/srv/zeros/home/agent \
    USER=zeros-agent \
    LOGNAME=zeros-agent \
    SHELL=/bin/bash \
    ZEROS_PTY_HOST_RUNTIME=/opt/zeros-runtime/bin/node \
    ZEROS_PTY_HOST_SCRIPT=/opt/zeros/apps/desktop/src/engine/pty/pty-host.cjs \
    ZEROS_CURSOR_HOST_SCRIPT=/opt/zeros/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs

# 1. OS toolchain and ZSR helpers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      acl apparmor bubblewrap busybox-static ca-certificates crun curl file g++ git git-lfs gnupg \
      inotify-tools make openssh-client openssh-sftp-server podman procps python3 ripgrep \
      slirp4netns socat uidmap unzip util-linux xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 zeros-agent \
 && install -d -o root -g root -m 0755 /srv/zeros /srv/zeros/home \
 && useradd --uid 10001 --gid 10001 --create-home \
      --home-dir /srv/zeros/home/agent --shell /bin/bash zeros-agent \
 && usermod --add-subuids 100000-165535 --add-subgids 100000-165535 zeros-agent \
 && groupadd --gid 10002 zeros-capture \
 && useradd --uid 10002 --gid 10002 --create-home \
      --home-dir /srv/zeros/home/capture --shell /usr/sbin/nologin zeros-capture \
 && chmod 0700 /srv/zeros/home/capture \
 && groupadd --gid 10003 zeros-engine \
 && useradd --uid 10003 --gid 10003 --no-create-home --shell /usr/sbin/nologin zeros-engine \
 && groupadd --gid 10004 zeros-coordinator \
 && useradd --uid 10004 --gid 10004 --no-create-home --shell /usr/sbin/nologin zeros-coordinator \
 && install -D -o root -g root -m 0755 /usr/local/bin/node /opt/zeros-runtime/bin/node

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
 && pnpm build:zsr-supervisor \
 && pnpm build:engine \
 && cc -std=c11 -O2 -Wall -Wextra -Werror apps/desktop/src/engine/agents/containment/cloud-process-supervisor.c -o /opt/zeros-runtime/cloud-process-supervisor \
 && chmod 0555 /opt/zeros-runtime/cloud-process-supervisor \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/zeros/design-browsers pnpm exec playwright-core install --with-deps chromium \
 && pnpm rebuild better-sqlite3 \
 && chmod -R go-w /opt/zeros \
 && git clone --no-hardlinks /opt/zeros /srv/zeros/workspace \
 && git -C /srv/zeros/workspace remote set-url origin "$ZEROS_REPO_URL" \
 && chown -R 10001:10001 /srv/zeros/workspace \
 && find /srv/zeros/workspace -type d -exec setfacl \
      -m u:zeros-agent:rwx,d:u:zeros-agent:rwx,d:m:rwx {} + \
 && find /srv/zeros/workspace -type f -exec setfacl -m u:zeros-agent:rw- {} + \
 && mkdir -p /srv/zeros/state/workspaces /srv/zeros/log /etc/zeros \
 && chown -R 10003:10003 /srv/zeros/state \
 && chmod 0700 /srv/zeros/state /srv/zeros/state/workspaces \
 && chown root:10001 /srv/zeros/log \
 && chmod 0750 /srv/zeros/log \
 && install -d -o root -g root -m 0700 /srv/zeros/setup \
 && install -d -o root -g 10001 -m 0750 /srv/zeros/managed-settings \
 && install -o root -g 10001 -m 0640 /dev/null /srv/zeros/managed-settings/settings.managed.toml

# 5. In-box launcher + egress probe.
COPY sandbox/start-engine.sh /opt/zeros-runtime/bin/start-engine.sh
COPY sandbox/egress-probe.sh /opt/zeros-runtime/bin/egress-probe.sh
COPY sandbox/cloud-worker.json /etc/zeros/cloud-worker.json
COPY sandbox/runtime-layout.json /opt/zeros-runtime/lib/zeros/runtime-layout.json
COPY sandbox/cgroup-resources.mjs /opt/zeros-runtime/lib/zeros/cgroup-resources.mjs
COPY sandbox/cloud-resource-admission.mjs /opt/zeros-runtime/lib/zeros/cloud-resource-admission.mjs
COPY sandbox/image-build-contract.mjs /opt/zeros-runtime/lib/zeros/image-build-contract.mjs
COPY sandbox/cloud-setup-process.mjs /opt/zeros-runtime/lib/zeros/cloud-setup-process.mjs
COPY sandbox/cloud-runtime-profile.mjs /opt/zeros-runtime/lib/zeros/cloud-runtime-profile.mjs
COPY sandbox/cloud-engine-cgroup.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs
COPY sandbox/cloud-engine-view.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-view.mjs
COPY sandbox/cloud-engine-launcher.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs
COPY sandbox/cloud-engine-namespace.c /tmp/cloud-engine-namespace.c
COPY sandbox/zeros-cloud-engine.apparmor /opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor
RUN cc -std=c11 -O2 -Wall -Wextra -Werror /tmp/cloud-engine-namespace.c -o /opt/zeros-runtime/cloud-engine-namespace \
 && chmod 0500 /opt/zeros-runtime/cloud-engine-namespace \
 && rm /tmp/cloud-engine-namespace.c
COPY sandbox/write-image-build-metadata.mjs /opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs
COPY sandbox/attest-cloud-worker.mjs /opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs
COPY sandbox/consume-cloud-admission.mjs /opt/zeros-runtime/lib/zeros/consume-cloud-admission.mjs
COPY sandbox/install-cloud-preview-links.mjs /opt/zeros-runtime/lib/zeros/install-cloud-preview-links.mjs
COPY sandbox/install-cloud-github-credential.mjs /opt/zeros-runtime/lib/zeros/install-cloud-github-credential.mjs
COPY sandbox/cloud-github-refresh-request.mjs /opt/zeros-runtime/lib/zeros/cloud-github-refresh-request.mjs
COPY sandbox/cloud-git-askpass.mjs /opt/zeros-runtime/lib/zeros/cloud-git-askpass.mjs
COPY sandbox/ensure-cloud-worker-supervisor.mjs /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs
COPY sandbox/cloud-worker-supervisor.mjs /opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs
COPY sandbox/setup-cloud-workspace.mjs /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs
RUN chown root:root /opt/zeros-runtime/bin/start-engine.sh \
      /opt/zeros-runtime/bin/egress-probe.sh \
      /opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs \
      /opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs \
      /opt/zeros-runtime/lib/zeros/consume-cloud-admission.mjs \
      /opt/zeros-runtime/lib/zeros/install-cloud-preview-links.mjs \
      /opt/zeros-runtime/lib/zeros/install-cloud-github-credential.mjs \
      /opt/zeros-runtime/lib/zeros/cloud-github-refresh-request.mjs \
      /opt/zeros-runtime/lib/zeros/cloud-git-askpass.mjs \
      /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs \
      /opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs \
      /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs \
      /etc/zeros/cloud-worker.json \
 && chmod 0755 /opt/zeros-runtime/bin/start-engine.sh /opt/zeros-runtime/bin/egress-probe.sh \
 && chmod 0555 /opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs \
      /opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs \
      /opt/zeros-runtime/lib/zeros/consume-cloud-admission.mjs \
      /opt/zeros-runtime/lib/zeros/install-cloud-preview-links.mjs \
      /opt/zeros-runtime/lib/zeros/install-cloud-github-credential.mjs \
      /opt/zeros-runtime/lib/zeros/cloud-github-refresh-request.mjs \
      /opt/zeros-runtime/lib/zeros/cloud-git-askpass.mjs \
      /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs \
      /opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs \
      /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs \
 && chmod 0644 /etc/zeros/cloud-worker.json \
 && chown root:root /opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor \
 && chmod 0444 /opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor \
 && chown root:root /opt/zeros-runtime/lib/zeros/runtime-layout.json \
 && chmod 0444 /opt/zeros-runtime/lib/zeros/runtime-layout.json \
 && chown root:root /opt/zeros-runtime/lib/zeros/cgroup-resources.mjs \
 && chmod 0444 /opt/zeros-runtime/lib/zeros/cgroup-resources.mjs \
 && chown root:root /opt/zeros-runtime/lib/zeros/cloud-runtime-profile.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-view.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs \
 && chmod 0444 /opt/zeros-runtime/lib/zeros/cloud-runtime-profile.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-view.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs \
 && /opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs \
      /etc/zeros/image-build.json "$ZEROS_NODE_BASE_IMAGE" "$ZEROS_REPO_URL" \
      "$ZEROS_REPO_REF" /opt/zeros "$ZEROS_IMAGE_CONTRACT_SHA256" \
 && rm -f /opt/zeros/.git/index

WORKDIR /srv/zeros/workspace

# Keep the sandbox alive and launch engines only through a one-use root session.
ENTRYPOINT ["/opt/zeros-runtime/bin/node", "/opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs"]
