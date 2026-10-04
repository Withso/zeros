import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "../types";

const fixture = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
  resolveGit: vi.fn(),
  readGit: vi.fn(),
}));

vi.mock("../worktree", () => ({
  resolveRepoForGitOp: fixture.resolveWorkspace,
}));
vi.mock("../../settings/repo-git", () => ({
  resolveRepoGit: fixture.resolveGit,
}));
vi.mock("../git-exec", () => ({
  runGitRead: fixture.readGit,
  runGit: fixture.readGit,
  assertSafeGitRef: (value: string) => value,
}));
vi.mock("../repo", () => ({ getInProgressState: vi.fn() }));

const FLOOR = "1".repeat(40);
const HEAD = "2".repeat(40);
type GitResult = { stdout: string; stderr: string };

function workspace(id: string): Workspace {
  return {
    id,
    repoRoot: "/fixture/repository",
    repoSlug: "fixture",
    path: `/fixture/${id}`,
    branch: "feature",
    baseBranch: "main",
    createdAt: 1,
    archivedAt: null,
    stashRef: null,
    status: "in-progress",
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function gitResult(args: string[], status = "", tracked = "M\0changed.txt\0"): GitResult {
  if (args[0] === "status") return { stdout: status, stderr: "" };
  if (args.includes("diff")) return { stdout: tracked, stderr: "" };
  if (args[0] === "merge-base") return { stdout: FLOOR, stderr: "" };
  if (args.includes("--abbrev-ref")) return { stdout: "feature", stderr: "" };
  return { stdout: args.at(-1) === "HEAD" ? HEAD : FLOOR, stderr: "" };
}

function statusReads() {
  return fixture.readGit.mock.calls.filter(([, args]) => args[0] === "status");
}

function diffReads() {
  return fixture.readGit.mock.calls.filter(([, args]) => args.includes("diff"));
}

let hasWorkspaceChanges: typeof import("../diff").hasWorkspaceChanges;
let invalidateWorkspaceChangeProbes: typeof import("../workspace-change-probe").invalidateWorkspaceChangeProbes;

beforeEach(async () => {
  vi.resetModules();
  fixture.resolveWorkspace.mockReset().mockImplementation(async (id: string) => workspace(id));
  fixture.resolveGit.mockReset().mockReturnValue({ remote: "origin" });
  fixture.readGit.mockReset().mockImplementation(async (_cwd: string, args: string[]) => gitResult(args));
  ({ hasWorkspaceChanges } = await import("../diff"));
  ({ invalidateWorkspaceChangeProbes } = await import("../workspace-change-probe"));
});

describe("hasWorkspaceChanges read budget and ownership", () => {
  it("uses one All comparison without computing the other three scopes", async () => {
    await expect(hasWorkspaceChanges("workspace-a")).resolves.toBe(true);
    expect(diffReads()).toHaveLength(1);
    expect(diffReads()[0]?.[1]).toContain(FLOOR);
    expect(diffReads()[0]?.[1]).not.toContain("--cached");
  });

  it("does not hide All changes when an unrelated scope would fail", async () => {
    fixture.readGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args.includes("diff") && !args.includes(FLOOR)) {
        throw new Error("unrelated scope unavailable");
      }
      return gitResult(args);
    });
    await expect(hasWorkspaceChanges("workspace-a")).resolves.toBe(true);
  });

  it("shares an overlapping burst for the same workspace and target", async () => {
    const status = deferred<GitResult>();
    fixture.readGit.mockImplementation(async (_cwd: string, args: string[]) =>
      args[0] === "status" ? status.promise : gitResult(args),
    );
    const probes = Array.from({ length: 12 }, () => hasWorkspaceChanges("workspace-a"));
    status.resolve({ stdout: "", stderr: "" });
    await expect(Promise.all(probes)).resolves.toEqual(Array(12).fill(true));
    expect(statusReads()).toHaveLength(1);
    expect(diffReads()).toHaveLength(1);
  });

  it("keeps unrelated workspace reads independent while one is waiting", async () => {
    const status = deferred<GitResult>();
    fixture.readGit.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === "status" && cwd === "/fixture/workspace-a") return status.promise;
      return gitResult(args, "", cwd === "/fixture/workspace-a" ? "M\0changed.txt\0" : "");
    });
    const first = hasWorkspaceChanges("workspace-a");
    try {
      await expect(hasWorkspaceChanges("workspace-b")).resolves.toBe(false);
      expect(statusReads().map(([cwd]) => cwd)).toEqual([
        "/fixture/workspace-a",
        "/fixture/workspace-b",
      ]);
    } finally {
      status.resolve({ stdout: "", stderr: "" });
      await first;
    }
  });

  it("does not retain a settled answer after the working tree changes", async () => {
    fixture.readGit.mockImplementation(async (_cwd: string, args: string[]) => gitResult(args, "", ""));
    await expect(hasWorkspaceChanges("workspace-a")).resolves.toBe(false);
    fixture.readGit.mockImplementation(async (_cwd: string, args: string[]) => gitResult(args, "?? added.txt\0", ""));
    await expect(hasWorkspaceChanges("workspace-a")).resolves.toBe(true);
    expect(statusReads()).toHaveLength(2);
  });

  it("retires a failed flight so a later read can succeed", async () => {
    let fail = true;
    fixture.readGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "status" && fail) throw new Error("checkout unavailable");
      return gitResult(args);
    });
    await expect(hasWorkspaceChanges("workspace-a")).resolves.toBe(false);
    fail = false;
    await expect(hasWorkspaceChanges("workspace-a")).resolves.toBe(true);
    expect(statusReads()).toHaveLength(2);
  });

  it("coalesces invalidated reads into one fresh follow-up and keeps it owned after the old reply", async () => {
    const oldStatus = deferred<GitResult>();
    const freshStatus = deferred<GitResult>();
    let scans = 0;
    fixture.readGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "status") return ++scans === 1 ? oldStatus.promise : freshStatus.promise;
      return gitResult(args, "", "");
    });
    const first = hasWorkspaceChanges("workspace-a");
    await vi.waitFor(() => expect(statusReads()).toHaveLength(1));
    const refreshed: Promise<boolean>[] = [];
    for (let index = 0; index < 20; index += 1) {
      invalidateWorkspaceChangeProbes(["workspace-a"]);
      refreshed.push(hasWorkspaceChanges("workspace-a"));
    }
    try {
      expect(statusReads()).toHaveLength(1);
      oldStatus.resolve({ stdout: "", stderr: "" });
      await expect(first).resolves.toBe(false);
      await vi.waitFor(() => expect(statusReads()).toHaveLength(2));
      // An old completion must not remove the successor's in-flight identity.
      refreshed.push(hasWorkspaceChanges("workspace-a"));
      freshStatus.resolve({ stdout: "?? fresh.txt\0", stderr: "" });
      await expect(Promise.all(refreshed)).resolves.toEqual(Array(21).fill(true));
      expect(statusReads()).toHaveLength(2);
    } finally {
      oldStatus.resolve({ stdout: "", stderr: "" });
      freshStatus.resolve({ stdout: "?? fresh.txt\0", stderr: "" });
      await Promise.all([first, ...refreshed]);
    }
  });

  it("an exact invalidation leaves another workspace's pending read shared", async () => {
    const status = deferred<GitResult>();
    fixture.readGit.mockImplementation(async (_cwd: string, args: string[]) =>
      args[0] === "status" ? status.promise : gitResult(args),
    );
    const first = hasWorkspaceChanges("workspace-b");
    await vi.waitFor(() => expect(statusReads()).toHaveLength(1));
    invalidateWorkspaceChangeProbes(["workspace-a"]);
    const second = hasWorkspaceChanges("workspace-b");
    status.resolve({ stdout: "", stderr: "" });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(statusReads()).toHaveLength(1);
  });

  it.each(["path", "repoRoot", "baseBranch", "createdAt", "remote"] as const)(
    "does not reuse a running read after its %s identity changes",
    async (changed) => {
      const status = deferred<GitResult>();
      let current = workspace("workspace-a");
      fixture.resolveWorkspace.mockImplementation(async () => ({ ...current }));
      fixture.readGit.mockImplementation(async (_cwd: string, args: string[]) =>
        args[0] === "status" ? status.promise : gitResult(args),
      );
      const first = hasWorkspaceChanges("workspace-a");
      await vi.waitFor(() => expect(statusReads()).toHaveLength(1));
      if (changed === "remote") fixture.resolveGit.mockReturnValue({ remote: "upstream" });
      else current = {
        ...current,
        [changed]: changed === "createdAt" ? 2 : `${current[changed]}-replacement`,
      };
      const replacement = hasWorkspaceChanges("workspace-a");
      try {
        await vi.waitFor(() => expect(statusReads()).toHaveLength(2));
      } finally {
        status.resolve({ stdout: "", stderr: "" });
        await Promise.all([first, replacement]);
      }
    },
  );
});
