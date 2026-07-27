#!/usr/bin/env node
// 01w (2026-05-20) — chmod +x node-pty's spawn-helper.
//
// node-pty's darwin prebuilds ship `spawn-helper` as a Mach-O binary,
// but pnpm extraction sometimes strips the executable bit. Without
// it, every call to pty.spawn() throws `posix_spawnp failed`.
// This postinstall script flips +x on every spawn-helper we find,
// across both the symlinked node_modules/node-pty and the .pnpm
// store entries.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function chmodIfExists(target) {
  try {
    if (!fs.existsSync(target)) return;
    fs.chmodSync(target, 0o755);
  } catch (err) {
    // Best-effort — don't fail the whole install over a chmod.
    console.warn(
      `[fix-node-pty-helper] could not chmod ${target}: ${err.message}`,
    );
  }
}

function walkPnpmStore(rootNodeModules) {
  const pnpmDir = path.join(rootNodeModules, ".pnpm");
  if (!fs.existsSync(pnpmDir)) return;
  for (const entry of fs.readdirSync(pnpmDir)) {
    if (!entry.startsWith("node-pty@")) continue;
    const inner = path.join(
      pnpmDir,
      entry,
      "node_modules",
      "node-pty",
      "prebuilds",
    );
    if (!fs.existsSync(inner)) continue;
    for (const arch of fs.readdirSync(inner)) {
      chmodIfExists(path.join(inner, arch, "spawn-helper"));
    }
  }
}

function main() {
  // 1. Symlinked / hoisted node_modules/node-pty
  const direct = path.join(
    __dirname,
    "..",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  if (fs.existsSync(direct)) {
    for (const arch of fs.readdirSync(direct)) {
      chmodIfExists(path.join(direct, arch, "spawn-helper"));
    }
  }

  // 2. .pnpm store entries
  walkPnpmStore(path.join(__dirname, "..", "node_modules"));
}

try {
  main();
} catch (err) {
  console.warn(`[fix-node-pty-helper] non-fatal failure: ${err.message}`);
}
