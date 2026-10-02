import { describe, expect, it } from "vitest";
import type { CodeReviewThread } from "@zeros/protocol/code-review";
import {
  createCodeReviewCache,
  codeReviewCacheKey,
  publishCodeReviewThread,
  type CodeReviewCollection,
} from "../review-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function thread(id = "t", version = 1): CodeReviewThread {
  return {
    id,
    workspaceId: "w",
    anchor: {
      path: "a.ts",
      side: "file",
      startLine: 1,
      endLine: 1,
      revision: "a",
    },
    comments: [
      {
        id: `c-${version}`,
        author: { id: "u", name: "Author", kind: "human" },
        body: "Review",
        createdAt: 1,
      },
    ],
    resolved: false,
    version,
    createdAt: 1,
    updatedAt: version,
  };
}
function collection(
  threads: readonly CodeReviewThread[],
): CodeReviewCollection {
  return { workspaceId: "w", threads, partial: false };
}

describe("code review exact-key cache", () => {
  it("deduplicates concurrent reads and restores A → B → A immediately", async () => {
    const cache = createCodeReviewCache();
    const a = codeReviewCacheKey("/a", "worktree-a");
    const b = codeReviewCacheKey("/b", "worktree-b");
    const pending = deferred<CodeReviewCollection>();
    let calls = 0;
    const first = cache.load(a, () => {
      calls++;
      return pending.promise;
    });
    const same = cache.load(a, () => {
      calls++;
      return pending.promise;
    });
    expect(same).toBe(first);
    pending.resolve(collection([thread()]));
    await first;
    cache.setData(b, collection([thread("b")]));
    expect(cache.getSnapshot(a).data?.threads[0]?.id).toBe("t");
    expect(cache.getSnapshot(b).data?.threads[0]?.id).toBe("b");
    expect(calls).toBe(1);
  });

  it("retains confirmed threads and rejects a read superseded by a mutation", async () => {
    const cache = createCodeReviewCache();
    const key = codeReviewCacheKey("/a", "a");
    const initial = collection([thread()]);
    cache.setData(key, initial);
    const pending = deferred<CodeReviewCollection>();
    const read = cache.load(key, () => pending.promise, { force: true });
    expect(cache.getSnapshot(key).data).toBe(initial);
    publishCodeReviewThread(cache, key, thread("t", 3));
    pending.resolve(collection([thread("t", 2)]));
    await read;
    expect(cache.getSnapshot(key).data?.threads[0]?.version).toBe(3);
    publishCodeReviewThread(cache, key, thread("t", 2));
    expect(cache.getSnapshot(key).data?.threads[0]?.version).toBe(3);
  });

  it("structurally shares unchanged threads and arrays on a refresh", async () => {
    const cache = createCodeReviewCache();
    const key = codeReviewCacheKey("/a", "a");
    const initial = collection([thread(), thread("other")]);
    cache.setData(key, initial);
    await cache.load(key, async () => structuredClone(initial), {
      force: true,
    });
    expect(cache.getSnapshot(key).data).toBe(initial);
    await cache.load(
      key,
      async () => collection([thread("t", 2), thread("other")]),
      { force: true },
    );
    expect(cache.getSnapshot(key).data?.threads[1]).toBe(initial.threads[1]);
  });

  it("bounds inactive workspace entries", () => {
    const cache = createCodeReviewCache(2);
    for (const key of ["a", "b", "c"])
      cache.setData(key, collection([thread(key)]));
    expect(cache.keys()).toEqual(["b", "c"]);
  });
});
