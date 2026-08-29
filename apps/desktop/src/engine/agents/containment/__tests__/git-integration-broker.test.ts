import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runFile } from "../../../git/git-exec";
import { discoverCanonicalGitRepository } from "../canonical-git-repository";
import {
  isTreeLevelGitIntegration,
  pinAmbiguousCheckoutIntegration,
  resolveRegisteredIntegrationRepository,
} from "../git-integration-broker";

describe("host-parity Git integration classification", () => {
  it.each([
    [["checkout", "incoming"]],
    [["checkout", "-b", "incoming", "main"]],
    [["switch", "incoming"]],
    [["reset", "--hard", "HEAD~1"]],
    [["merge", "incoming"]],
    [["rebase", "--abort"]],
    [["cherry-pick", "--continue"]],
    [["revert", "abc123"]],
    [["pull", "--ff-only"]],
  ])("admits tree-level argv %j", (args) => {
    expect(isTreeLevelGitIntegration(args)).toBe(true);
  });

  it.each([
    [["checkout", "HEAD", "--", "Zeros Design/canvas.json"]],
    [["checkout", "HEAD", "Zeros Design/canvas.json"]],
    [["checkout", "--", "."]],
    [["checkout", "--pathspec-from-file=paths"]],
    [["reset", "--hard", "HEAD", "--", "Zeros Design"]],
    [["reset", "HEAD", "Zeros Design/canvas.json"]],
    [["restore", "Zeros Design/canvas.json"]],
    [["stash", "push", "--", "Zeros Design/canvas.json"]],
    [["stash", "push", "code.txt"]],
    [["stash", "push", "--include-untracked"]],
    [["stash", "apply"]],
    [["stash", "branch", "from-stash"]],
    [["stash", "pop"]],
    [["checkout", "--help"]],
    [["-c", "core.hooksPath=/tmp/hooks", "merge", "incoming"]],
  ])("keeps path-naming or authority-changing argv native %j", (args) => {
    expect(isTreeLevelGitIntegration(args)).toBe(false);
  });

  it("does not treat an unregistered nested repository as its outer owner", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-git-owner-")),
    );
    const workspace = path.join(root, "workspace");
    const subdirectory = path.join(workspace, "subdirectory");
    const nested = path.join(workspace, "nested");
    try {
      await Promise.all([
        mkdir(subdirectory, { recursive: true }),
        mkdir(nested, { recursive: true }),
      ]);
      await runFile("git", ["init", "-b", "main"], { cwd: workspace });
      await runFile("git", ["init", "-b", "main"], { cwd: nested });
      const registered = await discoverCanonicalGitRepository(workspace);
      expect(registered).not.toBeNull();
      await expect(
        resolveRegisteredIntegrationRepository(subdirectory, [registered!]),
      ).resolves.toMatchObject({ workspaceRoot: workspace });
      await expect(
        resolveRegisteredIntegrationRepository(nested, [registered!]),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins an ambiguous branch checkout before trusted execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-git-checkout-pin-"));
    const workspace = path.join(root, "workspace");
    try {
      await mkdir(workspace, { recursive: true });
      await runFile("git", ["init", "-b", "main"], { cwd: workspace });
      await runFile("git", ["config", "user.email", "test@example.com"], {
        cwd: workspace,
      });
      await runFile("git", ["config", "user.name", "Zeros Test"], {
        cwd: workspace,
      });
      await writeFile(path.join(workspace, "incoming"), "committed\n");
      await runFile("git", ["add", "incoming"], { cwd: workspace });
      await runFile("git", ["commit", "-m", "initial"], { cwd: workspace });
      await runFile("git", ["branch", "incoming"], { cwd: workspace });

      const pinned = await pinAmbiguousCheckoutIntegration(workspace, [
        "checkout",
        "incoming",
      ]);
      expect(pinned).not.toBeNull();
      await runFile("git", pinned!, { cwd: workspace });
      await expect(
        runFile("git", ["symbolic-ref", "HEAD"], { cwd: workspace }),
      ).resolves.toMatchObject({ stdout: "refs/heads/incoming\n" });
      await runFile("git", ["checkout", "main"], { cwd: workspace });

      // Simulate the ref-to-path race that made the original one-argument
      // checkout ambiguous after authorization. The pinned invocation must
      // fail instead of restoring the identically named path outside the actor
      // fence.
      await runFile("git", ["branch", "-D", "incoming"], { cwd: workspace });
      await writeFile(path.join(workspace, "incoming"), "dirty\n");
      await expect(runFile("git", pinned!, { cwd: workspace })).rejects.toThrow();
      await expect(
        runFile("git", ["symbolic-ref", "HEAD"], { cwd: workspace }),
      ).resolves.toMatchObject({ stdout: "refs/heads/main\n" });
      await expect(
        readFile(path.join(workspace, "incoming"), "utf8"),
      ).resolves.toBe("dirty\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["HEAD", "@"]) (
    "keeps checkout %s native so the current symbolic branch is not detached",
    async (target) => {
      const root = await mkdtemp(path.join(tmpdir(), "zeros-git-checkout-head-"));
      const workspace = path.join(root, "workspace");
      try {
        await mkdir(workspace, { recursive: true });
        await runFile("git", ["init", "-b", "main"], { cwd: workspace });
        await runFile("git", ["config", "user.email", "test@example.com"], {
          cwd: workspace,
        });
        await runFile("git", ["config", "user.name", "Zeros Test"], {
          cwd: workspace,
        });
        await runFile("git", ["commit", "--allow-empty", "-m", "initial"], {
          cwd: workspace,
        });
        const before = await runFile(
          "git",
          ["reflog", "--format=%H%x00%gs"],
          { cwd: workspace },
        );

        await expect(
          pinAmbiguousCheckoutIntegration(workspace, ["checkout", target]),
        ).resolves.toBeNull();
        await runFile("git", ["checkout", target], { cwd: workspace });

        await expect(
          runFile("git", ["symbolic-ref", "HEAD"], { cwd: workspace }),
        ).resolves.toMatchObject({ stdout: "refs/heads/main\n" });
        await expect(
          runFile("git", ["reflog", "--format=%H%x00%gs"], {
            cwd: workspace,
          }),
        ).resolves.toMatchObject({ stdout: before.stdout });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
