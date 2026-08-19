import { describe, expect, it } from "vitest";

import {
  buildAutoCommitMessage,
  describeAutoCommitBlock,
  describeAutoCommitFailure,
  summarizePendingWork,
} from "../pr-auto-commit";

const EMPTY = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  conflictState: null,
} as const;

describe("summarizePendingWork", () => {
  it("unions staged, unstaged and untracked paths without duplicates", () => {
    const pending = summarizePendingWork({
      ...EMPTY,
      staged: [{ path: "src/a.ts" }],
      unstaged: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      untracked: ["notes.md"],
    });
    expect(pending.paths).toEqual(["notes.md", "src/a.ts", "src/b.ts"]);
    expect(pending.blocker).toBeNull();
  });

  // The counts these decisions run on already exclude `.zeros`, and so does the
  // staging pathspec — the summary has to agree with both or the toast would
  // promise a file that never lands in the commit.
  it("ignores the internal .zeros tree", () => {
    const pending = summarizePendingWork({
      ...EMPTY,
      unstaged: [{ path: ".zeros/settings.toml" }],
      untracked: [".zeros/settings.local.toml"],
    });
    expect(pending.paths).toEqual([]);
  });

  // Staging a file with conflict markers still in it and committing is the one
  // outcome that is WRONG rather than merely unasked-for.
  it("blocks on unresolved conflicts", () => {
    const pending = summarizePendingWork({
      ...EMPTY,
      unstaged: [{ path: "src/a.ts" }],
      conflicted: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    });
    expect(pending.blocker).toEqual({ kind: "conflicts", count: 2 });
  });

  // A commit made in the middle of a rebase lands on a detached HEAD and leaves
  // the rebase running — never something a PR button should do silently.
  it("blocks while a merge or rebase is mid-flight even with no conflicted paths", () => {
    for (const operation of ["merge", "rebase", "cherry-pick", "revert"] as const) {
      expect(
        summarizePendingWork({
          ...EMPTY,
          unstaged: [{ path: "src/a.ts" }],
          conflictState: operation,
        }).blocker,
      ).toEqual({ kind: "operation", operation });
    }
  });

  it("reports conflicts ahead of the operation that caused them", () => {
    expect(
      summarizePendingWork({
        ...EMPTY,
        conflicted: [{ path: "src/a.ts" }],
        conflictState: "rebase",
      }).blocker,
    ).toEqual({ kind: "conflicts", count: 1 });
  });
});

describe("buildAutoCommitMessage", () => {
  it("names a single file", () => {
    expect(buildAutoCommitMessage(["src/features/agent/pills.tsx"]).subject).toBe(
      "Update pills.tsx",
    );
  });

  it("names two files", () => {
    expect(buildAutoCommitMessage(["src/a.ts", "src/b.ts"]).subject).toBe(
      "Update a.ts and b.ts",
    );
  });

  it("counts the tail beyond the first file", () => {
    expect(
      buildAutoCommitMessage(["src/a.ts", "src/b.ts", "src/c.ts"]).subject,
    ).toBe("Update a.ts and 2 more files");
  });

  // The subject becomes the PR title when the auto-commit is the branch's only
  // commit, so it must stay inside a readable one-line budget.
  it("falls back to a plain count when the names would run long", () => {
    const long = `src/${"a".repeat(80)}.ts`;
    expect(buildAutoCommitMessage([long, "src/b.ts"]).subject).toBe(
      "Update 2 files",
    );
    expect(buildAutoCommitMessage([long]).subject.length).toBeLessThanOrEqual(
      72,
    );
  });

  it("lists every path in the body so the commit is auditable", () => {
    const body = buildAutoCommitMessage(["src/a.ts", "src/b.ts"]).body;
    expect(body).toContain("- src/a.ts");
    expect(body).toContain("- src/b.ts");
    // Explains an otherwise mysterious commit nobody typed a message for.
    expect(body).toMatch(/Zeros/);
  });

  it("bounds a huge sweep instead of writing a thousand-line commit", () => {
    const paths = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    const lines = buildAutoCommitMessage(paths).body.split("\n");
    expect(lines.length).toBeLessThan(60);
    expect(buildAutoCommitMessage(paths).body).toContain("150 more");
  });

  // Never produce an empty message: the engine's commit op rejects one outright.
  it("still produces a subject with no paths", () => {
    expect(buildAutoCommitMessage([]).subject.length).toBeGreaterThan(0);
  });
});

describe("describeAutoCommitFailure", () => {
  // The engine's own message for a failed commit is "git commit -m <the whole
  // generated message> failed" — never copy that into a toast.
  it("names the causes worth checking and offers the agent", () => {
    const message = describeAutoCommitFailure({});
    expect(message.title).toBe("Couldn't commit your changes");
    expect(message.description).toMatch(/pre-commit hook/);
    expect(message.canAskAgent).toBe(true);
  });

  it("prefers the engine's remediation when it sent one", () => {
    expect(
      describeAutoCommitFailure({ remediation: "Stage paths first." })
        .description,
    ).toBe("Stage paths first.");
    // A blank hint is not a hint.
    expect(
      describeAutoCommitFailure({ remediation: "   " }).description,
    ).toMatch(/pre-commit hook/);
  });

  // A lost response is not "nothing happened": the commit is probably still
  // running, and a second writer (the agent) is the worst possible next step.
  it("does not claim failure — or offer the agent — when the op may still be running", () => {
    const message = describeAutoCommitFailure({ stillRunning: true });
    expect(message.title).toMatch(/still/i);
    expect(message.description).toMatch(/Changes tab/);
    expect(message.canAskAgent).toBe(false);
  });
});

describe("describeAutoCommitBlock", () => {
  it("names conflicts as the thing to fix", () => {
    const message = describeAutoCommitBlock({ kind: "conflicts", count: 2 });
    expect(message.title).toMatch(/conflict/i);
    expect(message.description).toMatch(/2/);
  });

  it("names the operation that is mid-flight", () => {
    expect(
      describeAutoCommitBlock({ kind: "operation", operation: "rebase" })
        .description,
    ).toMatch(/rebase/i);
  });
});
