// Development .app bundles (scripts/dev-electron-bundle.cjs). macOS takes the
// Dock name from the bundle filename and Cmd-Tab from CFBundleName, so both
// carry the display name; uniqueness lives in the parent instance folder.
// prepareLocalInstanceBundle() itself is darwin-only (it hardlink-clones and
// patches a real Electron.app), so CI pins the layout and plist patching.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
// @ts-expect-error — .cjs has no type declarations; it exports plain functions.
import {
  patchPlist,
  localInstanceBundlePaths,
} from "../dev-electron-bundle.cjs";

const NAME = "Zeros Local Alpha";
const BUNDLE_ID = "com.zeros.local.alpha";

describe("Local bundle containment",()=>{
  it("keeps a legacy profile's bundle beside its state and puts new ones in the family cache",()=>{
    const home=tmp(), slug="a123456789abcdef", name="Zeros Local test abcdef";
    expect(localInstanceBundlePaths({slug,name,home,layout:"legacy"}).bundlePath)
      .toBe(path.join(home,".zeros-local","instances",slug,"bundle",`${name}.app`));
    expect(localInstanceBundlePaths({slug,name,home}).bundlePath)
      .toBe(path.join(home,"Library","Caches","com.zeros.local","bundles",slug,`${name}.app`));
    expect(localInstanceBundlePaths({slug:"alpha",name:NAME,home}).versionMarker)
      .toBe(path.join(home,"Library","Caches","com.zeros.local","bundles","alpha",`${NAME}.app.version`));
  });
  it.each([false,true])("creates a protected Local bundle and cleans the old cache best-effort (failure=%s)",(failure)=>{
    const home=tmp();
    const name="Zeros Local test abcdef";
    const slug="a123456789abcdef";
    const expected=path.join(home,"Library","Caches","com.zeros.local","bundles",slug,`${name}.app`);
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
  it.each([[false,true],[true,false]])("declares the Dev callback scheme only for hosted electron:alpha (callbackScheme=%s → local=%s)",(callbackScheme,local)=>{
    const patched:Array<{local:boolean;bundleId:string}>=[];
    const source=fs.readFileSync("scripts/dev-electron-bundle.cjs","utf8");
    const context={
      module:{exports:{} as {prepareLocalInstanceBundle:(identity:object)=>unknown}},process:{platform:"darwin"},path,
      localInstanceBundlePaths:(identity:{slug:string;name:string})=>localInstanceBundlePaths({...identity,home:"/h"}),
      fs:{...fs,readFileSync:()=>"",existsSync:()=>true,rmSync:()=>{},mkdirSync:()=>{},writeFileSync:()=>{}},
      findBaseElectronApp:()=>"/base/Electron.app",readElectronVersion:()=>"",
      cloneBundleHardlink:()=>{},readPlistValue:()=>"Electron",patchExecutable:()=>{},
      patchPlist:(_file:string,identity:{local:boolean;bundleId:string})=>{patched.push(identity);},patchIcon:()=>{},
      refreshLaunchServices:(dir:string)=>{registered.push(dir);},
    };
    const registered:string[]=[];
    vm.runInNewContext(source.slice(source.indexOf("function prepareLocalInstanceBundle("))+"\nmodule.exports={prepareLocalInstanceBundle};",context);
    context.module.exports.prepareLocalInstanceBundle({slug:"alpha",name:NAME,callbackScheme});
    expect(patched).toEqual([expect.objectContaining({local,bundleId:BUNDLE_ID})]);
    expect(registered).toHaveLength(callbackScheme ? 1 : 0);
  });
});

const tmpdirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-bundle-"));
  tmpdirs.push(dir);
  return dir;
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
        bundleId: BUNDLE_ID,
      };

      expect(patchPlist(clone, identity)).toBe(true);

      const patched = fs.readFileSync(clone, "utf8");
      expect(patched).toMatch(
        /<key>NSAppleEventsUsageDescription<\/key>\s*<string>[^<]*Zeros[^<]*<\/string>/,
      );
      expect(patched).not.toContain("Old description");
      // macOS cannot register the running electron:alpha bundle for OAuth
      // returns without this declaration; it otherwise opens an older checkout.
      expect(patched).toMatch(
        /<key>CFBundleURLTypes<\/key>\s*<array>\s*<dict>\s*<key>CFBundleURLName<\/key>\s*<string>Zeros Dev<\/string>\s*<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>zeros-dev<\/string>\s*<\/array>\s*<\/dict>\s*<\/array>/,
      );
      expect(
        patched.match(/<key>NSAppleEventsUsageDescription<\/key>/g),
      ).toHaveLength(1);
      // Cloned bundles share inodes with Electron; permission metadata must
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
    const identity = { name: NAME, exec: NAME, bundleId: BUNDLE_ID };
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
    const identity = { name: NAME, exec: NAME, bundleId: BUNDLE_ID };
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
