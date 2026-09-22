// ──────────────────────────────────────────────────────────
// zeros-engine-v1 — the Daytona cloud-validation image build spec
// ──────────────────────────────────────────────────────────
//
// A declarative Daytona `Image` that reproduces the Zeros engine runtime inside
// a linux/amd64 sandbox. Baked once into a registered Snapshot (bake-snapshot.ts)
// for warm-pool creates.
//
// The build (NOT the sandbox runtime) runs `pnpm install` + `pnpm build:engine`
// inside the box, so better-sqlite3 / node-pty compile against the box's Node
// ABI — there is NO Electron in a cloud sandbox, so the electron-rebuild ABI
// trap simply does not apply here. The engine runs under Node by default in the
// validation harness (every native loads under one ABI; PTY works in-process).
//
// What's baked:           Why:
//  • digest-pinned Node     real Node (engine + PTY/Cursor hosts; bun can't run those)
//  • bubblewrap + brokers   the qualified Linux ZSR backend
//  • git/GPG/LFS/toolchain  normal cloud-workspace development baseline
//  • immutable engine       root-owned at SANDBOX_ENGINE_DIR
//  • writable checkout      zeros-agent-owned at SANDBOX_REPO_DIR
// ──────────────────────────────────────────────────────────

import { Image } from "@daytona/sdk";
import {
  NODE_BASE_IMAGE,
  ZEROS_REPO_URL,
  ZEROS_REPO_REF,
  ZEROS_REPO_COMMIT,
  SANDBOX_AGENT_GID,
  SANDBOX_AGENT_UID,
  SANDBOX_AGENT_HOME,
  SANDBOX_CAPTURE_HOME,
  SANDBOX_ENGINE_DIR,
  SANDBOX_ENGINE_LOG,
  SANDBOX_REPO_DIR,
  SANDBOX_DATA_DIR,
  imageContractSha256,
} from "./config";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const PNPM_VERSION = "10.28.0";

function shellQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("cloud image input contains a forbidden control character");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildEngineImage(options: {sourceCommit?:string} = {}): Image {
  if (!/@sha256:[a-f0-9]{64}$/.test(NODE_BASE_IMAGE)) {
    throw new Error(
      "ZEROS_NODE_BASE_IMAGE must include an immutable sha256 digest",
    );
  }
  const repositoryUrl = shellQuote(ZEROS_REPO_URL);
  const repositoryRef = shellQuote(ZEROS_REPO_REF);
  const sourceCommit=options.sourceCommit??ZEROS_REPO_COMMIT;
  if(sourceCommit&&!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit))throw new Error("Cloud image source commit is invalid");
  const repositoryCommit = sourceCommit
    ? shellQuote(sourceCommit)
    : null;
  const baseImage = shellQuote(NODE_BASE_IMAGE);
  const imageContract = shellQuote(imageContractSha256());
  const engineDirectory = shellQuote(SANDBOX_ENGINE_DIR);
  const workspaceDirectory = shellQuote(SANDBOX_REPO_DIR);

  return (
    Image.base(NODE_BASE_IMAGE)
      // Stable, path-derivable env baked into the image. The cloud port + token,
      // and any agent creds, are injected per-sandbox at create() — never baked
      // (a baked secret is readable by any context-injected agent in the box).
      .env({
        ZEROS_DATA_DIR: SANDBOX_DATA_DIR,
        ZEROS_WORKSPACES_DIR: `${SANDBOX_DATA_DIR}/workspaces`,
        ZEROS_REPO_DIR: SANDBOX_REPO_DIR,
        ZEROS_ENGINE_LOG: SANDBOX_ENGINE_LOG,
        HOME: SANDBOX_AGENT_HOME,
        USER: "zeros-agent",
        LOGNAME: "zeros-agent",
        SHELL: "/bin/bash",
        // Runtime roots must come from the immutable engine installation, not
        // the agent-writable checkout being served.
        ZEROS_PTY_HOST_RUNTIME: "/opt/zeros-runtime/bin/node",
        ZEROS_PTY_HOST_SCRIPT: `${SANDBOX_ENGINE_DIR}/apps/desktop/src/engine/pty/pty-host.cjs`,
        ZEROS_CURSOR_HOST_SCRIPT: `${SANDBOX_ENGINE_DIR}/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs`,
        DEBIAN_FRONTEND: "noninteractive",
      })
      .runCommands(
        // 1. OS toolchain and the exact helper families required by the ZSR
        //    admission canary. The baked attestation records resolved package
        //    versions; the snapshot digest is the deployment identity.
        "apt-get update",
        "apt-get install -y --no-install-recommends acl apparmor bubblewrap busybox-static ca-certificates crun curl file g++ git git-lfs gnupg inotify-tools make openssh-client openssh-sftp-server podman procps python3 ripgrep slirp4netns socat uidmap unzip util-linux xz-utils",
        "rm -rf /var/lib/apt/lists/*",
        `groupadd --gid ${SANDBOX_AGENT_GID} zeros-agent`,
        "install -d -o root -g root -m 0755 /srv/zeros /srv/zeros/home",
        `useradd --uid ${SANDBOX_AGENT_UID} --gid ${SANDBOX_AGENT_GID} --create-home --home-dir ${SANDBOX_AGENT_HOME} --shell /bin/bash zeros-agent`,
        "groupadd --gid 10002 zeros-capture",
        `useradd --uid 10002 --gid 10002 --create-home --home-dir ${SANDBOX_CAPTURE_HOME} --shell /usr/sbin/nologin zeros-capture`,
        `chmod 0700 ${SANDBOX_CAPTURE_HOME}`,
        "groupadd --gid 10003 zeros-engine",
        "useradd --uid 10003 --gid 10003 --no-create-home --shell /usr/sbin/nologin zeros-engine",
        "groupadd --gid 10004 zeros-coordinator",
        "useradd --uid 10004 --gid 10004 --no-create-home --shell /usr/sbin/nologin zeros-coordinator",
        "install -D -o root -g root -m 0755 /usr/local/bin/node /opt/zeros-runtime/bin/node",
        "usermod --add-subuids 100000-165535 --add-subgids 100000-165535 zeros-agent",
        // 2. Exact pnpm version (matches packageManager). No curl-piped
        //    installer or unattested optional runtime enters the image.
        `npm install -g pnpm@${PNPM_VERSION}`,
        // 3. Build a root-owned immutable engine. `pnpm install` compiles the
        //    native bindings for this image's Node ABI (no Electron here).
        ...(repositoryCommit
          ? [
              `git init ${engineDirectory}`,
              `git -C ${engineDirectory} remote add origin ${repositoryUrl}`,
              `git -C ${engineDirectory} fetch --depth 1 origin ${repositoryCommit}`,
              `git -C ${engineDirectory} checkout --detach ${repositoryCommit}`,
            ]
          : [
              `git clone --depth 1 --branch ${repositoryRef} -- ${repositoryUrl} ${engineDirectory}`,
            ]),
        `cd ${engineDirectory} && pnpm install --frozen-lockfile`,
        `cd ${engineDirectory} && pnpm build:zsr-supervisor`,
        `cd ${engineDirectory} && pnpm build:engine`,
        `cc -std=c11 -O2 -Wall -Wextra -Werror ${engineDirectory}/apps/desktop/src/engine/agents/containment/cloud-process-supervisor.c -o /opt/zeros-runtime/cloud-process-supervisor`,
        "chmod 0555 /opt/zeros-runtime/cloud-process-supervisor",
        // Pinned Playwright browser revision, installed read-only outside every
        // writable workspace. Capture runs as its own UID with Chromium sandboxing.
        `cd ${engineDirectory} && PLAYWRIGHT_BROWSERS_PATH=/opt/zeros/design-browsers pnpm exec playwright-core install --with-deps chromium`,
        // Ensure the SQLite binding matches the box Node. A failed rebuild is a
        // broken engine image, so image creation must stop here.
        `cd ${engineDirectory} && pnpm rebuild better-sqlite3`,
        `chmod -R go-w ${engineDirectory}`,
        // 4. Seed a physically separate writable checkout. Its origin retains
        //    the operator-selected URL even though the local clone avoids a
        //    second network transfer.
        `git clone --no-hardlinks ${engineDirectory} ${workspaceDirectory}`,
        `git -C ${workspaceDirectory} remote set-url origin ${repositoryUrl}`,
        `chown -R ${SANDBOX_AGENT_UID}:${SANDBOX_AGENT_GID} ${workspaceDirectory}`,
        `find ${workspaceDirectory} -type d -exec setfacl -m u:zeros-agent:rwx,d:u:zeros-agent:rwx,d:m:rwx {} +`,
        `find ${workspaceDirectory} -type f -exec setfacl -m u:zeros-agent:rw- {} +`,
        `mkdir -p ${SANDBOX_DATA_DIR}/workspaces /srv/zeros/log /etc/zeros`,
        `chown -R 10003:10003 ${SANDBOX_DATA_DIR}`,
        `chmod 0700 ${SANDBOX_DATA_DIR} ${SANDBOX_DATA_DIR}/workspaces`,
        "chown root:10001 /srv/zeros/log && chmod 0750 /srv/zeros/log",
        "install -d -o root -g root -m 0700 /srv/zeros/setup",
        "install -d -o root -g 10001 -m 0750 /srv/zeros/managed-settings",
        "install -o root -g 10001 -m 0640 /dev/null /srv/zeros/managed-settings/settings.managed.toml",
      )
      // Bake the launcher, egress probe, and immutable activation marker.
      .addLocalFile(
        path.join(here, "sandbox", "start-engine.sh"),
        "/opt/zeros-runtime/bin/start-engine.sh",
      )
      .addLocalFile(
        path.join(here, "sandbox", "egress-probe.sh"),
        "/opt/zeros-runtime/bin/egress-probe.sh",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-worker.json"),
        "/etc/zeros/cloud-worker.json",
      )
      .addLocalFile(
        path.join(here, "sandbox", "runtime-layout.json"),
        "/opt/zeros-runtime/lib/zeros/runtime-layout.json",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-setup-process.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-setup-process.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "image-build-contract.mjs"),
        "/opt/zeros-runtime/lib/zeros/image-build-contract.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-resource-admission.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-resource-admission.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cgroup-resources.mjs"),
        "/opt/zeros-runtime/lib/zeros/cgroup-resources.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-runtime-profile.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-runtime-profile.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-engine-cgroup.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-engine-view.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-engine-view.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-engine-launcher.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-engine-namespace.c"),
        "/tmp/cloud-engine-namespace.c",
      )
      .addLocalFile(
        path.join(here, "sandbox", "zeros-cloud-engine.apparmor"),
        "/opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor",
      )
      .addLocalFile(
        path.join(here, "sandbox", "write-image-build-metadata.mjs"),
        "/opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "attest-cloud-worker.mjs"),
        "/opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "consume-cloud-admission.mjs"),
        "/opt/zeros-runtime/lib/zeros/consume-cloud-admission.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "install-cloud-preview-links.mjs"),
        "/opt/zeros-runtime/lib/zeros/install-cloud-preview-links.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "install-cloud-github-credential.mjs"),
        "/opt/zeros-runtime/lib/zeros/install-cloud-github-credential.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-github-refresh-request.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-github-refresh-request.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-git-askpass.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-git-askpass.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "ensure-cloud-worker-supervisor.mjs"),
        "/opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-worker-supervisor.mjs"),
        "/opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "setup-cloud-workspace.mjs"),
        "/opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs",
      )
      .runCommands(
        "chown root:root /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs /opt/zeros-runtime/bin/start-engine.sh /opt/zeros-runtime/bin/egress-probe.sh /opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs /opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs /opt/zeros-runtime/lib/zeros/consume-cloud-admission.mjs /opt/zeros-runtime/lib/zeros/install-cloud-preview-links.mjs /opt/zeros-runtime/lib/zeros/install-cloud-github-credential.mjs /opt/zeros-runtime/lib/zeros/cloud-github-refresh-request.mjs /opt/zeros-runtime/lib/zeros/cloud-git-askpass.mjs /opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs /etc/zeros/cloud-worker.json",
        "chmod 0755 /opt/zeros-runtime/bin/start-engine.sh /opt/zeros-runtime/bin/egress-probe.sh",
        "chmod 0555 /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs /opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs /opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs /opt/zeros-runtime/lib/zeros/consume-cloud-admission.mjs /opt/zeros-runtime/lib/zeros/install-cloud-preview-links.mjs /opt/zeros-runtime/lib/zeros/install-cloud-github-credential.mjs /opt/zeros-runtime/lib/zeros/cloud-github-refresh-request.mjs /opt/zeros-runtime/lib/zeros/cloud-git-askpass.mjs /opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs",
        "cc -std=c11 -O2 -Wall -Wextra -Werror /tmp/cloud-engine-namespace.c -o /opt/zeros-runtime/cloud-engine-namespace && chmod 0500 /opt/zeros-runtime/cloud-engine-namespace && rm /tmp/cloud-engine-namespace.c",
        "chown root:root /opt/zeros-runtime/lib/zeros/cloud-runtime-profile.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-view.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs && chmod 0444 /opt/zeros-runtime/lib/zeros/cloud-runtime-profile.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-view.mjs /opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs",
        "chmod 0644 /etc/zeros/cloud-worker.json",
        "chown root:root /opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor && chmod 0444 /opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor",
        "chown root:root /opt/zeros-runtime/lib/zeros/runtime-layout.json && chmod 0444 /opt/zeros-runtime/lib/zeros/runtime-layout.json",
        "chown root:root /opt/zeros-runtime/lib/zeros/cgroup-resources.mjs && chmod 0444 /opt/zeros-runtime/lib/zeros/cgroup-resources.mjs",
        `/opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs /etc/zeros/image-build.json ${baseImage} ${repositoryUrl} ${repositoryRef} ${engineDirectory} ${imageContract}`,
      )
      .workdir(SANDBOX_REPO_DIR)
      // Root-owned PID 1 keeps the sandbox alive and is the only component
      // allowed to turn a one-use setup session into a persistent engine.
      .entrypoint([
        "/opt/zeros-runtime/bin/node",
        "/opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs",
      ])
  );
}
