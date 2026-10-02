import { describe, expect, it } from "vitest";
import type {
  CodeReviewListResult,
  CodeReviewThread,
} from "@zeros/protocol/code-review";
import {
  createCodeReviewCache,
  codeReviewCacheKey,
  publishCodeReviewPage,
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
  threads: CodeReviewThread[],
): CodeReviewListResult & { partial: boolean } {
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

  it.each([false, true])(
    "removes inaccessible thread membership after a complete refresh (empty=%s)",
    async (empty) => {
      const cache = createCodeReviewCache();
      const key = codeReviewCacheKey("/parent", "w");
      const visible = thread("visible");
      const revoked = {
        ...thread("nested"),
        anchor: { ...thread().anchor, path: "nested/old.ts" },
      };
      const initial = collection([revoked, visible]);
      cache.setData(key, initial);
      const pending = deferred<CodeReviewCollection>();
      const refresh = cache.load(key, () => pending.promise, { force: true });
      expect(cache.getSnapshot(key).data).toBe(initial);

      pending.resolve(collection(empty ? [] : [structuredClone(visible)]));
      await refresh;
      const current = cache.getSnapshot(key).data!;
      expect(current.threads.map((item) => item.id)).toEqual(
        empty ? [] : ["visible"],
      );
      if (!empty) expect(current.threads[0]).toBe(visible);
    },
  );

  it("retains loaded membership across partial reads and incremental replies and pages", async () => {
    const cache = createCodeReviewCache();
    const key = codeReviewCacheKey("/parent", "w");
    const first = thread("first");
    const later = thread("later");
    cache.setData(key, collection([first, later]));
    await cache.load(
      key,
      async () => ({
        ...collection([structuredClone(first)]),
        partial: true,
        nextCursor: "next-page",
      }),
      { force: true },
    );
    expect(cache.getSnapshot(key).data?.threads).toEqual([first, later]);

    publishCodeReviewThread(cache, key, thread("first", 2));
    expect(cache.getSnapshot(key).data?.threads[1]).toBe(later);
    publishCodeReviewPage(
      cache,
      key,
      collection([structuredClone(later), thread("last")]),
      { cursor: "next-page" },
    );
    expect(cache.getSnapshot(key).data?.threads.map((item) => item.id)).toEqual(
      ["first", "later", "last"],
    );
    expect(cache.getSnapshot(key).data?.partial).toBe(false);
    publishCodeReviewThread(cache, key, thread("first", 3));
    expect(cache.getSnapshot(key).data?.threads.map((item) => item.id)).toEqual(
      ["first", "later", "last"],
    );
  });

  it.each([false, true])(
    "removes unconfirmed membership when a refreshed listing reaches its final page (empty=%s)",
    async (empty) => {
      const cache = createCodeReviewCache();
      const key = codeReviewCacheKey("/parent", "w");
      const first = thread("first");
      const later = thread("later");
      cache.setData(key, collection([first, later, thread("revoked")]));
      await cache.load(
        key,
        async () => ({
          ...collection(empty ? [] : [structuredClone(first)]),
          partial: true,
          nextCursor: "after-first",
        }),
        { force: true },
      );
      expect(cache.getSnapshot(key).data?.threads).toHaveLength(3);
      publishCodeReviewPage(
        cache,
        key,
        collection(empty ? [] : [structuredClone(later)]),
        { cursor: "after-first" },
      );
      expect(
        cache.getSnapshot(key).data?.threads.map((item) => item.id),
      ).toEqual(empty ? [] : ["first", "later"]);
      if (!empty) expect(cache.getSnapshot(key).data?.threads[1]).toBe(later);
    },
  );

  it("keeps a newly acknowledged thread when an overlapping listing finishes", async () => {
    const cache = createCodeReviewCache();
    const key = codeReviewCacheKey("/parent", "w");
    const first = thread("first");
    cache.setData(key, collection([first, thread("revoked")]));
    await cache.load(
      key,
      async () => ({
        ...collection([structuredClone(first)]),
        partial: true,
        nextCursor: "after-first",
      }),
      { force: true },
    );
    publishCodeReviewThread(cache, key, thread("new"));
    publishCodeReviewPage(cache, key, collection([]), {
      cursor: "after-first",
    });
    expect(cache.getSnapshot(key).data?.threads.map((item) => item.id)).toEqual(
      ["first", "new"],
    );
  });

  it.each([undefined, "revoked"])(
    "does not reintroduce removed membership from a late continuation (threadId=%s)",
    async (threadId) => {
      const cache = createCodeReviewCache();
      const key = codeReviewCacheKey("/parent", "w");
      cache.setData(key, {
        ...collection([thread("revoked")]),
        partial: true,
        nextCursor: "old-page",
      });
      await cache.load(key, async () => collection([]), { force: true });
      publishCodeReviewPage(cache, key, collection([thread("revoked", 2)]), {
        cursor: "old-page",
        threadId,
      });
      expect(cache.getSnapshot(key).data?.threads).toEqual([]);
    },
  );

  it("bounds inactive workspace entries", () => {
    const cache = createCodeReviewCache(2);
    for (const key of ["a", "b", "c"])
      cache.setData(key, collection([thread(key)]));
    expect(cache.keys()).toEqual(["b", "c"]);
  });
});
