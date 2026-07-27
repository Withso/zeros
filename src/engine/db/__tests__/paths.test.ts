import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { repoKey, engineRuntimeDir, worktreeSeedPath, worktreeSeedsRoot } from "../paths";

// Guards the ".zeros retirement" contract: the engine's runtime files
// (engine.json / busy) resolve to the app-data dir keyed per repo, NEVER into
// the served repo's working tree.
describe("engine runtime paths", () => {
  const prev = process.env.ZEROS_DATA_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = prev;
  });

  it("repoKey is deterministic and formatted <basename>-<12 hex>", () => {
    const root = "/tmp/does-not-exist/my-repo";
    expect(repoKey(root)).toBe(repoKey(root));
    expect(repoKey(root)).toMatch(/^my-repo-[0-9a-f]{12}$/);
  });

  it("repoKey differs for different roots", () => {
    expect(repoKey("/tmp/a/repo-one")).not.toBe(repoKey("/tmp/b/repo-two"));
  });

  it("repoKey dedupes symlinked roots via realpath", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-rk-"));
    try {
      const real = path.join(dir, "real");
      const link = path.join(dir, "link");
      fs.mkdirSync(real);
      fs.symlinkSync(real, link);
      expect(repoKey(link)).toBe(repoKey(real));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("engineRuntimeDir lives under <dataDir>/engines/<repoKey>, never inside the repo", () => {
    process.env.ZEROS_DATA_DIR = "/tmp/zeros-data";
    const root = "/tmp/does-not-exist/proj";
    const dir = engineRuntimeDir(root);
    expect(dir).toBe(path.join("/tmp/zeros-data", "engines", repoKey(root)));
    expect(dir.startsWith(root)).toBe(false);
  });

  it("worktreeSeedPath lives under <dataDir>/worktrees/<repoKey>, never inside the worktree", () => {
    process.env.ZEROS_DATA_DIR = "/tmp/zeros-data";
    const wt = "/tmp/does-not-exist/zeros/workspaces/repo/ws_1";
    const seed = worktreeSeedPath(wt);
    expect(worktreeSeedsRoot()).toBe(path.join("/tmp/zeros-data", "worktrees"));
    expect(seed).toBe(path.join("/tmp/zeros-data", "worktrees", repoKey(wt), "workspace.json"));
    expect(seed.startsWith(wt)).toBe(false); // never inside the served worktree
  });
});
