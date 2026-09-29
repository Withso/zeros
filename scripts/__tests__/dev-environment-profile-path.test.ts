import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfile } from "../dev-environment/profile.mjs";
import { loadHostedProfile } from "../dev-environment/hosted-profile.mjs";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dev-profile-path-")); homes.push(home);
  const directory = path.join(home, ".zeros-dev"), root = path.join(home, "checkout");
  fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(root);
  const write = (file: string, profile: unknown) => fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
  return { home, directory, root, write };
}

describe("portable Dev profile compatibility", () => {
  it("reads the renamed home profile without changing its schema or contents", () => {
    const f = fixture(), p = { version: 1, sentinel: "preserved" };
    f.write(path.join(f.directory, "zeros-dev-env.json"), p);
    expect(loadProfile(f.home, { env: {} })).toEqual(p);
  });

  it("keeps the legacy name readable for recovery", () => {
    const f = fixture(), p = { version: 1, sentinel: "legacy" };
    f.write(path.join(f.directory, "development.json"), p);
    expect(loadProfile(f.home, { env: {} })).toEqual(p);
  });

  it("does not fall back to stale credentials when the renamed file is invalid", () => {
    const f = fixture();
    f.write(path.join(f.directory, "development.json"), { version: 1 });
    f.write(path.join(f.directory, "zeros-dev-env.json"), { version: 99 });
    expect(() => loadProfile(f.home, { env: {} })).toThrow(/version/);
  });

  it("uses the checkout profile before legacy checkout and home profiles", () => {
    const f = fixture();
    f.write(path.join(f.root, "zeros-dev-env.json"), { version: 1 });
    fs.writeFileSync(path.join(f.root, ".env.zeros-dev.json"), "not-json", { mode: 0o600 });
    expect(() => loadHostedProfile(f.root, { homeDir: f.home, env: {} })).toThrow(/version 2/);
  });

  it("honors an explicit legacy profile path for cleanup", () => {
    const f = fixture(), file = path.join(f.home, "recovery.json"), p = { version: 1 };
    f.write(path.join(f.directory, "zeros-dev-env.json"), { version: 2 }); f.write(file, p);
    expect(loadProfile(f.home, { env: { ZEROS_DEV_PROFILE_PATH: file } })).toEqual(p);
  });

  it("refuses a linked canonical file even when legacy credentials exist", () => {
    const f = fixture(); f.write(path.join(f.directory, "development.json"), { version: 1 });
    fs.symlinkSync("missing.json", path.join(f.directory, "zeros-dev-env.json"));
    expect(() => loadProfile(f.home, { env: {} })).toThrow(/private/);
  });

  it("retains the private home directory boundary after the rename", () => {
    const f = fixture(), elsewhere = path.join(f.home, "elsewhere");
    f.write(path.join(f.directory, "zeros-dev-env.json"), { version: 1 });
    fs.renameSync(f.directory, elsewhere); fs.symlinkSync(elsewhere, f.directory);
    expect(() => loadProfile(f.home, { env: {} })).toThrow(/private/);
  });
});
