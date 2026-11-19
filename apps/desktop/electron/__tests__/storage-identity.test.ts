import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLocalAdmission, assertLocalOverrideIsolated } from "../storage-identity";

const roots: string[] = [];
function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-identity-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Review A finding 5 / B6: account-free Local keeps its own namespace, and its
// override must never be a real profile.
describe("Local identity authority", () => {
  it("admits account-free Local only on a checkout id", () => {
    expect(() => assertLocalAdmission("0123456789abcdef")).not.toThrow();
    for (const instance of ["alpha", "default", "design-owner-1", "feature", ""])
      expect(() => assertLocalAdmission(instance), instance).toThrow(/Zeros Local/);
  });

  function profiles() {
    const home = scratch();
    const appData = path.join(home, "Library", "Application Support");
    const stable = path.join(appData, "com.zeros"), alpha = path.join(appData, "com.zeros.alpha");
    const family = path.join(appData, "com.zeros.local");
    for (const dir of [stable, alpha, path.join(family, "instances", "alpha"), path.join(appData, "com.zeros.local.0123456789abcdef"),
      path.join(appData, "com.zeros.dev.coral")])
      fs.mkdirSync(dir, { recursive: true });
    return { home, appData, profileRoots: [stable, alpha, family] };
  }

  it("refuses an override that physically is, contains or sits inside a real profile, legacy siblings included", () => {
    const { home, appData, profileRoots } = profiles();
    const alias = path.join(home, "alias-to-alpha");
    fs.symlinkSync(path.join(appData, "com.zeros.local", "instances", "alpha"), alias);
    const linkedSupport = path.join(home, "linked-support");
    fs.symlinkSync(appData, linkedSupport);
    for (const override of [
      alias,
      path.join(alias, "fixture"),
      path.join(appData, "com.zeros.local.0123456789abcdef"),
      path.join(linkedSupport, "com.zeros.local.0123456789abcdef", "nested"),
      path.join(appData, "com.zeros.dev.coral"),
      path.join(appData, "com.zeros"),
      appData,
      `${appData}/com.zeros.alpha/../com.zeros`,
    ])
      expect(() => assertLocalOverrideIsolated(override, { profileRoots, appData }), override).toThrow(/ZEROS_DATA_DIR/);
    const fixture = path.join(scratch(), "fixture");
    expect(() => assertLocalOverrideIsolated(fixture, { profileRoots, appData })).not.toThrow();
    expect(() => assertLocalOverrideIsolated(path.join(appData, "unrelated-app"), { profileRoots, appData })).not.toThrow();
    expect(() => assertLocalOverrideIsolated(undefined, { profileRoots, appData })).not.toThrow();
  });
});
