import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertCompiledChannel } from "../electron-builder-run.mjs";

const roots: string[] = [];
function root(baked?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-builder-"));
  roots.push(dir);
  if (baked !== undefined) {
    fs.mkdirSync(path.join(dir, "dist-electron"));
    fs.writeFileSync(path.join(dir, "dist-electron", "build-channel.json"), JSON.stringify({ channel: baked }));
  }
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Review A finding 13: a packaged build takes its channel from its bake only,
// so a main compiled without the Alpha bake would open Stable's profile.
describe("packaging the compiled main", () => {
  it("packages Alpha only from a main baked as alpha", () => {
    expect(() => assertCompiledChannel("alpha", { root: root("alpha") })).not.toThrow();
    for (const baked of ["", "stable", "dev"])
      expect(() => assertCompiledChannel("alpha", { root: root(baked) }), baked).toThrow(/baked/);
  });

  it("packages Stable from a main baked as stable or with no bake", () => {
    for (const baked of ["", "stable"]) expect(() => assertCompiledChannel("stable", { root: root(baked) })).not.toThrow();
    expect(() => assertCompiledChannel("stable", { root: root("alpha") })).toThrow(/baked/);
  });

  it("refuses when the compile left no record of its bake", () => {
    expect(() => assertCompiledChannel("alpha", { root: root() })).toThrow(/electron:compile/);
    const broken = root("alpha");
    fs.writeFileSync(path.join(broken, "dist-electron", "build-channel.json"), "{nope");
    expect(() => assertCompiledChannel("alpha", { root: broken })).toThrow(/electron:compile/);
  });

  it("is written by the electron compile itself", () => {
    const config = fs.readFileSync("apps/desktop/electron/tsup.config.ts", "utf8");
    expect(config).toMatch(/onSuccess[\s\S]*build-channel\.json/);
  });
});
