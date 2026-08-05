#!/usr/bin/env node
/**
 * Optional helper: standalone install of @zeros/marketing deps from its own
 * committed pnpm-lock.yaml (never a root workspace install — see
 * ensureMarketingDeps() in assemble-marketing.mjs).
 *
 * Cloudflare Pages Builds UI has NO separate "Install command" field — the
 * assemble-marketing.mjs build already calls this logic. You can still run
 * this manually locally:
 *
 *   node scripts/cf-install-marketing.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_APP = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WEB_APP, "../..");

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}  (cwd=${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env, shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const MARKETING = path.join(REPO_ROOT, "apps", "marketing");

if (!existsSync(path.join(MARKETING, "pnpm-lock.yaml"))) {
  console.error(
    "apps/marketing/pnpm-lock.yaml not found — regenerate with:\n" +
      "  cd apps/marketing && pnpm install --ignore-workspace --lockfile-only",
  );
  process.exit(1);
}

run("corepack", ["enable"], REPO_ROOT);
// Standalone install from marketing's own lockfile — NOT a root workspace
// install. See ensureMarketingDeps() in assemble-marketing.mjs for why.
run("pnpm", ["install", "--ignore-workspace", "--frozen-lockfile"], MARKETING);
console.log("Marketing deps installed.");
