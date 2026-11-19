import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertDevelopmentAdmission, assertDevelopmentOverrideIsolated } from "../storage-identity";

const roots: string[] = [];
function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-identity-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Review A finding 5 / B6: account-free Local and hosted development must never
// resolve to the same profile, and an override must never be a real one.
describe("development identity authority", () => {
  it("admits account-free Local only on a checkout id, and hosted development never on one", () => {
    const checkout = "0123456789abcdef";
    expect(() => assertDevelopmentAdmission({ localDevelopment: true, instance: checkout })).not.toThrow();
    for (const instance of ["alpha", "default", "design-owner-1", "feature"])
      expect(() => assertDevelopmentAdmission({ localDevelopment: true, instance }), instance).toThrow(/Zeros Local/);
    for (const instance of ["alpha", "default", "design-owner-1", "design-qual-0011aabb"])
      expect(() => assertDevelopmentAdmission({ localDevelopment: false, instance }), instance).not.toThrow();
    expect(() => assertDevelopmentAdmission({ localDevelopment: false, instance: checkout })).toThrow(/checkout/);
    expect(() => assertDevelopmentAdmission({ localDevelopment: false, instance: null })).not.toThrow();
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
      expect(() => assertDevelopmentOverrideIsolated(override, { profileRoots, appData }), override).toThrow(/ZEROS_DATA_DIR/);
    const fixture = path.join(scratch(), "fixture");
    expect(() => assertDevelopmentOverrideIsolated(fixture, { profileRoots, appData })).not.toThrow();
    expect(() => assertDevelopmentOverrideIsolated(path.join(appData, "unrelated-app"), { profileRoots, appData })).not.toThrow();
    expect(() => assertDevelopmentOverrideIsolated(undefined, { profileRoots, appData })).not.toThrow();
  });
});
