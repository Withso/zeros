#!/usr/bin/env node
// A Bun-compiled engine cannot resolve the SDK's native CLI beside sdk.mjs.
// Stage the platform executable and version at fixed extraResources paths;
// the sidecar passes them through ZEROS_CLAUDE_CLI_PATH / ZEROS_CLAUDE_CLI_VERSION.
// Prefer hardlinks to avoid a second staging copy; electron-builder copies the
// runtime into the app and excludes its platform package from app.asar.

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

/** The compiled engine cannot read the SDK manifest, so ship its CLI version
 * beside the staged executable. */
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
  // Replace old hardlinks so an SDK upgrade cannot stage the previous binary.
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
  // Rewrite unknown versions too; stale metadata would misidentify the shipped runtime.
  writeFileSync(versionDest, `${version ?? ""}\n`, "utf8");

  const mib = (srcStat.size / 1024 / 1024).toFixed(1);
  log(
    `[stage-claude-cli] ${how} ${pkg} → ${STAGED_BINARY} (${mib} MiB, claude-code ${version ?? "unknown"})`,
  );
  if (!version) {
    // Missing version metadata must remain visible even when the binary stages successfully.
    console.warn(
      `[stage-claude-cli] WARNING: could not read claudeCodeVersion from the SDK ` +
        `manifest near ${sdkMain}; Settings → Agent providers will show no ` +
        `Claude runtime version.`,
    );
  }
  return { dest, versionDest, version, size: srcStat.size };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    stageClaudeCli();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
