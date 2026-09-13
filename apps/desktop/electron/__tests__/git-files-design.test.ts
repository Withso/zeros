import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { gitListFiles } from "../ipc/commands/git";
import { commitDesignMetadata } from "../../src/engine/design/metadata";
import { runGit } from "../../src/engine/git/git-exec";

it("native Files listing includes validated, untracked Design roots only when requested", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-native-design-files-"));
  const previous = process.env.ZEROS_DATA_DIR;
  process.env.ZEROS_DATA_DIR = path.join(root, "private");
  try {
    await runGit(root, ["init", "-b", "main"]);
    mkdirSync(path.join(root, "Brand"));
    writeFileSync(path.join(root, "Brand/home.html"), "<h1>Design</h1>");
    commitDesignMetadata(root, "Brand", '{"version":3,"frames":{}}');
    mkdirSync(path.join(root, "Other"));
    writeFileSync(path.join(root, "Other/design.toml"), 'name = "unrelated"\n');
    const result = await gitListFiles(
      { cwd: root, includeDesignDirectories: true },
      {} as never,
    );
    expect(result).toMatchObject({
      files: expect.arrayContaining(["Brand/design.toml", "Other/design.toml"]),
      designDirectories: ["Brand"],
    });
    const ordinary = await gitListFiles({ cwd: root }, {} as never);
    expect(ordinary).not.toHaveProperty("designDirectories");
    expect((await runGit(root, ["ls-files"])).stdout).toBe("");
  } finally {
    if (previous === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
