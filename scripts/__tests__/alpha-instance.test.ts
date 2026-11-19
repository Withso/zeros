import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { alphaLockPath, prepareAlphaLaunch } from "../alpha-instance.mjs";

const roots: string[] = [];
function directory() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-alpha-")));
  roots.push(root);
  return root;
}
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
// A real process whose command line names a launcher, as the lock classifier reads it.
function launcher(marker: string) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", marker], { stdio: "ignore" });
  children.push(child);
  return child.pid as number;
}

describe("pnpm electron:alpha", () => {
  it("keeps main's hosted identity: the primary profile, or an explicit instance", () => {
    const home = "/Users/dev";
    expect(alphaLockPath({ home, instance: undefined })).toBe("/Users/dev/.zeros-dev/electron-alpha.lock");
    expect(alphaLockPath({ home, instance: " Design-Owner_1 " })).toBe("/Users/dev/.zeros-dev/electron-alpha-design-owner_1.lock");
    const source = fs.readFileSync("scripts/dev-environment/launcher.mjs", "utf8");
    const branch = source.slice(source.indexOf('if (action === "alpha")'));
    expect(branch).not.toMatch(/ZEROS_INSTANCE|alphaInstanceEnvironment/);
    const instance = fs.readFileSync("scripts/dev-instance.mjs", "utf8");
    expect(instance).toContain('return { slug: "", human: "" }; // every checkout → the primary identity');
  });

  it("refuses a second launch of the same profile from another checkout, before any build", () => {
    const home = directory(), first = directory(), second = directory();
    const release = prepareAlphaLaunch({ home, root: first, instance: undefined });
    try {
      expect(() => prepareAlphaLaunch({ home, root: second, instance: undefined })).toThrow(/already running for this Zeros Dev profile/);
      prepareAlphaLaunch({ home, root: second, instance: "other" })();
    } finally {
      release();
    }
    expect(fs.existsSync(alphaLockPath({ home, instance: undefined }))).toBe(false);
    prepareAlphaLaunch({ home, root: second, instance: undefined })();
  });

  it("excludes Local from the same checkout in both directions, before either rebuilds", async () => {
    const home = directory(), root = directory();
    fs.mkdirSync(path.join(root, ".context", "zeros-local"), { recursive: true });
    fs.writeFileSync(path.join(root, ".context/zeros-local/launcher.lock"), JSON.stringify({ pid: launcher("scripts/electron-local.mjs"), token: "local" }));
    expect(() => prepareAlphaLaunch({ home, root, instance: undefined })).toThrow(/already running from this checkout/);
    fs.rmSync(path.join(root, ".context/zeros-local/launcher.lock"));
    const release = prepareAlphaLaunch({ home, root, instance: undefined });
    try {
      const { runLocalDevelopment } = await import("../electron-local.mjs");
      let built = false;
      await expect(runLocalDevelopment({ root, home: directory(), platform: "darwin", environment: {}, listProcesses: () => "",
        run: async () => { built = true; return { code: 0 }; } })).rejects.toThrow(/already running/);
      expect(built).toBe(false);
    } finally {
      release();
    }
  });

  it("recovers a profile lock whose launcher is gone, without asking anyone to delete it", () => {
    const home = directory(), root = directory();
    const lock = alphaLockPath({ home, instance: undefined });
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 99, token: "dead" }));
    prepareAlphaLaunch({ home, root, instance: undefined })();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("checks for a running launcher before refreshing public auth", () => {
    const source = fs.readFileSync("scripts/dev-environment/launcher.mjs", "utf8");
    const branch = source.slice(source.indexOf('if (action === "alpha")'));
    expect(branch.indexOf("prepareAlphaLaunch(")).toBeGreaterThan(-1);
    expect(branch.indexOf("prepareAlphaLaunch(")).toBeLessThan(branch.indexOf("ensureDevAuthEnvironment("));
  });
});
