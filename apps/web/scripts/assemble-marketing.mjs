#!/usr/bin/env node
/**
 * Assemble the marketing Vite build and web-hub static files into
 * apps/web/dist for the unified zeros-web Cloudflare Pages project.
 *
 * Source of truth for app static files stays in public/ (_headers, robots.txt).
 * Marketing is built from apps/marketing and overlaid into dist/.
 *
 * Cloudflare Pages UI (zeros-web → Settings → Builds) has NO separate
 * "Install command" field — only Framework / Build command / Output / Root.
 * So this script installs the marketing deps itself before building — a
 * STANDALONE install from apps/marketing/pnpm-lock.yaml (see
 * ensureMarketingDeps), never a root workspace install.
 *
 *   Framework preset:        None
 *   Build command:           npm run build
 *   Build output directory:  dist
 *   Root directory:          apps/web
 *
 * Local:
 *   cd apps/web && npm run build && npm run dev
 * CI/deployment-boundary verification:
 *   npm run build:standalone
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pagesFunctionRoutes } from "../lib/pages-routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_APP = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WEB_APP, "../..");
const MARKETING = path.join(REPO_ROOT, "apps", "marketing");
const MARKETING_DIST = path.join(MARKETING, "dist");
const PUBLIC_SRC = path.join(WEB_APP, "public");
const ZEROS_TOKENS = path.join(REPO_ROOT, "styles", "zeros-tokens.css");
const OUT = path.join(WEB_APP, "dist");
const LEGAL_FILES = [
  [path.join(REPO_ROOT, "LICENSE"), "LICENSE.txt"],
  [path.join(REPO_ROOT, "THIRD-PARTY-NOTICES.md"), "THIRD-PARTY-NOTICES.md"],
  [
    path.join(REPO_ROOT, "THIRD-PARTY-LICENSES.txt"),
    "THIRD-PARTY-LICENSES.txt",
  ],
];

/** Explicit SPA fallbacks — NOT `/*`. A blanket rule would make
 *  app.zeros.build/unknown serve the marketing homepage.
 *  KEEP IN SYNC with apps/marketing/src/routes.tsx and MARKETING_SPA_PATHS
 *  in functions/_middleware.ts. */
const SPA_REDIRECTS = `# Marketing SPA deep links (explicit — do not use /* here).
# App Functions (/auth, /handoff, /launch, /invite, /) take precedence on
# app.zeros.build; marketing hosts are served via ASSETS in _middleware.ts.
# KEEP IN SYNC with apps/marketing/src/routes.tsx.
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
 *  apps/web (npm). Marketing is installed STANDALONE from its own
 *  committed pnpm-lock.yaml via `--ignore-workspace`: `pnpm install --filter`
 *  cannot narrow a workspace install (pnpm/pnpm#8318), so a root-lockfile
 *  install would pull the whole monorepo onto the CF build machine (Electron
 *  binary download + better-sqlite3/node-pty/sqlite3 native compiles).
 *  After changing apps/marketing/package.json, regenerate the lockfile:
 *    cd apps/marketing && pnpm install --ignore-workspace --lockfile-only */
function ensureMarketingDeps(forceStandaloneInstall) {
  if (!existsSync(path.join(MARKETING, "pnpm-lock.yaml"))) {
    console.error(
      "apps/marketing/pnpm-lock.yaml not found — regenerate with:\n" +
        "  cd apps/marketing && pnpm install --ignore-workspace --lockfile-only",
    );
    process.exit(1);
  }
  // Local development can reuse a declared marketing install. The explicit
  // standalone mode always validates apps/marketing/pnpm-lock.yaml even when a
  // root workspace install exists and could otherwise mask drift.
  const marketingVite = path.join(MARKETING, "node_modules", ".bin", "vite");
  if (!forceStandaloneInstall && existsSync(marketingVite)) {
    console.log("Marketing deps already present — skipping pnpm install.");
    return;
  }
  run("corepack", ["enable"], REPO_ROOT);
  run(
    "pnpm",
    ["install", "--ignore-workspace", "--frozen-lockfile"],
    MARKETING,
  );
}

function buildMarketing(forceStandaloneInstall) {
  if (!existsSync(path.join(MARKETING, "package.json"))) {
    console.error(`Marketing package not found at ${MARKETING}`);
    process.exit(1);
  }

  ensureMarketingDeps(forceStandaloneInstall);

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
  for (const name of [
    "_headers",
    "robots.txt",
    "404.html",
    "dashboard.css",
    "dashboard.js",
    "account-deletion.js",
    "ops.css",
    "ops.js",
  ]) {
    const src = path.join(PUBLIC_SRC, name);
    if (existsSync(src)) {
      writeFileSync(path.join(OUT, name), readFileSync(src));
    }
  }

  // Cloudflare auto-excludes static files from Functions. Keep stable hosted
  // UI assets inside host middleware so its runtime cache/CSP policy applies.
  // The isolated Ops deployment routes every path through its deny-by-default
  // allowlist; public web deployments retain free delivery for immutable files.
  const surface = process.env.ZEROS_SURFACE === "ops" ? "ops" : "app";
  writeFileSync(
    path.join(OUT, "_routes.json"),
    `${JSON.stringify(pagesFunctionRoutes(surface), null, 2)}\n`,
  );

  // The dashboard consumes the SAME primitive values as the desktop. Strip
  // Tailwind's build-only setup (`@theme`, package imports, source scanning)
  // and publish the concrete :root/theme blocks verbatim. This keeps the web
  // surface token-linked without forcing the Cloudflare package to install the
  // Electron renderer's entire Tailwind dependency graph.
  const tokenSource = readFileSync(ZEROS_TOKENS, "utf8");
  const concreteStart = tokenSource.indexOf("\n:root {");
  if (concreteStart < 0) {
    console.error(`Couldn't locate concrete :root tokens in ${ZEROS_TOKENS}`);
    process.exit(1);
  }
  writeFileSync(
    path.join(OUT, "dashboard-tokens.css"),
    `/* Generated from styles/zeros-tokens.css — do not edit here. */\n${tokenSource.slice(concreteStart + 1)}`,
  );

  // 3) Distribution terms for the browser bundle. The root inventory covers
  // the exact standalone marketing lockfile used above, not only the root
  // workspace's convenient development resolution.
  for (const [src, name] of LEGAL_FILES) {
    if (!existsSync(src)) {
      console.error(`Missing required legal distribution file: ${src}`);
      process.exit(1);
    }
    copyFileSync(src, path.join(OUT, name));
  }

  // 4) Explicit SPA redirects (ignore marketing's /* rule)
  writeFileSync(path.join(OUT, "_redirects"), SPA_REDIRECTS);

  console.log(`Assembled → ${OUT}`);
}

const skipBuild = process.argv.includes("--skip-build");
const forceStandaloneInstall = process.argv.includes("--standalone-install");
if (!skipBuild) buildMarketing(forceStandaloneInstall);
assemble();
