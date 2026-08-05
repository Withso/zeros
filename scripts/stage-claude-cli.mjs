#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// stage-claude-cli — put the Claude Code CLI where the packaged app can run it
// ──────────────────────────────────────────────────────────
//
// `@anthropic-ai/claude-agent-sdk` ships NO cli.js. The real `claude` executable
// lives in a platform-specific OPTIONAL dependency
// (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, ~245 MiB), which pnpm
// links as a SIBLING of sdk.mjs inside the virtual store
// (`.pnpm/@anthropic-ai+claude-agent-sdk@<v>/node_modules/@anthropic-ai/…`) and
// never hoists to the root `node_modules/@anthropic-ai/`. The SDK finds it with
// `createRequire(sdk.mjs).resolve('<pkg>/claude')`.
//
// That lookup is IMPOSSIBLE in the packaged app: the engine is a
// `bun build --compile` single-file binary (scripts/build-sidecar.mjs), so
// sdk.mjs is bundled in, `import.meta.url` points into bun's `$bunfs`, and there
// is no node_modules on disk to walk. The SDK then throws
// "Native CLI binary for darwin-arm64 not found …", which surfaces to the user
// as "AGENT RESPONSE FAILURE" on every send. In dev the engine is
// `bun <repo>/apps/desktop/src/cli.ts`, sdk.mjs is a real file, and the lookup succeeds —
// which is exactly why this only ever broke Beta and Production.
//
// So we stage the binary to a STABLE, version-free path that
// electron-builder.yml can name literally:
//
//   binaries/claude                  → Contents/Resources/claude
//   binaries/claude-cli-version.txt  → Contents/Resources/claude-cli-version.txt
//
// apps/desktop/electron/sidecar.ts then hands both to the engine as ZEROS_CLAUDE_CLI_PATH /
// ZEROS_CLAUDE_CLI_VERSION, the same handoff shape as the PTY and Cursor hosts'
// ZEROS_*_HOST_SCRIPT. `binaries/` is gitignored and already the home of the
// bun-compiled engine, so this adds no new packaging concept.
//
// A HARDLINK is used when possible: same filesystem, so it is instant and costs
// no extra disk. electron-builder dereferences it when copying into the .app, so
// exactly one 245 MiB copy ships (electron-builder.yml `files:` excludes the
// platform package from app.asar so it can't ship twice).
//
// FAILS LOUD. A build with no Claude runtime is the precise defect this script
// exists to prevent, and it is invisible until a user sends a message.
//
// Run: `pnpm stage:claude-cli` (also invoked from scripts/electron-before-pack.cjs).
// ──────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const require = createRequire(join(repoRoot, "package.json"));

const PKG_BASE = "@anthropic-ai/claude-agent-sdk";

/** Staged filenames. MUST byte-match electron-builder.yml's extraResources
 *  `from:`/`to:` entries — scripts/check-packaging-paths.mjs asserts this, the
 *  same way it guards the engine binary's name. */
export const STAGED_BINARY = "binaries/claude";
export const STAGED_VERSION_FILE = "binaries/claude-cli-version.txt";

/** Candidate platform packages, in the SAME order the SDK's own resolver tries
 *  them (sdk.mjs `FU`). Keep in lockstep with
 *  apps/desktop/src/engine/agents/adapters/claude-sdk/binary-resolver.ts. */
function platformPackages(platform = process.platform, arch = process.arch) {
  if (platform === "android") return [`${PKG_BASE}-linux-${arch}-android`];
  if (platform === "linux") {
    return [`${PKG_BASE}-linux-${arch}`, `${PKG_BASE}-linux-${arch}-musl`];
  }
  return [`${PKG_BASE}-${platform}-${arch}`];
}

const binName = process.platform === "win32" ? "claude.exe" : "claude";

/** Resolve the platform binary through the SDK's OWN location — the only anchor
 *  that works under pnpm, where the platform package is a sibling of sdk.mjs
 *  rather than hoisted. */
