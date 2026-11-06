// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PR, PrCheck, PrCommitSummary } from "../../../../platform/git";
import type { ChatThread } from "@/renderer/state/store";

vi.mock("../../../scroll-memory", () => ({ useScrollMemoryRef: () => () => {} }));
vi.mock("@/renderer/features/agent/markdown", () => ({ renderMarkdown: () => "" }));
vi.mock("../../../../platform/turns", () => ({ turnCommitLinks: vi.fn() }));

import { turnCommitLinks } from "../../../../platform/turns";
import { forgetPrCachesForWorkspace } from "../../../pr/pr-cache-forget";
import { commitChatsFor, forgetReviewCommitChats, useReviewCommitChats, type ReviewCommitChat } from "../review-commit-chats";
import { composeTimeline } from "../review-model";
import { ReviewCommitsSection } from "../review-commits";
import { ReviewTimelineSection } from "../review-timeline";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const commit = (sha: string, checks: PrCommitSummary["checks"]): PrCommitSummary => ({
  sha, abbreviatedSha: sha.slice(0, 7), message: `Commit ${sha[0]}`, authorName: "Alex Morgan",
  authorLogin: "alex", authorAvatarUrl: null, date: Date.now() - 60_000, coAuthors: [],
  additions: 1, deletions: 0, changedFiles: 1, checks,
});
const chat = (id: string, title: string, extra: Partial<ChatThread> = {}) =>
  ({ id, title, agentId: "claude", kind: "chat", ...extra }) as ChatThread;
const pr = {
  number: 42, url: "https://github.com/acme/api/pull/42", state: "ready", title: "Fix", body: "",
  authorLogin: "alex", baseBranch: "main", headBranch: "fix", headSha: SHA, mergeableState: "clean",
  isMergeable: true, createdAt: Date.now() - 600_000, updatedAt: Date.now(), mergedAt: null,
} as PR;
const failed = (name: string, completedAt: number | null): PrCheck => ({
  name, status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt,
} as PrCheck);

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
  vi.mocked(turnCommitLinks).mockReset();
});

describe("which chat made a commit", () => {
  it("joins links to chats the store still has, never to a terminal or a commit not shown", () => {
    const links = [
      { sha: SHA, chatId: "c1", turnId: "t1" },
      { sha: OTHER, chatId: "gone", turnId: "t2" },
      { sha: "c".repeat(40), chatId: "c1", turnId: "t3" },
      { sha: "d".repeat(40), chatId: "term", turnId: "t4" },
    ];
    const chats = [chat("c1", "Fix login redirect"), chat("term", "zsh", { kind: "terminal" })];
    const joined = commitChatsFor(links, [SHA, OTHER, "d".repeat(40)], chats);
    expect([...joined.entries()]).toEqual([[SHA, { chatId: "c1", title: "Fix login redirect", agentId: "claude" }]]);
  });

  it.each([["Local", "local-links-ws"], ["cloud", "cloud://11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444"]])(
    "reads the %s workspace's links only while a surface shows them, keeping them across a new commit list",
    async (_label, workspaceId) => {
      vi.mocked(turnCommitLinks).mockResolvedValue([{ sha: SHA, chatId: "c1", turnId: "t1" }]);
      const chats = [chat("c1", "Fix login redirect")];
      let seen: ReadonlyMap<string, ReviewCommitChat> = new Map();
      function Probe({ commits, active }: { commits: PrCommitSummary[]; active: boolean }) {
        seen = useReviewCommitChats(workspaceId, commits, chats, active);
        return null;
      }
      const first = [commit(SHA, "passed")];
      await act(async () => root.render(createElement(Probe, { commits: first, active: false })));
      expect(turnCommitLinks).not.toHaveBeenCalled();
      await act(async () => root.render(createElement(Probe, { commits: first, active: true })));
      expect(turnCommitLinks).toHaveBeenCalledWith(workspaceId, [SHA]);
      expect(seen.get(SHA)?.title).toBe("Fix login redirect");
      vi.mocked(turnCommitLinks).mockReturnValue(new Promise(() => {}));
      await act(async () => root.render(createElement(Probe, { commits: [...first, commit(OTHER, null)], active: true })));
      expect(seen.get(SHA)?.chatId).toBe("c1");
      forgetReviewCommitChats(workspaceId);
    },
  );

  it("lets go of a workspace's links with its other pull request caches", async () => {
    const workspaceId = "forgotten-links-ws";
    vi.mocked(turnCommitLinks).mockResolvedValue([{ sha: SHA, chatId: "c1", turnId: "t1" }]);
    const chats = [chat("c1", "Fix login redirect")];
    const commits = [commit(SHA, null)];
    let seen: ReadonlyMap<string, ReviewCommitChat> = new Map();
    function Probe({ active }: { active: boolean }) {
      seen = useReviewCommitChats(workspaceId, commits, chats, active);
      return null;
    }
    await act(async () => root.render(createElement(Probe, { active: true })));
    expect(seen.size).toBe(1);
    forgetPrCachesForWorkspace(workspaceId);
    await act(async () => root.render(createElement(Probe, { active: false })));
    expect(seen.size).toBe(0);
  });
});

