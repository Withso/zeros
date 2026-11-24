#!/usr/bin/env node
// electron-updater skips an update whose feed names a `minimumSystemVersion`
// newer than os.release(), which on macOS is the Darwin version, not the macOS
// one. electron-builder never writes the field, so without it a Mac below the
// packaged app's LSMinimumSystemVersion installs an update that cannot launch.
//
//   node scripts/stamp-update-feed-minimum-os.mjs --feed release/latest-mac.yml [--app <packaged .app>]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

const PLUTIL = "/usr/bin/plutil";

/** The Darwin version every release of a macOS major version reports. */
export function darwinVersionForMacOS(version) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(version).trim());
  if (!match) throw new Error(`unrecognized macOS version ${JSON.stringify(version)}`);
  const major = Number(match[1]);
  // Darwin minors do not track macOS minors, so only a major floor converts exactly.
  if (Number(match[2] ?? 0) !== 0 || Number(match[3] ?? 0) !== 0)
    throw new Error(`macOS ${version} is not a major-version floor; its Darwin version is not exact`);
  // macOS 11-15 are Darwin 20-24; macOS 26 (the year numbering) is Darwin 25.
  if (major >= 11 && major <= 15) return `${major + 9}.0.0`;
  if (major >= 26) return `${major - 1}.0.0`;
  throw new Error(`no Darwin version known for macOS ${version}`);
}

export function stampMinimumSystemVersion(feed, darwinVersion) {
  const before = yaml.load(feed);
  if (!before || typeof before !== "object" || typeof before.version !== "string" || !Array.isArray(before.files))
    throw new Error("not an electron-updater feed (version and files are required)");
  const kept = feed.replace(/^minimumSystemVersion:.*\n?/m, "");
  const stamped = `${kept}${kept.endsWith("\n") ? "" : "\n"}minimumSystemVersion: ${darwinVersion}\n`;
  const after = yaml.load(stamped);
  if (after.minimumSystemVersion !== darwinVersion)
    throw new Error(`stamped feed reads minimumSystemVersion ${JSON.stringify(after.minimumSystemVersion)}`);
  return stamped;
}

export function packagedApp(root) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".app")) found.push(join(dir, entry.name));
      else visit(join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  if (found.length !== 1)
    throw new Error(`expected exactly one packaged .app under ${root} (found ${found.length}); pass --app`);
  return found[0];
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!["--feed", "--app"].includes(name) || !value || value.startsWith("--"))
      throw new Error(`expected --feed <file> [--app <path>]; received ${JSON.stringify(argv)}`);
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`);
    values.set(name, value);
  }
  if (!values.has("--feed")) throw new Error("missing required argument: --feed");
  return { feed: resolve(values.get("--feed")), app: values.has("--app") ? resolve(values.get("--app")) : undefined };
}

export function stampFeed({ feed, app = packagedApp(resolve("release")) }) {
  const minimum = execFileSync(PLUTIL, ["-extract", "LSMinimumSystemVersion", "raw", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  const darwin = darwinVersionForMacOS(minimum);
  writeFileSync(feed, stampMinimumSystemVersion(readFileSync(feed, "utf8"), darwin));
  return { minimum, darwin };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const { minimum, darwin } = stampFeed(options);
    console.log(`✓ ${options.feed}: minimumSystemVersion ${darwin} (macOS ${minimum})`);
  } catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
