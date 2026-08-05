import { describe, it, expect } from "vitest";

import {
  bucketChecks,
  checkOutcome,
  commitAuthorsLabel,
  composeTimeline,
  formatDuration,
  groupCommitsByRecency,
  hasPendingChecks,
  recencyLabel,
  relTime,
  reviewActionBlockReason,
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
