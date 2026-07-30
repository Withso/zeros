// Dev-instance .app bundle layout (scripts/dev-electron-bundle.cjs).
//
// The bug these pin: a per-worktree dev instance has TWO names — a slug that
// exists only to be unique (branch tail + a 4-char realpath hash, e.g.
// `coralline-ebf2`) and the display name the user should actually see
// (`zeros-coralline`). The launcher patched CFBundleName/CFBundleDisplayName
// with the display name but FILED the bundle under the slug, and macOS reads
// those two surfaces from different places: Cmd-Tab, the Apple menu and
// `lsappinfo` take the running process's CFBundleName, while a Dock tile is a
// FILE reference whose tooltip is the file's Finder display name — and Finder
// ignores CFBundleDisplayName when it disagrees with the on-disk filename. Net
// effect, verified on macOS 26: Cmd-Tab said "zeros-coralline", the Dock said
// "coralline-ebf2". The fix moves the slug up a directory so the filename can be
// the display name, which is what test 1 below actually asserts.
//
// prepareInstanceBundle() itself is darwin-only (it hardlink-clones and patches a
// real Electron.app), so what CI can pin is the layout + the cleanup rules — and
// the cleanup is the risky half: it deletes directories under $HOME.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — .cjs has no type declarations; it exports plain functions.
import {
  instanceBundleDir,
  legacyInstanceBundleDir,
  pruneStaleBundles,
  discardBundle,
} from "../dev-electron-bundle.cjs";

// A realistic pair: the slug carries the uniqueness hash, the name never does.
const SLUG = "coralline-ebf2";
const NAME = "zeros-coralline";

const tmpdirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-bundle-"));
  tmpdirs.push(dir);
  return dir;
}

/** A stand-in for a cloned bundle: a `<name>.app` directory with one file
 *  inside, plus the sibling `.version` cache marker the launcher writes. */
function fakeBundle(dir: string, name: string): string {
  const app = path.join(dir, `${name}.app`);
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), "<plist/>");
  fs.writeFileSync(`${app}.version`, "38.0.0");
  return app;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("instanceBundleDir", () => {
  it("names the .app after the DISPLAY name, never the slug", () => {
    const dir = instanceBundleDir(SLUG, NAME);
    // The Dock reads this basename. It must be the display name verbatim —
    // that is the entire fix.
    expect(path.basename(dir)).toBe(`${NAME}.app`);
    expect(path.basename(dir)).not.toContain("ebf2");
  });

  it("keeps the slug as the parent directory, so uniqueness survives", () => {
    expect(path.dirname(instanceBundleDir(SLUG, NAME))).toBe(
      path.join(os.homedir(), ".zeros-dev", "dev-instances", SLUG),
    );
    // Two worktrees on branches whose tails collide share a display name; the
    // realpath hash in the slug is what still keeps their bundles apart.
    expect(instanceBundleDir("coralline-ebf2", NAME)).not.toBe(
      instanceBundleDir("coralline-91ac", NAME),
    );
  });

  it("lives under the dev dot-dir, never the production ~/.zeros", () => {
    const dir = instanceBundleDir(SLUG, NAME);
    expect(dir.startsWith(path.join(os.homedir(), ".zeros-dev") + path.sep)).toBe(
      true,
    );
  });

  it("does not collide with the legacy flat path it replaces", () => {
    // Old layout: `dev-instances/<slug>.app`. New: `dev-instances/<slug>/…`.
    // Distinct names, so the cleanup below can never delete the live bundle.
    const legacy = legacyInstanceBundleDir(SLUG);
    expect(legacy).toBe(
      path.join(os.homedir(), ".zeros-dev", "dev-instances", `${SLUG}.app`),
    );
    expect(instanceBundleDir(SLUG, NAME).startsWith(legacy + path.sep)).toBe(
      false,
    );
  });
});

describe("discardBundle", () => {
  it("removes the bundle and its version marker", () => {
    const dir = tmp();
    const app = fakeBundle(dir, "zeros-old-name");
    discardBundle(app);
    expect(fs.existsSync(app)).toBe(false);
    expect(fs.existsSync(`${app}.version`)).toBe(false);
  });

  it("is a no-op on a path that isn't there", () => {
    expect(() => discardBundle(path.join(tmp(), "nope.app"))).not.toThrow();
  });
});

describe("pruneStaleBundles", () => {
  it("keeps the live bundle and retires every other one", () => {
    // The rename case: an explicit $ZEROS_INSTANCE pins the slug, so a branch
    // rename changes only the display name — leaving the old bundle behind with
    // the SAME CFBundleIdentifier for LaunchServices to choose between.
    const dir = tmp();
    const keep = fakeBundle(dir, NAME);
    const stale = fakeBundle(dir, "zeros-old-name");

    pruneStaleBundles(dir, path.basename(keep));

    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(`${keep}.version`)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(`${stale}.version`)).toBe(false);
  });

  it("leaves non-.app entries alone", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
    pruneStaleBundles(dir, `${NAME}.app`);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("is a no-op before the first clone, when the directory is absent", () => {
    const missing = path.join(tmp(), "never-created");
    expect(() => pruneStaleBundles(missing, `${NAME}.app`)).not.toThrow();
  });
});
