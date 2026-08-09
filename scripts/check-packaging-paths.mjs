#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-packaging-paths — package inputs and updater assets must stay complete
// ──────────────────────────────────────────────────────────
//
// electron-builder does NOT fail when an `extraResources` `from:` matches zero
// files — the filter just yields nothing → a packaged .app that boots into a
// broken engine/PTY/Cursor with no compile error. This statically confirms every
// on-disk SOURCE path electron-builder.yml points at exists, and that the engine
// sidecar's `from:` name byte-matches what `build:sidecar` actually outputs (a
// rename desyncs them silently). `check:cursor-asar` validates the require()
// CLOSURE but never that the host files themselves exist.
//
// The release workflow checks below also prevent generated macOS differential
// blockmaps and channel feeds from being dropped between packaging and the
// GitHub Release that serves them. A missing blockmap does not break updates,
// but silently forces every client to download the complete zip; a missing feed
// means no client ever learns an update exists.
//
// Run: `pnpm check:packaging-paths`. Exit 0 = all invariants hold, 1 = a missing/
// renamed package input or updater asset.
// ──────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";

const yml = readFileSync("electron-builder.yml", "utf8");
const stableReleaseWorkflow = readFileSync(
  ".github/workflows/release.yml",
  "utf8",
);
// Both PRE-RELEASE channel workflows. Alpha (every merge to main) and Beta (a
// release/* stabilization cut) are structurally identical — same publish shape,
// same feed/blockmap handoff — so they get the SAME assertions. Adding a channel
// workflow without adding it here would ship a channel whose differential-update
// blockmap is silently dropped: updates still work, but every client downloads the
// full ~800 MB zip instead of a delta.
const channelReleaseWorkflows = [
  ["alpha release workflow", ".github/workflows/release-alpha.yml"],
  ["beta release workflow", ".github/workflows/release-beta.yml"],
].map(([label, file]) => ({ label, file, text: readFileSync(file, "utf8") }));
const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");

// The engine binary is BUILT at pack time (gitignored) — don't fs-stat it; assert
// its `from:` name matches build-sidecar's output for arm64. Keep in sync with
// scripts/build-sidecar.mjs (zeros-engine-<rustTriple>, arm64 → aarch64-apple-darwin).
const ENGINE_BINARY = "binaries/zeros-engine-aarch64-apple-darwin";

// The Claude Code runtime is staged at pack time too (gitignored). Keep in sync
// with scripts/stage-claude-cli.mjs's STAGED_BINARY / STAGED_VERSION_FILE.
const CLAUDE_STAGED = ["binaries/claude", "binaries/claude-cli-version.txt"];
const CODEX_STAGED = [
  "binaries/codex-runtime",
  "binaries/codex-cli-version.txt",
];
const LEGAL_RESOURCES = [
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "THIRD-PARTY-LICENSES.txt",
  "third_party",
];
const beforePackSource = readFileSync(
  "scripts/electron-before-pack.cjs",
  "utf8",
);

const froms = [...yml.matchAll(/^\s*-?\s*from:\s*(.+)$/gm)].map((m) =>
  unquote(m[1]),
);
const beforePack = (yml.match(/^beforePack:\s*(.+)$/m) || [])[1];
const afterPack = (yml.match(/^afterPack:\s*(.+)$/m) || [])[1];
const icon = (yml.match(/^\s*icon:\s*(.+)$/m) || [])[1];
// Hardened-runtime signing needs the entitlements plist(s) to exist; a wrong
// path here doesn't fail until the signed pack step in release.yml.
const entitlements = [
  ...yml.matchAll(/^\s*entitlements(?:Inherit)?:\s*(.+)$/gm),
].map((m) => unquote(m[1]));

const errs = [];

const countOccurrences = (source, token) => source.split(token).length - 1;
const requireWorkflowToken = (workflow, label, token, minimum = 1) => {
  const count = countOccurrences(workflow, token);
  if (count < minimum) {
    errs.push(
      `${label} must contain ${JSON.stringify(token)} at least ${minimum} time(s); found ${count}`,
    );
  }
};

