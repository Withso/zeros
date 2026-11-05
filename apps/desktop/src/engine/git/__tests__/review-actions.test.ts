import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyConflictChoices,
  parseMergeConflicts,
} from "@zeros/protocol/git-review-actions";
import {
  createWorkspace,
  getWorkspace,
  closeState,
  setStateRootForTesting,
} from "..";
import { resolveConflict } from "../review-actions";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd })).stdout;

describe("guarded Git review actions in real repositories", () => {
  let temporary: string;
  let workspaceId: string;
  let cwd: string;
  let original: string;
  const file = () => path.join(cwd, "file.txt");
  const read = () => fs.readFileSync(file(), "utf8");
  beforeEach(async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-review-actions-"));
    setStateRootForTesting(path.join(temporary, "state"));
    const repository = path.join(temporary, "repo");
    fs.mkdirSync(repository);
    await git(repository, "init", "-q", "-b", "main");
    await git(repository, "config", "user.name", "Review test");
    await git(repository, "config", "user.email", "test@example.com");
    await git(
      repository,
      "remote",
      "add",
      "origin",
      "https://example.com/test/review.git",
    );
    original = Array.from({ length: 24 }, (_, i) => `line ${i + 1}\n`).join("");
    fs.writeFileSync(path.join(repository, "file.txt"), original);
    await git(repository, "add", "file.txt");
    await git(repository, "commit", "-q", "-m", "base");
    workspaceId = (await createWorkspace({ repoRoot: repository })).workspaceId;
    cwd = getWorkspace(workspaceId).path;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeState();
    setStateRootForTesting(null);
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  async function makeConflict() {
    const branch = (await git(cwd, "branch", "--show-current")).trim();
    await git(cwd, "switch", "-q", "-c", "incoming");
    fs.writeFileSync(file(), original.replace("line 2\n", "incoming\n"));
    await git(cwd, "add", "file.txt");
    await git(cwd, "commit", "-q", "-m", "incoming");
    await git(cwd, "switch", "-q", branch);
    fs.writeFileSync(file(), original.replace("line 2\n", "current\n"));
    await git(cwd, "add", "file.txt");
    await git(cwd, "commit", "-q", "-m", "current");
    await expect(git(cwd, "merge", "incoming")).rejects.toThrow();
    const expectedContent = read();
    const choices = Object.fromEntries(
      parseMergeConflicts(expectedContent).conflicts.map((block) => [
        block.id,
        "both" as const,
      ]),
    );
    return {
      workspaceId,
      path: "file.txt",
      expectedContent,
      choices,
      content: applyConflictChoices(expectedContent, choices).content,
    };
  }
  it("saves an explicit conflict preview while leaving Git's unmerged index and continuation separate", async () => {
    const input = await makeConflict();
    const unmerged = await git(cwd, "ls-files", "-u");
    const head = await git(cwd, "rev-parse", "HEAD");
    expect((await resolveConflict(input)).kind).toBe("success");
    expect(read()).toBe(original.replace("line 2\n", "current\nincoming\n"));
    expect(await git(cwd, "ls-files", "-u")).toBe(unmerged);
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
    expect(await git(cwd, "rev-parse", "--verify", "MERGE_HEAD")).toBeTruthy();
  });
  it("refuses stale conflict saves and retains the concurrent editor's content", async () => {
    const input = await makeConflict();
    fs.writeFileSync(file(), "concurrent resolution\r\n");
    await expect(resolveConflict(input)).rejects.toThrow(/changed|refresh/i);
    expect(read()).toBe("concurrent resolution\r\n");
  });
  it("refuses unresolved choices, unrelated replacements and marker-only non-conflicts", async () => {
    const input = await makeConflict();
    await expect(resolveConflict({ ...input, choices: {} })).rejects.toThrow(
      /every conflict/i,
    );
    await expect(
      resolveConflict({
        ...input,
        content: input.content.replace("line 24", "other edit"),
      }),
    ).rejects.toThrow(/unrelated/i);
    expect(read()).toBe(input.expectedContent);
    await git(cwd, "merge", "--abort");
    fs.writeFileSync(file(), input.expectedContent);
    await expect(resolveConflict(input)).rejects.toThrow(/live Git conflict/i);
    expect(read()).toBe(input.expectedContent);
  });
});
