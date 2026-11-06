// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrInlineReview } from "@zeros/protocol/github-review";
import { githubReviewItems, githubReviewThreadItem } from "../github-review-model";
import { InlineReviewThread } from "../inline-review-thread";
import { ReviewDraftStore } from "../review-draft-store";
import type {
  CodeReviewOperations,
  CodeReviewThreadItem,
} from "../review-thread-model";

const anchor = {
  path: "src/auth.ts",
  side: "new" as const,
  startLine: 4,
  endLine: 6,
  revision: "rev-1",
};
const operations = {
  create: vi.fn(),
  reply: vi.fn(),
  setResolved: vi.fn(),
} as unknown as CodeReviewOperations;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(thread: CodeReviewThreadItem) {
  await act(async () =>
    root.render(
      createElement(InlineReviewThread, {
        thread,
        operations,
        drafts: new ReviewDraftStore(),
        active: true,
      }),
    ),
  );
  return host.querySelector("[data-review-thread]") as HTMLElement;
}

function thread(
  source: CodeReviewThreadItem["source"],
  author: CodeReviewThreadItem["comments"][number]["author"],
  extra: Partial<CodeReviewThreadItem> = {},
): CodeReviewThreadItem {
  return {
    id: `${source}-thread`,
    source,
    anchor,
    comments: [{ id: "c1", author, body: "Check the role.", createdAt: 10 }],
    resolved: false,
    version: 1,
    canReply: source !== "check",
    ...extra,
  };
}

