// ──────────────────────────────────────────────────────────
// zeros-engine-v0 — the Daytona image build spec (Phase 1 spike)
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
// spike (every native loads under one ABI; PTY works in-process); `bun` is also
// baked so Phase 6 can flip the runtime via start-engine.sh.
//
// What's baked:           Why:
//  • node:22-bookworm      real Node (engine + PTY host + Cursor host; bun can't run those)
//  • bun                   the eventual engine runtime (§2.2)
//  • git, openssh, curl     git-clone seeding + Mutagen's scp/ssh agent injection (Phase 3)
//  • python3/make/g++       node-gyp, to compile the native bindings from source
//  • Mutagen + agents       the Phase 3 file-mirror (baked now so Phase 3 doesn't re-bake)
//  • the 3 agent SDKs       brought in by the repo's own `pnpm install` (Phase 6 pins CLIs)
//  • the Zeros engine       cloned + built at SANDBOX_REPO_DIR; served on 0.0.0.0
// ──────────────────────────────────────────────────────────

import { Image } from "@daytona/sdk";
import {
  NODE_BASE_IMAGE,
  ZEROS_REPO_URL,
  ZEROS_REPO_REF,
  SANDBOX_REPO_DIR,
  SANDBOX_DATA_DIR,
} from "./config";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Pin Mutagen to a known-good release (MIT-buildable; we use the official
 *  linux-amd64 binary for the spike — an MIT-only embeddable build is a Phase 3
 *  concern). */
const MUTAGEN_VERSION = "0.18.1";
const PNPM_VERSION = "10.28.0";

export function buildEngineImage(): Image {
  return (
    Image.base(NODE_BASE_IMAGE)
      // Stable, path-derivable env baked into the image. The cloud port + token,
      // and any agent creds, are injected per-sandbox at create() — never baked
      // (a baked secret is readable by any context-injected agent in the box).
      .env({
        ZEROS_DATA_DIR: SANDBOX_DATA_DIR,
        ZEROS_WORKSPACES_DIR: `${SANDBOX_DATA_DIR}/workspaces`,
        // PTY/Cursor hosts (for the eventual bun runtime). Harmless under Node.
        ZEROS_PTY_HOST_RUNTIME: "/usr/local/bin/node",
        ZEROS_PTY_HOST_SCRIPT: `${SANDBOX_REPO_DIR}/src/engine/pty/pty-host.cjs`,
        ZEROS_CURSOR_HOST_SCRIPT: `${SANDBOX_REPO_DIR}/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs`,
        DEBIAN_FRONTEND: "noninteractive",
      })
      .runCommands(
        // 1. OS toolchain.
        "apt-get update",
        "apt-get install -y --no-install-recommends git openssh-client curl ca-certificates python3 make g++ unzip xz-utils procps",
        "rm -rf /var/lib/apt/lists/*",
        // 2. bun (the eventual engine runtime) + pnpm (matches packageManager).
        "curl -fsSL https://bun.sh/install | bash",
        "ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
        `npm install -g pnpm@${PNPM_VERSION}`,
        // 3. Mutagen + its agent bundle (Phase 3 file-mirror). Best-effort: the
        //    spike's exit criterion doesn't need it, so a release-URL hiccup
        //    must not fail the bake.
        `curl -fsSL -o /tmp/mutagen.tar.gz https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_linux_amd64_v${MUTAGEN_VERSION}.tar.gz || true`,
        "tar -xzf /tmp/mutagen.tar.gz -C /usr/local/bin 2>/dev/null || true",
        "rm -f /tmp/mutagen.tar.gz",
        // 4. Clone + build the engine. `pnpm install` compiles the native
        //    bindings for THIS box's Node ABI (no Electron here). Shallow clone of
        //    the pinned ref keeps the bake fast.
        `git clone --depth 1 --branch ${ZEROS_REPO_REF} ${ZEROS_REPO_URL} ${SANDBOX_REPO_DIR}`,
        `cd ${SANDBOX_REPO_DIR} && pnpm install --frozen-lockfile`,
        `cd ${SANDBOX_REPO_DIR} && pnpm build:engine`,
        // Belt-and-suspenders: ensure the SQLite binding matches the box Node.
        `cd ${SANDBOX_REPO_DIR} && pnpm rebuild better-sqlite3 || true`,
        // 5. Pre-create the data dir so the first engine boot doesn't race mkdir.
        `mkdir -p ${SANDBOX_DATA_DIR}/workspaces`,
      )
      // Bake the in-box launcher + egress probe (uploaded from ./sandbox/).
      .addLocalFile(path.join(here, "sandbox", "start-engine.sh"), "/usr/local/bin/start-engine.sh")
      .addLocalFile(path.join(here, "sandbox", "egress-probe.sh"), "/usr/local/bin/egress-probe.sh")
      .runCommands("chmod +x /usr/local/bin/start-engine.sh /usr/local/bin/egress-probe.sh")
      .workdir(SANDBOX_REPO_DIR)
      // Keep the container alive; provision.ts starts the engine as a managed
      // session process so an engine crash ≠ container death (§2.2).
      .entrypoint(["sleep", "infinity"])
  );
}