// electron-builder emits these alongside the macOS zip. They must survive every
// handoff: build artifact → GitHub Release, which IS the update origin now that
// the repo is public (apps/desktop/electron/updater.ts UPDATER_FEED_BY_CHANNEL).
requireWorkflowToken(
  stableReleaseWorkflow,
  "stable release workflow",
  "release/Zeros-*-arm64-mac.zip.blockmap",
);
// Twice: the emit assertion, and the `gh release create` upload list. Dropping
// either leaves differential updates fetching a blockmap that 404s, which
// silently degrades every update to a full ~180 MB download.
requireWorkflowToken(
  stableReleaseWorkflow,
  "stable release workflow",
  '"release/Zeros-${VERSION}-arm64-mac.zip.blockmap"',
  2,
);
// The feed itself must be ON the release, or /releases/latest/download/latest-mac.yml
// 404s and no installed app ever learns a new version exists.
requireWorkflowToken(
  stableReleaseWorkflow,
  "stable release workflow",
  '"release/latest-mac.yml"',
);
// The constant-named dmg the website Download button points at
// (apps/marketing/src/lib/site.ts DOWNLOAD_URL).
requireWorkflowToken(
  stableReleaseWorkflow,
  "stable release workflow",
  '"release/Zeros-arm64.dmg"',
);
for (const { label, text, file } of channelReleaseWorkflows) {
  // `alpha` | `beta` — the rolling release tag AND the artifact basename. They
  // must agree, or the feed references assets that were never uploaded.
  const ch = /release-(\w+)\.yml$/.exec(file)?.[1];
  requireWorkflowToken(text, label, 'ZIP_BLOCKMAP="${ZIP}.blockmap"');
  // Both `gh release` paths — the edit-existing branch and the create branch.
  // The zip and its blockmap ARE the update payload; without them the feed
  // points at nothing.
  requireWorkflowToken(
    text,
    label,
    '"$DMG" "$ZIP" "$ZIP_BLOCKMAP" "$LATEST_DMG"',
    2,
  );
  // The channel's own feed file, at EVERY hand-off: the emit guard, its error
  // message, and both `gh release` upload lists — 4 references. Asserting the
  // COUNT (not just presence) means a single hand-off silently dropping to
  // latest-mac.yml still fails; verified by swapping one line, which a min-1
  // check waved through.
  //
  // This is the #198 guard: that incident removed beta's uploads while the app
  // kept polling beta's feed, producing a stale feed and a false "You're up to
  // date!". Since the rolling prerelease is now BOTH the manual-install source
  // and the update origin, these four references are the whole chain.
  requireWorkflowToken(text, label, `release/${ch}-mac.yml`, 4);
  // The rolling tag the updater's base URL points at
  // (/releases/download/<ch>/). If the workflow ever published under a
  // versioned tag instead, every installed client would 404 forever.
  requireWorkflowToken(text, label, `"${ch}"`);
  // And the job env must pin the channel, or electron-builder-run applies the
  // WRONG appId/feed overrides (or stable's, which are none at all).
  requireWorkflowToken(text, label, `ZEROS_CHANNEL: ${ch}`);
}

for (const from of froms) {
  if (from.startsWith("binaries/zeros-engine-")) {
    if (from !== ENGINE_BINARY) {
      errs.push(
        `extraResources engine binary from: "${from}" does not match build-sidecar's output "${ENGINE_BINARY}" — they will desync at pack time`,
      );
    }
    continue; // built artifact, gitignored — name-match only
  }
  // Staged at pack time by scripts/stage-claude-cli.mjs (gitignored, like the
  // engine binary) — name-matched against that script's constants below.
  if (CLAUDE_STAGED.includes(from) || CODEX_STAGED.includes(from)) continue;
  if (!existsSync(from))
    errs.push(`extraResources from: "${from}" does not exist`);
}

// ── Bundled agent runtimes must actually ship ─────────────
//
// The packaged engine is a `bun build --compile` single-file binary with NO
// node_modules on disk, so ANY runtime it locates via require.resolve is
// unreachable there — while resolving perfectly in dev (`bun apps/desktop/src/cli.ts`) and in
// vitest. That asymmetry shipped a Claude that threw "Native CLI binary for
// darwin-arm64 not found" on every send in Beta + Production while dev was
// flawless (0.0.14), and nothing failed at build time: the app just booted into a
// broken agent. These assertions are the missing build-time failure.
for (const staged of CLAUDE_STAGED) {
  if (!froms.includes(staged)) {
    errs.push(
      `electron-builder.yml has no extraResources \`from: ${staged}\` — the packaged ` +
        `app would ship WITHOUT the Claude Code runtime and every Claude send would ` +
        `fail with "AGENT RESPONSE FAILURE" (the engine cannot require.resolve it: ` +
        `bun-compiled binary, no node_modules). Keep this in sync with ` +
        `scripts/stage-claude-cli.mjs.`,
    );
  }
}
for (const staged of CODEX_STAGED) {
  if (!froms.includes(staged)) {
    errs.push(
      `electron-builder.yml has no extraResources \`from: ${staged}\` — the packaged ` +
        `engine would fall back to an unpinned Codex from PATH. Keep this in sync ` +
        `with scripts/stage-codex-cli.mjs.`,
    );
  }
}
for (const legalResource of LEGAL_RESOURCES) {
  if (!froms.includes(legalResource)) {
    errs.push(
      `electron-builder.yml has no extraResources \`from: ${legalResource}\` — binary releases must include repository and third-party terms`,
    );
  }
}
// beforePack is what actually runs the staging. Without this call the
// extraResources entries above point at files that were never created, and
// electron-builder does NOT fail on a `from:` that matches zero files.
if (!/stage-claude-cli\.mjs/.test(beforePackSource)) {
  errs.push(
    "scripts/electron-before-pack.cjs no longer invokes stage-claude-cli.mjs — " +
      "binaries/claude would never be created and electron-builder silently packs nothing " +
      "for a zero-match extraResources entry",
  );
}
if (!/stage-codex-cli\.mjs/.test(beforePackSource)) {
  errs.push(
    "scripts/electron-before-pack.cjs no longer invokes stage-codex-cli.mjs — " +
      "the packaged engine would silently fall back to an unpinned Codex on PATH",
  );
}
// The npm copy of the ~250 MiB platform package must stay OUT of the asar: it is
// exec'd directly (impossible from inside an archive) and would otherwise double
// the blob's contribution to the download.
if (
  !/!\*\*\/node_modules\/@anthropic-ai\/claude-agent-sdk-\*\/\*\*/.test(yml)
) {
  errs.push(
    "electron-builder.yml `files:` must exclude **/node_modules/@anthropic-ai/claude-agent-sdk-*/** — " +
      "otherwise the ~250 MiB Claude Code binary is ALSO packed inside app.asar, where it " +
      "cannot be executed, doubling the app's size for nothing",
  );
}
if (!/!\*\*\/node_modules\/@openai\/codex-\*\/\*\*/.test(yml)) {
  errs.push(
    "electron-builder.yml `files:` must exclude **/node_modules/@openai/codex-*/** — " +
      "the staged native runtime already ships through extraResources",
  );
}