describe("comment authors", () => {
  it("keeps a GitHub author's sanitised avatar on the thread comment", () => {
    const comment = {
      id: "comment-1",
      databaseId: 21,
      body: "Check role.",
      url: "https://github.com/org/repo/pull/7#discussion_r21",
      createdAt: 10,
      updatedAt: 20,
      commitSha: "b".repeat(40),
    };
    const review = {
      threads: [
        {
          id: "thread-1",
          path: "src/auth.ts",
          side: "RIGHT",
          startLine: 4,
          line: 6,
          originalStartLine: 4,
          originalLine: 6,
          isOutdated: false,
          isResolved: false,
          canResolve: true,
          canUnresolve: false,
          commentsTruncated: false,
          comments: [
            {
              ...comment,
              author: {
                login: "priya",
                kind: "human",
                avatarUrl: "https://avatars.githubusercontent.com/u/1",
              },
            },
            {
              ...comment,
              id: "comment-2",
              author: { login: "coderabbitai", kind: "bot", avatarUrl: null },
            },
          ],
        },
      ],
    } as unknown as PrInlineReview;
    const item = githubReviewThreadItem(review.threads[0]!, "rev-1");
    expect(item.comments[0]!.author).toMatchObject({
      name: "priya",
      kind: "human",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
    });
    expect(item.comments[1]!.author).not.toHaveProperty("avatarUrl");
    // A new photo alone gives the thread a new version, so it re-renders.
    const [first, ...rest] = review.threads[0]!.comments;
    const changed = githubReviewThreadItem(
      {
        ...review.threads[0]!,
        comments: [
          { ...first!, author: { ...first!.author, avatarUrl: "https://avatars.githubusercontent.com/u/2" } },
          ...rest,
        ],
      },
      "rev-1",
    );
    expect(changed.version).not.toBe(item.version);
  });

  it("drops the date of a comment whose stored time is out of range instead of throwing", async () => {
    const section = await render(
      thread("workspace", { id: "u1", name: "Priya", kind: "human" }, {
        comments: [{ id: "c1", author: { id: "u1", name: "Priya", kind: "human" }, body: "Check the role.", createdAt: 8.65e15 }],
      }),
    );
    expect(section.textContent).toContain("Check the role.");
    expect(section.querySelector("time")).toBeNull();
  });

  it("gives an agent its mark on a rounded square and an Agent badge, without the provider", async () => {
    const section = await render(
      thread("workspace", {
        id: "agent:claude:1",
        name: "Claude",
        kind: "agent",
        provider: "claude",
      }),
    );
    const article = section.querySelector("article")!;
    const avatar = article.firstElementChild as HTMLElement;
    expect(avatar.className).toContain("rounded-md");
    expect(avatar.querySelector("svg, span[data-agent-icon], img")).not.toBeNull();
    expect(article.textContent).toContain("Agent");
    expect(article.textContent).not.toContain("claude");
    expect(article.textContent).not.toContain("Human");
  });

  it("draws people in a circle and review apps on a rounded square with a Bot badge", async () => {
    const person = await render(
      thread("github", { id: "github:priya", name: "Priya Shah", kind: "human" }),
    );
    const personAvatar = person.querySelector("article [data-slot=avatar]")!;
    expect(personAvatar.className).toContain("rounded-full");
    expect(personAvatar.textContent).toBe("PS");
    expect(person.querySelector("article")!.textContent).not.toContain("Bot");

    const bot = await render(
      thread("github", {
        id: "github:coderabbitai",
        name: "coderabbitai",
        kind: "integration",
      }),
    );
    expect(bot.querySelector("article [data-slot=avatar]")!.className).toContain(
      "rounded-md",
    );
    expect(bot.querySelector("article")!.textContent).toContain("Bot");
  });

  it("puts a check's severity icon in the avatar slot and its pill in the comment row", async () => {
    const section = await render(
      thread(
        "check",
        { id: "check:typecheck", name: "Typecheck", kind: "integration" },
        { severity: "failure" },
      ),
    );
    expect(section.getAttribute("aria-label")).toBe(
      "Check annotation on New lines 4–6",
    );
    const slot = section.querySelector("article")!.firstElementChild!;
    expect(slot.className).toContain("text-red-primary");
    expect(slot.querySelector("svg")).not.toBeNull();
    expect(section.querySelector("[data-slot=avatar]")).toBeNull();
    expect(section.textContent).toContain("failure");
    expect(section.textContent).not.toContain("Check annotation");
  });

  it("offers the reply as a field beside the viewer's avatar", async () => {
    const section = await render(
      thread("workspace", { id: "human:1", name: "Alex Morgan", kind: "human" }),
    );
    const reply = section.querySelector<HTMLButtonElement>(
      'button[aria-label="Reply"]',
    )!;
    expect(reply.textContent).toBe("Reply…");
    expect(reply.previousElementSibling!.querySelector("[data-slot=avatar]")).not.toBeNull();
    await act(async () => reply.click());
    const textarea = section.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it("shows the GitHub account a GitHub reply posts as beside Reply", async () => {
    const review = {
      headSha: "b".repeat(40),
      baseSha: "a".repeat(40),
      threads: [
        {
          id: "thread-viewer",
          path: "src/auth.ts",
          side: "RIGHT",
          startLine: 4,
          line: 6,
          originalStartLine: 4,
          originalLine: 6,
          isOutdated: false,
          isResolved: false,
          canResolve: true,
          canUnresolve: false,
          commentsTruncated: false,
          comments: [
            {
              id: "comment-viewer",
              databaseId: 31,
              body: "Check role.",
              url: null,
              createdAt: 10,
              updatedAt: 20,
              commitSha: "b".repeat(40),
              author: { login: "sam", kind: "human", avatarUrl: null },
            },
          ],
        },
      ],
      annotations: [],
      threadsTruncated: false,
      annotationsTruncated: false,
      annotationError: null,
      viewer: { login: "priya-gh", avatarUrl: "https://avatars.githubusercontent.com/u/9" },
    } as unknown as PrInlineReview;
    const target = { workspaceId: "ws", prNumber: 7 };
    const [item] = githubReviewItems(review, target);
    expect(item!.replyAs).toEqual({
      name: "priya-gh",
      avatarUrl: "https://avatars.githubusercontent.com/u/9",
    });
    const section = await render(item!);
    const reply = section.querySelector<HTMLButtonElement>('button[aria-label="Reply"]')!;
    expect(reply.previousElementSibling!.textContent).toBe("PG");
    // Another account makes a new version, so the open thread re-renders.
    const [other] = githubReviewItems(
      { ...review, threads: review.threads.map((t) => ({ ...t })), viewer: { login: "sam", avatarUrl: null } },
      target,
    );
    expect(other!.version).not.toBe(item!.version);
  });

  it("shows no avatar beside a GitHub reply when the posting account is unknown", async () => {
    const section = await render(
      thread(
        "github",
        { id: "github:sam", name: "sam", kind: "human" },
        { replyAs: null },
      ),
    );
    const reply = section.querySelector<HTMLButtonElement>('button[aria-label="Reply"]')!;
    expect(reply.previousElementSibling?.querySelector("[data-slot=avatar]") ?? null).toBeNull();
  });

  it("shows a person's photo once it has loaded", async () => {
    // jsdom never loads images; Radix shows one when it reports complete.
    const spies = [
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true),
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(20),
    ];
    try {
      const avatarUrl = "https://avatars.githubusercontent.com/u/1";
      const section = await render(
        thread("github", { id: "github:priya", name: "priya", kind: "human", avatarUrl }),
      );
      expect(section.querySelector("[data-slot=avatar-image]")?.getAttribute("src")).toBe(avatarUrl);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
