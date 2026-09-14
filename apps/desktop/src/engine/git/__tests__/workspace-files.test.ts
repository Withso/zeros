// Default Git-aware file listing and inclusive @-mention searches. The default
// keeps its Git and non-Git compatibility behavior; inclusive mentions search
// actual files/directories, including ignored paths, before capping results.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listWorkspaceFiles } from "../workspace-files";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
}

async function commitAll(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "add", "-A"]);
  await execFileAsync("git", [
    "-C",
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
}

describe("listWorkspaceFiles", () => {
  let workdir = "";

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-wsfiles-"));
  });

  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("returns [] for an empty cwd", async () => {
    expect(await listWorkspaceFiles("")).toEqual([]);
  });

  describe("git repo path", () => {
    it("lists tracked + untracked-not-ignored files and honours .gitignore", async () => {
      const repo = path.join(workdir, "repo");
      await mkdir(repo);
      await initRepo(repo);
      await writeFile(path.join(repo, "tracked.ts"), "export const a = 1;");
      await writeFile(
        path.join(repo, ".gitignore"),
        "ignored.log\nnode_modules/\n",
      );
      await commitAll(repo);
      // Untracked-but-not-ignored — brand-new file the user just made; must
      // surface so it's mentionable.
      await writeFile(path.join(repo, "untracked.ts"), "export const b = 2;");
      // Ignored — must NOT surface.
      await writeFile(path.join(repo, "ignored.log"), "noise");
      await mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "x");

      const files = await listWorkspaceFiles(repo);

      expect(files).toContain("tracked.ts");
      expect(files).toContain("untracked.ts");
      expect(files).toContain(".gitignore");
      expect(files).not.toContain("ignored.log");
      expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    });

    it("respects the limit cap", async () => {
      const repo = path.join(workdir, "repo2");
      await mkdir(repo);
      await initRepo(repo);
      for (let i = 0; i < 6; i++) {
        await writeFile(path.join(repo, `f${i}.txt`), String(i));
      }
      const files = await listWorkspaceFiles(repo, 3);
      expect(files.length).toBe(3);
    });

    it("does not let one deep dependency subtree hide shallow sibling files at the cap", async () => {
      const repo = path.join(workdir, "repo-wide-tree");
      await mkdir(path.join(repo, "node_modules", "package", "dist"), {
        recursive: true,
      });
      await initRepo(repo);
      for (let i = 0; i < 12; i++) {
        await writeFile(
          path.join(repo, "node_modules", "package", "dist", `file-${i}.js`),
          String(i),
        );
      }
      // Reproduce Zinc: its initial commit force-tracked node_modules even
      // though the user's global ignore excludes it from ordinary `git add`.
      await execFileAsync("git", ["-C", repo, "add", "-f", "node_modules"]);
      await commitAll(repo);
      // pnpm then replaces that tracked npm tree with a large untracked store.
      // Those paths sort between `new-york.md` and `paris.md` in the `-o`
      // section of `git ls-files`, which is what exhausted Zinc's 20k prefix.
      await mkdir(path.join(repo, "node_modules", ".pnpm", "new-store"), {
        recursive: true,
      });
      for (let i = 0; i < 12; i++) {
        await writeFile(
          path.join(repo, "node_modules", ".pnpm", "new-store", `new-${i}`),
          String(i),
        );
      }
      for (const city of ["london", "new-york", "paris", "rome", "tokyo"]) {
        await writeFile(path.join(repo, `${city}.md`), `# ${city}\n`);
      }

      const files = await listWorkspaceFiles(repo, 5);

      expect(files).toEqual([
        "london.md",
        "new-york.md",
        "paris.md",
        "rome.md",
        "tokyo.md",
      ]);
    });

    it("excludes tracked paths deleted from disk", async () => {
      const repo = path.join(workdir, "repo-deleted");
      await mkdir(repo);
      await initRepo(repo);
      await writeFile(path.join(repo, "kept.txt"), "keep");
      await writeFile(path.join(repo, "deleted.txt"), "delete");
      await commitAll(repo);
      await rm(path.join(repo, "deleted.txt"));

      const files = await listWorkspaceFiles(repo);

      expect(files).toContain("kept.txt");
      expect(files).not.toContain("deleted.txt");
    });
  });

  describe("non-git fallback walk", () => {
    it("lists files, skips heavy dirs and dotdirs (except .github)", async () => {
      const plain = path.join(workdir, "plain");
      await mkdir(plain);
      await writeFile(path.join(plain, "index.ts"), "x");
      await mkdir(path.join(plain, "src"));
      await writeFile(path.join(plain, "src", "app.ts"), "x");
      // Heavy dep dir — skipped by SKIP_DIRS.
      await mkdir(path.join(plain, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(plain, "node_modules", "pkg", "i.js"), "x");
      // Generic dotdir — skipped.
      await mkdir(path.join(plain, ".cache"));
      await writeFile(path.join(plain, ".cache", "c"), "x");
      // .github is the one dotdir we keep (real config lives there).
      await mkdir(path.join(plain, ".github", "workflows"), {
        recursive: true,
      });
      await writeFile(path.join(plain, ".github", "workflows", "ci.yml"), "x");

      const files = await listWorkspaceFiles(plain);

      expect(files).toContain("index.ts");
      expect(files).toContain("src/app.ts");
      expect(files).toContain(".github/workflows/ci.yml");
      expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
      expect(files.some((f) => f.startsWith(".cache/"))).toBe(false);
    });

    it("returns POSIX-separated repo-relative paths", async () => {
      const plain = path.join(workdir, "plain2");
      await mkdir(path.join(plain, "a", "b"), { recursive: true });
      await writeFile(path.join(plain, "a", "b", "deep.ts"), "x");
      const files = await listWorkspaceFiles(plain);
      expect(files).toContain("a/b/deep.ts");
    });
  });

  describe("inclusive mention listing", () => {
    it.each([true, false])(
      "includes ignored paths, dotfiles and empty folders (git: %s)",
      async (git) => {
        if (git) await initRepo(workdir);
        await writeFile(path.join(workdir, ".gitignore"), "*\n");
        const files = [
          ".context/attachments/assets/id/Screenshot at 7.31 AM.png",
          ".context/rollout.jsonl",
          ".context-graph/local/attachments/pasted-text.txt",
          ".hidden/.nested/.file",
          ".env",
          "node_modules/pkg/index.js",
          "dist/output.js",
        ];
        for (const file of files) {
          await mkdir(path.dirname(path.join(workdir, file)), {
            recursive: true,
          });
          await writeFile(path.join(workdir, file), "fixture");
        }
        await mkdir(path.join(workdir, ".empty", "nested"), {
          recursive: true,
        });

        const entries = await listWorkspaceFiles(workdir, 200, {
          includeIgnored: true,
        });
        expect(entries).toEqual(
          expect.arrayContaining([
            ...files,
            ".context/",
            ".empty/",
            ".empty/nested/",
          ]),
        );
        expect(new Set(entries).size).toBe(entries.length);
        if (git) expect(entries).toContain(".git/HEAD");
      },
    );

    it("matches before capping so deep attachments survive a large unrelated tree", async () => {
      await initRepo(workdir);
      await writeFile(path.join(workdir, ".gitignore"), ".context/\n");
      for (let i = 0; i < 20; i++) {
        await writeFile(path.join(workdir, `noise-${i}.ts`), "fixture");
      }
      await mkdir(path.join(workdir, ".context/attachments/deep"), {
        recursive: true,
      });
      await writeFile(
        path.join(workdir, ".context/attachments/deep/rollout.jsonl"),
        "fixture",
      );

      expect(
        await listWorkspaceFiles(workdir, 1, {
          includeIgnored: true,
          query: "rollout",
        }),
      ).toEqual([".context/attachments/deep/rollout.jsonl"]);
    });

    it("ranks exact basenames ahead of earlier fuzzy matches at the cap", async () => {
      await mkdir(path.join(workdir, ".context/deep"), { recursive: true });
      await writeFile(path.join(workdir, ".context/deep/rollout"), "fixture");
      for (let i = 0; i < 10; i++) {
        await writeFile(path.join(workdir, `a-roll-out-${i}`), "fixture");
      }
      expect(
        await listWorkspaceFiles(workdir, 1, {
          includeIgnored: true,
          query: "rollout",
        }),
      ).toEqual([".context/deep/rollout"]);
    });

    it("lists symlinks without traversing cycles or outside-workspace targets", async () => {
      const root = path.join(workdir, "root");
      const outside = path.join(workdir, "outside");
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(outside, "private.txt"), "fixture");
      await writeFile(path.join(root, "visible.txt"), "fixture");
      await symlink(outside, path.join(root, "external"), "dir");
      await symlink(root, path.join(root, "cycle"), "dir");
      await symlink("missing", path.join(root, "broken"));
      expect(
        await listWorkspaceFiles(root, 200, { includeIgnored: true }),
      ).toEqual(["broken", "visible.txt", "cycle/", "external/"]);
    });

    it("preserves unusual filenames and observes creates and deletes", async () => {
      const filename = "白 space\nback\\tick`.png";
      await writeFile(path.join(workdir, filename), "fixture");
      expect(
        await listWorkspaceFiles(workdir, 200, { includeIgnored: true }),
      ).toEqual([filename]);
      await rm(path.join(workdir, filename));
      expect(
        await listWorkspaceFiles(workdir, 200, { includeIgnored: true }),
      ).toEqual([]);
    });

    it("reports an unavailable root instead of a successful empty search", async () => {
      await expect(
        listWorkspaceFiles(path.join(workdir, "missing"), 10, {
          includeIgnored: true,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
