#!/usr/bin/env node
/**
 * Assemble the marketing Vite build + web-app static files into
 * website/web-app/dist for the unified zeros-web Cloudflare Pages project.
 *
 * Source of truth for app static files stays in public/ (_headers, robots.txt).
 * Marketing is built from website/marketing and overlaid into dist/.
 *
 * Cloudflare Pages UI (zeros-web → Settings → Builds) has NO separate
 * "Install command" field — only Framework / Build command / Output / Root.
 * So this script installs the marketing deps itself before building — a
 * STANDALONE install from website/marketing/pnpm-lock.yaml (see
 * ensureMarketingDeps), never a root workspace install.
 *
 *   Framework preset:        None
 *   Build command:           npm run build
 *   Build output directory:  dist
 *   Root directory:          website/web-app
 *
 * Local:
 *   cd website/web-app && npm run build && npm run dev
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_APP = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WEB_APP, "../..");
const MARKETING = path.join(REPO_ROOT, "website", "marketing");
const MARKETING_DIST = path.join(MARKETING, "dist");
const PUBLIC_SRC = path.join(WEB_APP, "public");
const OUT = path.join(WEB_APP, "dist");

/** Explicit SPA fallbacks — NOT `/*`. A blanket rule would make
 *  app.zeros.build/unknown serve the marketing homepage.
 *  KEEP IN SYNC with website/marketing/src/routes.tsx and MARKETING_SPA_PATHS
 *  in functions/_middleware.ts. */
const SPA_REDIRECTS = `# Marketing SPA deep links (explicit — do not use /* here).
# App Functions (/auth, /handoff, /launch, /invite, /) take precedence on
# app.zeros.build; marketing hosts are served via ASSETS in _middleware.ts.
# KEEP IN SYNC with website/marketing/src/routes.tsx.
/changelog  /index.html  200
/privacy    /index.html  200
/terms      /index.html  200
`;

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}  (cwd=${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

/** Install the marketing deps so it can build. CF Pages only auto-installs
 *  website/web-app (npm). Marketing is installed STANDALONE from its own
 *  committed pnpm-lock.yaml via `--ignore-workspace`: `pnpm install --filter`
 *  cannot narrow a workspace install (pnpm/pnpm#8318), so a root-lockfile
 *  install would pull the whole monorepo onto the CF build machine (Electron
 *  binary download + better-sqlite3/node-pty/sqlite3 native compiles).
 *  After changing website/marketing/package.json, regenerate the lockfile:
 *    cd website/marketing && pnpm install --ignore-workspace --lockfile-only */
function ensureMarketingDeps() {
  if (!existsSync(path.join(MARKETING, "pnpm-lock.yaml"))) {
    console.error(
      "website/marketing/pnpm-lock.yaml not found — regenerate with:\n" +
        "  cd website/marketing && pnpm install --ignore-workspace --lockfile-only",
    );
    process.exit(1);
  }
  // Skip if marketing's vite is already resolvable (local/dev already installed
  // via the root pnpm workspace).
  const viteBin = path.join(REPO_ROOT, "node_modules", ".bin", "vite");
  const marketingVite = path.join(MARKETING, "node_modules", ".bin", "vite");
  if (existsSync(viteBin) || existsSync(marketingVite)) {
    console.log("Marketing deps already present — skipping pnpm install.");
    return;
  }
  run("corepack", ["enable"], REPO_ROOT);
  run("pnpm", ["install", "--ignore-workspace", "--frozen-lockfile"], MARKETING);
}

function buildMarketing() {
  if (!existsSync(path.join(MARKETING, "package.json"))) {
    console.error(`Marketing package not found at ${MARKETING}`);
    process.exit(1);
  }

  ensureMarketingDeps();

  run("pnpm", ["run", "build"], MARKETING);
}

function assemble() {
  if (!existsSync(MARKETING_DIST)) {
    console.error(`Missing ${MARKETING_DIST} — marketing build failed?`);
    process.exit(1);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 1) Marketing SPA + assets + schemas + logos
  cpSync(MARKETING_DIST, OUT, { recursive: true });

  // 2) App static defaults — overwrite marketing if any. 404.html is
  // load-bearing: without it, Pages' implicit SPA mode serves index.html
  // with 200 for every unmatched path on BOTH hosts.
  for (const name of ["_headers", "robots.txt", "404.html"]) {
    const src = path.join(PUBLIC_SRC, name);
    if (existsSync(src)) {
      writeFileSync(path.join(OUT, name), readFileSync(src));
    }
  }

  // 3) Explicit SPA redirects (ignore marketing's /* rule)
  writeFileSync(path.join(OUT, "_redirects"), SPA_REDIRECTS);

  console.log(`Assembled → ${OUT}`);
}

const skipBuild = process.argv.includes("--skip-build");
if (!skipBuild) buildMarketing();
assemble();
