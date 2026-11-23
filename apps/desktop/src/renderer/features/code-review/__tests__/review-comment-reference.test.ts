import { describe, expect, it, vi } from "vitest";
import {
  parseReviewCommentReference,
  reviewCommentDocument,
  reviewCommentFileName,
  reviewCommentLocation,
  reviewCommentSourceKey,
  reviewCommentTitle,
  sortReviewComments,
  threadCommentItems,
  timelineCommentItems,
} from "../review-comment-reference";
import {
  consumeReviewCommentReveal,
  currentReviewCommentReveal,
  requestReviewCommentReveal,
} from "../review-comment-reveal";
import type { CodeReviewThreadItem } from "../review-thread-model";

const coderabbit = [
  "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
  "<!-- walkthrough_start -->",
  "",
  "<details>",
  "<summary>📝 Walkthrough</summary>",
  "",
  "## Walkthrough",
  "No actionable comments were generated in the recent review. 🎉",
  "</details>",
].join("\n");

function thread(over: Partial<CodeReviewThreadItem> = {}): CodeReviewThreadItem {
  return {
    id: "T1",
    source: "github",
    anchor: { path: "src/auth/login.ts", side: "new", startLine: 14, endLine: 18, revision: "r" },
    comments: [
      {
        id: "c1",
        author: { id: "github:devin-ai-integration", name: "devin-ai-integration", kind: "integration", avatarUrl: "https://avatars.example/devin" },
        body: "🔍 **Unbounded smoke wait** for reveal setting\n\nDetails",
        createdAt: 200,
      },
      {
        id: "c2",
        author: { id: "github:priya", name: "priya", kind: "human" },
        body: "Agreed",
        createdAt: 300,
      },
    ],
    resolved: false,
    version: 1,
    url: "https://github.com/o/r/pull/42#discussion_r1",
    ...over,
  };
}

