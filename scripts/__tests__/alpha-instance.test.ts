import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { ALPHA_INSTANCE, ALPHA_NAME, alphaInstanceEnvironment, importHostedFontCache, prepareAlphaLaunch } from "../alpha-instance.mjs";

const homes: string[] = [];
function home() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-alpha-home-")));
  homes.push(root);
  return root;
}
afterEach(() => {
  for (const root of homes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("pnpm electron:alpha identity", () => {
  it("is the one hosted `alpha` instance: dev channel, never account-free, never legacy", () => {
    expect(ALPHA_INSTANCE).toBe("alpha");
    expect(ALPHA_NAME).toBe("Zeros Local Alpha");
    const env = alphaInstanceEnvironment({
      ZEROS_INSTANCE: "inherited", ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_LOCAL_LAYOUT: "legacy",
      ZEROS_ISOLATE: "1", ZEROS_SHARED_SECRETS_DIR: "/x", ZEROS_DATA_DIR: "/y", PATH: "/bin",
    });
    expect(env).toEqual({ PATH: "/bin", ZEROS_INSTANCE: "alpha", ZEROS_INSTANCE_NAME: "Zeros Local Alpha" });
  });

  const checkout = () => {
    const root = home();
    fs.mkdirSync(path.join(root, ".context", "zeros-local"), { recursive: true });
    return root;
  };
  // A real process whose command line names a launcher, as the lock classifier reads it.
  const launcher = (marker: string) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", marker], { stdio: "ignore" });

  it("registers itself, holds its lock and refuses a second concurrent launch before any build", () => {
    const h = home(), root = checkout();
    const release = prepareAlphaLaunch({ home: h, root, platform: "darwin" });
    try {
      const registry = JSON.parse(fs.readFileSync(path.join(h, "Library/Application Support/com.zeros.local/instances.json"), "utf8"));
      expect(registry.instances.alpha).toMatchObject({ kind: "alpha", name: "Zeros Local Alpha", checkout: null, layout: "v2" });
      expect(JSON.parse(fs.readFileSync(path.join(h, ".zeros-local/instances/alpha/launcher.lock"), "utf8")).pid).toBe(process.pid);
      expect(() => prepareAlphaLaunch({ home: h, root: checkout(), platform: "darwin" })).toThrow(/already running/);
    } finally {
      release();
    }
    expect(fs.existsSync(path.join(h, ".zeros-local/instances/alpha/launcher.lock"))).toBe(false);
    prepareAlphaLaunch({ home: h, root, platform: "darwin" })();
  });

  it("refuses while its app is still running after the launcher died", () => {
    const h = home();
    const dataDir = path.join(h, "Library/Application Support/com.zeros.local/instances/alpha");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dataDir, "SingletonLock"));
    expect(() => prepareAlphaLaunch({ home: h, root: checkout(), platform: "darwin" })).toThrow(/already running/);
    expect(fs.existsSync(path.join(h, ".zeros-local/instances/alpha/launcher.lock"))).toBe(false);
  });

  it("excludes Local from the same checkout, in both directions, before either rebuilds", async () => {
    const h = home(), root = checkout();
    const local = launcher("scripts/electron-local.mjs");
    try {
      fs.writeFileSync(path.join(root, ".context/zeros-local/launcher.lock"), JSON.stringify({ pid: local.pid, token: "local" }));
      expect(() => prepareAlphaLaunch({ home: h, root, platform: "darwin" })).toThrow(/already running from this checkout/);
    } finally {
      local.kill("SIGKILL");
    }
    const release = prepareAlphaLaunch({ home: h, root, platform: "darwin" });
    try {
      const { runLocalDevelopment } = await import("../electron-local.mjs");
      let built = false;
      await expect(runLocalDevelopment({ root, home: home(), platform: "darwin", environment: {}, listProcesses: () => "",
        run: async () => { built = true; return { code: 0 }; } })).rejects.toThrow(/already running/);
      expect(built).toBe(false);
    } finally {
      release();
    }
  });

  it("registers within a short bound when the registry is busy", () => {
    const h = home(), root = checkout();
    const file = path.join(h, "Library/Application Support/com.zeros.local/instances.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    try {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: holder.pid, token: "busy" }));
      const started = Date.now();
      prepareAlphaLaunch({ home: h, root, platform: "darwin", log: () => {} })();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  // Review B finding 7: hosted Dev's Design font cache lived in com.zeros.dev.
  it("carries hosted Dev's cached Design fonts over once, copying only cached stylesheets", () => {
    const h = home();
    const support = path.join(h, "Library/Application Support");
    const old = path.join(support, "com.zeros.dev", "design-fonts");
    fs.mkdirSync(old, { recursive: true });
    const cached = `${"a".repeat(32)}.css`;
    fs.writeFileSync(path.join(old, cached), "@font-face{}");
    fs.writeFileSync(path.join(old, "notes.txt"), "not a font cache file");
    fs.writeFileSync(path.join(support, "com.zeros.dev", "secrets.json"), "{}");
    fs.symlinkSync(path.join(support, "com.zeros.dev", "secrets.json"), path.join(old, `${"b".repeat(32)}.css`));
    expect(importHostedFontCache({ home: h, platform: "darwin" })).toBe("imported");
    const target = path.join(support, "com.zeros.local", "design-fonts");
    expect(fs.readdirSync(target)).toEqual([cached]);
    expect(fs.readFileSync(path.join(target, cached), "utf8")).toBe("@font-face{}");
    expect(fs.readdirSync(old).sort()).toEqual([cached, `${"b".repeat(32)}.css`, "notes.txt"].sort());
    fs.writeFileSync(path.join(target, cached), "newer");
    fs.writeFileSync(path.join(old, `${"c".repeat(32)}.css`), "later");
    expect(importHostedFontCache({ home: h, platform: "darwin" })).toBe("kept");
    expect(fs.readdirSync(target)).toEqual([cached]);
    expect(fs.readFileSync(path.join(target, cached), "utf8")).toBe("newer");
    expect(fs.readdirSync(path.dirname(target)).filter((name) => name.includes("import"))).toEqual([]);
  });

  it("imports nothing when hosted Dev never cached fonts", () => {
    const h = home();
    expect(importHostedFontCache({ home: h, platform: "darwin" })).toBe("none");
    expect(fs.existsSync(path.join(h, "Library/Application Support/com.zeros.local/design-fonts"))).toBe(false);
  });

  it("checks for a running instance before refreshing public auth", () => {
    const source = fs.readFileSync("scripts/dev-environment/launcher.mjs", "utf8");
    const branch = source.slice(source.indexOf('if (action === "alpha")'));
    expect(branch.indexOf("prepareAlphaLaunch(")).toBeGreaterThan(-1);
    expect(branch.indexOf("prepareAlphaLaunch(")).toBeLessThan(branch.indexOf("ensureDevAuthEnvironment("));
    expect(branch).not.toContain("Prune");
  });
});
