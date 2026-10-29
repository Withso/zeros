#!/usr/bin/env node
// Major/minor are manually pinned; patch follows the highest release tag
// on that line, respecting the configured floor. Fetch tags before computing
// locally. A checkout without release tags cannot prove a safe version:
// falling back to its baseline could overwrite the updater feed with a downgrade.

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

/** Local results are only as fresh as the checkout's fetched release tags. */
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

/** Missing Git and missing tags both mean the downgrade guard lacks evidence. */
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
  // Exclude neighboring minor lines and prerelease suffixes from the patch sequence.
  const re = new RegExp(`^v${base.major}\\.${base.minor}\\.(\\d+)$`);
  const patches = (tags ?? [])
    .map((t) => re.exec(String(t).trim()))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n) && n >= 0);

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

  // Refuse a baseline fallback when release history is unknown. A deliberate
  // first release opts in only after pinning above every version ever shipped.
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