describe("review comment references", () => {
  it("titles a review app's comment by its first readable line", () => {
    expect(reviewCommentTitle(coderabbit)).toBe("📝 Walkthrough");
    expect(reviewCommentTitle("## Fix the `redirect`\n\nmore")).toBe("Fix the `redirect`");
    expect(reviewCommentTitle("[![badge](x.svg)](https://x) **Bold**")).toBe("badge Bold");
    expect(reviewCommentTitle("<!-- only a marker -->")).toBe("");
    expect(reviewCommentTitle("a".repeat(400))).toHaveLength(160);
    expect(reviewCommentTitle("if a < b and c > d")).toBe("if a < b and c > d");
    expect(reviewCommentTitle('<img alt="Screenshot of the bug" src="x.png">')).toBe("Screenshot of the bug");
    expect(reviewCommentTitle("<script>alert(1)</script>Fix")).toBe("alert(1)Fix");
    expect(reviewCommentTitle("See [the docs](https://x) and ![shot](a.png)")).toBe("See the docs and shot");
    expect(reviewCommentTitle("[ ] unchecked [x] done")).toBe("[ ] unchecked [x] done");
    const started = performance.now();
    reviewCommentTitle(`${"[".repeat(1_999)}`);
    reviewCommentTitle(`${"[a](".repeat(500)}`);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("reads malformed markup in linear time", () => {
    const hostile = ["<!--".repeat(50_000), "<".repeat(100_000), "<img alt=\"".repeat(20_000), "[".repeat(100_000) + "](".repeat(50_000), "![".repeat(100_000), "-->".repeat(50_000) + "<!--"];
    const started = performance.now();
    for (const body of hostile)
      timelineCommentItems([{ kind: "comment", id: 1, author: "x", authorAvatarUrl: null, state: "", body, url: null, createdAt: 1 }], 1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("titles a screenshot-only comment instead of dropping it", () => {
    const [item] = timelineCommentItems(
      [{ kind: "comment", id: 7, author: "priya", authorAvatarUrl: null, state: "", body: '<img width="400" src="https://user-images.example/1.png">', url: null, createdAt: 1 }],
      42,
    );
    expect(item!.reference.title).toBe("Image");
    expect(timelineCommentItems([{ kind: "comment", id: 8, author: "bot", authorAvatarUrl: null, state: "", body: "<!-- marker only -->", url: null, createdAt: 1 }], 42)).toEqual([]);
    // A marker longer than the title's scan still leaves its summary listed.
    const [late] = timelineCommentItems(
      [{ kind: "comment", id: 9, author: "bot", authorAvatarUrl: null, state: "", body: `<!-- ${"m".repeat(9_000)} -->\n\nSummary after the marker`, url: null, createdAt: 1 }],
      42,
    );
    expect(late!.reference.title).toBe("Comment");
    expect(reviewCommentDocument(late!)).toContain("Summary after the marker");
  });

  it("sends the whole comment to chat while the saved pill keeps a bounded copy", () => {
    const long = `Summary\n\n${"x".repeat(25_000)}\n\nRequired: rename foo`;
    const [item] = threadCommentItems([thread({ comments: [{ ...thread().comments[0]!, body: long }] })], 42);
    expect(item!.reference.body.length).toBeLessThan(20_100);
    expect(reviewCommentDocument(item!)).toContain("Required: rename foo");
  });

  it("lists conversation comments and review bodies, never empty or optimistic ones", () => {
    const items = timelineCommentItems(
      [
        { kind: "comment", id: 1, author: "coderabbitai[bot]", authorAvatarUrl: null, state: "", body: coderabbit, url: "https://github.com/o/r/pull/42#issuecomment-1", createdAt: 10 },
        { kind: "review", id: 2, author: "priya", authorAvatarUrl: null, state: "COMMENTED", body: "", url: null, createdAt: 11 },
        { kind: "comment", id: 3, author: "me", authorAvatarUrl: null, state: "", body: "pending", url: null, createdAt: 12, optimistic: true },
      ],
      42,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.reference).toMatchObject({
      key: "comment:1",
      author: { name: "coderabbitai", bot: true },
      title: "📝 Walkthrough",
    });
    expect(reviewCommentLocation(items[0]!.reference)).toBeNull();
  });

  it("lists line comments with their location, replies and resolution", () => {
    const [item] = threadCommentItems([thread()], 42);
    expect(item!.reference).toMatchObject({
      key: "github:T1",
      path: "src/auth/login.ts",
      side: "new",
      startLine: 14,
      line: 18,
      resolved: false,
      author: { name: "devin-ai-integration", bot: true, avatarUrl: "https://avatars.example/devin" },
      title: "🔍 Unbounded smoke wait for reveal setting",
    });
    expect(reviewCommentLocation(item!.reference)).toBe("login.ts:14–18");
    expect(reviewCommentLocation(item!.reference, true)).toBe("src/auth/login.ts:14–18");
    const doc = reviewCommentDocument(item!);
    expect(doc).toContain("# PR #42 comment by devin-ai-integration (bot)");
    expect(doc).toContain("File: `src/auth/login.ts:14–18`");
    expect(doc).toContain("Status: unresolved");
    expect(doc).toContain("## Replies");
    expect(doc).toContain("**priya**:\n> Agreed");
    expect(reviewCommentFileName(item!.reference)).toBe("pr42-login.ts-L18.md");
    // A person's private workspace note is not a bot, whatever its kind says.
    expect(threadCommentItems([thread({ source: "workspace" })], 42)[0]!.reference.author.bot).toBe(false);
  });

  it("puts unresolved comments first, each group oldest first", () => {
    const items = sortReviewComments([
      ...threadCommentItems([thread({ id: "done", resolved: true })], 1),
      ...threadCommentItems([thread({ id: "late", comments: [{ ...thread().comments[0]!, createdAt: 900 }] })], 1),
      ...threadCommentItems([thread({ id: "early", comments: [{ ...thread().comments[0]!, createdAt: 5 }] })], 1),
    ]);
    expect(items.map((item) => item.reference.key)).toEqual(["github:early", "github:late", "github:done"]);
  });

  it("keeps one pill per comment and owner, and validates restored references", () => {
    const [item] = threadCommentItems([thread()], 42);
    expect(reviewCommentSourceKey("ws-a", item!.reference)).not.toBe(
      reviewCommentSourceKey("ws-b", item!.reference),
    );
    expect(parseReviewCommentReference(item!.reference)).toBe(item!.reference);
    expect(parseReviewCommentReference({ ...item!.reference, path: "../etc/passwd" })).toBeNull();
    expect(parseReviewCommentReference({ ...item!.reference, url: "javascript:alert(1)" })).toBeNull();
    expect(parseReviewCommentReference({ ...item!.reference, line: 0 })).toBeNull();
    expect(parseReviewCommentReference({ kind: "transcript" })).toBeNull();
    expect(parseReviewCommentReference(null)).toBeNull();
  });
});

describe("revealing a comment in Changes", () => {
  it("hands one request to the diff and forgets it once consumed or stale", () => {
    requestReviewCommentReveal({ owner: "ws-a", path: "a.ts", side: "old", line: 4 }, 1_000);
    const first = currentReviewCommentReveal(1_500);
    expect(first).toMatchObject({ path: "a.ts", side: "old", line: 4 });
    expect(currentReviewCommentReveal(1_000 + 16_000)).toBeNull();
    consumeReviewCommentReveal(first!.id);
    expect(currentReviewCommentReveal(1_500)).toBeNull();
    requestReviewCommentReveal({ owner: "ws-a", path: "b.ts", side: "new", line: 1 }, 2_000);
    // An older id never consumes a newer request.
    consumeReviewCommentReveal(first!.id);
    expect(currentReviewCommentReveal(2_100)?.path).toBe("b.ts");
  });
});

describe("hidden comments", () => {
  it("are remembered per owner and PR, and forgotten with a deleted owner", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        get length() { return storage.size; },
        key: (index: number) => [...storage.keys()][index] ?? null,
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    });
    try {
      const { setReviewCommentHidden, forgetHiddenReviewComments } = await import("../review-comment-hidden");
      setReviewCommentHidden("ws-a", 1, "github:T1", true);
      setReviewCommentHidden("ws-b", 1, "github:T1", true);
      expect([...storage.keys()]).toHaveLength(2);
      setReviewCommentHidden("ws-a", 1, "github:T1", false);
      expect([...storage.keys()]).toHaveLength(1);
      setReviewCommentHidden("ws-a", 2, "comment:5", true);
      forgetHiddenReviewComments("ws-a");
      expect([...storage.keys()].map((key) => JSON.parse(key.slice(key.indexOf("[")))[0])).toEqual(["ws-b"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
