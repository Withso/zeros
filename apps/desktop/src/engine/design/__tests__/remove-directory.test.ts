import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../../git/git-exec";
import { commitDesignMetadata, readDesignDirectoryRegistry } from "../metadata";
import { discoverDesignDirectories } from "../directory";
import {
  rememberRecognizedDesignDirectories,
  stickyRecognizedDesignDirectories,
} from "../recognition-store";
import { removeDesignDirectory } from "../remove-directory";
import { renameDesignDirectory } from "../../git/design-mode";
import { opSettingsWrite, opSettingsResolve } from "../../settings/ops";
import {
  forgetDesignDirectoryName,
  primeDesignDirectoryName,
} from "../directory-registry";
import {
  LOCAL_MAIN_WORKSPACE_ID,
  WorkspaceService,
} from "../../workspace/service";
import { semanticDesignDirectories } from "../../git/design-draft-guard";

const live = vi.hoisted(() => ({
  workspaces: [] as Array<{ kind: string; repoRoot: string }>,
}));
vi.mock("../../git/state", async (original) => ({
  ...(await original<object>()),
  listWorkspaces: () => live.workspaces,
}));

describe("remove Design registration", () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-remove-design-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    live.workspaces = [];
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.name", "Test"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
    for (const folder of ["Brand", "Other"]) {
      mkdirSync(path.join(root, folder));
      writeFileSync(path.join(root, folder, "home.html"), "<h1>Keep me</h1>");
      commitDesignMetadata(root, folder, '{"version":3,"frames":{}}');
    }
    await runGit(root, ["add", "Brand", "Other", ".gitignore"]);
    await runGit(root, ["commit", "-m", "Design folders"]);
  });
  afterEach(() => {
    forgetDesignDirectoryName(root);
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers main-checkout manifests with no worktrees", async () => {
    expect(await discoverDesignDirectories(root)).toEqual(["Brand", "Other"]);
  });

  it.each([false, true])(
    "returns the default folder to Code, including after restart (selected: %s)",
    async (selected) => {
      await removeDesignDirectory({ repoRoot: root, directory: "Brand" });
      await removeDesignDirectory({ repoRoot: root, directory: "Other" });
      const directory = "Zeros Design";
      const file = `${directory}/source.txt`;
      mkdirSync(path.join(root, directory));
      writeFileSync(path.join(root, file), "Preserved source");
      commitDesignMetadata(root, directory, '{"version":3,"frames":{}}');
      await rememberRecognizedDesignDirectories(root, [directory]);
      if (selected) {
        const id = Object.keys(
          readDesignDirectoryRegistry(root)!.directories,
        )[0]!;
        opSettingsWrite("repo-local", { design: { directory_id: id } }, root);
        primeDesignDirectoryName(root, directory);
      }
      await removeDesignDirectory({ repoRoot: root, directory });
      expect(await discoverDesignDirectories(root)).toEqual([]);
      expect(await stickyRecognizedDesignDirectories(root)).toEqual([]);

      for (const restarted of [false, true]) {
        if (restarted) forgetDesignDirectoryName(root);
        const service = new WorkspaceService(root);
        const read = (await service.handle("file.read", {
          workspaceId: LOCAL_MAIN_WORKSPACE_ID,
          path: file,
        })) as { designPath?: boolean };
        expect(read.designPath).toBeUndefined();
        await expect(
          service.handle("file.write", {
            workspaceId: LOCAL_MAIN_WORKSPACE_ID,
            path: file,
            content: `Code edit after restart: ${restarted}`,
          }),
        ).resolves.toBeTruthy();
        expect(
          await semanticDesignDirectories({
            workspaceId: LOCAL_MAIN_WORKSPACE_ID,
            repoRoot: root,
            path: root,
          }),
        ).not.toContain(directory);
        await expect(
          service.handle("git.stage", {
            workspaceId: LOCAL_MAIN_WORKSPACE_ID,
            paths: [file],
          }),
        ).resolves.toEqual({ ok: true });
        await service.handle("git.commit", {
          workspaceId: LOCAL_MAIN_WORKSPACE_ID,
          message: "Edit ordinary source",
        });
        expect((await runGit(root, ["show", `HEAD:${file}`])).stdout).toBe(
          `Code edit after restart: ${restarted}`,
        );
      }

      // The same folder can be registered again; removal must not exempt it
      // from future Design ownership.
      commitDesignMetadata(root, directory, '{"version":3,"frames":{}}');
      await expect(
        new WorkspaceService(root).handle("file.write", {
          workspaceId: LOCAL_MAIN_WORKSPACE_ID,
          path: file,
          content: "Refuse this Code edit",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    },
  );

  it("renames an inactive row without selecting it", async () => {
    const registry = readDesignDirectoryRegistry(root)!;
    const id = Object.entries(registry.directories).find(
      ([, entry]) => entry.path === "Other",
    )![0];
    opSettingsWrite("repo-local", { design: { directory_id: id } }, root);
    await renameDesignDirectory({
      repoRoot: root,
      from: "Brand",
      to: "Studio",
    });
    expect(
      (
        opSettingsResolve(root).effective.design as
          | { directory_id?: string }
          | undefined
      )?.directory_id,
    ).toBe(id);
    expect(await discoverDesignDirectories(root)).toEqual(["Other", "Studio"]);
  });

  it("clears a removed selection and supports untracked registration", async () => {
    const id = Object.entries(
      readDesignDirectoryRegistry(root)!.directories,
    ).find(([, entry]) => entry.path === "Brand")![0];
    opSettingsWrite("repo-local", { design: { directory_id: id } }, root);
    await removeDesignDirectory({ repoRoot: root, directory: "Brand" });
    expect(
      (
        opSettingsResolve(root).effective.design as
          | { directory_id?: string }
          | undefined
      )?.directory_id,
    ).toBeUndefined();
    mkdirSync(path.join(root, "New"));
    writeFileSync(path.join(root, "New/home.html"), "Untracked page");
    commitDesignMetadata(root, "New", '{"version":3,"frames":{}}');
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout;
    await removeDesignDirectory({ repoRoot: root, directory: "New" });
    expect((await runGit(root, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(readFileSync(path.join(root, "New/home.html"), "utf8")).toBe(
      "Untracked page",
    );
  });

  it("removes only registration, preserving dirty and staged source and other folders", async () => {
    await rememberRecognizedDesignDirectories(root, ["Brand", "Other"]);
    const other = readFileSync(path.join(root, "Other/design.toml"), "utf8");
    writeFileSync(path.join(root, "Brand/home.html"), "staged source");
    await runGit(root, ["add", "Brand/home.html"]);
    writeFileSync(path.join(root, "Brand/home.html"), "unstaged source");
    writeFileSync(path.join(root, "Brand/style.css"), "body {}");
    await removeDesignDirectory({ repoRoot: root, directory: "Brand" });
    expect(existsSync(path.join(root, "Brand/design.toml"))).toBe(false);
    expect(existsSync(path.join(root, "Brand/rules.md"))).toBe(false);
    expect(readFileSync(path.join(root, "Brand/home.html"), "utf8")).toBe(
      "unstaged source",
    );
    expect(readFileSync(path.join(root, "Brand/style.css"), "utf8")).toBe(
      "body {}",
    );
    expect((await runGit(root, ["show", ":Brand/home.html"])).stdout).toBe(
      "staged source",
    );
    expect((await runGit(root, ["show", "HEAD:Brand/home.html"])).stdout).toBe(
      "<h1>Keep me</h1>",
    );
    expect(readFileSync(path.join(root, "Other/design.toml"), "utf8")).toBe(
      other,
    );
    expect(await discoverDesignDirectories(root)).toEqual(["Other"]);
    expect(await stickyRecognizedDesignDirectories(root)).toEqual(["Other"]);
    expect(
      Object.values(readDesignDirectoryRegistry(root)!.directories).map(
        (e) => e.path,
      ),
    ).toEqual(["Other"]);
  });

  it("removes committed recognition even when the marker was already removed from the index", async () => {
    execFileSync("git", ["rm", "--cached", "Brand/design.toml"], { cwd: root });
    await removeDesignDirectory({ repoRoot: root, directory: "Brand" });
    expect(await discoverDesignDirectories(root)).toEqual(["Other"]);
  });

  it("restores working metadata and preserves the index when committing fails", async () => {
    const before = readFileSync(path.join(root, "Brand/design.toml"), "utf8");
    writeFileSync(path.join(root, ".git/refs/heads/main.lock"), "locked");
    await expect(
      removeDesignDirectory({ repoRoot: root, directory: "Brand" }),
    ).rejects.toThrow();
    expect(readFileSync(path.join(root, "Brand/design.toml"), "utf8")).toBe(
      before,
    );
    expect(
      (await runGit(root, ["diff", "--cached", "--name-only"])).stdout,
    ).toBe("");
    rmSync(path.join(root, ".git/refs/heads/main.lock"));
    await removeDesignDirectory({ repoRoot: root, directory: "Brand" });
    expect(await discoverDesignDirectories(root)).toEqual(["Other"]);
  });

  it("can unregister staged metadata before the repository's first commit", async () => {
    const unborn = path.join(root, "unborn");
    mkdirSync(path.join(unborn, "Draft"), { recursive: true });
    await runGit(unborn, ["init", "-b", "main"]);
    writeFileSync(path.join(unborn, "Draft/home.html"), "Keep staged source");
    commitDesignMetadata(unborn, "Draft", '{"version":3,"frames":{}}');
    await runGit(unborn, ["add", "Draft"]);
    await removeDesignDirectory({ repoRoot: unborn, directory: "Draft" });
    expect((await runGit(unborn, ["ls-files"])).stdout).toBe(
      "Draft/home.html\n",
    );
    expect(await discoverDesignDirectories(unborn)).toEqual([]);
    expect(readFileSync(path.join(unborn, "Draft/home.html"), "utf8")).toBe(
      "Keep staged source",
    );
  });

  it("removes one legacy central entry while preserving another document", async () => {
    const registry = readDesignDirectoryRegistry(root)!;
    let source = "version = 1\n";
    for (const [id, entry] of Object.entries(registry.directories)) {
      rmSync(path.join(root, entry.path, "design.toml"));
      mkdirSync(path.join(root, ".zeros/design", id), { recursive: true });
      writeFileSync(
        path.join(root, ".zeros/design", id, "document.json"),
        '{"version":3,"frames":{}}',
      );
      source += `[directories.${id}]\npath = "${entry.path}"\n`;
    }
    writeFileSync(path.join(root, ".zeros/design-dir.toml"), source);
    await runGit(root, [
      "add",
      "-A",
      "-f",
      "Brand",
      "Other",
      ".zeros/design",
      ".zeros/design-dir.toml",
    ]);
    await runGit(root, ["commit", "-m", "Legacy fixture"]);
    writeFileSync(
      path.join(root, "Brand/design.toml"),
      'name = "another application"\n',
    );
    await expect(
      removeDesignDirectory({ repoRoot: root, directory: "Brand" }),
    ).rejects.toThrow(/not a Zeros Design manifest/);
    expect(readFileSync(path.join(root, "Brand/design.toml"), "utf8")).toBe(
      'name = "another application"\n',
    );
    rmSync(path.join(root, "Brand/design.toml"));
    await removeDesignDirectory({ repoRoot: root, directory: "Brand" });
    expect(await discoverDesignDirectories(root)).toEqual(["Other"]);
    const remaining = readDesignDirectoryRegistry(root)!;
    expect(Object.values(remaining.directories)).toEqual([{ path: "Other" }]);
    const id = Object.keys(remaining.directories)[0];
    expect(
      readFileSync(
        path.join(root, ".zeros/design", id, "document.json"),
        "utf8",
      ),
    ).toBe('{"version":3,"frames":{}}');
  });

  it("keeps user-authored rules and refuses unsafe or live removals", async () => {
    writeFileSync(path.join(root, "Brand/rules.md"), "My project instructions");
    await expect(
      removeDesignDirectory({ repoRoot: root, directory: "../outside" }),
    ).rejects.toThrow();
    live.workspaces = [{ kind: "design", repoRoot: root }];
    await expect(
      removeDesignDirectory({ repoRoot: root, directory: "Brand" }),
    ).rejects.toThrow(/still open/);
    expect(existsSync(path.join(root, "Brand/design.toml"))).toBe(true);
    live.workspaces = [];
    await removeDesignDirectory({ repoRoot: root, directory: "Brand" });
    expect(readFileSync(path.join(root, "Brand/rules.md"), "utf8")).toBe(
      "My project instructions",
    );
  });
});