export function resolveClaudeCliSource() {
  // The package's own package.json is not an exported subpath, so resolve main.
  const sdkMain = require.resolve(PKG_BASE);
  const fromSdk = createRequire(sdkMain);
  const tried = [];
  for (const pkg of platformPackages()) {
    const spec = `${pkg}/${binName}`;
    tried.push(spec);
    try {
      const p = fromSdk.resolve(spec);
      if (existsSync(p)) return { path: p, pkg, sdkMain };
    } catch {
      /* not installed for this platform — try the next candidate */
    }
  }
  throw new Error(
    `[stage-claude-cli] could not resolve the Claude Code binary for ` +
      `${process.platform}-${process.arch}. Tried: ${tried.join(", ")} ` +
      `(anchored at ${sdkMain}).\n` +
      `The platform package is an OPTIONAL dependency of ${PKG_BASE} — a ` +
      `\`pnpm install --no-optional\` / \`npm ci --omit=optional\` drops it. ` +
      `Reinstall dependencies WITH optional deps and retry.`,
  );
}

/** claude-code version the staged binary implements, read from the SDK's
 *  manifest.json (`version`) / package.json (`claudeCodeVersion`). The engine
 *  cannot read this itself in a packaged build (registry.ts's require.resolve
 *  fails in the compiled binary), so we bake it into a sibling file. */
export function readClaudeCodeVersion(sdkMain) {
  let dir = dirname(sdkMain);
  for (let i = 0; i < 6; i++) {
    const manifest = join(dir, "manifest.json");
    if (existsSync(manifest)) {
      const v = JSON.parse(readFileSync(manifest, "utf8")).version;
      if (typeof v === "string") return v;
    }
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const j = JSON.parse(readFileSync(pkg, "utf8"));
      if (j.name === PKG_BASE) {
        return typeof j.claudeCodeVersion === "string"
          ? j.claudeCodeVersion
          : null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function stageClaudeCli({ quiet = false } = {}) {
  const log = (m) => {
    if (!quiet) console.log(m);
  };

  const { path: src, pkg, sdkMain } = resolveClaudeCliSource();
  const srcStat = statSync(src);
  if (!srcStat.isFile() || srcStat.size === 0) {
    throw new Error(
      `[stage-claude-cli] resolved ${src} but it is not a non-empty file ` +
        `(size=${srcStat.size}, isFile=${srcStat.isFile()}) — the install is corrupt.`,
    );
  }

  const dest = join(repoRoot, STAGED_BINARY);
  mkdirSync(dirname(dest), { recursive: true });
  // Idempotent: a stale hardlink from a previous SDK version would silently ship
  // the WRONG claude-code, so always replace rather than reuse.
  rmSync(dest, { force: true });
  let how;
  try {
    linkSync(src, dest);
    how = "hardlink";
  } catch {
    // Different filesystem (a CI cache mount) or a hardlink-hostile FS.
    copyFileSync(src, dest);
    how = "copy";
  }
  // pnpm extraction and copyFileSync can both drop the x-bit; without it the
  // SDK spawns and fails with EACCES far away from here.
  chmodSync(dest, 0o755);

  const version = readClaudeCodeVersion(sdkMain);
  const versionDest = join(repoRoot, STAGED_VERSION_FILE);
  // Always (re)write, including the unknown case: a stale version file from a
  // previous SDK would mis-report the runtime in Settings → Agent providers.
  writeFileSync(versionDest, `${version ?? ""}\n`, "utf8");

  const mib = (srcStat.size / 1024 / 1024).toFixed(1);
  log(
    `[stage-claude-cli] ${how} ${pkg} → ${STAGED_BINARY} (${mib} MiB, claude-code ${version ?? "unknown"})`,
  );
  if (!version) {
    // Not fatal — the binary is what matters — but it degrades the version
    // surface, so make it visible rather than silently shipping "unknown".
    console.warn(
      `[stage-claude-cli] WARNING: could not read claudeCodeVersion from the SDK ` +
        `manifest near ${sdkMain}; Settings → Agent providers will show no ` +
        `Claude runtime version.`,
    );
  }
  return { dest, versionDest, version, size: srcStat.size };
}

// Run as a script (not when imported by a check/test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    stageClaudeCli();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
