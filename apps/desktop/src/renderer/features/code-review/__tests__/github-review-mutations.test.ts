import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PrCommentResult,
  PrInlineReview,
} from "@zeros/protocol/github-review";
import {
  getPrInlineReview,
  postPrLineComment,
  replyPrReviewThread,
  setPrReviewThreadResolved,
} from "@/renderer/platform/github-review";
import { forgetPrCachesForWorkspace } from "@/renderer/shell/pr/pr-cache-forget";
import { githubReviewCache, githubReviewKey } from "../github-review-cache";
import * as reviewCacheForget from "../review-cache-forget";
import { useGithubReview } from "../use-github-review";

vi.mock("@/renderer/platform/github-review", () => ({
  getPrInlineReview: vi.fn(),
  postPrLineComment: vi.fn(),
  replyPrReviewThread: vi.fn(),
  setPrReviewThreadResolved: vi.fn(),
}));

const target = { workspaceId: "mutation-workspace", prNumber: 7 };
const cwd = "/repo/mutation-workspace";
const key = githubReviewKey(target.workspaceId, target.prNumber);
const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
const sent: PrCommentResult = {
  id: 22,
  url: "https://github.com/org/repo/pull/7#discussion_r22",
};
const mutations = ["post", "reply", "resolve"] as const;

