import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLocalGitGraph } from "../local-git-graph";
import type { Workspace } from "../types";

let root: string;
let workspace: Workspace;
const observed = { head: "2".repeat(40), branch: "feature" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-graph-cache-test-"));
  await mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature\n");
  await writeFile(path.join(root, ".git", "refs", "heads", "main"), "1".repeat(40));
  await writeFile(path.join(root, ".git", "refs", "heads", "feature"), observed.head);
  workspace = { id: "workspace", path: root, repoRoot: root, repoSlug: "fixture", branch: "feature", baseBranch: "main",
    createdAt: 1, archivedAt: null, stashRef: null, status: "in-progress", prNumber: null, prState: null,
    prUrl: null, agentId: null, lastActiveAt: null, placement: "local", organizationId: null };
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("Local graph cache", () => {
  it("retains only the exact owner, target, HEAD and metadata identity", async () => {
    const read = vi.fn(async () => ({ value: "floor", complete: true }));
    const query = (target = workspace) => readLocalGitGraph(target, "origin", observed, read);
    await query();
    await query();
    expect(read).toHaveBeenCalledTimes(1);
    await query({ ...workspace, organizationId: "organization-b" });
    await query();
    expect(read).toHaveBeenCalledTimes(2);
    await writeFile(path.join(root, ".git", "refs", "heads", "main"), "3".repeat(40));
    await query();
    expect(read).toHaveBeenCalledTimes(3);
    await readLocalGitGraph(workspace, "origin", { ...observed, head: "4".repeat(40) }, read);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("does not retain a partial or failed graph probe", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ value: "partial-floor", complete: false })
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue({ value: "complete-floor", complete: true });
    const query = () => readLocalGitGraph(workspace, "origin", observed, read);
    expect(await query()).toBe("partial-floor");
    await expect(query()).rejects.toThrow("unavailable");
    expect(await query()).toBe("complete-floor");
    expect(await query()).toBe("complete-floor");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(["release~1", "refs/worktree/release"])("uses native reads for a nonstandard comparison target: %s", async (baseBranch) => {
    const read = vi.fn(async () => ({ value: "floor", complete: true }));
    const target = { ...workspace, baseBranch };
    await readLocalGitGraph(target, "origin", observed, read);
    await readLocalGitGraph(target, "origin", observed, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps an old completion from replacing the graph after a ref moves", async () => {
    const started = deferred<void>();
    const held = deferred<{ value: string; complete: boolean }>();
    const old = readLocalGitGraph(workspace, "origin", observed, async () => { started.resolve(); return held.promise; });
    await started.promise;
    await writeFile(path.join(root, ".git", "refs", "heads", "main"), "5".repeat(40));
    const current = vi.fn(async () => ({ value: "fresh", complete: true }));
    expect(await readLocalGitGraph(workspace, "origin", observed, current)).toBe("fresh");
    held.resolve({ value: "old", complete: true });
    expect(await old).toBe("old");
    expect(await readLocalGitGraph(workspace, "origin", observed, current)).toBe("fresh");
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("bounds settled graph entries without allocating eviction timers", async () => {
    const read = vi.fn(async () => ({ value: "floor", complete: true }));
    for (let index = 0; index < 129; index += 1) {
      await readLocalGitGraph({ ...workspace, id: `workspace-${index}` }, "origin", observed, read);
    }
    await readLocalGitGraph({ ...workspace, id: "workspace-128" }, "origin", observed, read);
    expect(read).toHaveBeenCalledTimes(129);
    await readLocalGitGraph({ ...workspace, id: "workspace-0" }, "origin", observed, read);
    expect(read).toHaveBeenCalledTimes(130);
  });

  it("leaves cloud reads independent", async () => {
    const read = vi.fn(async () => ({ value: "floor", complete: true }));
    for (let index = 0; index < 2; index += 1) {
      await readLocalGitGraph({ ...workspace, placement: "cloud" }, "origin", observed, read);
    }
    expect(read).toHaveBeenCalledTimes(2);
  });
});