if (beforePack && !existsSync(unquote(beforePack))) {
  errs.push(`beforePack hook "${unquote(beforePack)}" does not exist`);
}
if (afterPack && !existsSync(unquote(afterPack))) {
  errs.push(`afterPack hook "${unquote(afterPack)}" does not exist`);
}
if (icon && !existsSync(unquote(icon))) {
  errs.push(`mac.icon "${unquote(icon)}" does not exist`);
}

// Per-channel icons come from `-c.mac.icon=` CLI OVERRIDES in
// electron-builder-run.mjs, not from electron-builder.yml — so the `icon:` check
// above never sees them. Without this, a missing or typo'd channel icon is only
// discovered by looking at the Dock of a shipped build, and the channels would be
// visually indistinguishable from Production (the one thing the badge exists to
// prevent).
const builderRun = readFileSync("scripts/electron-builder-run.mjs", "utf8");
const channelIcons = [...builderRun.matchAll(/-c\.mac\.icon=([^"']+)/g)].map(
  (m) => m[1],
);
if (channelIcons.length === 0) {
  errs.push(
    "no `-c.mac.icon=` overrides parsed from scripts/electron-builder-run.mjs — " +
      "parser drift, or the channels lost their distinct icons",
  );
}
for (const p of channelIcons) {
  if (!existsSync(p)) {
    errs.push(`channel icon override "${p}" does not exist`);
  }
}
// Each non-stable channel must have its OWN icon file. Sharing one (e.g. Alpha
// falling back to the β mark) makes two channels indistinguishable in the Dock.
if (new Set(channelIcons).size !== channelIcons.length) {
  errs.push(
    `channel icons are not distinct (${channelIcons.join(", ")}) — each channel needs its own badge`,
  );
}
for (const ent of entitlements) {
  // Skip electron-builder ${env.*} interpolations — only static paths are checkable.
  if (ent.includes("${")) continue;
  if (!existsSync(ent)) errs.push(`mac.entitlements "${ent}" does not exist`);
}
if (froms.length === 0) {
  errs.push(
    "no `from:` entries parsed from electron-builder.yml — parser drift?",
  );
}
// node-pty's Darwin prebuild is deliberate. A blanket source rebuild creates a
// higher-priority build/ override, making the packaged selection cache-dependent.
// Guard the deterministic policy here; the packaged spawn smoke covers the
// separate app.asar.unpacked helper-location failure seen in beta.58.
if (!/^npmRebuild:\s*false\s*$/m.test(yml)) {
  errs.push(
    "npmRebuild must stay false (beforePack rebuilds only better-sqlite3)",
  );
}
if (/^buildDependenciesFromSource:\s*true\s*$/m.test(yml)) {
  errs.push(
    "blanket buildDependenciesFromSource makes Darwin node-pty cache-dependent",
  );
}

if (errs.length > 0) {
  console.error(
    "✖ check:packaging-paths — electron-builder path(s) don't resolve:",
  );
  for (const e of errs) console.error(`  • ${e}`);
  process.exit(1);
}
console.log(
  `✓ check:packaging-paths — ${froms.length} extraResources + beforePack/afterPack + icon + ` +
    `${entitlements.length} entitlements resolve; engine binary, Claude/Codex runtime staging, and ` +
    `updater assets for stable + ${channelReleaseWorkflows.length} channel workflow(s) ` +
    `(${channelReleaseWorkflows.map((w) => w.label.split(" ")[0]).join(", ")}) are guarded`,
);
