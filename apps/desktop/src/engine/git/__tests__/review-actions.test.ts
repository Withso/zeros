import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyConflictChoices,
  parseMergeConflicts,
  splitReviewHunks,
  untrackedReviewPatch,
  type ReviewHunkInput,
  type ReviewComparison,
} from "@zeros/protocol/git-review-actions";
import {
  createWorkspace,
  getWorkspace,
  closeState,
  setStateRootForTesting,
} from "..";
import { diff } from "../diff";
import {
  listHunkReviews,
  reviewHunk,
  resolveConflict,
} from "../review-actions";
import * as writer from "../../files/write-file";
import { QualifiedCloudFilePolicy } from "../../files/cloud-file-policy";

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
  async function target(
    comparison: ReviewComparison = "worktree-vs-head",
    index = 0,
  ): Promise<Omit<ReviewHunkInput, "decision" | "confirm">> {
    const result = await diff({
      workspaceId,
      filePath: "file.txt",
      mode: comparison,
      base: "HEAD",
      rawPatch: true,
    });
    return {
      workspaceId,
      path: "file.txt",
      comparison,
      expectedContent: fs.existsSync(file()) ? read() : null,
      patch: splitReviewHunks(result.patch!)[index].patch,
    };
  }
  function changeTwo() {
    fs.writeFileSync(
      file(),
      original
        .replace("line 2\n", "first change\n")
        .replace("line 20\n", "second change\n"),
    );
  }

  it("reverses one exact uncommitted hunk, retaining the other hunk and index", async () => {
    changeTwo();
    const index = await git(cwd, "show", ":file.txt");
    const head = await git(cwd, "rev-parse", "HEAD");
    const result = await reviewHunk({
      ...(await target()),
      decision: "rejected",
      confirm: true,
    });
    expect(result.fileChanged).toBe(true);
    expect(read()).toBe(original.replace("line 20\n", "second change\n"));
    expect(await git(cwd, "show", ":file.txt")).toBe(index);
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
  });
  it("records Accept durably while keeping both bytes and index untouched", async () => {
    changeTwo();
    const input = await target();
    const result = await reviewHunk({ ...input, decision: "accepted" });
    expect(result.fileChanged).toBe(false);
    expect(read()).toBe(input.expectedContent);
    expect(await git(cwd, "show", ":file.txt")).toBe(original);
    closeState();
    expect(await listHunkReviews({ workspaceId, path: "file.txt" })).toEqual([
      result.decision,
    ]);
    expect(
      (await reviewHunk({ ...input, decision: "accepted" })).decision,
    ).toEqual(result.decision);
    const other = await createWorkspace({
      repoRoot: getWorkspace(workspaceId).repoRoot,
    });
    expect(
      await listHunkReviews({
        workspaceId: other.workspaceId,
        path: "file.txt",
      }),
    ).toEqual([]);
  });
  it("does not unstage a staged hunk when rejecting its HEAD-to-worktree change", async () => {
    fs.writeFileSync(file(), original.replace("line 2\n", "staged\n"));
    await git(cwd, "add", "file.txt");
    const index = await git(cwd, "show", ":file.txt");
    fs.writeFileSync(file(), read().replace("line 20\n", "unstaged\n"));
    await reviewHunk({
      ...(await target()),
      decision: "rejected",
      confirm: true,
    });
    expect(read()).toBe(original.replace("line 20\n", "unstaged\n"));
    expect(await git(cwd, "show", ":file.txt")).toBe(index);
  });
  it("reverses only the index-to-worktree comparison", async () => {
    fs.writeFileSync(file(), original.replace("line 2\n", "staged\n"));
    await git(cwd, "add", "file.txt");
    const staged = read();
    fs.writeFileSync(file(), staged.replace("line 20\n", "unstaged\n"));
    await reviewHunk({
      ...(await target("worktree-vs-index")),
      decision: "rejected",
      confirm: true,
    });
    expect(read()).toBe(staged);
    expect(await git(cwd, "show", ":file.txt")).toBe(staged);
  });
  it.each(["accepted", "rejected"] as const)(
    "refuses stale %s, even when another hunk alone changed",
    async (decision) => {
      changeTwo();
      const input = await target();
      fs.writeFileSync(
        file(),
        read().replace("second change", "concurrent change"),
      );
      const newer = read();
      await expect(
        reviewHunk({ ...input, decision, confirm: true }),
      ).rejects.toThrow(/changed|refresh/i);
      expect(read()).toBe(newer);
      expect(await listHunkReviews({ workspaceId, path: "file.txt" })).toEqual(
        [],
      );
    },
  );
  it("requires confirmation and disallows historical/committed/staged comparisons", async () => {
    changeTwo();
    const input = await target();
    await expect(
      reviewHunk({ ...input, decision: "rejected" }),
    ).rejects.toThrow(/confirm/i);
    for (const comparison of [
      "base",
      "range",
      "refs",
      "index-vs-head",
      "worktree-vs-base",
    ]) {
      await expect(
        reviewHunk({
          ...input,
          comparison: comparison as ReviewComparison,
          decision: "rejected",
          confirm: true,
        }),
      ).rejects.toThrow(/invalid/i);
    }
    expect(read()).toBe(input.expectedContent);
  });
  it("validates one exact path and hunk rather than accepting an arbitrary patch", async () => {
    changeTwo();
    const input = await target();
    const full = (
      await diff({
        workspaceId,
        mode: "worktree-vs-head",
        base: "HEAD",
        rawPatch: true,
      })
    ).patch!;
    await expect(
      reviewHunk({
        ...input,
        patch: full,
        decision: "rejected",
        confirm: true,
      }),
    ).rejects.toThrow(/one|exactly/i);
    await expect(
      reviewHunk({
        ...input,
        patch: input.patch.replace("first change", "invented change"),
        decision: "rejected",
        confirm: true,
      }),
    ).rejects.toThrow(/changed/i);
    await expect(
      reviewHunk({
        ...input,
        path: "different.txt",
        expectedContent: null,
        decision: "rejected",
        confirm: true,
      }),
    ).rejects.toThrow(/selected file/i);
    expect(read()).toBe(input.expectedContent);
  });
  it("rejects only an exact untracked addition, including a quoted path", async () => {
    const relative = "new file.txt";
    fs.writeFileSync(path.join(cwd, relative), "new\r\nfile");
    fs.writeFileSync(path.join(cwd, "keep.txt"), "keep\n");
    await reviewHunk({
      workspaceId,
      path: relative,
      comparison: "worktree-vs-index",
      patch: untrackedReviewPatch(relative, "new\r\nfile"),
      expectedContent: "new\r\nfile",
      decision: "rejected",
      confirm: true,
    });
    expect(fs.existsSync(path.join(cwd, relative))).toBe(false);
    expect(fs.readFileSync(path.join(cwd, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await git(cwd, "ls-files", "--", relative)).toBe("");
  });
  it("restores a deleted file without changing its index entry", async () => {
    fs.unlinkSync(file());
    await reviewHunk({
      ...(await target()),
      decision: "rejected",
      confirm: true,
    });
    expect(read()).toBe(original);
    expect(await git(cwd, "show", ":file.txt")).toBe(original);
  });
  it("supports complete-context previews and preserves CRLF/no-final-newline bytes", async () => {
    fs.writeFileSync(file(), "before\r\nlast");
    await git(cwd, "add", "file.txt");
    await git(cwd, "commit", "-q", "-m", "newline fixture");
    fs.writeFileSync(file(), "after\r\nlast");
    const result = await diff({
      workspaceId,
      filePath: "file.txt",
      mode: "worktree-vs-head",
      base: "HEAD",
      rawPatch: true,
      fullContext: true,
    });
    await reviewHunk({
      workspaceId,
      path: "file.txt",
      comparison: "worktree-vs-head",
      expectedContent: read(),
      patch: splitReviewHunks(result.patch!)[0].patch,
      decision: "rejected",
      confirm: true,
    });
    expect(read()).toBe("before\r\nlast");
  });
  it("serializes app-owned rejects and fails the second stale request", async () => {
    changeTwo();
    const input = {
      ...(await target()),
      decision: "rejected" as const,
      confirm: true,
    };
    const results = await Promise.allSettled([
      reviewHunk(input),
      reviewHunk(input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(read()).toBe(original.replace("line 20\n", "second change\n"));
  });
  it("fails closed on an external edit after asynchronous Git validation", async () => {
    changeTwo();
    const input = await target();
    const write = writer.writeWorkspaceFile;
    vi.spyOn(writer, "writeWorkspaceFile").mockImplementation((...args) => {
      fs.writeFileSync(file(), "external edit\n");
      return write(...args);
    });
    await expect(
      reviewHunk({ ...input, decision: "rejected", confirm: true }),
    ).rejects.toThrow(/changed/i);
    expect(read()).toBe("external edit\n");
  });
  it("protects inactive, index-recognized Design roots after their disk marker is removed", async () => {
    fs.mkdirSync(path.join(cwd, "Paint"));
    fs.writeFileSync(path.join(cwd, "Paint/.zeros-canvas.json"), "{}\n");
    await git(cwd, "add", "Paint/.zeros-canvas.json");
    fs.unlinkSync(path.join(cwd, "Paint/.zeros-canvas.json"));
    fs.writeFileSync(path.join(cwd, "Paint/frame.html"), "frame\n");
    await expect(
      reviewHunk({
        workspaceId,
        path: "Paint/frame.html",
        comparison: "worktree-vs-index",
        expectedContent: "frame\n",
        patch: untrackedReviewPatch("Paint/frame.html", "frame\n"),
        decision: "rejected",
        confirm: true,
      }),
    ).rejects.toThrow(/Design/);
    expect(fs.readFileSync(path.join(cwd, "Paint/frame.html"), "utf8")).toBe(
      "frame\n",
    );
  });
  it("allows ordinary repository TOML named design.toml without claiming Design territory", async () => {
    const relative = "design.toml";
    const content = 'theme = "dark"\n';
    fs.writeFileSync(path.join(cwd, relative), content);
    await reviewHunk({
      workspaceId,
      path: relative,
      comparison: "worktree-vs-index",
      expectedContent: content,
      patch: untrackedReviewPatch(relative, content),
      decision: "rejected",
      confirm: true,
    });
    expect(fs.existsSync(path.join(cwd, relative))).toBe(false);
  });
  it("rechecks Design registration after asynchronous validation", async () => {
    fs.mkdirSync(path.join(cwd, "Paint"));
    fs.writeFileSync(path.join(cwd, "Paint/frame.html"), "frame\n");
    const input = {
      workspaceId,
      path: "Paint/frame.html",
      comparison: "worktree-vs-index" as const,
      expectedContent: "frame\n",
      patch: untrackedReviewPatch("Paint/frame.html", "frame\n"),
      decision: "rejected" as const,
      confirm: true,
    };
    await expect(
      reviewHunk(input, {
        cwd,
        assertSourceWrite: async () => {
          fs.writeFileSync(path.join(cwd, "Paint/.zeros-canvas.json"), "{}\n");
        },
      }),
    ).rejects.toThrow(/Design/);
    expect(fs.readFileSync(path.join(cwd, "Paint/frame.html"), "utf8")).toBe(
      "frame\n",
    );
  });
  it("refuses bad paths, aliases and separately owned nested checkouts", async () => {
    changeTwo();
    const input = await target();
    for (const relative of [
      "../file.txt",
      "/file.txt",
      "a/../file.txt",
      "a\\file.txt",
      ".git/config",
    ]) {
      await expect(
        reviewHunk({
          ...input,
          path: relative,
          decision: "rejected",
          confirm: true,
        }),
      ).rejects.toThrow();
    }
    fs.symlinkSync("file.txt", path.join(cwd, "alias.txt"));
    await expect(
      listHunkReviews({ workspaceId, path: "alias.txt" }),
    ).rejects.toThrow(/aliases/i);
    fs.mkdirSync(path.join(cwd, "nested"));
    fs.writeFileSync(path.join(cwd, "nested/.git"), "owned elsewhere\n");
    fs.writeFileSync(path.join(cwd, "nested/file.txt"), "nested\n");
    await expect(
      listHunkReviews({ workspaceId, path: "nested/file.txt" }),
    ).rejects.toThrow(/aliases/i);
    expect(read()).toBe(input.expectedContent);
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
  it("honors qualified cloud write admission and private/nested owner boundaries", async () => {
    const input = await makeConflict();
    const denied = new QualifiedCloudFilePolicy(cwd, {
      canEdit: false,
      authorized: () => true,
      privateRoots: [],
      ownerRoots: () => [],
    });
    await expect(
      resolveConflict(input, { cwd, remote: true, cloudPolicy: denied }),
    ).rejects.toThrow(/policy/i);
    expect(read()).toBe(input.expectedContent);
    const allowed = new QualifiedCloudFilePolicy(cwd, {
      canEdit: true,
      authorized: () => true,
      privateRoots: [],
      ownerRoots: () => [],
    });
    expect(
      (
        await resolveConflict(input, {
          cwd,
          remote: true,
          cloudPolicy: allowed,
        })
      ).kind,
    ).toBe("success");
    expect(read()).toBe(input.content);
  });
});
