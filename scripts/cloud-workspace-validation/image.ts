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

export function buildEngineImage(): Image {
  if (!/@sha256:[a-f0-9]{64}$/.test(NODE_BASE_IMAGE)) {
    throw new Error(
      "ZEROS_NODE_BASE_IMAGE must include an immutable sha256 digest",
    );
  }
  const repositoryUrl = shellQuote(ZEROS_REPO_URL);
  const repositoryRef = shellQuote(ZEROS_REPO_REF);
  const repositoryCommit = ZEROS_REPO_COMMIT
    ? shellQuote(ZEROS_REPO_COMMIT)
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
        HOME: "/home/zeros-agent",
        USER: "zeros-agent",
        LOGNAME: "zeros-agent",
        SHELL: "/bin/bash",
        // Runtime roots must come from the immutable engine installation, not
        // the agent-writable checkout being served.
        ZEROS_PTY_HOST_RUNTIME: "/usr/local/bin/node",
        ZEROS_PTY_HOST_SCRIPT: `${SANDBOX_ENGINE_DIR}/apps/desktop/src/engine/pty/pty-host.cjs`,
        ZEROS_CURSOR_HOST_SCRIPT: `${SANDBOX_ENGINE_DIR}/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs`,
        DEBIAN_FRONTEND: "noninteractive",
      })
      .runCommands(
        // 1. OS toolchain and the exact helper families required by the ZSR
        //    admission canary. The baked attestation records resolved package
        //    versions; the snapshot digest is the deployment identity.
        "apt-get update",
        "apt-get install -y --no-install-recommends acl bubblewrap busybox-static ca-certificates curl file g++ git git-lfs gnupg inotify-tools make openssh-client podman procps python3 ripgrep slirp4netns uidmap unzip util-linux xz-utils",
        "rm -rf /var/lib/apt/lists/*",
        `groupadd --gid ${SANDBOX_AGENT_GID} zeros-agent`,
        `useradd --uid ${SANDBOX_AGENT_UID} --gid ${SANDBOX_AGENT_GID} --create-home --home-dir /home/zeros-agent --shell /bin/bash zeros-agent`,
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
        `cd ${engineDirectory} && pnpm build:engine`,
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
        `mkdir -p ${SANDBOX_DATA_DIR}/workspaces /var/log/zeros /etc/zeros`,
        `chown -R root:${SANDBOX_AGENT_GID} ${SANDBOX_DATA_DIR} /var/log/zeros`,
        `chmod 0750 ${SANDBOX_DATA_DIR} ${SANDBOX_DATA_DIR}/workspaces /var/log/zeros`,
      )
      // Bake the launcher, egress probe, and immutable activation marker.
      .addLocalFile(
        path.join(here, "sandbox", "start-engine.sh"),
        "/usr/local/bin/start-engine.sh",
      )
      .addLocalFile(
        path.join(here, "sandbox", "egress-probe.sh"),
        "/usr/local/bin/egress-probe.sh",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-worker.json"),
        "/etc/zeros/cloud-worker.json",
      )
      .addLocalFile(
        path.join(here, "sandbox", "write-image-build-metadata.mjs"),
        "/usr/local/lib/zeros/write-image-build-metadata.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "attest-cloud-worker.mjs"),
        "/usr/local/lib/zeros/attest-cloud-worker.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "consume-cloud-admission.mjs"),
        "/usr/local/lib/zeros/consume-cloud-admission.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "install-cloud-preview-links.mjs"),
        "/usr/local/lib/zeros/install-cloud-preview-links.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "install-cloud-github-credential.mjs"),
        "/usr/local/lib/zeros/install-cloud-github-credential.mjs",
      )
      .addLocalFile(
        path.join(here, "sandbox", "cloud-github-refresh-request.mjs"),
        "/usr/local/lib/zeros/cloud-github-refresh-request.mjs",
      )
      .runCommands(
        "chown root:root /usr/local/bin/start-engine.sh /usr/local/bin/egress-probe.sh /usr/local/lib/zeros/write-image-build-metadata.mjs /usr/local/lib/zeros/attest-cloud-worker.mjs /usr/local/lib/zeros/consume-cloud-admission.mjs /usr/local/lib/zeros/install-cloud-preview-links.mjs /usr/local/lib/zeros/install-cloud-github-credential.mjs /usr/local/lib/zeros/cloud-github-refresh-request.mjs /etc/zeros/cloud-worker.json",
        "chmod 0755 /usr/local/bin/start-engine.sh /usr/local/bin/egress-probe.sh",
        "chmod 0555 /usr/local/lib/zeros/write-image-build-metadata.mjs /usr/local/lib/zeros/attest-cloud-worker.mjs /usr/local/lib/zeros/consume-cloud-admission.mjs /usr/local/lib/zeros/install-cloud-preview-links.mjs /usr/local/lib/zeros/install-cloud-github-credential.mjs /usr/local/lib/zeros/cloud-github-refresh-request.mjs",
        "chmod 0644 /etc/zeros/cloud-worker.json",
        `/usr/local/bin/node /usr/local/lib/zeros/write-image-build-metadata.mjs /etc/zeros/image-build.json ${baseImage} ${repositoryUrl} ${repositoryRef} ${engineDirectory} ${imageContract}`,
      )
      .workdir(SANDBOX_REPO_DIR)
      // Keep the container alive; provision.ts starts the engine as a managed
      // session process so an engine crash does not stop the container.
      .entrypoint(["sleep", "infinity"])
  );
}
