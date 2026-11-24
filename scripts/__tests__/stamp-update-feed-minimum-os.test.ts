import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  darwinVersionForMacOS,
  parseArguments,
  stampFeed,
  stampMinimumSystemVersion,
} from "../stamp-update-feed-minimum-os.mjs";

const require = createRequire(import.meta.url);
const { AppUpdater } = require("electron-updater/out/AppUpdater");
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");

const FEED = `version: 0.1.31
files:
  - url: Zeros-0.1.31-arm64-mac.zip
    sha512: emlwc2hh
    size: 181234567
    blockMapSize: 190123
  - url: Zeros-0.1.31-arm64.dmg
    sha512: ZG1nc2hh
    size: 185234567
path: Zeros-0.1.31-arm64-mac.zip
sha512: emlwc2hh
releaseDate: '2026-11-24T10:00:00.000Z'
`;

/** What an installed app's electron-updater decides for this feed on a Mac reporting `darwin`. */
function updaterAccepts(feed: string, darwin: string): boolean {
  const info = parseUpdateInfo(feed, "latest-mac.yml", new URL("https://example.invalid/latest-mac.yml"));
  vi.spyOn(os, "release").mockReturnValue(darwin);
  return AppUpdater.prototype.checkIfUpdateSupported.call({ _logger: { info() {}, warn() {} } }, info);
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("update feed minimum macOS", () => {
  it("converts a macOS major floor to the Darwin version os.release() reports", () => {
    expect(darwinVersionForMacOS("12.0")).toBe("21.0.0");
    expect(darwinVersionForMacOS("13.0")).toBe("22.0.0");
    expect(darwinVersionForMacOS("15")).toBe("24.0.0");
    expect(darwinVersionForMacOS("26.0")).toBe("25.0.0");
    expect(() => darwinVersionForMacOS("13.5")).toThrow(/not a major-version floor/);
    expect(() => darwinVersionForMacOS("10.15")).toThrow(/not a major-version floor/);
    expect(() => darwinVersionForMacOS("10.0")).toThrow(/no Darwin version/);
    expect(() => darwinVersionForMacOS("")).toThrow(/unrecognized/);
  });

  it("keeps a macOS 12 Mac on its build and lets macOS 13 and later update", () => {
    expect(updaterAccepts(FEED, "21.6.0")).toBe(true);
    const stamped = stampMinimumSystemVersion(FEED, "22.0.0");
    expect(updaterAccepts(stamped, "21.6.0")).toBe(false);
    expect(updaterAccepts(stamped, "22.1.0")).toBe(true);
    expect(updaterAccepts(stamped, "25.2.0")).toBe(true);
  });

  it("adds only the field and replaces an earlier stamp", () => {
    const stamped = stampMinimumSystemVersion(FEED, "22.0.0");
    expect(stamped).toBe(`${FEED}minimumSystemVersion: 22.0.0\n`);
    expect(stampMinimumSystemVersion(stamped, "22.0.0")).toBe(stamped);
    expect(stampMinimumSystemVersion(stamped, "23.0.0")).toBe(`${FEED}minimumSystemVersion: 23.0.0\n`);
    expect(stampMinimumSystemVersion(FEED.trimEnd(), "22.0.0")).toBe(stamped);
  });

  it("refuses a file that is not an update feed", () => {
    expect(() => stampMinimumSystemVersion("files: []\n", "22.0.0")).toThrow(/not an electron-updater feed/);
    expect(() => stampMinimumSystemVersion("version: 1.0.0\n", "22.0.0")).toThrow(/not an electron-updater feed/);
  });

  it("requires a feed and accepts an explicit app", () => {
    expect(() => parseArguments([])).toThrow(/--feed/);
    expect(() => parseArguments(["--feed"])).toThrow(/expected --feed/);
    expect(() => parseArguments(["--feed", "a.yml", "--feed", "b.yml"])).toThrow(/duplicate/);
    expect(() => parseArguments(["--zip", "a.zip"])).toThrow(/expected --feed/);
    expect(parseArguments(["--feed", "/r/latest-mac.yml", "--app", "/r/mac-arm64/Zeros.app"])).toEqual({
      feed: "/r/latest-mac.yml",
      app: "/r/mac-arm64/Zeros.app",
    });
  });

  it.runIf(process.platform === "darwin")("reads the floor from the packaged app's Info.plist", () => {
    const root = mkdtempSync(join(tmpdir(), "zeros-feed-minimum-"));
    roots.push(root);
    const contents = join(root, "mac-arm64", "Zeros Alpha.app", "Contents");
    mkdirSync(contents, { recursive: true });
    const plist = join(contents, "Info.plist");
    writeFileSync(plist, "{}");
    execFileSync("/usr/bin/plutil", ["-convert", "binary1", plist]);
    execFileSync("/usr/bin/plutil", ["-insert", "LSMinimumSystemVersion", "-string", "13.0", plist]);
    const feed = join(root, "alpha-mac.yml");
    writeFileSync(feed, FEED);
    expect(stampFeed({ feed, app: join(root, "mac-arm64", "Zeros Alpha.app") })).toEqual({ minimum: "13.0", darwin: "22.0.0" });
    expect(readFileSync(feed, "utf8")).toBe(`${FEED}minimumSystemVersion: 22.0.0\n`);
  });
});