function snapshot(body = "original"): PrInlineReview {
  return {
    headSha: sha,
    baseSha,
    threadsTruncated: false,
    annotationsTruncated: false,
    annotationError: null,
    annotations: [],
    threads: [
      {
        id: "thread-1",
        path: "src/auth.ts",
        side: "RIGHT",
        startLine: 4,
        line: 4,
        originalStartLine: 4,
        originalLine: 4,
        isOutdated: false,
        isResolved: false,
        canResolve: true,
        canUnresolve: false,
        commentsTruncated: false,
        comments: [
          {
            id: "comment-1",
            databaseId: 21,
            body,
            url: null,
            createdAt: 1,
            updatedAt: 1,
            commitSha: sha,
            author: { login: "reviewer", kind: "human", avatarUrl: null },
          },
        ],
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function captureSource(owner: { cwd?: string } = { cwd }) {
  let review!: ReturnType<typeof useGithubReview>;
  function CaptureReview() {
    review = useGithubReview({
      ...target,
      ...owner,
      active: true,
      refreshKey: 0,
      confirmedHeadSha: sha,
      confirmedBaseSha: baseSha,
    });
    return null;
  }
  // Real hook callbacks and cache snapshots, without browser polling effects.
  renderToString(createElement(CaptureReview));
  if (!review.source) throw new Error("Expected a GitHub review source");
  return review.source;
}

function mutate(kind: (typeof mutations)[number], source = captureSource()) {
  const thread = source.threads[0];
  if (kind === "post") {
    if (!source.postComment) throw new Error("Expected confirmed PR anchors");
    return source.postComment(thread.anchor, "Comment sent");
  }
  if (kind === "reply") return source.reply(thread, "Reply sent");
  return source.setResolved(thread, true);
}

function holdWrites() {
  const response = deferred<PrCommentResult>();
  vi.mocked(postPrLineComment).mockReturnValue(response.promise);
  vi.mocked(replyPrReviewThread).mockReturnValue(response.promise);
  vi.mocked(setPrReviewThreadResolved).mockReturnValue(
    response.promise.then(() => undefined),
  );
  return response;
}

function forgetOwner() {
  // Confirmed workspace deletion uses both registries in this order.
  forgetPrCachesForWorkspace(target.workspaceId);
  reviewCacheForget.forgetReviewCachesForFolders((folder) => folder === cwd);
}

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetAllMocks();
  githubReviewCache.clear();
  githubReviewCache.setData(key, snapshot());
  vi.mocked(getPrInlineReview).mockResolvedValue(snapshot("refreshed"));
  vi.mocked(postPrLineComment).mockResolvedValue(sent);
  vi.mocked(replyPrReviewThread).mockResolvedValue(sent);
  vi.mocked(setPrReviewThreadResolved).mockResolvedValue(undefined);
});
afterEach(forgetOwner);

describe("GitHub review mutation owner lifetime", () => {
  it.each([undefined, "", "   "])(
    "renders without a usable cwd (%j) but rejects mutations before capturing a lifetime",
    async (ownerCwd) => {
      const beginLifetime = vi.spyOn(reviewCacheForget, "beginReviewCacheRequest");
      try {
        const source = captureSource(
          ownerCwd === undefined ? {} : { cwd: ownerCwd },
        );
        expect(source.threads).toHaveLength(1);
        for (const kind of mutations) {
          await expect(mutate(kind, source)).rejects.toThrow("Open a workspace");
        }
        expect(beginLifetime).not.toHaveBeenCalled();
        expect(postPrLineComment).not.toHaveBeenCalled();
        expect(replyPrReviewThread).not.toHaveBeenCalled();
        expect(setPrReviewThreadResolved).not.toHaveBeenCalled();
        expect(getPrInlineReview).not.toHaveBeenCalled();
      } finally {
        beginLifetime.mockRestore();
      }
    },
  );

  it.each(mutations)(
    "does not resurrect a deleted owner after a successful %s with no consumers",
    async (kind) => {
      const response = holdWrites();
      const write = mutate(kind);
      forgetOwner();
      response.resolve(sent);
      await expect(write).resolves.toBeUndefined();
      expect(getPrInlineReview).not.toHaveBeenCalled();
      expect(githubReviewCache.keys()).not.toContain(key);
      expect(githubReviewCache.peekSnapshot(key).data).toBeUndefined();
    },
  );

  it.each(mutations)(
    "does not invalidate or join a reopened owner's pending read after a successful %s",
    async (kind) => {
      const response = holdWrites();
      let acknowledged = false;
      const write = mutate(kind).then(() => {
        acknowledged = true;
      });
      forgetOwner();
      const fresh = snapshot("new owner");
      const read = deferred<PrInlineReview>();
      vi.mocked(getPrInlineReview).mockReturnValueOnce(read.promise);
      const reopened = githubReviewCache.load(key, () =>
        getPrInlineReview(target),
      );
      const before = githubReviewCache.peekSnapshot(key);
      captureSource();
      try {
        response.resolve(sent);
        await settle();
        expect(acknowledged).toBe(true);
        expect(githubReviewCache.peekSnapshot(key)).toBe(before);
        const same = githubReviewCache.load(key, () =>
          getPrInlineReview(target),
        );
        expect(same).toBe(reopened);
        expect(getPrInlineReview).toHaveBeenCalledTimes(1);
      } finally {
        read.resolve(fresh);
        await Promise.all([write, reopened]);
      }
      expect(githubReviewCache.peekSnapshot(key).data).toBe(fresh);
      expect(getPrInlineReview).toHaveBeenCalledTimes(1);
    },
  );

  it.each(mutations)(
    "refreshes the current owner after a successful %s",
    async (kind) => {
      await expect(mutate(kind)).resolves.toBeUndefined();
      expect(getPrInlineReview).toHaveBeenCalledExactlyOnceWith(target);
      expect(
        githubReviewCache.peekSnapshot(key).data?.threads[0].comments[0].body,
      ).toBe("refreshed");
    },
  );

  it("keeps an acknowledged write successful when its follow-up read fails", async () => {
    vi.mocked(getPrInlineReview).mockRejectedValue(
      new Error("Read unavailable"),
    );
    await expect(mutate("post")).resolves.toBeUndefined();
    expect(githubReviewCache.peekSnapshot(key).error?.message).toBe(
      "Read unavailable",
    );
  });

  it("preserves remote mutation failures without refreshing", async () => {
    vi.mocked(postPrLineComment).mockRejectedValue(new Error("Write denied"));
    await expect(mutate("post")).rejects.toThrow("Write denied");
    expect(getPrInlineReview).not.toHaveBeenCalled();
  });
});
