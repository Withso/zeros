import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../../../../..");

describe("Zeros-scoped design-directory containment guarantees", () => {
  let temporaryRoot: string;
  let repo: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "zeros-design-containment-"),
    );
    repo = path.join(temporaryRoot, "repo");
    await mkdir(path.join(repo, "design"), { recursive: true });
    await mkdir(path.join(repo, "code"), { recursive: true });
    await Promise.all([
      writeFile(path.join(repo, "design", "write.txt"), "before-write\n"),
      writeFile(path.join(repo, "design", "delete.txt"), "before-delete\n"),
      writeFile(path.join(repo, "design", "rename.txt"), "before-rename\n"),
      writeFile(path.join(repo, "design", "linked-from-code.txt"), "design\n"),
      writeFile(path.join(repo, "code", "linked-from-design.txt"), "code\n"),
      writeFile(path.join(repo, "code", "hardlinked.txt"), "hardlink\n"),
    ]);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@zeros.local"], {
      cwd: repo,
    });
    await execFileAsync("git", ["config", "user.name", "Zeros Test"], {
      cwd: repo,
    });
    await execFileAsync("git", ["add", "-A"], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "fixture"], {
      cwd: repo,
    });
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("leaves the shared checkout writable to same-user tools outside Zeros", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const attack = String.raw`
      const { appendFileSync, chmodSync, existsSync, linkSync, renameSync,
        symlinkSync, unlinkSync, writeFileSync } = require("node:fs");
      const path = require("node:path");
      const root = process.cwd();
      const design = (...parts) => path.join(root, "design", ...parts);
      const code = (...parts) => path.join(root, "code", ...parts);
      const outcome = {};
      const attempt = (name, operation) => {
        try {
          operation();
          outcome[name] = true;
        } catch (error) {
          outcome[name] = false;
          outcome[name + "Error"] = error && error.code
            ? String(error.code)
            : String(error);
        }
      };

      attempt("trackedWrite", () => writeFileSync(design("write.txt"), "after-write\n"));
      attempt("untrackedCreate", () => writeFileSync(design("untracked.txt"), "created\n"));
      attempt("trackedDelete", () => {
        unlinkSync(design("delete.txt"));
      });
      attempt("trackedRename", () => {
        renameSync(design("rename.txt"), design("renamed.txt"));
      });
      attempt("symlinkOut", () => {
        symlinkSync(code("linked-from-design.txt"), design("link-to-code"));
        appendFileSync(design("link-to-code"), "through-design-link\n");
      });
      attempt("symlinkIn", () => {
        symlinkSync(design("linked-from-code.txt"), code("link-to-design"));
        appendFileSync(code("link-to-design"), "through-code-link\n");
      });
      attempt("hardlinkOut", () => {
        linkSync(code("hardlinked.txt"), design("hardlink-to-code"));
        appendFileSync(design("hardlink-to-code"), "through-hardlink\n");
      });
      outcome.deleteObserved = !existsSync(design("delete.txt"));
      outcome.renameObserved = existsSync(design("renamed.txt"));
      process.stdout.write(JSON.stringify(outcome));
    `;

    const { stdout } = await execFileAsync(process.execPath, ["-e", attack], {
      cwd: repo,
    });
    expect(JSON.parse(stdout)).toMatchObject({
      trackedWrite: true,
      untrackedCreate: true,
      trackedDelete: true,
      trackedRename: true,
      symlinkOut: true,
      symlinkIn: true,
      hardlinkOut: true,
      deleteObserved: true,
      renameObserved: true,
    });
    await expect(
      readFile(path.join(repo, "design", "untracked.txt"), "utf8"),
    ).resolves.toBe("created\n");
    await expect(
      readFile(path.join(repo, "code", "linked-from-design.txt"), "utf8"),
    ).resolves.toContain("through-design-link");
    await expect(
      readFile(path.join(repo, "design", "linked-from-code.txt"), "utf8"),
    ).resolves.toContain("through-code-link");
    await expect(
      readFile(path.join(repo, "code", "hardlinked.txt"), "utf8"),
    ).resolves.toContain("through-hardlink");
  });

  it("documents that enforcement belongs to Zeros-launched actors", () => {
    const designMode = readFileSync(
      path.join(repositoryRoot, "docs", "design-mode.md"),
      "utf8",
    );
    expect(designMode).toContain("Zeros-launched code agent");
    expect(designMode).toContain("external editor or coding platform");
    expect(designMode).toContain("does not install persistent filesystem ACLs");
  });
});
