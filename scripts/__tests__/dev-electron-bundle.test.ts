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
import vm from "node:vm";
// @ts-expect-error — .cjs has no type declarations; it exports plain functions.
import {
  instanceBundleDir,
  legacyInstanceBundleDir,
  pruneStaleBundles,
  discardBundle,
  patchPlist,
  localInstanceBundlePaths,
} from "../dev-electron-bundle.cjs";

// A realistic pair: the slug carries the uniqueness hash, the name never does.
const SLUG = "coralline-ebf2";
const NAME = "zeros-coralline";

describe("Local bundle containment",()=>{
  it.each([false,true])("creates a protected Local bundle and cleans the old cache best-effort (failure=%s)",(failure)=>{
    const home=tmp();
    const name="Zeros Local test abcdef";
    const slug="a123456789abcdef";
    const expected=path.join(home,".zeros-local","instances",slug,"bundle",`${name}.app`);
    const legacy=path.join(home,".zeros-local","dev-instances",slug);
    fs.mkdirSync(path.join(legacy,"old.app"),{recursive:true});
    const source=fs.readFileSync("scripts/dev-electron-bundle.cjs","utf8");
    const context={
      module:{exports:{} as {prepareLocalInstanceBundle:(identity:object)=>unknown}},process:{platform:"darwin"},os:{homedir:()=>home},path,
      localInstanceBundlePaths:(identity:{slug:string;name:string})=>localInstanceBundlePaths({...identity,home}),
      fs:{...fs,readFileSync:()=>"",existsSync:()=>false,rmSync:(file:string,options:object)=>{if(file===legacy && failure)throw new Error("synthetic cache cleanup failure");fs.rmSync(file,options);},mkdirSync:()=>{},writeFileSync:(file:string)=>{markers.push(file);}},
      findBaseElectronApp:()=>"/base/Electron.app",readElectronVersion:()=>"38.0.0",
      cloneBundleHardlink:(_base:string,dest:string)=>{clones.push(dest);},readPlistValue:()=>"Electron",patchExecutable:()=>{},patchPlist:()=>{},patchIcon:()=>{},
    };
    const clones:string[]=[],markers:string[]=[];
    vm.runInNewContext(source.slice(source.indexOf("function prepareLocalInstanceBundle("))+"\nmodule.exports={prepareLocalInstanceBundle};",context);
    context.module.exports.prepareLocalInstanceBundle({slug,name});
    expect(clones).toEqual([expected]);
    expect(markers).toEqual([`${expected}.version`]);
    expect(fs.existsSync(legacy)).toBe(failure);
  });
});

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

describe("dev automation permissions", () => {
  it.each([false, true])(
    "declares why the app requests Apple Events (existing description: %s)",
    (existingDescription) => {
      const dir = tmp();
      const base = path.join(dir, "base.plist");
      const clone = path.join(dir, "clone.plist");
      const original = `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
${existingDescription ? "<key>NSAppleEventsUsageDescription</key><string>Old description</string>" : ""}
</dict></plist>`;
      fs.writeFileSync(base, original);
      fs.linkSync(base, clone);
      const identity = {
        name: NAME,
        exec: NAME,
        bundleId: `com.zeros.dev.${SLUG}`,
      };

      expect(patchPlist(clone, identity)).toBe(true);

      const patched = fs.readFileSync(clone, "utf8");
      expect(patched).toMatch(
        /<key>NSAppleEventsUsageDescription<\/key>\s*<string>[^<]*Zeros[^<]*<\/string>/,
      );
      expect(patched).not.toContain("Old description");
      // macOS cannot register the running Dev instance for OAuth returns
      // without this declaration; it otherwise opens an older checkout.
      expect(patched).toMatch(
        /<key>CFBundleURLTypes<\/key>\s*<array>\s*<dict>\s*<key>CFBundleURLName<\/key>\s*<string>Zeros Dev<\/string>\s*<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>zeros-dev<\/string>\s*<\/array>\s*<\/dict>\s*<\/array>/,
      );
      expect(
        patched.match(/<key>NSAppleEventsUsageDescription<\/key>/g),
      ).toHaveLength(1);
      // Instance bundles share inodes with Electron; permission metadata must
      // never rewrite the base bundle or another instance through a hardlink.
      expect(fs.readFileSync(base, "utf8")).toBe(original);
      expect(patchPlist(clone, identity)).toBe(false);
      expect(fs.readFileSync(clone, "utf8")).toBe(patched);
    },
  );
});

describe("dev callback scheme", () => {
  it("removes inherited OAuth schemes from Local without changing the shared hardlink", () => {
    const dir = tmp(), base = path.join(dir, "base.plist"), clone = path.join(dir, "local.plist");
    const original = '<plist><dict><key>CFBundleName</key><string>Zeros Dev</string><key>CFBundleExecutable</key><string>Zeros Dev</string><key>CFBundleIdentifier</key><string>com.zeros.dev</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>zeros-dev</string></array></dict></array></dict></plist>';
    fs.writeFileSync(base, original); fs.linkSync(base, clone);
    const identity = { name: "Zeros Local checkout", exec: "Zeros Local checkout", bundleId: "com.zeros.local.a123", local: true };
    expect(patchPlist(clone, identity)).toBe(true);
    expect(fs.readFileSync(clone, "utf8")).not.toContain("<string>zeros-dev</string>");
    expect(fs.readFileSync(base, "utf8")).toBe(original);
    expect(patchPlist(clone, identity)).toBe(false);
  });
  it("fills an empty callback array and leaves malformed metadata untouched", () => {
    const file = path.join(tmp(), "Info.plist");
    const identity = { name: NAME, exec: NAME, bundleId: `com.zeros.dev.${SLUG}` };
    const plist = (array: string) => `<plist><dict><key>CFBundleName</key><string>Electron</string><key>CFBundleURLTypes</key>${array}</dict></plist>`;
    fs.writeFileSync(file, plist("<array/>"));
    expect(patchPlist(file, identity)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("<string>zeros-dev</string>");
    for (const invalid of ["<string>bad</string>", "<array><dict></dict>"]) {
      const original = plist(invalid);
      fs.writeFileSync(file, original);
      expect(() => patchPlist(file, identity)).toThrow("Dev bundle callback declaration");
      expect(fs.readFileSync(file, "utf8")).toBe(original);
    }
  });

  it("replaces an inherited scheme without damaging nested or adjacent plist values", () => {
    const file = path.join(tmp(), "Info.plist");
    fs.writeFileSync(file, `<plist version="1.0"><dict>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLSchemes</key><array><string>zeros-alpha</string><string>zeros</string></array>
</dict><dict><key>CFBundleURLSchemes</key><array><string>old-dev</string></array></dict></array>
<key>DocumentTypes</key><array><dict><key>Name</key><string>keep</string></dict></array>
</dict></plist>`);
    const identity = { name: NAME, exec: NAME, bundleId: `com.zeros.dev.${SLUG}` };
    expect(patchPlist(file, identity)).toBe(true);
    const patched = fs.readFileSync(file, "utf8");
    expect(patched).not.toMatch(/<string>(?:zeros-alpha|zeros|old-dev)<\/string>/);
    expect(patched.match(/<key>CFBundleURLTypes<\/key>/g)).toHaveLength(1);
    expect(patched.match(/<string>zeros-dev<\/string>/g)).toHaveLength(1);
    expect(patched).toContain('<key>DocumentTypes</key><array><dict><key>Name</key><string>keep</string></dict></array>');
    expect(patched.match(/<array>/g)?.length).toBe(patched.match(/<\/array>/g)?.length);
    expect(patchPlist(file, identity)).toBe(false);
  });
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
