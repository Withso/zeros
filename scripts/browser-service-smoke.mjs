#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

if (process.platform !== "darwin") {
  console.log(
    `[smoke:browser-service] skipped — Electron Chromium runtime check requires macOS (got ${process.platform}).`,
  );
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "zeros-browser-service-"));
const output = join(scratch, "browser-service-smoke.cjs");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");

try {
  await build({
    entryPoints: [
      resolve(scriptDir, "fixtures", "browser-service-smoke-entry.ts"),
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
    timeout: 120_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Electron browser service harness exited with ${String(result.status)}${
        result.signal ? ` (${result.signal})` : ""
      }.`,
    );
  }
  if (!result.stdout?.includes("zeros-browser-service-smoke: complete")) {
    throw new Error(
      "Electron browser service harness exited before running every check.",
    );
  }
  console.log(
    "✓ smoke:browser-service — identity, workspace relocation, owner release, loopback auth, isolation, agent and ordinary-tab favicon publication, ordinary-tab live Back/Forward/Reload, tokenized stale-ref rejection, trusted/occlusion-safe clicks, explicit/script/redirect cross-site confirmations and denial, consequential confirmations, key/select/wait actions with Enter-submit and Enter/Space control confirmations, HTTP action stop, the attached page's agent control bar with Esc takeover and a closed Zeros browser rollout, cancellable downloads/navigation, parked-page scroll and screenshots, click targets on smooth-scrolling pages, uploads, clean screenshots, traces, Appearance emulation across navigation and Codex debugger release, native IAB committed-URL reads and optional-method fallback, retained close handoff, and browsing-data reset passed",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
