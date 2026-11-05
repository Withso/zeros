import { describe, it, expect } from "vitest";

import {
  appDisplayName,
  bucketChecks,
  checkOutcome,
  commitAuthorsLabel,
  composeTimeline,
  derivePrStatusView,
  filterTimelineEvents,
  formatDuration,
  groupCommitsByRecency,
  hasPendingChecks,
  isBotLogin,
  latestReviewsByAuthor,
  mergeMethodDetail,
  recencyLabel,
  relTime,
  reviewActionBlockReason,
  reviewFindings,
  summarizeChecks,
} from "../review-model";
import type {
  PR,
  PrCheck,
  PrChecksResult,
  PrCommitSummary,
  PrTimelineItem,
} from "../../../../platform/git";

const NOW = new Date("2026-07-15T12:00:00Z").getTime();

function check(over: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "build",
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

function commit(over: Partial<PrCommitSummary> = {}): PrCommitSummary {
  return {
    sha: "a".repeat(40),
    abbreviatedSha: "aaaaaaa",
    message: "feat: thing",
    authorName: "Jordan Lee",
    authorLogin: "jordan",
    authorAvatarUrl: null,
    date: NOW - 3_600_000,
    coAuthors: [],
    additions: null,
    deletions: null,
    changedFiles: null,
    ...over,
  };
}

function timelineItem(over: Partial<PrTimelineItem> = {}): PrTimelineItem {
  return {
    kind: "comment",
    id: 1,
    author: "jordan",
    authorAvatarUrl: null,
    state: "",
    body: "hello",
    url: null,
    createdAt: NOW - 60_000,
    ...over,
  };
}

function pr(over: Partial<PR> = {}): PR {
  return {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state: "ready",
    title: "T",
    body: "",
    authorLogin: "jordan",
    baseBranch: "main",
    headBranch: "zeros/x",
    mergeableState: "clean",
    isMergeable: true,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW,
    mergedAt: null,
    ...over,
  };
}

describe("relTime", () => {
  it("formats the ladder and clamps clock skew", () => {
    expect(relTime(NOW - 5_000, NOW)).toBe("just now");
    expect(relTime(NOW + 5_000, NOW)).toBe("just now"); // skew → clamp
    expect(relTime(NOW - 4 * 60_000, NOW)).toBe("4m ago");
    expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(relTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
    expect(relTime(NOW - 21 * 86_400_000, NOW)).toBe("3w ago");
    expect(relTime(0, NOW)).toBe("");
  });
});

describe("formatDuration", () => {
  it("scales s → m → h", () => {
    expect(formatDuration(2_000)).toBe("2s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_840_000)).toBe("1h 4m");
    expect(formatDuration(-5)).toBe("");
  });
});

describe("recencyLabel / groupCommitsByRecency", () => {
  it("walks the bucket ladder and keeps year suffixes for past years", () => {
    expect(recencyLabel(NOW, NOW)).toBe("Today");
    expect(recencyLabel(NOW + 5_000, NOW)).toBe("Today"); // skew → clamp
    expect(recencyLabel(NOW - 86_400_000, NOW)).toBe("Yesterday");
    expect(recencyLabel(NOW - 3 * 86_400_000, NOW)).toBe("Last 7 days");
    expect(recencyLabel(NOW - 10 * 86_400_000, NOW)).toBe("Last 30 days");
    // >30 days but same year (NOW is 2026-07-15) → month only.
    expect(recencyLabel(new Date("2026-03-05T10:00:00Z").getTime(), NOW)).toBe(
      "March",
    );
    // A past year keeps the year suffix.
    expect(recencyLabel(new Date("2025-06-20T10:00:00Z").getTime(), NOW)).toBe(
      "June 2025",
    );
  });

  it("groups newest bucket first, commits newest-first inside", () => {
    const old = new Date("2025-06-20T10:00:00Z").getTime();
    const groups = groupCommitsByRecency(
      [
        commit({ sha: "1".repeat(40), date: NOW - 120_000 }),
        commit({ sha: "2".repeat(40), date: old }),
        commit({ sha: "3".repeat(40), date: NOW - 60_000 }),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "June 2025"]);
    expect(groups[0].commits.map((c) => c.sha[0])).toEqual(["3", "1"]);
  });
});

describe("commitAuthorsLabel", () => {
  it("joins primary + co-authors GitHub-style", () => {
    expect(commitAuthorsLabel(commit())).toBe("Jordan Lee");
    expect(
      commitAuthorsLabel(
        commit({ coAuthors: [{ name: "Cursor Agent", avatarUrl: null }] }),
      ),
    ).toBe("Jordan Lee and Cursor Agent");
    expect(
      commitAuthorsLabel(
        commit({
          coAuthors: [
            { name: "B", avatarUrl: null },
            { name: "C", avatarUrl: null },
          ],
        }),
      ),
    ).toBe("Jordan Lee, B and C");
  });
});

describe("checks buckets + summary", () => {
  it("maps conclusions to outcomes", () => {
    expect(checkOutcome(check({ conclusion: "success" }))).toBe("passed");
    expect(checkOutcome(check({ conclusion: "skipped" }))).toBe("passed");
    expect(checkOutcome(check({ conclusion: "failure" }))).toBe("failed");
    expect(checkOutcome(check({ conclusion: "timed_out" }))).toBe("failed");
    expect(
      checkOutcome(check({ conclusion: null, status: "in_progress" })),
    ).toBe("pending");
  });

  it("buckets failed → pending → passed", () => {
    const buckets = bucketChecks([
      check({ name: "a", conclusion: "failure" }),
      check({ name: "b", conclusion: null, status: "queued" }),
      check({ name: "c" }),
    ]);
    expect(buckets.failed.map((c) => c.name)).toEqual(["a"]);
    expect(buckets.pending.map((c) => c.name)).toEqual(["b"]);
    expect(buckets.passed.map((c) => c.name)).toEqual(["c"]);
  });

  it("summarizes tone + fraction", () => {
    const base: PrChecksResult = {
      checks: [],
      deployments: [],
      total: 5,
      passed: 5,
      failed: 0,
      pending: 0,
    };
    expect(summarizeChecks(null)).toMatchObject({ tone: "none" });
    expect(summarizeChecks({ ...base, total: 0 })).toMatchObject({
      tone: "none",
    });
    expect(summarizeChecks(base)).toMatchObject({
      tone: "success",
      fraction: "5/5",
    });
    expect(summarizeChecks({ ...base, passed: 3, failed: 2 })).toMatchObject({
      tone: "failure",
      label: "2 checks failing",
    });
    expect(summarizeChecks({ ...base, passed: 4, failed: 1 }).label).toBe(
      "1 check failing",
    );
    expect(summarizeChecks({ ...base, passed: 4, pending: 1 })).toMatchObject({
      tone: "pending",
    });
  });

  it("hasPendingChecks reads both counters and rows", () => {
    expect(hasPendingChecks(null)).toBe(false);
    expect(
      hasPendingChecks({
        checks: [check()],
        deployments: [],
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
      }),
    ).toBe(false);
    expect(
      hasPendingChecks({
        checks: [check({ conclusion: null, status: "queued" })],
        deployments: [],
        total: 1,
        passed: 0,
        failed: 0,
        pending: 0, // counter lies → rows win
      }),
    ).toBe(true);
  });
});

describe("reviewActionBlockReason", () => {
  it("enables Review's duplicate CTA only when the shared island enables the same action", () => {
    expect(reviewActionBlockReason("ready-to-merge", "merge")).toBeNull();
    expect(reviewActionBlockReason("draft", "ready")).toBeNull();
  });

  it("keeps merge disabled for every higher-priority local or GitHub blocker", () => {
    expect(reviewActionBlockReason("merge-conflicts", "merge")).toMatch(
      /conflicts/i,
    );
    expect(reviewActionBlockReason("uncommitted", "merge")).toMatch(/commit/i);
    expect(reviewActionBlockReason("diverged", "merge")).toMatch(/pull/i);
    expect(reviewActionBlockReason("ahead", "merge")).toMatch(/push/i);
    expect(reviewActionBlockReason("checks-pending", "merge")).toMatch(
      /checks/i,
    );
    expect(reviewActionBlockReason("unable-to-merge", "merge")).toMatch(
      /checks/i,
    );
    expect(reviewActionBlockReason("behind-base", "merge")).toMatch(/update/i);
    expect(reviewActionBlockReason("blocked", "merge")).toMatch(
      /requirements/i,
    );
    expect(reviewActionBlockReason("checking", "merge")).toMatch(/checking/i);
  });

  it("does not let a draft skip local blockers when marking ready", () => {
    expect(reviewActionBlockReason("uncommitted", "ready")).toMatch(/commit/i);
    expect(reviewActionBlockReason(null, "ready")).toMatch(/loading/i);
  });
});

describe("composeTimeline", () => {
  it("merges opened + commits + items chronologically", () => {
    const events = composeTimeline({
      pr: pr(),
      commits: [commit({ date: NOW - 7_200_000 })],
      items: [timelineItem({ createdAt: NOW - 1_800_000 })],
    });
    expect(events.map((e) => e.kind)).toEqual(["opened", "commit", "comment"]);
  });

  it("appends merged / closed terminal events", () => {
    const merged = composeTimeline({
      pr: pr({ state: "merged", mergedAt: NOW }),
      commits: [],
      items: [],
    });
    expect(merged[merged.length - 1].kind).toBe("merged");

    const closed = composeTimeline({
      pr: pr({ state: "closed" }),
      commits: [],
      items: [],
    });
    expect(closed[closed.length - 1].kind).toBe("closed");
  });

  it("review items keep their kind; zero-date commits are dropped", () => {
    const events = composeTimeline({
      pr: null,
      commits: [commit({ date: 0 })],
      items: [
        timelineItem({ kind: "review", state: "APPROVED", createdAt: NOW }),
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("review");
  });

  it("keeps insertion order for same-timestamp events", () => {
    const t = NOW - 1000;
    const events = composeTimeline({
      pr: pr({ createdAt: t }),
      commits: [commit({ date: t })],
      items: [timelineItem({ createdAt: t })],
    });
    expect(events.map((e) => e.kind)).toEqual(["opened", "commit", "comment"]);
  });
});

function checks(list: PrCheck[]): PrChecksResult {
  const failed = list.filter((c) => checkOutcome(c) === "failed").length;
  const pending = list.filter((c) => checkOutcome(c) === "pending").length;
  return { checks: list, deployments: [], total: list.length, passed: list.length - failed - pending, failed, pending };
}

const review = (author: string, state: string, at: number, body = "") =>
  timelineItem({ kind: "review", id: at, author, state, body, createdAt: NOW - at });

// Overview's PR status (plans.md §1.4): the verdict, the one action, only what
// blocks it with Add to chat, and what is already done in one line.
describe("latestReviewsByAuthor", () => {
  it("keeps each reviewer's latest verdict; a later comment does not undo it", () => {
    const latest = latestReviewsByAuthor([
      review("priya", "APPROVED", 300),
      review("priya", "CHANGES_REQUESTED", 200),
      review("priya", "COMMENTED", 100),
      review("sam", "COMMENTED", 50),
      timelineItem({ author: "sam", body: "a plain comment" }),
    ]);
    // Newest first: sam's comment is the latest review.
    expect(latest.map((r) => [r.author, r.state])).toEqual([
      ["sam", "COMMENTED"],
      ["priya", "CHANGES_REQUESTED"],
    ]);
  });
});

describe("derivePrStatusView", () => {
  const branch = "zeros/x";
  it("blocks Merge on a failing check and requested changes, each with Add to chat", () => {
    const view = derivePrStatusView({
      pr: pr(),
      branch,
      checks: checks([
        check({ name: "test (ubuntu-latest)", conclusion: "failure", detailsUrl: "https://ci/1" }),
        ...Array.from({ length: 5 }, (_, i) => check({ name: `ok-${i}` })),
        check({ name: "lint", status: "in_progress", conclusion: null }),
      ]),
      timeline: [review("priya", "CHANGES_REQUESTED", 100, "Please add a test"), review("sam", "APPROVED", 50)],
    });
    expect([view.title, view.detail, view.tone, view.action]).toEqual([
      "Merge blocked",
      "1 failing check and requested changes",
      "danger",
      "merge",
    ]);
    expect(view.blockers.map((b) => b.title)).toEqual(["test (ubuntu-latest) failed", "priya requested changes"]);
    expect(view.blockers[0].chatText).toContain("`test (ubuntu-latest)` is failing on PR #7");
    expect(view.blockers[1].chatText).toContain("> Please add a test");
    expect(view.done).toBe("5 checks passed · 1 running · Approved by sam");
  });

  it("reads ready, running, draft, conflicts and the terminal states", () => {
    const ready = derivePrStatusView({ pr: pr(), branch, checks: checks([check()]), timeline: [] });
    expect([ready.title, ready.tone, ready.action, ready.blockers, ready.done]).toEqual([
      "Ready to merge", "success", "merge", [], "1 check passed",
    ]);
    const running = derivePrStatusView({ pr: pr(), branch, checks: checks([check({ status: "queued", conclusion: null })]), timeline: [] });
    expect([running.title, running.detail]).toEqual(["Checks running", "1 of 1 checks running"]);
    const draft = derivePrStatusView({ pr: pr({ state: "draft" }), branch, checks: null, timeline: [] });
    expect([draft.title, draft.action]).toEqual(["Draft", "ready"]);
    const dirty = derivePrStatusView({ pr: pr({ mergeableState: "dirty", isMergeable: false }), branch, checks: null, timeline: [] });
    expect([dirty.title, dirty.detail, dirty.blockers.map((b) => [b.title, b.chatText])]).toEqual([
      "Merge blocked", "conflicts with main", [["Conflicts with main", undefined]],
    ]);
    const merged = derivePrStatusView({ pr: pr({ state: "merged", mergedAt: NOW - 3_600_000 }), branch, checks: null, timeline: [], now: NOW });
    expect([merged.title, merged.detail, merged.tone, merged.action]).toEqual(["Merged", "Merged 1h ago", "merged", null]);
    const closed = derivePrStatusView({ pr: pr({ state: "closed" }), branch, checks: null, timeline: [] });
    expect([closed.title, closed.tone, closed.action]).toEqual(["Closed", "closed", null]);
  });
});

describe("reviewFindings", () => {
  const thread = (id: string, source: "workspace" | "github" | "check", kind: "agent" | "integration" | "human", body: string, resolved = false) => ({
    id,
    source,
    anchor: { path: "src/auth/login.ts", side: "new" as const, startLine: 18, endLine: id === "range" ? 21 : 18, revision: "r" },
    comments: [{ id: `${id}-c`, author: { id: kind, name: kind === "agent" ? "Claude" : kind === "integration" ? "coderabbitai" : "Priya", kind, ...(kind === "agent" ? { provider: "claude" } : {}) }, body, createdAt: 1 }],
    resolved,
    version: 1,
  });
  it("keeps agents, review apps and code scanning; people stay in Activity", () => {
    const findings = reviewFindings(
      [
        thread("done", "github", "integration", "Old note", true),
        thread("person", "github", "human", "Looks good"),
        thread("agent", "workspace", "agent", "**Protocol-relative URLs** pass `safeRedirect`"),
        thread("range", "check", "integration", "Server-side URL redirect from user input"),
        thread("local-person", "workspace", "human", "Note to self"),
      ],
      42,
    );
    expect(findings.map((f) => [f.author.kind, f.title, f.location, f.resolved])).toEqual([
      ["agent", "Protocol-relative URLs pass `safeRedirect`", "login.ts:18", false],
      ["check", "Server-side URL redirect from user input", "login.ts:18–21", false],
      ["bot", "Old note", "login.ts:18", true],
    ]);
    expect(findings[0].author.provider).toBe("claude");
    expect(findings[0].chatText).toBe(
      "PR #42 — Claude on `src/auth/login.ts:18`:\n> **Protocol-relative URLs** pass `safeRedirect`\n\n",
    );
  });
});

describe("mergeMethodDetail", () => {
  it("says what each GitHub method does to the commits", () => {
    expect(mergeMethodDetail("squash", 3, "main")).toBe("The 3 commits land on main as one");
    expect(mergeMethodDetail("merge", 3, "main")).toBe("All 3 commits join main with a merge commit");
    expect(mergeMethodDetail("rebase", 3, "main")).toBe("The 3 commits replay onto main");
  });

  it("reads one commit and an unknown count naturally", () => {
    expect(mergeMethodDetail("squash", 1, "main")).toBe("The commit lands on main");
    expect(mergeMethodDetail("merge", 1, "main")).toBe("The commit joins main with a merge commit");
    expect(mergeMethodDetail("rebase", null, "dev")).toBe("The commits replay onto dev");
  });

  it("has nothing to say about a method it doesn't know", () => {
    expect(mergeMethodDetail("fast-forward", 2, "main")).toBeNull();
  });
});

describe("timeline people and bots", () => {
  const item = (id: number, author: string, kind: "review" | "comment" = "comment") => ({
    kind, id, author, authorAvatarUrl: null, state: kind === "review" ? "COMMENTED" : "", body: "x", url: null, createdAt: id,
  });
  const commit = (sha: string, authorLogin: string): PrCommitSummary => ({
    sha, abbreviatedSha: sha.slice(0, 7), message: "m", authorName: authorLogin, authorLogin, authorAvatarUrl: null,
    coAuthors: [], date: 1, changedFiles: 1, additions: 1, deletions: 0,
  } as PrCommitSummary);
  const events = [
    { kind: "opened" as const, at: 1, author: "alex" },
    { kind: "commit" as const, at: 2, commit: commit("a1b2c3d4", "alex") },
    { kind: "commit" as const, at: 3, commit: commit("e5f6a7b8", "dependabot[bot]") },
    { kind: "review" as const, at: 4, item: item(4, "coderabbitai[bot]", "review") },
    { kind: "comment" as const, at: 5, item: item(5, "sam") },
    { kind: "merged" as const, at: 6 },
  ];

  it("tells a GitHub App's login from a person's", () => {
    expect(isBotLogin("coderabbitai[bot]")).toBe(true);
    expect(isBotLogin("github-actions[bot]")).toBe(true);
    expect(isBotLogin("robot")).toBe(false);
    expect(isBotLogin("bot-lover")).toBe(false);
    expect(appDisplayName("coderabbitai[bot]")).toBe("coderabbitai");
    expect(appDisplayName("sam-lee")).toBe("sam-lee");
  });

  it("filters by who acted, keeping authorless events with people", () => {
    expect(filterTimelineEvents(events, "all")).toHaveLength(6);
    expect(filterTimelineEvents(events, "people").map((e) => e.at)).toEqual([1, 2, 5, 6]);
    expect(filterTimelineEvents(events, "bots").map((e) => e.at)).toEqual([3, 4]);
  });
});
