import { describe, expect, it } from "vitest";
import type { HunkReviewDecision } from "@zeros/protocol/git-review-actions";
import {
  createHunkReviewCache,
  hunkReviewCacheKey,
  hunkReviewTargetFromKey,
  publishHunkReview,
} from "../hunk-review-cache";

const decision = (key = "a", updatedAt = 1): HunkReviewDecision => ({
  key: key.repeat(64),
  path: "file.txt",
  comparison: "worktree-vs-head",
  decision: "accepted",
  updatedAt,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("exact hunk review decision cache", () => {
  it("shares a file request across hunks and restores A → B → A synchronously", async () => {
    const cache = createHunkReviewCache();
    const a = hunkReviewCacheKey("engine", "/a", "file.txt");
    const b = hunkReviewCacheKey("engine", "/b", "file.txt");
    const pending = deferred<readonly HunkReviewDecision[]>();
    let calls = 0;
    const first = cache.load(a, () => {
      calls++;
      return pending.promise;
    });
    expect(
      cache.load(a, () => {
        calls++;
        return pending.promise;
      }),
    ).toBe(first);
    pending.resolve([decision()]);
    await first;
    const confirmed = cache.getSnapshot(a).data;
    cache.setData(b, [decision("b")]);
    expect(cache.getSnapshot(a).data).toBe(confirmed);
    expect(cache.getSnapshot(b).data?.[0].key).toBe("b".repeat(64));
    expect(calls).toBe(1);
  });
  it("never installs an old list over a confirmed Accept", async () => {
    const cache = createHunkReviewCache();
    const key = hunkReviewCacheKey("engine", "/a", "file.txt");
    cache.setData(key, []);
    const pending = deferred<readonly HunkReviewDecision[]>();
    const loading = cache.load(key, () => pending.promise, { force: true });
    publishHunkReview(cache, key, decision());
    pending.resolve([]);
    await loading;
    expect(cache.getSnapshot(key).data).toEqual([decision()]);
  });
  it("retains exact confirmed data on revalidation failure and shares unchanged references", async () => {
    const cache = createHunkReviewCache();
    const key = hunkReviewCacheKey("engine", "/a", "file.txt");
    const records = [decision(), decision("b")];
    cache.setData(key, records);
    await expect(
      cache.load(
        key,
        async () => {
          throw new Error("offline");
        },
        { force: true },
      ),
    ).rejects.toThrow("offline");
    expect(cache.getSnapshot(key).data).toBe(records);
    await cache.load(key, async () => structuredClone(records), {
      force: true,
    });
    expect(cache.getSnapshot(key).data).toBe(records);
    await cache.load(key, async () => [decision("a", 2), decision("b")], {
      force: true,
    });
    expect(cache.getSnapshot(key).data?.[1]).toBe(records[1]);
  });
  it("isolates owners, clients, and filenames and bounds inactive entries", () => {
    const cache = createHunkReviewCache(2);
    const keys = [
      hunkReviewCacheKey("engine", "/a", "file.txt"),
      hunkReviewCacheKey("engine", "/a", "other.txt"),
      hunkReviewCacheKey("preview", "/a", "file.txt"),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(hunkReviewTargetFromKey(keys[1])).toEqual({
      identity: "engine",
      cwd: "/a",
      path: "other.txt",
    });
    keys.forEach((key, i) => cache.setData(key, [decision(String(i))]));
    expect(cache.keys()).toEqual(keys.slice(1));
  });
  it("rejects late lists after owner deletion or invalidation", async () => {
    const cache = createHunkReviewCache();
    const key = hunkReviewCacheKey("engine", "/a", "file.txt");
    const old = deferred<readonly HunkReviewDecision[]>();
    const load = cache.load(key, () => old.promise);
    cache.forget(key);
    old.resolve([decision()]);
    await load;
    expect(cache.getSnapshot(key).data).toBeUndefined();
  });
});
