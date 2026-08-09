// ──────────────────────────────────────────────────────────
// electron-builder beforePack hook — targeted native rebuild
// ──────────────────────────────────────────────────────────
//
// better-sqlite3 uses the V8 ABI, so the copy shipped in the app must be built
// for Electron. node-pty uses N-API and ships tested Darwin prebuilds. A blanket
// rebuild creates a higher-priority build/ tree whose contents depend on local
// SDK/cache state, so npmRebuild is disabled and this hook invokes the repo's
// strict better-sqlite3-only rebuild before selecting node-pty's prebuild.
// ──────────────────────────────────────────────────────────

const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, rmSync } = require("node:fs");
const path = require("node:path");

const ARCH_BY_ENUM = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
};

/** @type {import("electron-builder").BeforePackContext => Promise<void>} */
exports.default = async function beforePack(context) {
  // The app currently ships macOS arm64 only. Fail loudly if a future
  // cross-architecture target reuses this hook: electron-rebuild runs for the
  // host architecture unless explicitly taught otherwise, and silently
  // packaging that output would recreate an ABI failure for users.
  const targetArch = ARCH_BY_ENUM[context.arch] || String(context.arch);
  if (targetArch !== process.arch) {
    throw new Error(
      `targeted native rebuild requires a ${targetArch} host (running on ${process.arch})`,
    );
  }

  const projectDir = context.packager.projectDir;
  const script = path.join(
    projectDir,
    "scripts",
    "electron-rebuild-sqlite.cjs",
  );
  console.log(
    `[beforePack] rebuilding better-sqlite3 only (${context.electronPlatformName}/${targetArch}); preserving node-pty prebuild`,
  );
  execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });

  // node-pty checks build/Release BEFORE prebuilds/darwin-<arch>. A previous
  // electron-builder run can leave source-built output in node_modules, so
  // npmRebuild:false alone would still make the fallback copy cache-dependent.
  // Remove that override and verify the prebuild pair copied to Resources.
  const nodePtyRoot = path.dirname(
    require.resolve("node-pty/package.json", { paths: [projectDir] }),
  );
  const prebuildDir = path.join(
    nodePtyRoot,
    "prebuilds",
    `darwin-${targetArch}`,
  );
  const addon = path.join(prebuildDir, "pty.node");
  const helper = path.join(prebuildDir, "spawn-helper");
  for (const required of [addon, helper]) {
    if (!existsSync(required)) {
      throw new Error(`node-pty Darwin prebuild is missing: ${required}`);
    }
  }
  rmSync(path.join(nodePtyRoot, "build"), { recursive: true, force: true });
  // pnpm extraction can strip the helper's executable bit. Packaging preserves
  // this mode, and node-pty's native addon cannot spawn without it.
  chmodSync(helper, 0o755);
  console.log(
    `[beforePack] selected node-pty ${path.basename(prebuildDir)} prebuild and removed stale build/ overrides`,
  );

  // Stage the Claude Code CLI to binaries/claude so electron-builder's
  // extraResources entry can name a stable, version-free path. The SDK's own
  // `createRequire(sdk.mjs).resolve('<platform-pkg>/claude')` lookup cannot work
  // in the packaged app (the engine is a bun-compiled single-file binary with no
  // node_modules), so without this the packaged app throws "Native CLI binary for
  // darwin-arm64 not found" on EVERY send while dev works fine. Run here rather
  // than in the `electron:build` script so ANY packaging entrypoint gets it —
  // release.yml invokes electron-builder directly, bypassing the wrapper script.
  // The stage script fails loud; shipping a Claude-less build is the exact defect
  // it exists to prevent.
  execFileSync(
    process.execPath,
    [path.join(projectDir, "scripts", "stage-claude-cli.mjs")],
    { cwd: projectDir, env: process.env, stdio: "inherit" },
  );

  // Codex has the same compiled-engine/node_modules boundary. Stage its whole
  // native vendor target (main binary + code-mode host + ripgrep/resources),
  // then sidecar.ts supplies the pinned executable and version to the engine.
  execFileSync(
    process.execPath,
    [path.join(projectDir, "scripts", "stage-codex-cli.mjs")],
    { cwd: projectDir, env: process.env, stdio: "inherit" },
  );
};
