#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-vite-env-sync — keep the production VITE_* build set reviewable
// ──────────────────────────────────────────────────────────
//
// VITE_* values are inlined into the renderer bundle at BUILD time
// (import.meta.env) and `.env` is gitignored (absent in CI), so a production
// build (`release.yml` → build:ui) MUST inject them from environment-scoped
// Actions variables/secrets. A VITE_
// var the app uses but release.yml does NOT inject ships a DMG without it →
// analytics or environment routing goes dark, with no failing test. This guard
// makes the production build set a first-class invariant. It reads names only,
// never values; release-environment.ts validates the public URL values.
//
// Checks (NAMES only):
//   1. Every VITE_ var used in src/ is documented in .env.example.
//   2. Every PROD-required VITE_ var is injected by release.yml's build:ui step.
//   3. The dev-only key is NOT injected into the prod build.
// Run: `pnpm check:vite-env`. Exit 0 = in sync, 1 = drift.
// ──────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Required in EVERY production build — a missing one breaks the shipped app.
// Auth has no entry here: the desktop never talks to Auth0 directly, only to
// app.zeros.build (see apps/desktop/electron/ipc/commands/auth-session.ts).
const PROD_REQUIRED = [
  "VITE_POSTHOG_KEY_PROD",
  "VITE_APP_BASE_URL",
  "VITE_CONTROL_PLANE_URL",
];
// VITE_ZEROS_CHANNEL: release.yml does NOT inject it — Production's renderer channel
// comes from the `import.meta.env.DEV ? "dev" : "stable"` fallback in
// apps/desktop/src/renderer/config/release-channel.ts. (An earlier version of this comment claimed release.yml
// injected "stable". It never did.) The alpha + beta workflows DO inject it
// explicitly, and CHANNEL_WORKFLOWS below asserts that.
//
// There is deliberately NO entry for internal features. Settings → Internal is
// gated on `users.staff_role` from the control plane, not on a build-time var:
// the removed VITE_INTERNAL_USER_EMAILS was inlined into the renderer bundle,
// so it shipped maintainer addresses inside every .app while hiding nothing.
// Re-adding a VITE_* var for that purpose would be a regression.
// Intentionally NOT in a prod build (a packaged app always runs in prod mode).
const DEV_ONLY = ["VITE_POSTHOG_KEY_DEV"];

// Every non-stable release workflow, and the channel it MUST bake into the renderer.
//
// WHY: this check used to read release.yml ONLY. A VITE_* var added for stable and
// forgotten in a channel workflow shipped that channel with the feature dark — and CI
// stayed GREEN, because nothing ever looked at the other files. It is worse for
// VITE_ZEROS_CHANNEL specifically: without it the renderer falls back to
// `import.meta.env.DEV ? "dev" : "stable"`, so an Alpha or Beta build's RENDERER
// reports CHANNEL === "stable" while its MAIN process reports the real channel. The
// two then disagree about feature gating and the deep-link scheme it builds.
const CHANNEL_WORKFLOWS = {
  ".github/workflows/release-alpha.yml": "alpha",
  ".github/workflows/release-beta.yml": "beta",
};

const names = (text) => [...text.matchAll(/VITE_[A-Z0-9_]+/g)].map((m) => m[0]);

// 1. VITE_ vars actually referenced in src/.
const used = new Set(
  names(
    execFileSync("grep", ["-rhoE", "import\\.meta\\.env\\.VITE_[A-Z0-9_]+", "apps/desktop/src/"], {
      encoding: "utf8",
    }),
  ),
);

// 2. VITE_ vars documented in .env.example (commented `# VITE_X=` counts).
const documented = new Set(names(readFileSync(".env.example", "utf8")));

// 3. VITE_ vars injected by release.yml's build:ui env block (lines `VITE_X: ...`).
const releaseYml = readFileSync(".github/workflows/release.yml", "utf8");
const injected = new Set(
  [...releaseYml.matchAll(/^\s*(VITE_[A-Z0-9_]+):/gm)].map((m) => m[1]),
);

const errs = [];
for (const v of used) {
  if (!documented.has(v)) {
    errs.push(`${v} is used in src/ but NOT documented in .env.example`);
  }
}
for (const v of PROD_REQUIRED) {
  if (!injected.has(v)) {
    errs.push(
      `${v} is PROD-required but NOT injected by release.yml's build:ui step — the packaged app would ship without it`,
    );
  }
}
for (const v of DEV_ONLY) {
  if (injected.has(v)) {
    errs.push(`${v} is dev-only but is injected into the production build`);
  }
}

// 4. Every channel workflow must inject the SAME prod-required set as stable, plus
//    its own VITE_ZEROS_CHANNEL. Without this, a var added to release.yml and
//    forgotten here ships that channel with the feature dark, CI green.
for (const [file, expectedChannel] of Object.entries(CHANNEL_WORKFLOWS)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    errs.push(`${file} is missing — the ${expectedChannel} channel has no release workflow`);
    continue;
  }
  const chInjected = new Set(
    [...text.matchAll(/^\s*(VITE_[A-Z0-9_]+):/gm)].map((m) => m[1]),
  );
  for (const v of PROD_REQUIRED) {
    if (!chInjected.has(v)) {
      errs.push(
        `${v} is injected by release.yml but NOT by ${file} — the ${expectedChannel} build would ship without it`,
      );
    }
  }
  for (const v of DEV_ONLY) {
    if (chInjected.has(v)) {
      errs.push(`${v} is dev-only but is injected by ${file}`);
    }
  }
  if (!chInjected.has("VITE_ZEROS_CHANNEL")) {
    errs.push(
      `${file} must inject VITE_ZEROS_CHANNEL: ${expectedChannel} — otherwise its renderer falls back to "stable" and disagrees with the main process about feature flags + the deep-link scheme`,
    );
  } else if (!new RegExp(`VITE_ZEROS_CHANNEL:\\s*${expectedChannel}\\b`).test(text)) {
    errs.push(
      `${file} injects VITE_ZEROS_CHANNEL but not as "${expectedChannel}" — renderer and main would resolve different channels`,
    );
  }
  // The main-process side of the same value. Both must be present and agree.
  if (!new RegExp(`ZEROS_CHANNEL:\\s*${expectedChannel}\\b`).test(text)) {
    errs.push(
      `${file} must set ZEROS_CHANNEL: ${expectedChannel} (job env) so electron:compile bakes the channel and electron-builder-run applies the right appId/feed`,
    );
  }
}

if (errs.length > 0) {
  console.error("✖ check:vite-env — VITE_* env drift:");
  for (const e of errs) console.error(`  • ${e}`);
  console.error(
    "\nFix: document the var in .env.example and/or add it to release.yml's build:ui `env:` block, then add the matching repo secret. Update PROD_REQUIRED here when a new prod var is introduced.",
  );
  process.exit(1);
}
console.log(
  `✓ check:vite-env — ${used.size} VITE_ vars used, all documented; ` +
    `${PROD_REQUIRED.length} prod-required injected by release.yml and by each of ` +
    `${Object.keys(CHANNEL_WORKFLOWS).length} channel workflow(s) with a matching channel`,
);
