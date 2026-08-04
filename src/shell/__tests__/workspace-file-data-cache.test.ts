import { beforeEach, describe, expect, it, vi } from "vitest";

import { readWorkspaceFile } from "@/native/files";
import { gitDiff } from "@/native/git";
import { turnDiff } from "@/native/turns";
import {
  invalidateWorkspaceFileData,
  loadWorkspaceFileDiff,
  loadWorkspaceFileRead,
  peekWorkspaceFileDiff,
  peekWorkspaceFileRead,
  primeWorkspaceFileDiff,
  primeWorkspaceFileRead,
  prefetchWorkspaceFileDiff,
  resetWorkspaceFileDataCacheForTests,
} from "../workspace-file-data-cache";

vi.mock("@/native/files", () => ({ readWorkspaceFile: vi.fn() }));
vi.mock("@/native/git", () => ({ gitDiff: vi.fn() }));
vi.mock("@/native/turns", () => ({ turnDiff: vi.fn() }));

const readFile = vi.mocked(readWorkspaceFile);
const diffFile = vi.mocked(gitDiff);
const diffTurn = vi.mocked(turnDiff);

function textResult(path: string, content: string) {
  return { kind: "text" as const, path, bytes: content.length, content };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("workspace file data cache", () => {
  beforeEach(() => {
    resetWorkspaceFileDataCacheForTests();
    readFile.mockReset();
    diffFile.mockReset();
    diffTurn.mockReset();
  });

  it("deduplicates exact file reads and keeps other paths isolated", async () => {
    const pending = deferred<ReturnType<typeof textResult>>();
    readFile.mockReturnValueOnce(pending.promise);
    const query = { cwd: "/repo", path: "src/a.ts", contentRevision: 0 };

    const first = loadWorkspaceFileRead(query);
    const second = loadWorkspaceFileRead(query);
    await Promise.resolve();
    expect(readFile).toHaveBeenCalledTimes(1);

    const result = textResult("src/a.ts", "export {};");
    pending.resolve(result);
    await expect(Promise.all([first, second])).resolves.toEqual([
      result,
      result,
    ]);
    expect(peekWorkspaceFileRead(query)).toBe(result);
    expect(
      peekWorkspaceFileRead({ ...query, path: "src/b.ts" }),
    ).toBeUndefined();
  });

  it("retains confirmed content while a stale cwd revalidates", async () => {
    const query = { cwd: "/repo", path: "README.md", contentRevision: 0 };
    const cached = textResult("README.md", "old");
    primeWorkspaceFileRead(query, cached);
    invalidateWorkspaceFileData("/repo");

    const pending = deferred<ReturnType<typeof textResult>>();
    readFile.mockReturnValueOnce(pending.promise);
    const refresh = loadWorkspaceFileRead(query, { maxAgeMs: 60_000 });
    expect(peekWorkspaceFileRead(query)).toBe(cached);

    const fresh = textResult("README.md", "new");
    pending.resolve(fresh);
    await expect(refresh).resolves.toBe(fresh);
    expect(peekWorkspaceFileRead(query)).toBe(fresh);
  });

  it("never publishes a file read that an external invalidation superseded", async () => {
    const query = { cwd: "/repo", path: "new.md", contentRevision: 0 };
    const confirmed = textResult("new.md", "first version");
    primeWorkspaceFileRead(query, confirmed);

    const staleRead = deferred<ReturnType<typeof textResult>>();
    const freshRead = deferred<ReturnType<typeof textResult>>();
    readFile
      .mockReturnValueOnce(staleRead.promise)
      .mockReturnValueOnce(freshRead.promise);

    const first = loadWorkspaceFileRead(query, { force: true });
    await Promise.resolve();
    invalidateWorkspaceFileData("/repo");
    const replacement = loadWorkspaceFileRead(query);

    const superseded = textResult("new.md", "agent's first write");
    staleRead.resolve(superseded);
    await expect(first).resolves.toBe(superseded);
    expect(peekWorkspaceFileRead(query)).toBe(confirmed);

    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    const latest = textResult("new.md", "agent's latest write");
    freshRead.resolve(latest);
    await expect(replacement).resolves.toBe(latest);
    expect(peekWorkspaceFileRead(query)).toBe(latest);
  });

  it("serves aggregate and turn patches without repeating their source work", async () => {
    const ordinary = {
      workspaceId: "workspace-1",
      path: "src/a.ts",
      diffScope: "uncommitted" as const,
    };
    primeWorkspaceFileDiff(ordinary, "primed patch");
    await expect(
      loadWorkspaceFileDiff(ordinary, { maxAgeMs: 60_000 }),
    ).resolves.toBe("primed patch");
    expect(diffFile).not.toHaveBeenCalled();

    diffTurn.mockResolvedValueOnce("turn patch");
    const turn = {
      workspaceId: "workspace-1",
      path: "src/b.ts",
      diffScope: "turn" as const,
      turnChatId: "chat-1",
      turnId: "turn-1",
    };
    await expect(loadWorkspaceFileDiff(turn)).resolves.toBe("turn patch");
    expect(diffTurn).toHaveBeenCalledWith({
      chatId: "chat-1",
      turnId: "turn-1",
      path: "src/b.ts",
    });
    expect(peekWorkspaceFileDiff(turn)).toBe("turn patch");
  });

  it("deduplicates hover/viewer reads while isolating the same path across turns", async () => {
    const firstPending = deferred<string>();
    diffTurn
      .mockReturnValueOnce(firstPending.promise)
      .mockResolvedValueOnce("second turn patch");
    const first = {
      workspaceId: "workspace-1",
      path: "src/shared.ts",
      diffScope: "turn" as const,
      turnChatId: "chat-1",
      turnId: "turn-1",
    };
    const second = { ...first, turnId: "turn-2" };

    prefetchWorkspaceFileDiff(first);
    const viewerRead = loadWorkspaceFileDiff(first);
    await Promise.resolve();
    expect(diffTurn).toHaveBeenCalledTimes(1);

    await expect(loadWorkspaceFileDiff(second)).resolves.toBe(
      "second turn patch",
    );
    firstPending.resolve("first turn patch");
    await expect(viewerRead).resolves.toBe("first turn patch");

    expect(peekWorkspaceFileDiff(first)).toBe("first turn patch");
    expect(peekWorkspaceFileDiff(second)).toBe("second turn patch");
    expect(diffTurn).toHaveBeenNthCalledWith(1, {
      chatId: "chat-1",
      turnId: "turn-1",
      path: "src/shared.ts",
    });
    expect(diffTurn).toHaveBeenNthCalledWith(2, {
      chatId: "chat-1",
      turnId: "turn-2",
      path: "src/shared.ts",
    });
  });

  it("invalidates only one workspace's diff snapshots for an exact event", async () => {
    const queryA = {
      workspaceId: "workspace-a",
      path: "src/a.ts",
      diffScope: "uncommitted" as const,
    };
    const queryB = {
      workspaceId: "workspace-b",
      path: "src/b.ts",
      diffScope: "uncommitted" as const,
    };
    primeWorkspaceFileDiff(queryA, "old a");
    primeWorkspaceFileDiff(queryB, "stable b");

    invalidateWorkspaceFileData("/repo/a", "workspace-a");
    diffFile.mockResolvedValueOnce({ patch: "fresh a" } as never);

    await expect(
      loadWorkspaceFileDiff(queryB, { maxAgeMs: 60_000 }),
    ).resolves.toBe("stable b");
    await expect(
      loadWorkspaceFileDiff(queryA, { maxAgeMs: 60_000 }),
    ).resolves.toBe("fresh a");
    expect(diffFile).toHaveBeenCalledOnce();
  });

  it("retains a confirmed diff when revalidation loses the transport", async () => {
    const query = {
      workspaceId: "workspace-a",
      path: "src/a.ts",
      diffScope: "all" as const,
    };
    primeWorkspaceFileDiff(query, "confirmed patch");
    invalidateWorkspaceFileData("/repo/a", "workspace-a");
    diffFile.mockRejectedValueOnce(new Error("engine disconnected"));

    await expect(loadWorkspaceFileDiff(query)).rejects.toThrow(
      "engine disconnected",
    );
    expect(peekWorkspaceFileDiff(query)).toBe("confirmed patch");
  });

  it("maps staged and unstaged viewer keys to the two sides of the index", async () => {
    diffFile
      .mockResolvedValueOnce({ patch: "staged patch" } as never)
      .mockResolvedValueOnce({ patch: "unstaged patch" } as never);

    await expect(
      loadWorkspaceFileDiff({
        workspaceId: "workspace-scopes",
        path: "test.md",
        diffScope: "staged",
      }),
    ).resolves.toBe("staged patch");
    await expect(
      loadWorkspaceFileDiff({
        workspaceId: "workspace-scopes",
        path: "test.md",
        diffScope: "unstaged",
      }),
    ).resolves.toBe("unstaged patch");

    expect(diffFile).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-scopes",
      filePath: "test.md",
      mode: "index-vs-head",
      rawPatch: true,
    });
    expect(diffFile).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-scopes",
      filePath: "test.md",
      mode: "worktree-vs-index",
      rawPatch: true,
    });
  });
});
