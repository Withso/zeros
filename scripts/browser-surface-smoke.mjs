#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

if (process.platform !== "darwin") {
  console.log(
    `[smoke:browser] skipped — native Electron surface check requires macOS (got ${process.platform}).`,
  );
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "zeros-browser-surface-"));
const output = join(scratch, "browser-surface-smoke.cjs");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");

try {
  await build({
    entryPoints: [
      resolve(scriptDir, "fixtures", "browser-surface-smoke-entry.ts"),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    logLevel: "silent",
  });
  const result = spawnSync(electronBinary, [output], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Electron browser-surface harness exited with ${String(result.status)}${result.signal ? ` (${result.signal})` : ""}.`,
    );
  }
  console.log(
    "✓ smoke:browser — shared WebContents, diagnostics, isolation, recovery, provider switching, confirmations, files, permissions, screenshots, and trace passed",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
