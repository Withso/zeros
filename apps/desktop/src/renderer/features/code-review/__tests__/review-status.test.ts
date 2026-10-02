import { describe, expect, it, vi } from "vitest";
import type { StatusResult } from "@/renderer/platform/git";
import { WorkspaceReviewStatusStore } from "../use-workspace-review-status";

const clean: StatusResult = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  conflictState: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("viewer aggregate conflict status", () => {
  it("shares a generation read across viewers and restores another exact owner immediately", async () => {
    const store = new WorkspaceReviewStatusStore();
    const pending = deferred<StatusResult>();
    const read = vi.fn(() => pending.promise);
    const first = store.load("cwd-a:workspace-a", "workspace-a", 1, read);
    const same = store.load("cwd-a:workspace-a", "workspace-a", 1, read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    await store.load("cwd-b:workspace-b", "workspace-b", 1, async () => clean);
    const b = store.cache.getSnapshot("cwd-b:workspace-b").data;
    pending.resolve(clean);
    expect(await first).toBe(clean);
    expect(await same).toBe(clean);
    expect(store.cache.getSnapshot("cwd-b:workspace-b").data).toBe(b);
  });

  it("fences a late generation and retains confirmed metadata while refreshing", async () => {
    const store = new WorkspaceReviewStatusStore();
    await store.load("a", "workspace-a", 0, async () => clean);
    const pending = deferred<StatusResult>();
    const newer = { ...clean, ahead: 2 };
    const read = vi.fn((_workspaceId: string, generation: number) =>
      generation === 1 ? pending.promise : Promise.resolve(newer),
    );
    const old = store.load("a", "workspace-a", 1, read);
    await Promise.resolve();
    const latest = store.load("a", "workspace-a", 2, read);
    expect(store.cache.getSnapshot("a").data).toBe(clean);
    pending.resolve({ ...clean, ahead: 1 });
    await old;
    await latest;
    expect(read.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(store.cache.getSnapshot("a").data).toBe(newer);
    await store.load("a", "workspace-a", 1, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
