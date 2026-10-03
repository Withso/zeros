import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodeReviewListResult,
  CodeReviewThread,
} from "@zeros/protocol/code-review";
import type { HunkReviewDecision } from "@zeros/protocol/git-review-actions";
import { listCodeReviewThreads } from "@/renderer/platform/bridge/code-review-bridge";
import {
  codeReviewCache,
  codeReviewCacheKey,
  publishCodeReviewThread,
} from "../review-cache";
import {
  hunkReviewCache,
  hunkReviewCacheKey,
  publishHunkReview,
} from "../hunk-review-cache";
import {
  beginReviewCacheRequest,
  forgetReviewCachesForFolders,
} from "../review-cache-forget";
import { loadCodeReview, loadCodeReviewPage } from "../use-code-review";

vi.mock("@/renderer/platform/bridge/code-review-bridge", () => ({
  listCodeReviewThreads: vi.fn(),
  createCodeReviewThread: vi.fn(),
  replyCodeReviewThread: vi.fn(),
  setCodeReviewThreadResolved: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function thread(id: string): CodeReviewThread {
  return {
    id,
    workspaceId: "workspace",
    anchor: {
      path: "file.ts",
      side: "file",
      startLine: 1,
      endLine: 1,
      revision: "snapshot",
    },
    comments: [
      {
        id: `${id}-comment`,
        author: { id: "reviewer", name: "Reviewer", kind: "human" },
        body: id,
        createdAt: 1,
      },
    ],
    resolved: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function page(
  threads: CodeReviewThread[],
): CodeReviewListResult & { partial: boolean } {
  return { workspaceId: "workspace", threads, partial: false };
}

const folder = "/repo/worktree";
const key = codeReviewCacheKey(folder, "workspace");

beforeEach(() => {
  forgetReviewCachesForFolders(() => true);
  codeReviewCache.clear();
  hunkReviewCache.clear();
  vi.clearAllMocks();
});

describe("review cache owner removal", () => {
  it("fences a late workspace mutation even after the exact key is reopened", async () => {
    codeReviewCache.setData(key, page([thread("original")]));
    const request = beginReviewCacheRequest(folder);
    const response = deferred<CodeReviewThread>();
    const mutation = response.promise
      .then((result) =>
        publishCodeReviewThread(codeReviewCache, key, result, request),
      )
      .finally(() => request.finish());
    forgetReviewCachesForFolders((cwd) => cwd === folder);
    const reopened = page([thread("reopened")]);
    codeReviewCache.setData(key, reopened);
    response.resolve(thread("deleted-owner-reply"));
    await mutation;
    expect(codeReviewCache.peekSnapshot(key).data).toBe(reopened);
  });

  it("fences a late hunk decision while allowing a separately owned pending request", async () => {
    const hunkKey = hunkReviewCacheKey("engine", folder, "file.ts");
    const request = beginReviewCacheRequest(folder);
    const nested = beginReviewCacheRequest(`${folder}/nested`);
    const response = deferred<HunkReviewDecision>();
    const mutation = response.promise
      .then((result) =>
        publishHunkReview(hunkReviewCache, hunkKey, result, request),
      )
      .finally(() => request.finish());
    hunkReviewCache.setData(hunkKey, []);
    forgetReviewCachesForFolders((cwd) => cwd === folder);
    const reopened: HunkReviewDecision[] = [];
    hunkReviewCache.setData(hunkKey, reopened);
    response.resolve({
      key: "a".repeat(64),
      path: "file.ts",
      comparison: "worktree-vs-head",
      decision: "accepted",
      updatedAt: 1,
    });
    await mutation;
    expect(hunkReviewCache.peekSnapshot(hunkKey).data).toBe(reopened);
    expect(nested.isCurrent()).toBe(true);
    nested.finish();
  });

  it("rejects a deleted owner's late read before restoring aliases or snapshots", async () => {
    const response = deferred<CodeReviewListResult>();
    vi.mocked(listCodeReviewThreads).mockReturnValueOnce(response.promise);
    const read = loadCodeReview(key).catch((error: unknown) => error);
    await Promise.resolve();
    forgetReviewCachesForFolders((cwd) => cwd === folder);
    response.resolve(page([thread("old-owner")]));
    expect(await read).toMatchObject({
      message: expect.stringContaining("removed"),
    });
    expect(codeReviewCache.peekSnapshot(key).data).toBeUndefined();
  });

  it("purges pending continuation pages and cannot merge them into a reopened owner", async () => {
    codeReviewCache.setData(key, {
      ...page([thread("original")]),
      partial: true,
      nextCursor: "continuation",
    });
    const oldResponse = deferred<CodeReviewListResult>();
    const newResponse = deferred<CodeReviewListResult>();
    vi.mocked(listCodeReviewThreads)
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    const request = { cursor: "continuation" };
    const oldPage = loadCodeReviewPage(key, request).catch(
      (error: unknown) => error,
    );
    await Promise.resolve();
    forgetReviewCachesForFolders((cwd) => cwd === folder);
    codeReviewCache.setData(key, {
      ...page([thread("reopened")]),
      partial: true,
      nextCursor: "continuation",
    });
    const newPage = loadCodeReviewPage(key, request);
    await Promise.resolve();
    oldResponse.resolve(page([thread("deleted-page")]));
    newResponse.resolve(page([thread("new-page")]));
    await newPage;
    expect(await oldPage).toMatchObject({
      message: expect.stringContaining("removed"),
    });
    expect(listCodeReviewThreads).toHaveBeenCalledTimes(2);
    expect(
      codeReviewCache.peekSnapshot(key).data?.threads.map((item) => item.id),
    ).toEqual(["reopened", "new-page"]);
  });
});
