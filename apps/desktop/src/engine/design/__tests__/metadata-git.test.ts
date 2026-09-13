import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../git/git-exec";
import { commitDesignMetadata, readDesignDirectoryRegistry } from "../metadata";
import {
  designRegistryAtGitRef,
  scopeDesignRegistryCommit,
  stageDesignRegistry,
  designMetadataIndexPaths,
} from "../metadata-git";
import {
  discoverDesignDirectories,
  resolveDesignDirectoryForEnter,
} from "../directory";
import { initializeDesignDocument } from "../document";
import { opSettingsWrite } from "../../settings/ops";
import { useLegacyDesignStorage } from "./storage-fixtures";

describe("Design manifest Git ownership", () => {
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
  const stage = async (directory: string) => {
    await runGit(root, [
      "add",
      "-A",
      "-f",
      "--",
      directory,
      ...(await designMetadataIndexPaths(root, directory)),
    ]);
    await stageDesignRegistry(root, directory);
  };
  const unstage = async (directory: string) => {
    await runGit(root, [
      "reset",
      "-q",
      "HEAD",
      "--",
      directory,
      ...(await designMetadataIndexPaths(root, directory, true)),
    ]);
    await stageDesignRegistry(root, directory, true);
  };

  it("stages and unstages one folder while preserving another folder's staging", async () => {
    await stage("A");
    expect(
      Object.values((await designRegistryAtGitRef(root, ":"))!.directories),
    ).toEqual([{ path: "A" }]);
    await stage("B");
    await unstage("A");
    expect(
      Object.values((await designRegistryAtGitRef(root, ":"))!.directories),
    ).toEqual([{ path: "B" }]);
    expect(
      Object.values(readDesignDirectoryRegistry(root)!.directories),
    ).toEqual([{ path: "A" }, { path: "B" }]);
  });

  it.each([
    ".zeros/design-dir.toml",
    ".zeros/design/design-dir.toml",
    ".zeros/design/design.toml",
  ])(
    "migrates %s without committing another folder's migration and restores legacy paths on unstage",
    async (legacyFile) => {
      const original = readDesignDirectoryRegistry(root)!;
      useLegacyDesignStorage(root, "A", legacyFile);
      useLegacyDesignStorage(root, "B", legacyFile);
      await writeFile(path.join(root, legacyFile), stringify(original));
      await runGit(root, ["add", "-f", "A", "B", ".zeros"]);
      await runGit(root, ["commit", "-m", "old registry"]);
      commitDesignMetadata(root, "A", '{"version":3,"frames":{"a.html":{}}}');
      await stage("A");
      expect(await designRegistryAtGitRef(root, ":")).toEqual(original);
      const stagedRegistry = (await runGit(root, ["show", `:${legacyFile}`]))
        .stdout;
      expect(stagedRegistry).toContain('path = "B"');
      expect(stagedRegistry).not.toContain('path = "A"');
      expect(
        (await runGit(root, ["ls-files", "--", "B/design.toml"])).stdout,
      ).toBe("");
      await unstage("A");
      expect(
        (await runGit(root, ["diff", "--cached", "--name-only"])).stdout,
      ).toBe("");
      expect(await discoverDesignDirectories(root)).toEqual(["A", "B"]);
      await stage("A");
      await stage("B");
      // Projection of the shared legacy deletion must also stay scoped in a
      // temporary commit index, even if both folders were explicitly staged.
      const env = { GIT_INDEX_FILE: path.join(root, "private-index") };
      const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
      const tree = (await runGit(root, ["write-tree"])).stdout.trim();
      await runGit(root, ["read-tree", tree], { env });
      await scopeDesignRegistryCommit(root, "A", head, env);
      expect(
        (await runGit(root, ["show", `:${legacyFile}`], { env })).stdout,
      ).toContain('path = "B"');
      expect((await runGit(root, ["ls-files", "--", legacyFile])).stdout).toBe(
        "",
      );
    },
  );

  it("recognizes a legacy rename after git mv and before legacy index cleanup", async () => {
    const original = readDesignDirectoryRegistry(root)!;
    const id = Object.entries(original.directories).find(
      ([, value]) => value.path === "A",
    )![0];
    useLegacyDesignStorage(root, "A", ".zeros/design-dir.toml");
    await runGit(root, ["add", "-f", "A", ".zeros"]);
    await runGit(root, ["commit", "-m", "old registry"]);
    commitDesignMetadata(root, "A", '{"version":3,"frames":{}}');
    await runGit(root, ["add", "A"]);
    await runGit(root, ["mv", "A", "Moved"]);
    expect(
      (await designRegistryAtGitRef(root, ":"))?.directories[id].path,
    ).toBe("Moved");
    expect(await discoverDesignDirectories(root)).toEqual(["A", "B", "Moved"]);
  });

  it("identifies only valid Zeros manifests at exact Git snapshots", async () => {
    await writeFile(path.join(root, "B/design.toml"), 'name = "unrelated"\n');
    await runGit(root, ["add", "A", "B"]);
    await runGit(root, ["commit", "-m", "design and ordinary TOML"]);
    expect(
      Object.values((await designRegistryAtGitRef(root, "HEAD"))!.directories),
    ).toEqual([{ path: "A" }]);
    await writeFile(
      path.join(root, "A/design.toml"),
      (await readFile(path.join(root, "A/design.toml"), "utf8")).replace(
        "version = 1",
        "version = 9",
      ),
    );
    expect(
      Object.values((await designRegistryAtGitRef(root, "HEAD"))!.directories),
    ).toEqual([{ path: "A" }]);
    await runGit(root, ["add", "A/design.toml"]);
    await expect(designRegistryAtGitRef(root, ":")).rejects.toThrow();
  });

  it("migrates an older branch using the inherited legacy ID", async () => {
    await rm(path.join(root, "A/design.toml"));
    await rm(path.join(root, "B"), { recursive: true });
    await writeFile(
      path.join(root, "A/.zeros-canvas.json"),
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
