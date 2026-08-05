#!/usr/bin/env node
// Hydrate the independent production graphs consumed by the license generator.
//
// A root workspace install does not prove the dependency versions deployed by
// Railway or by Cloudflare's standalone marketing build. Install those exact
// lockfiles before inventorying licenses so `check:licenses` cannot validate a
// convenient workspace graph while deployment ships different package bytes.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const graphs = [
  {
    name: "control plane",
    cwd: join(ROOT, "apps", "control-plane"),
    args: ["install", "--frozen-lockfile", "--ignore-scripts"],
  },
  {
    name: "standalone marketing deployment",
    cwd: join(ROOT, "apps", "marketing"),
    args: [
      "install",
      "--ignore-workspace",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
  },
];

for (const graph of graphs) {
  console.log(`Hydrating ${graph.name} license graph...`);
  const result = spawnSync(PNPM, graph.args, {
    cwd: graph.cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
