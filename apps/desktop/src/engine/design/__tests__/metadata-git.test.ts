import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../git/git-exec";
import {
  commitDesignMetadata,
  designMetadataGitPaths,
  readDesignDirectoryRegistry,
} from "../metadata";
import {
  designRegistryAtGitRef,
  scopeDesignRegistryCommit,
  stageDesignRegistry,
} from "../metadata-git";
import {
  discoverDesignDirectories,
  resolveDesignDirectoryForEnter,
} from "../directory";
import { initializeDesignDocument } from "../document";
import { opSettingsWrite } from "../../settings/ops";

describe("Design registry Git ownership", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-git-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.name", "Test"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(root, "README.md"), "test");
    await runGit(root, ["add", "README.md"]);
    await runGit(root, ["commit", "-m", "seed"]);
    for (const directory of ["A", "B"]) {
      await mkdir(path.join(root, directory));
      commitDesignMetadata(root, directory, '{"version":3,"frames":{}}');
    }
  });
  afterEach(async () => {
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });
  it("stages and unstages one mapping while preserving another directory's staging", async () => {
    await stageDesignRegistry(root, "A");
    expect(
      Object.values((await designRegistryAtGitRef(root, ":"))!.directories).map(
        (entry) => entry.path,
      ),
    ).toEqual(["A"]);
    await stageDesignRegistry(root, "B");
    await stageDesignRegistry(root, "A", true);
    expect(
      Object.values((await designRegistryAtGitRef(root, ":"))!.directories).map(
        (entry) => entry.path,
      ),
    ).toEqual(["B"]);
    expect(
      Object.values(readDesignDirectoryRegistry(root)!.directories).map(
        (entry) => entry.path,
      ),
    ).toEqual(["A", "B"]);
    expect(designMetadataGitPaths(root, "A")).toHaveLength(2);
  });
  it("selects only the active mapping in a commit index and recognizes branch-local registry content", async () => {
    await stageDesignRegistry(root, "A");
    await stageDesignRegistry(root, "B");
    const env = { GIT_INDEX_FILE: path.join(root, "private-index") };
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    const tree = (await runGit(root, ["write-tree"])).stdout.trim();
    await runGit(root, ["read-tree", tree], { env });
    await scopeDesignRegistryCommit(root, "A", head, env);
    expect(
      Object.values(
        (await designRegistryAtGitRef(root, ":", env))!.directories,
      ).map((entry) => entry.path),
    ).toEqual(["A"]);
    expect(
      Object.keys((await designRegistryAtGitRef(root, ":"))!.directories),
    ).toHaveLength(2);
    expect(await discoverDesignDirectories(root)).toEqual(["A", "B"]);
  });
  it("migrates an older branch using the inherited ID without borrowing the main registry", async () => {
    // Main and the old branch contain the same pre-registry document.
    await rm(path.join(root, ".zeros"), { recursive: true });
    await writeFile(
      path.join(root, "A", ".zeros-canvas.json"),
      '{"version":2,"frames":{}}',
    );
    await runGit(root, ["add", "A"]);
    await runGit(root, ["commit", "-m", "legacy design"]);
    const checkout = path.join(root, "old-branch");
    await runGit(root, ["worktree", "add", "-b", "old", checkout, "HEAD"]);
    commitDesignMetadata(
      root,
      "A",
      '{"version":3,"frames":{},"frame_info":{},"foundation":{"schemaVersion":1,"parameters":[],"variants":[],"components":[]}}',
    );
    const [id] = Object.keys(readDesignDirectoryRegistry(root)!.directories);
    opSettingsWrite("repo-local", { design: { directory_id: id } }, root);
    expect(
      await resolveDesignDirectoryForEnter({ repoRoot: root, path: checkout }),
    ).toBe("A");
    await initializeDesignDocument(checkout);
    expect(
      Object.keys(readDesignDirectoryRegistry(checkout)!.directories),
    ).toEqual([id]);
  });
});
