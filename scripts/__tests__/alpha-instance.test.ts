import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAlphaLaunch } from "../alpha-instance.mjs";

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
  it("keeps main's hosted identity: every checkout opens the primary profile", () => {
    const source = fs.readFileSync("scripts/dev-environment/launcher.mjs", "utf8");
    const branch = source.slice(source.indexOf('if (action === "alpha")'));
    expect(branch).not.toMatch(/ZEROS_INSTANCE|alphaInstanceEnvironment/);
    const instance = fs.readFileSync("scripts/dev-instance.mjs", "utf8");
    expect(instance).toContain('return { slug: "", human: "" }; // every checkout → the primary identity');
  });

  // Master review: the launcher's child environment (systemEnvironment) drops
  // ZEROS_INSTANCE, so the app is always the primary profile whatever the
  // caller's shell says; the lock must be that profile's lock too.
  it("takes the primary profile's lock whatever ZEROS_INSTANCE the caller's shell holds", () => {
    const home = directory(), first = directory(), second = directory();
    const saved = process.env.ZEROS_INSTANCE;
    try {
      process.env.ZEROS_INSTANCE = "one";
      const release = prepareAlphaLaunch({ home, root: first });
      try {
        expect(fs.existsSync(path.join(home, ".zeros-dev", "electron-alpha.lock"))).toBe(true);
        process.env.ZEROS_INSTANCE = "two";
        expect(() => prepareAlphaLaunch({ home, root: second })).toThrow(/already running for this Zeros Dev profile/);
      } finally {
        release();
      }
      expect(fs.readdirSync(path.join(home, ".zeros-dev"))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.ZEROS_INSTANCE;
      else process.env.ZEROS_INSTANCE = saved;
    }
  });

  it("refuses a second launch from another checkout, naming the lock and when removing it is safe", () => {
    const home = directory(), first = directory(), second = directory();
    const lock = path.join(home, ".zeros-dev", "electron-alpha.lock");
    const release = prepareAlphaLaunch({ home, root: first });
    try {
      let message = "";
      try {
        prepareAlphaLaunch({ home, root: second });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("already running for this Zeros Dev profile");
      expect(message).toContain(lock);
      expect(message).toMatch(/safe to remove only when no Zeros Dev app is running/);
    } finally {
      release();
    }
    expect(fs.existsSync(lock)).toBe(false);
    prepareAlphaLaunch({ home, root: second })();
  });

  it("excludes Local from the same checkout in both directions, before either rebuilds", async () => {
    const home = directory(), root = directory();
    fs.mkdirSync(path.join(root, ".context", "zeros-local"), { recursive: true });
    fs.writeFileSync(path.join(root, ".context/zeros-local/launcher.lock"), JSON.stringify({ pid: launcher("scripts/electron-local.mjs"), token: "local" }));
    expect(() => prepareAlphaLaunch({ home, root })).toThrow(/already running from this checkout/);
    fs.rmSync(path.join(root, ".context/zeros-local/launcher.lock"));
    const release = prepareAlphaLaunch({ home, root });
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
    const lock = path.join(home, ".zeros-dev", "electron-alpha.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 99, token: "dead" }));
    prepareAlphaLaunch({ home, root })();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("checks for a running launcher before refreshing public auth", () => {
    const source = fs.readFileSync("scripts/dev-environment/launcher.mjs", "utf8");
    const branch = source.slice(source.indexOf('if (action === "alpha")'));
    expect(branch.indexOf("prepareAlphaLaunch(")).toBeGreaterThan(-1);
    expect(branch.indexOf("prepareAlphaLaunch(")).toBeLessThan(branch.indexOf("ensureDevAuthEnvironment("));
  });
});
