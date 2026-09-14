import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkspaceMentionPaths } from "../../../platform/git";
import {
  MentionFileSearch,
  mentionFilesCache,
  invalidateMentionFiles,
  clearMentionFilesCache,
} from "../mention-files-cache";

vi.mock("../../../platform/git", () => ({
  listWorkspaceMentionPaths: vi.fn(),
}));
const list = vi.mocked(listWorkspaceMentionPaths);
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  clearMentionFilesCache();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("mention file search", () => {
  it("filters confirmed workspace paths synchronously for a new query", async () => {
    list.mockResolvedValueOnce([".context/rollout.jsonl", "src/readme.md"]);
    const search = new MentionFileSearch(() => {});
    search.search("/instant", "");
    await tick();
    const pending = deferred<string[]>();
    list.mockReturnValue(pending.promise);
    search.search("/instant", "roll");
    expect(search.snapshot("/instant", "roll").data).toEqual([
      { path: ".context/rollout.jsonl", kind: "file" },
    ]);
    expect(search.snapshot("/other", "roll").data).toBeUndefined();
    search.clear();
    pending.resolve([]);
    await tick();
  });

  it("keeps one filesystem revision while typing and advances it on file changes", async () => {
    list.mockResolvedValue([".context/rollout.jsonl"]);
    const search = new MentionFileSearch(() => {});
    search.search("/a", "r");
    await tick();
    search.search("/a", "roll");
    await tick();
    expect(list.mock.calls[0][2]).toEqual(expect.any(String));
    expect(list.mock.calls[1][2]).toBe(list.mock.calls[0][2]);
    invalidateMentionFiles("/a");
    await tick();
    expect(list.mock.calls[2][2]).not.toBe(list.mock.calls[0][2]);
    search.clear();
  });

  it("replaces speculative matches with an authoritative empty result", async () => {
    list.mockResolvedValueOnce(["deleted.txt"]).mockResolvedValueOnce([]);
    const search = new MentionFileSearch(() => {});
    search.search("/a", "");
    await tick();
    search.search("/a", "deleted");
    expect(search.snapshot("/a", "deleted").data?.[0].path).toBe("deleted.txt");
    await tick();
    expect(search.snapshot("/a", "deleted").data).toEqual([]);
    expect(search.snapshot("/a", "dele").data).toBeUndefined();
    search.clear();
  });

  it("starts a new workspace immediately and an old completion cannot release its queue", async () => {
    const a = deferred<string[]>();
    const b = deferred<string[]>();
    list
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
      .mockResolvedValue([]);
    const search = new MentionFileSearch(() => {});
    search.search("/a", "a");
    await tick();
    search.search("/b", "b");
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    search.search("/b", "bb");
    a.resolve(["a.txt"]);
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    expect(search.snapshot("/b", "bb").data).toBeUndefined();
    b.resolve(["b.txt"]);
    await tick();
    expect(list.mock.calls.map(([cwd, query]) => [cwd, query])).toEqual([
      ["/a", "a"],
      ["/b", "b"],
      ["/b", "bb"],
    ]);
    search.clear();
  });

  it("opening an already-running query does not queue a duplicate retry on failure", async () => {
    const pending = deferred<string[]>();
    list.mockReturnValue(pending.promise);
    const search = new MentionFileSearch(() => {});
    search.search("/a", "rollout");
    search.refresh("/a", "rollout");
    await tick();
    pending.reject(new Error("offline"));
    await tick();
    expect(list).toHaveBeenCalledTimes(1);
    expect(search.snapshot("/a", "rollout").error?.message).toBe("offline");
    search.clear();
  });

  it("deduplicates composers, retains exact-key data and restores A → B → A synchronously", async () => {
    list.mockResolvedValue([".context/rollout.jsonl"]);
    const a = new MentionFileSearch(() => {});
    const b = new MentionFileSearch(() => {});
    a.search("/a", "rollout");
    b.search("/a/", "ROLLOUT");
    await tick();
    expect(list).toHaveBeenCalledTimes(1);
    const data = a.snapshot("/a", "rollout").data;
    expect(data).toContainEqual({
      path: ".context/rollout.jsonl",
      kind: "file",
    });
    a.search("/b", "rollout");
    expect(a.snapshot("/b", "rollout").data).toBeUndefined();
    a.search("/a", "rollout");
    expect(a.snapshot("/a", "rollout").data).toBe(data);
    a.clear();
    b.clear();
    await tick();
  });

  it("runs only the newest waiting query and never publishes an old response under it", async () => {
    const first = deferred<string[]>();
    const last = deferred<string[]>();
    list.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const search = new MentionFileSearch(() => {});
    search.search("/a", "r");
    await tick();
    search.search("/a", "ro");
    search.search("/b", "rollout");
    first.resolve(["old.ts"]);
    await tick();
    expect(list.mock.calls.map(([cwd, query]) => [cwd, query])).toEqual([
      ["/a", "r"],
      ["/b", "rollout"],
    ]);
    expect(search.snapshot("/b", "rollout").data).toBeUndefined();
    last.resolve([".context/rollout.jsonl"]);
    await tick();
    expect(search.snapshot("/b", "rollout").data?.[0].path).toBe(
      ".context/rollout.jsonl",
    );
    search.clear();
  });

  it("keeps confirmed rows during a failed refresh, preserves equal references and retries", async () => {
    vi.useFakeTimers();
    list.mockResolvedValue([".hidden/file.txt"]);
    const search = new MentionFileSearch(() => {});
    search.search("/a", "file");
    await tick();
    const previous = search.snapshot("/a", "file").data;
    vi.advanceTimersByTime(2001);
    const refresh = deferred<string[]>();
    list.mockReturnValueOnce(refresh.promise);
    search.refresh("/a", "file");
    await tick();
    expect(search.snapshot("/a", "file").data).toBe(previous);
    refresh.reject(new Error("offline"));
    await tick();
    expect(search.snapshot("/a", "file").data).toBe(previous);
    expect(search.snapshot("/a", "file").error?.message).toBe("offline");
    search.refresh("/a", "file");
    await tick();
    expect(search.snapshot("/a", "file").data).toBe(previous);
    expect(search.snapshot("/a", "file").error).toBeNull();
    search.clear();
  });

  it("closing a composer drops queued work and prevents late notifications", async () => {
    const pending = deferred<string[]>();
    list.mockReturnValue(pending.promise);
    const notify = vi.fn();
    const search = new MentionFileSearch(notify);
    search.search("/a", "r");
    await tick();
    search.search("/a", "rollout");
    search.clear();
    notify.mockClear();
    pending.resolve(["old.ts"]);
    await tick();
    expect(notify).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("a file change during a read rejects the stale generation and refreshes only that cwd", async () => {
    const stale = deferred<string[]>();
    const fresh = deferred<string[]>();
    list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const search = new MentionFileSearch(() => {});
    search.search("/a", "rollout");
    await tick();
    invalidateMentionFiles("/b");
    invalidateMentionFiles("/a/");
    stale.resolve(["deleted-rollout.jsonl"]);
    await tick();
    expect(search.snapshot("/a", "rollout").data).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(2);
    fresh.resolve([".context/rollout.jsonl"]);
    await tick();
    expect(search.snapshot("/a", "rollout").data?.[0].path).toBe(
      ".context/rollout.jsonl",
    );
    search.clear();
  });

  it("bounds inactive query snapshots", async () => {
    list.mockResolvedValue([]);
    const search = new MentionFileSearch(() => {});
    for (let i = 0; i < 80; i++) {
      search.search("/a", String(i));
      await tick();
    }
    search.clear();
    expect(mentionFilesCache.keys().length).toBeLessThanOrEqual(64);
  });
});
