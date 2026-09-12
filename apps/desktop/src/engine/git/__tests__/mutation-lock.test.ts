import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { withWorkspaceGitMutation } from "../mutation-lock";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("workspace Git mutation lane", () => {
  it("runs same-worktree index and history mutations in submission order", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const second = vi.fn(async () => "second");

    const firstResult = withWorkspaceGitMutation("/workspace/a", async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstEntered.promise;
    const secondResult = withWorkspaceGitMutation("/workspace/a", second);
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).resolves.toBe("second");
  });

  it("does not serialize independent worktrees", async () => {
    const releaseFirst = deferred();
    const second = vi.fn(async () => "second");
    const firstResult = withWorkspaceGitMutation("/workspace/a", async () => {
      await releaseFirst.promise;
      return "first";
    });
    const secondResult = withWorkspaceGitMutation("/workspace/b", second);

    await expect(secondResult).resolves.toBe("second");
    expect(second).toHaveBeenCalledOnce();
    releaseFirst.resolve();
    await expect(firstResult).resolves.toBe("first");
  });

  it("releases the lane after a failed mutation", async () => {
    await expect(
      withWorkspaceGitMutation("/workspace/a", async () => {
        throw new Error("failed mutation");
      }),
    ).rejects.toThrow("failed mutation");
    await expect(
      withWorkspaceGitMutation("/workspace/a", async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it("allows an admitted mutation to re-enter the same worktree lane", async () => {
    const nested = vi.fn(async () => "nested");

    await expect(
      withWorkspaceGitMutation("/workspace/reentrant", () =>
        withWorkspaceGitMutation("/workspace/reentrant", nested),
      ),
    ).resolves.toBe("nested");
    expect(nested).toHaveBeenCalledOnce();
  });

  it("serializes Git ref mutations across linked worktrees of one repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-repo-mutation-lane-"));
    const commonGitDir = path.join(root, "repo", ".git");
    const firstWorktree = path.join(root, "first");
    const secondWorktree = path.join(root, "second");
    const firstGitDir = path.join(commonGitDir, "worktrees", "first");
    const secondGitDir = path.join(commonGitDir, "worktrees", "second");
    await Promise.all([
      mkdir(firstGitDir, { recursive: true }),
      mkdir(secondGitDir, { recursive: true }),
      mkdir(firstWorktree, { recursive: true }),
      mkdir(secondWorktree, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(firstWorktree, ".git"), `gitdir: ${firstGitDir}\n`),
      writeFile(
        path.join(secondWorktree, ".git"),
        `gitdir: ${secondGitDir}\n`,
      ),
      writeFile(path.join(firstGitDir, "commondir"), "../..\n"),
      writeFile(path.join(secondGitDir, "commondir"), "../..\n"),
    ]);

    const entered = deferred();
    const release = deferred();
    const first = withWorkspaceGitMutation(firstWorktree, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const secondMutation = vi.fn(async () => undefined);
    const second = withWorkspaceGitMutation(secondWorktree, secondMutation);

    try {
      const state = await Promise.race([
        second.then(() => "ran" as const),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 25),
        ),
      ]);
      expect(state).toBe("blocked");
      expect(secondMutation).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([first, second]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects cross-worktree nested mutation instead of deadlocking behind repository ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-repo-nested-lane-"));
    const commonGitDir = path.join(root, "repo", ".git");
    const firstWorktree = path.join(root, "first");
    const secondWorktree = path.join(root, "second");
    const firstGitDir = path.join(commonGitDir, "worktrees", "first");
    const secondGitDir = path.join(commonGitDir, "worktrees", "second");
    await Promise.all([
      mkdir(firstGitDir, { recursive: true }),
      mkdir(secondGitDir, { recursive: true }),
      mkdir(firstWorktree, { recursive: true }),
      mkdir(secondWorktree, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(firstWorktree, ".git"), `gitdir: ${firstGitDir}\n`),
      writeFile(path.join(secondWorktree, ".git"), `gitdir: ${secondGitDir}\n`),
      writeFile(path.join(firstGitDir, "commondir"), "../..\n"),
      writeFile(path.join(secondGitDir, "commondir"), "../..\n"),
    ]);

    const firstEntered = deferred();
    const attemptNested = deferred();
    const first = withWorkspaceGitMutation(firstWorktree, async () => {
      firstEntered.resolve();
      await attemptNested.promise;
      return withWorkspaceGitMutation(secondWorktree, async () => undefined);
    });
    await firstEntered.promise;
    const second = withWorkspaceGitMutation(
      secondWorktree,
      async () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    attemptNested.resolve();

    try {
      const outcome = await Promise.race([
        first.then(
          () => ({ state: "resolved" as const }),
          (error: unknown) => ({ state: "rejected" as const, error }),
        ),
        new Promise<{ state: "timed-out" }>((resolve) =>
          setTimeout(() => resolve({ state: "timed-out" }), 100),
        ),
      ]);
      expect(outcome.state).toBe("rejected");
      expect(outcome).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringMatching(/nested.*different worktree/i),
        }),
      });
      await second;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
