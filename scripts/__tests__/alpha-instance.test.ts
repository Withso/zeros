import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALPHA_INSTANCE, ALPHA_NAME, alphaInstanceEnvironment, prepareAlphaLaunch } from "../alpha-instance.mjs";

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

  it("registers itself, prunes others, and refuses a second concurrent launch before any build", () => {
    const h = home();
    const pruned: unknown[] = [];
    const release = prepareAlphaLaunch({ home: h, platform: "darwin", prune: (options: unknown) => { pruned.push(options); return []; } });
    try {
      const registry = JSON.parse(fs.readFileSync(path.join(h, "Library/Application Support/com.zeros.local/instances.json"), "utf8"));
      expect(registry.instances.alpha).toMatchObject({ kind: "alpha", name: "Zeros Local Alpha", checkout: null, layout: "v2" });
      expect(pruned).toEqual([expect.objectContaining({ currentInstance: "alpha", home: h })]);
      expect(fs.existsSync(path.join(h, ".zeros-local/instances/alpha/launcher.lock"))).toBe(true);
      expect(() => prepareAlphaLaunch({ home: h, platform: "darwin", prune: () => [] })).toThrow(/already running/);
    } finally {
      release();
    }
    expect(fs.existsSync(path.join(h, ".zeros-local/instances/alpha/launcher.lock"))).toBe(false);
    prepareAlphaLaunch({ home: h, platform: "darwin", prune: () => [] })();
  });
});
