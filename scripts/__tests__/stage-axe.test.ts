import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneEmptyDirectories } from "../stage-axe.mjs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zeros-stage-axe-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The release's framework layout: the top-level `Frameworks` link points at
 * an empty `Versions/A/Frameworks` directory. */
function framework(name: string) {
  const bundle = join(root, "Frameworks", `${name}.framework`);
  const version = join(bundle, "Versions", "A");
  mkdirSync(join(version, "Frameworks"), { recursive: true });
  mkdirSync(join(version, "Resources"));
  writeFileSync(join(version, name), "mach-o");
  writeFileSync(join(version, "Resources", "Info.plist"), "plist");
  symlinkSync("A", join(bundle, "Versions", "Current"));
  for (const entry of [name, "Frameworks", "Resources"]) {
    symlinkSync(`Versions/Current/${entry}`, join(bundle, entry));
  }
}

/** electron-builder copies only files and symlinks into the app, so an empty
 * directory never arrives there and a link into it dangles, which fails the
 * signing pass when it stats the link. */
function entriesPackagingLoses(directory: string): string[] {
  const lost: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (lstatSync(path).isSymbolicLink()) {
      try {
        statSync(path);
      } catch {
        lost.push(relative(root, path));
      }
    } else if (lstatSync(path).isDirectory()) {
      if (readdirSync(path).length === 0) lost.push(relative(root, path));
      else lost.push(...entriesPackagingLoses(path));
    }
  }
  return lost;
}

function tree(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry);
      const name = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return [`${name} -> ${readlinkSync(path)}`];
      if (stat.isDirectory()) return [`${name}/`, ...tree(path)];
      return [name];
    });
}

describe("AXe staging", () => {
  it("leaves nothing for electron-builder's copy to drop or break", () => {
    writeFileSync(join(root, "axe"), "mach-o");
    framework("FBDeviceControl");
    framework("XCTestBootstrap");
    expect(entriesPackagingLoses(root)).not.toEqual([]);

    pruneEmptyDirectories(root);

    expect(entriesPackagingLoses(root)).toEqual([]);
  });

  it("removes only empty directories and the links into them", () => {
    writeFileSync(join(root, "axe"), "mach-o");
    framework("FBDeviceControl");
    mkdirSync(join(root, "empty", "nested"), { recursive: true });

    pruneEmptyDirectories(root);

    const bundle = "Frameworks/FBDeviceControl.framework";
    expect(tree(root)).toEqual([
      "Frameworks/",
      `${bundle}/`,
      `${bundle}/FBDeviceControl -> Versions/Current/FBDeviceControl`,
      `${bundle}/Resources -> Versions/Current/Resources`,
      `${bundle}/Versions/`,
      `${bundle}/Versions/A/`,
      `${bundle}/Versions/A/FBDeviceControl`,
      `${bundle}/Versions/A/Resources/`,
      `${bundle}/Versions/A/Resources/Info.plist`,
      `${bundle}/Versions/Current -> A`,
      "axe",
    ]);
  });
});
