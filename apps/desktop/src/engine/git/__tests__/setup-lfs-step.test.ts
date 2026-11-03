// A repository that tracks files with Git LFS gets its real files fetched by
// the Setup run, through the user's own git-lfs and Git configuration.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSetupCommand } from "../setup-hooks";

describe("Setup command for Git LFS repositories", () => {
  let repoRoot: string;
  beforeEach(async () => { repoRoot = await mkdtemp(path.join(tmpdir(), "zeros-setup-lfs-")); });
  afterEach(async () => { await rm(repoRoot, { recursive: true, force: true }); });

  it("runs git lfs pull before the repository's own setup command", async () => {
    await writeFile(path.join(repoRoot, ".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
    const command = await resolveSetupCommand({ repoRoot, inlineCommand: "pnpm install" });
    expect(command).toMatch(/git lfs pull/);
    expect(command!.indexOf("git lfs pull")).toBeLessThan(command!.indexOf("pnpm install"));
    expect(command).toMatch(/isn't installed/);
  });

  it("runs the LFS step alone when no setup command is configured", async () => {
    await writeFile(path.join(repoRoot, ".gitattributes"), "assets/** filter=lfs -text\n");
    expect(await resolveSetupCommand({ repoRoot })).toMatch(/git lfs pull/);
  });

  it("leaves repositories without LFS unchanged", async () => {
    await writeFile(path.join(repoRoot, ".gitattributes"), "*.md text eol=lf\n");
    expect(await resolveSetupCommand({ repoRoot, inlineCommand: "pnpm install" })).toBe("pnpm install");
    expect(await resolveSetupCommand({ repoRoot })).toBeNull();
  });

  it("ignores a .gitattributes that is not a regular file", async () => {
    const elsewhere = path.join(repoRoot, "elsewhere");
    await writeFile(elsewhere, "*.bin filter=lfs\n");
    await symlink(elsewhere, path.join(repoRoot, ".gitattributes"));
    expect(await resolveSetupCommand({ repoRoot })).toBeNull();
  });
});
