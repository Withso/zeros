#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// compute-version.mjs — derive the next release version
// ──────────────────────────────────────────────────────────
//
// Scheme (locked by release.config.json + release.yml):
//
//   version = MAJOR.MINOR.PATCH
//
//   • MAJOR + MINOR are MANUAL. They only ever change when you run
//       `pnpm version:set X.Y.Z`  (on `main`, then commit release.config.json).
//     Nothing auto-bumps them — a feature drop (0.0 → 0.1) or a milestone
//     (0.x → 1.0 / 1.x → 2.0) is always your decision.
//
//   • PATCH is AUTOMATIC and CONTIGUOUS. Every release bumps it by exactly 1:
//       0.0.1 → 0.0.2 → 0.0.3 → …
//     The next patch = (highest released patch on the current MAJOR.MINOR
//     line) + 1, read from the git tags `vMAJOR.MINOR.*`. With no tags yet on
//     the line, the next release is the baseline patch from release.config.json
//     (so the first release after `version:set 0.0.1` is exactly 0.0.1, and
//     the first release after `version:set 1.1.0` is exactly 1.1.0).
//
//   There is NO base-100 rollover — patch is unbounded (0.0.99 → 0.0.100 is
//   fine). Bump the minor whenever you want a cleaner number; that's manual.
//
// Authoritative computation runs in CI (release.yml) against freshly-fetched
// tags. Locally, run `git fetch --tags` first for an accurate `version:current`.
//
// SAFETY: a checkout with ZERO `v*` tags is treated as broken (shallow clone,
// tag-less CI checkout, post-rewrite tag loss) and FAILS, because falling back
// to the baseline there would publish a downgrade over the stable auto-update
// feed. Override with ZEROS_ALLOW_UNTAGGED_RELEASE=1 — see main() for the
// preconditions.
//
// Usage:
//   node scripts/compute-version.mjs            → prints the next release version
//   node scripts/compute-version.mjs --set 1.0.0
//       → rewrites release.config.json so the NEXT release is exactly 1.0.0,
//         and auto-increment resumes at 1.0.1, 1.0.2, …  Prints 1.0.0.
// ──────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "release.config.json");

function readConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  // Tolerate either a flat {major,minor,patch} or a nested {version:{…}} shape.
  const base = cfg.version ?? cfg;
  return {
    major: Number(base.major) || 0,
    minor: Number(base.minor) || 0,
    patch: Number(base.patch) || 0,
  };
}

/** Tags reachable in the current checkout that name a release on the
 *  MAJOR.MINOR line. CI fetches tags before calling this; locally it reflects
 *  whatever tags you have (run `git fetch --tags` for an accurate read). */
function lineTags(base) {
  try {
    const out = execSync(`git tag -l "v${base.major}.${base.minor}.*"`, {
      cwd: ROOT,
    })
      .toString()
      .trim();
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

/** Every release-shaped tag in the checkout (`vX.Y.Z`), on ANY line. The version
 *  computation itself only looks at the current MAJOR.MINOR line; this wider
 *  read exists solely for the downgrade guard in main(). Returns [] both when
 *  git has no tags and when git is unavailable — the guard treats the two the
 *  same, because both mean "this checkout cannot prove what shipped". */
function allReleaseTags() {
  try {
    const out = execSync(`git tag -l "v*"`, { cwd: ROOT }).toString().trim();
    if (!out) return [];
    return out
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  } catch {
    return [];
  }
}

/**
 * Pure: the next release version for a baseline + the set of existing tags.
 * Exported for unit testing (no git, no fs).
 *
 * @param {{major:number,minor:number,patch:number}} base  baseline from config
 * @param {string[]} tags  candidate tag names (e.g. ["v0.0.1","v0.1.0"])
 * @returns {string} "MAJOR.MINOR.PATCH"
 */
export function computeVersion(base, tags) {
  // Only tags on the SAME major.minor line count toward the patch sequence.
  // Anchored regex so "v0.1.*" never accidentally swallows "v0.10.*", and a
  // suffix like "v0.0.1-beta" is ignored (it has no plain integer patch).
  const re = new RegExp(`^v${base.major}\\.${base.minor}\\.(\\d+)$`);
  const patches = (tags ?? [])
    .map((t) => re.exec(String(t).trim()))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n) && n >= 0);

  // First release on the line → exactly the baseline patch. Otherwise one past
  // the highest released patch (and never below the baseline, so a freshly
  // pinned floor is always respected).
  const patch = patches.length
    ? Math.max(base.patch, Math.max(...patches) + 1)
    : base.patch;

  return `${base.major}.${base.minor}.${patch}`;
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) {
    console.error(
      `Invalid version "${v}". Expected MAJOR.MINOR.PATCH (e.g. 1.0.0).`,
    );
    process.exit(1);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function main() {
  const args = process.argv.slice(2);
  const setIdx = args.indexOf("--set");

  if (setIdx !== -1) {
    const target = parseSemver(args[setIdx + 1]);
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    // Preserve the leading $comment if present, rewrite the baseline.
    const next = {
      ...(cfg.$comment ? { $comment: cfg.$comment } : {}),
      major: target.major,
      minor: target.minor,
      patch: target.patch,
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
    process.stdout.write(`${target.major}.${target.minor}.${target.patch}\n`);
    return;
  }

  const base = readConfig();

  // ── Downgrade guard: no tags is a BROKEN checkout, not "first release" ──
  //
  // The patch number is derived entirely from the `v*` tags visible here. If
  // they are missing — a shallow clone, a CI checkout that skipped tags, or a
  // history rewrite that dropped them — computeVersion() silently falls back
  // to the release.config.json baseline while shipped users are already on a
  // much higher version. The release workflow then deletes and re-creates that
  // lower tag and publishes it over the STABLE auto-update feed, so every
  // installed app is offered a build older than the one it is running. That is
  // unrecoverable without a manual re-download campaign, so refuse to guess.
  //
  // A genuinely first-ever release (or a deliberate fresh-start repository)
  // opts in explicitly, AFTER pinning the baseline above the highest version
  // ever shipped with `pnpm version:set`.
  if (allReleaseTags().length === 0 && process.env.ZEROS_ALLOW_UNTAGGED_RELEASE !== "1") {
    console.error(
      [
        "✖ compute-version — no `vX.Y.Z` release tags are visible in this checkout.",
        "",
        `  Refusing to fall back to the release.config.json baseline (${base.major}.${base.minor}.${base.patch}):`,
        "  if any version has ever shipped, that baseline is a DOWNGRADE and publishing it",
        "  would overwrite the stable auto-update feed with a build older than users have.",
        "",
        "  Fix one of these, then re-run:",
        "    • Fetch the tags:            git fetch --tags --force",
        "    • In CI, checkout with:      fetch-depth: 0   (and do not filter tags)",
        "    • After a history rewrite:   re-create and force-push every `v*` tag onto",
        "                                 the rewritten commits BEFORE the next release.",
        "",
        "  If this really is the first release ever (or a deliberate fresh-start repo):",
        "    1. pnpm version:set <higher-than-anything-ever-shipped>   # commit release.config.json",
        "    2. ZEROS_ALLOW_UNTAGGED_RELEASE=1 node scripts/compute-version.mjs",
      ].join("\n"),
    );
    process.exit(1);
  }

  process.stdout.write(computeVersion(base, lineTags(base)) + "\n");
}

// Run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