describe("Commits rows", () => {
  it("show the commit's check result and open the chat that made it", async () => {
    const onOpenChat = vi.fn();
    const chats = new Map([[SHA, { chatId: "c1", title: "Fix login redirect", agentId: "claude" }]]);
    await act(async () => root.render(createElement(ReviewCommitsSection, {
      commits: [commit(SHA, "failed"), commit(OTHER, "passed")], loading: false, error: null,
      prUrl: pr.url, onRetry: () => {}, chats, onOpenChat,
    })));
    const row = host.querySelector(`[data-review-commit="${SHA.slice(0, 7)}"]`)!;
    expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("A check failed");
    const other = host.querySelector(`[data-review-commit="${OTHER.slice(0, 7)}"]`)!;
    expect(other.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Checks passed");
    expect(other.textContent).not.toContain("Fix login redirect");
    await act(async () => row.querySelector<HTMLButtonElement>('button[aria-label="Open the chat Fix login redirect"]')!.click());
    expect(onOpenChat).toHaveBeenCalledWith("c1");
  });
});

describe("Activity", () => {
  it("adds the head's finished failures in time order and keeps them out of People and Bots", () => {
    const now = Date.now();
    const events = composeTimeline({
      pr, commits: [commit(SHA, "failed")], items: [],
      checks: { checks: [failed("test", now - 1000), failed("lint", null), { ...failed("ok", now), conclusion: "success" }], deployments: [], total: 3, passed: 1, failed: 2, pending: 0 },
    });
    expect(events.map((e) => e.kind)).toEqual(["opened", "commit", "check"]);
    expect(events[2]).toMatchObject({ kind: "check", sha: SHA, check: { name: "test" } });
    expect(composeTimeline({ pr: { ...pr, headSha: undefined }, commits: [], items: [], checks: { checks: [failed("test", now)], deployments: [], total: 1, passed: 0, failed: 1, pending: 0 } })
      .some((e) => e.kind === "check")).toBe(false);
  });

  it("names the chat behind a commit and sends a failure's reader to Checks", async () => {
    const onOpenChat = vi.fn();
    const onViewChecks = vi.fn();
    await act(async () => root.render(createElement(ReviewTimelineSection, {
      pr, prNumber: 42, commits: [commit(SHA, "failed")], timeline: [], loading: false, error: null,
      scrollKey: "activity", hostLabel: "GitHub", onAddToChat: () => {}, onPostComment: async () => {}, onRetry: () => {},
      checks: { checks: [failed("test (ubuntu-latest)", Date.now() - 1000)], deployments: [], total: 1, passed: 0, failed: 1, pending: 0 },
      chats: new Map([[SHA, { chatId: "c1", title: "Fix login redirect", agentId: "claude" }]]), onOpenChat, onViewChecks,
    })));
    const commitEvent = host.querySelector(`[data-review-event-commit="${SHA.slice(0, 7)}"]`)!;
    expect(commitEvent.textContent).toContain("from the chat");
    await act(async () => commitEvent.querySelector<HTMLButtonElement>("button")!.click());
    expect(onOpenChat).toHaveBeenCalledWith("c1");
    const checkEvent = host.querySelector('[data-review-event-check="test (ubuntu-latest)"]')!;
    expect(checkEvent.textContent).toContain(`failed on${SHA.slice(0, 7)}`);
    await act(async () => [...checkEvent.querySelectorAll("button")].find((b) => b.textContent === "View checks")!.click());
    expect(onViewChecks).toHaveBeenCalledTimes(1);
  });
});
