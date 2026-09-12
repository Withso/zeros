#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Build the Zeros engine as a Bun single-file executable.
// ──────────────────────────────────────────────────────────
//
// Output: <repo>/binaries/zeros-engine-<triple>
//
// The <triple> suffix is historical: Tauri's externalBin wanted
// it appended so it could locate the right arch binary at bundle
// time. Electron doesn't need the suffix (we just name the file
// `zeros-engine` in Contents/Resources/ via electron-builder's
// extraResources `to:` rewrite), but keeping the suffix in the
// source location means cross-compiling to x64 from an arm Mac
// can drop both binaries side by side without overwriting.
//
// apps/desktop/electron/sidecar.ts resolves the correct file at runtime by
// reading process.arch.
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Map Node's `process.arch` to the Rust host triple + Bun target flag.
const archMap = {
  arm64: { rustTriple: "aarch64-apple-darwin", bunTarget: "bun-darwin-arm64" },
  x64: { rustTriple: "x86_64-apple-darwin", bunTarget: "bun-darwin-x64" },
};

const platform = process.platform;
if (platform !== "darwin") {
  console.error(
    `build-sidecar: currently only macOS is supported (got ${platform}).`,
  );
  process.exit(1);
}

const mapping = archMap[process.arch];
if (!mapping) {
  console.error(`build-sidecar: unsupported macOS arch ${process.arch}`);
  process.exit(1);
}

const entry = resolve(repoRoot, "apps/desktop/src/cli.ts");
if (!existsSync(entry)) {
  console.error(`build-sidecar: entry not found at ${entry}`);
  process.exit(1);
}

const binariesDir = resolve(repoRoot, "binaries");
mkdirSync(binariesDir, { recursive: true });

const outfile = resolve(binariesDir, `zeros-engine-${mapping.rustTriple}`);
const cloudWorkspacesEnabled =
  process.env.ZEROS_CLOUD_WORKSPACES_ENABLED === "true";

// NOT .join(" ") into a shell. `entry` and `outfile` are absolute paths derived
// from the checkout location, so a repo cloned to a path containing a space
// silently built the wrong thing, and one containing shell metacharacters was an
// injection (CodeQL js/shell-command-injection-from-environment). Keeping the argv
// as an array and handing it to execFileSync means no shell parses it at all —
// paths with spaces just work, and there is nothing left to quote.
const cmdArgs = [
  "build",
  entry,
  "--compile",
  `--target=${mapping.bunTarget}`,
  "--define",
  `__ZEROS_CLOUD_WORKSPACES_ENABLED_BAKED__=${JSON.stringify(cloudWorkspacesEnabled)}`,
  "--outfile",
  outfile,
];

// Run from a throwaway tmp dir: Bun drops intermediate `.*.bun-build` files in
// CWD during compile and strands them if the build is killed. Keeping CWD out
// of the repo means any leftovers land in /tmp (macOS auto-cleans) instead of
// accumulating in the project root.
const buildCwd = mkdtempSync(join(tmpdir(), "zeros-sidecar-"));

console.log(`[build-sidecar] bun ${cmdArgs.join(" ")}`);
execFileSync("bun", cmdArgs, { stdio: "inherit", cwd: buildCwd });

// Bun writes 755 already; chmod defensively in case of umask weirdness.
// chmodSync, not `execSync("chmod +x …")` — same unquoted-path problem as above,
// and spawning a process to set one mode bit was never worth it.
chmodSync(outfile, 0o755);

console.log(`[build-sidecar] wrote ${outfile}`);
