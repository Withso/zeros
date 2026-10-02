import { describe, expect, it, vi } from "vitest";
import type { PrInlineReview } from "@zeros/protocol/github-review";
import {
  createGithubReviewCache,
  githubReviewKey,
  reconcileGithubReview,
} from "../github-review-cache";
import {
  githubLineCommentForAnchor,
  githubReviewItems,
  githubReviewNotice,
  githubReviewRevision,
} from "../github-review-model";

const target = { workspaceId: "workspace-a", prNumber: 7 };

function snapshot(head = "a".repeat(40)): PrInlineReview {
  return {
    headSha: head,
    baseSha: "b".repeat(40),
    threadsTruncated: false,
    annotationsTruncated: false,
    annotationError: null,
    threads: [
      {
        id: "thread-1",
        path: "src/auth.ts",
        side: "LEFT",
        startLine: 4,
        line: 6,
        originalStartLine: 4,
        originalLine: 6,
        isOutdated: false,
        isResolved: false,
        canResolve: true,
        canUnresolve: false,
        commentsTruncated: false,
        context: "const role = input.role;",
        comments: [
          {
            id: "comment-1",
            databaseId: 21,
            body: "Check role.",
            url: "https://github.com/org/repo/pull/7#discussion_r21",
            createdAt: 10,
            updatedAt: 20,
            commitSha: head,
            author: { login: "review-bot", kind: "bot", avatarUrl: null },
          },
        ],
      },
    ],
    annotations: [
      {
        id: "check-1",
        path: "src/auth.ts",
        startLine: 8,
        endLine: 9,
        level: "warning",
        title: "Validate input",
        message: "Check the role.",
        source: "Code scanning",
        url: null,
        commitSha: head,
      },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("GitHub review cache and presentation", () => {
  it("refuses retained drafts after base, head or destination changes and maps renamed old paths once", () => {
    const first = snapshot();
    const anchor = {
      ...githubReviewItems(first, target)[0].anchor,
      path: "old.ts",
    };
    const renamed = new Map([
      ["old.ts", "new.ts"],
      ["new.ts", "next.ts"],
    ]);
    expect(
      githubLineCommentForAnchor(target, first, anchor, "Review", renamed),
    ).toMatchObject({
      prNumber: 7,
      path: "new.ts",
      commitSha: first.headSha,
      baseSha: first.baseSha,
      side: "LEFT",
      startLine: 4,
      line: 6,
    });
    for (const changed of [
      { ...first, baseSha: "c".repeat(40) },
      { ...first, headSha: "d".repeat(40) },
    ]) {
      expect(() =>
        githubLineCommentForAnchor(target, changed, anchor, "Review", renamed),
      ).toThrow("diff changed");
    }
    expect(() =>
      githubLineCommentForAnchor(
        { ...target, prNumber: 8 },
        first,
        anchor,
        "Review",
      ),
    ).toThrow();
    expect(() =>
      githubLineCommentForAnchor(
        { ...target, workspaceId: "workspace-b" },
        first,
        anchor,
        "Review",
      ),
    ).toThrow();
  });
  it("gives same-head PRs and changed bases distinct immutable anchor revisions", () => {
    const first = snapshot();
    const anchor = githubReviewItems(first, target)[0].anchor;
    const changedBase = githubReviewItems(
      { ...first, baseSha: "c".repeat(40) },
      target,
    )[0].anchor;
    const changedPr = githubReviewItems(first, { ...target, prNumber: 8 })[0]
      .anchor;
    const changedWorkspace = githubReviewItems(first, {
      ...target,
      workspaceId: "workspace-b",
    })[0].anchor;
    expect(
      new Set([
        anchor.revision,
        changedBase.revision,
        changedPr.revision,
        changedWorkspace.revision,
      ]).size,
    ).toBe(4);
  });
  it("publishes a changed base even when its head and discussion rows are unchanged", () => {
    const first = snapshot();
    const next = reconcileGithubReview(first, {
      ...first,
      baseSha: "c".repeat(40),
    });
    expect(next).not.toBe(first);
    expect(next.baseSha).toBe("c".repeat(40));
  });
  it("shares equivalent rows and correctly normalizes bot attribution and read-only findings", () => {
    const first = snapshot();
    expect(reconcileGithubReview(first, structuredClone(first))).toBe(first);
    const items = githubReviewItems(first, target);
    expect(items[0]).toMatchObject({
      source: "github",
      anchor: {
        side: "old",
        startLine: 4,
        endLine: 6,
        revision: githubReviewRevision(target, first),
      },
      canReply: true,
      canResolve: true,
      comments: [{ author: { name: "review-bot", kind: "integration" } }],
    });
    expect(items[1]).toMatchObject({
      source: "check",
      severity: "warning",
      canReply: false,
      canResolve: false,
    });
    expect(githubReviewItems(first, target)[0]).toBe(items[0]);
    const changed = structuredClone(first);
    changed.threads[0].isResolved = true;
    const next = reconcileGithubReview(first, changed);
    expect(next.annotations).toBe(first.annotations);
    expect(next.threads[0]).not.toBe(first.threads[0]);
  });
  it("keeps head revisions separate from original comment revisions and exposes outdated threads", () => {
    const first = snapshot();
    first.threads[0].comments[0].commitSha = "b".repeat(40);
    expect(githubReviewItems(first, target)[0].anchor.revision).toBe(
      githubReviewRevision(target, first),
    );
    first.threads[0] = { ...first.threads[0], isOutdated: true, line: null };
    expect(githubReviewItems(first, target)[0]).toMatchObject({
      outdated: true,
      anchor: { endLine: 6 },
    });
  });
  it("does not hide partial reads or failed annotation permissions", () => {
    const first = snapshot();
    expect(githubReviewNotice(first)).toBeUndefined();
    first.threads[0].commentsTruncated = true;
    first.annotationError = "Some check annotations could not be loaded.";
    expect(githubReviewNotice(first)).toContain("partially shown");
    expect(githubReviewNotice(first)).toContain("could not be loaded");
  });
  it("isolates exact workspace/PR owners, shares requests, and retains data on failed refresh", async () => {
    const cache = createGithubReviewCache();
    const a = githubReviewKey("workspace-a", 7);
    const b = githubReviewKey("workspace-b", 7);
    const c = githubReviewKey("workspace-a", 8);
    expect(new Set([a, b, c]).size).toBe(3);
    const pending = deferred<PrInlineReview>();
    const load = vi.fn(() => pending.promise);
    const one = cache.load(a, load);
    const two = cache.load(a, load);
    const first = snapshot();
    pending.resolve(first);
    await Promise.all([one, two]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot(b).data).toBeUndefined();
    expect(cache.getSnapshot(c).data).toBeUndefined();
    await expect(
      cache.load(a, () => Promise.reject(new Error("Offline")), {
        force: true,
      }),
    ).rejects.toThrow("Offline");
    expect(cache.getSnapshot(a).data).toBe(first);
  });
  it("rejects pre-mutation responses and bounds inactive workspace retention", async () => {
    const cache = createGithubReviewCache(2);
    const a = githubReviewKey("workspace-a", 7);
    const pending = deferred<PrInlineReview>();
    const request = cache.load(a, () => pending.promise);
    const newer = snapshot("b".repeat(40));
    cache.setData(a, newer);
    pending.resolve(snapshot());
    await request;
    expect(cache.getSnapshot(a).data).toBe(newer);
    cache.setData(githubReviewKey("workspace-b", 7), snapshot());
    cache.setData(githubReviewKey("workspace-c", 7), snapshot());
    expect(cache.keys()).toHaveLength(2);
    expect(cache.keys()).not.toContain(a);
  });
});
