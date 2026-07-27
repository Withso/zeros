// Priority matrix for the PR status island's single "current" state. The order
// (terminal PR states → local blockers → PR readiness) is the contract the UI
// depends on, so every branch is pinned here.
import { describe, it, expect } from "vitest";

import {
  derivePrIslandState,
  isActionGatedWhileAgentWorking,
  type PrStatusInputs,
} from "../pr-status";

const cleanStatus = {
  uncommitted: 0,
  conflicts: false,
  ahead: 0 as number | null,
  behind: 0 as number | null,
};

function base(overrides: Partial<PrStatusInputs> = {}): PrStatusInputs {
  return {
    prState: "ready",
    status: { ...cleanStatus },
    pr: null,
    checks: null,
    ...overrides,
  };
}

const readyPr = (mergeableState: string, isMergeable: boolean | null = true) => ({
  state: "ready" as const,
  mergeableState,
  isMergeable,
  mergedAt: null,
});

describe("derivePrIslandState — terminal PR states win over everything", () => {
  it("merged (via prState) → Continue + Archive, even with local conflicts", () => {
    const s = derivePrIslandState(
      base({ prState: "merged", status: { ...cleanStatus, conflicts: true } }),
    );
    expect(s.kind).toBe("merged");
    expect(s.tone).toBe("merged");
    expect(s.actions.map((a) => a.kind)).toEqual(["continue", "archive"]);
  });

  it("merged (via pr.mergedAt) is detected even if prState lags", () => {
    const s = derivePrIslandState(
      base({ prState: "ready", pr: { ...readyPr("clean"), mergedAt: 111 } }),
    );
    expect(s.kind).toBe("merged");
  });

  it("closed → red row with a single filled Archive", () => {
    const s = derivePrIslandState(base({ prState: "closed" }));
    expect(s.kind).toBe("closed");
    expect(s.tone).toBe("closed");
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0].kind).toBe("archive");
    expect(s.actions[0].variant).toBe("primary");
  });

  it("merged Continue is a DIRECT action (new branch, same worktree)", () => {
    const s = derivePrIslandState(base({ prState: "merged" }));
    const cont = s.actions.find((a) => a.kind === "continue");
    expect(cont?.behavior).toBe("continue");
  });

  it("merged omits desktop-only Continue for browser/relay clients", () => {
    const s = derivePrIslandState(base({ prState: "merged" }), {
      allowContinue: false,
    });
    expect(s.actions.map((a) => a.kind)).toEqual(["archive"]);
  });
});

describe("derivePrIslandState — local blockers, in priority order", () => {
  it("conflicts beat uncommitted / ahead / behind", () => {
    const s = derivePrIslandState(
      base({ status: { uncommitted: 5, conflicts: true, ahead: 3, behind: 2 } }),
    );
    expect(s.kind).toBe("merge-conflicts");
    expect(s.tone).toBe("warning");
    expect(s.actions[0].kind).toBe("resolve");
  });

  it("uncommitted beats ahead / behind — Commit & Push prompt", () => {
    const s = derivePrIslandState(
      base({ status: { uncommitted: 11, conflicts: false, ahead: 1, behind: 1 } }),
    );
    expect(s.kind).toBe("uncommitted");
    expect(s.actions[0].kind).toBe("commit-and-push");
    expect(s.actions[0].label).toBe("Commit & Push");
    expect(s.actions[0].behavior).toBe("prompt");
  });

  it("ahead → Push (direct), with singular/plural label", () => {
    expect(
      derivePrIslandState(base({ status: { ...cleanStatus, ahead: 1 } })).label,
    ).toBe("Ahead by 1 commit");
    const s = derivePrIslandState(base({ status: { ...cleanStatus, ahead: 3 } }));
    expect(s.label).toBe("Ahead by 3 commits");
    expect(s.actions[0].kind).toBe("push");
    expect(s.actions[0].behavior).toBe("push");
  });

  it("diverged → Pull/rebase before Push can be offered", () => {
    const s = derivePrIslandState(
      base({ status: { ...cleanStatus, ahead: 3, behind: 2 } }),
    );
    expect(s.kind).toBe("diverged");
    expect(s.label).toBe("Diverged · 3 ahead, 2 behind");
    expect(s.actions[0].kind).toBe("pull");
    expect(s.actions[0].behavior).toBe("pull");
  });

  it("behind → Pull (direct)", () => {
    const s = derivePrIslandState(base({ status: { ...cleanStatus, behind: 2 } }));
    expect(s.kind).toBe("behind");
    expect(s.actions[0].kind).toBe("pull");
    expect(s.actions[0].behavior).toBe("pull");
  });

  it("null ahead/behind (no upstream) are treated as unknown, not blocking", () => {
    const s = derivePrIslandState(
      base({ prState: "draft", status: { uncommitted: 0, conflicts: false, ahead: null, behind: null } }),
    );
    expect(s.kind).toBe("draft");
  });
});

describe("derivePrIslandState — draft", () => {
  it("draft prState → Ready for review (direct)", () => {
    const s = derivePrIslandState(base({ prState: "draft" }));
    expect(s.kind).toBe("draft");
    expect(s.actions[0].kind).toBe("ready-for-review");
    expect(s.actions[0].behavior).toBe("ready");
  });

  it("draft via mergeableState is also detected", () => {
    const s = derivePrIslandState(
      base({ prState: "ready", pr: readyPr("draft") }),
    );
    // pr.state 'ready' but mergeableState 'draft' → still draft label
    expect(s.kind).toBe("draft");
  });
});

describe("derivePrIslandState — open PR readiness (needs GitHub metadata)", () => {
  it("no live pr yet → calm 'PR open' placeholder, no buttons", () => {
    const s = derivePrIslandState(base({ pr: null }));
    expect(s.kind).toBe("pr-open");
    expect(s.actions).toHaveLength(0);
  });

  it("checks pending → count label, no button", () => {
    const s = derivePrIslandState(
      base({ pr: readyPr("unknown"), checks: { pending: 2, failed: 0, total: 5 } }),
    );
    expect(s.kind).toBe("checks-pending");
    expect(s.label).toBe("2 checks pending…");
    expect(s.actions).toHaveLength(0);
  });

  it("clean + mergeable + no failures → Ready to merge (Merge)", () => {
    const s = derivePrIslandState(
      base({ pr: readyPr("clean"), checks: { pending: 0, failed: 0, total: 4 } }),
    );
    expect(s.kind).toBe("ready-to-merge");
    expect(s.tone).toBe("success");
    expect(s.actions[0].kind).toBe("merge");
    expect(s.actions[0].behavior).toBe("merge");
  });

  it("mergeableState blocked → Blocked, no button", () => {
    const s = derivePrIslandState(base({ pr: readyPr("blocked") }));
    expect(s.kind).toBe("blocked");
    expect(s.actions).toHaveLength(0);
  });

  it("mergeableState behind → Require-up-to-date → update from base", () => {
    const s = derivePrIslandState(base({ pr: readyPr("behind") }));
    expect(s.kind).toBe("behind-base");
    expect(s.label).toBe("Require branch to be up to date");
    expect(s.actions[0].kind).toBe("update-from-base");
    expect(s.actions[0].behavior).toBe("prompt");
  });

  it("mergeableState behind with a compare count → '( N commits behind )'", () => {
    expect(
      derivePrIslandState(base({ pr: { ...readyPr("behind"), behindBy: 4 } }))
        .label,
    ).toBe("Require branch to be up to date ( 4 commits behind )");
    expect(
      derivePrIslandState(base({ pr: { ...readyPr("behind"), behindBy: 1 } }))
        .label,
    ).toBe("Require branch to be up to date ( 1 commit behind )");
  });

  it("mergeableState unstable → Unable to merge → Show checks", () => {
    const s = derivePrIslandState(base({ pr: readyPr("unstable") }));
    expect(s.kind).toBe("unable-to-merge");
    expect(s.tone).toBe("danger");
    expect(s.actions[0].kind).toBe("show-checks");
  });

  it("clean but failed checks → 'N/M checks failed' (not Ready)", () => {
    const s = derivePrIslandState(
      base({ pr: readyPr("clean"), checks: { pending: 0, failed: 1, total: 3 } }),
    );
    expect(s.kind).toBe("unable-to-merge");
    expect(s.label).toBe("1/3 checks failed");
  });

  it("unstable with no check rollup keeps the generic Unable-to-merge label", () => {
    const s = derivePrIslandState(base({ pr: readyPr("unstable") }));
    expect(s.label).toBe("Unable to merge");
  });

  it("a failed check wins over concurrently-pending checks (does NOT hide the failure)", () => {
    // Regression: checks run concurrently — one failed while others still run.
    // Must surface Unable-to-merge + Show-checks, not a calm "pending".
    const s = derivePrIslandState(
      base({
        pr: readyPr("unstable"),
        checks: { pending: 1, failed: 1, total: 3 },
      }),
    );
    expect(s.kind).toBe("unable-to-merge");
    expect(s.actions[0].kind).toBe("show-checks");
  });

  it("has_hooks (mergeable, repo has pre-receive hooks) → Ready to merge, not stuck Checking", () => {
    const s = derivePrIslandState(
      base({ pr: readyPr("has_hooks"), checks: { pending: 0, failed: 0, total: 2 } }),
    );
    expect(s.kind).toBe("ready-to-merge");
    expect(s.actions[0].kind).toBe("merge");
  });

  it("mergeableState dirty → Merge conflicts → Resolve", () => {
    const s = derivePrIslandState(base({ pr: readyPr("dirty") }));
    expect(s.kind).toBe("merge-conflicts");
    expect(s.actions[0].kind).toBe("resolve");
  });

  it("unknown mergeable state → Checking…, no button", () => {
    const s = derivePrIslandState(base({ pr: readyPr("unknown") }));
    expect(s.kind).toBe("checking");
    expect(s.actions).toHaveLength(0);
  });
});

describe("isActionGatedWhileAgentWorking — actions parked mid-turn", () => {
  const stateFor = (input: Partial<PrStatusInputs>) =>
    derivePrIslandState(base(input));

  it("prompt actions are gated (they'd queue behind the in-flight turn)", () => {
    const commitPush = stateFor({
      status: { ...cleanStatus, uncommitted: 3 },
    }).actions[0];
    expect(commitPush.behavior).toBe("prompt");
    expect(isActionGatedWhileAgentWorking(commitPush)).toBe(true);
  });

  it("merge is gated (could ship a half-pushed branch)", () => {
    const merge = stateFor({
      pr: readyPr("clean"),
      checks: { pending: 0, failed: 0, total: 1 },
    }).actions[0];
    expect(merge.behavior).toBe("merge");
    expect(isActionGatedWhileAgentWorking(merge)).toBe(true);
  });

  it("direct git actions (push / pull / ready / continue) are gated too", () => {
    const push = stateFor({ status: { ...cleanStatus, ahead: 2 } }).actions[0];
    expect(isActionGatedWhileAgentWorking(push)).toBe(true);
    const pull = stateFor({ status: { ...cleanStatus, behind: 2 } }).actions[0];
    expect(isActionGatedWhileAgentWorking(pull)).toBe(true);
    const ready = stateFor({ prState: "draft" }).actions[0];
    expect(isActionGatedWhileAgentWorking(ready)).toBe(true);
    const cont = stateFor({ prState: "merged" }).actions[0];
    expect(cont.behavior).toBe("continue");
    expect(isActionGatedWhileAgentWorking(cont)).toBe(true);
  });

  it("archive and show-checks stay available", () => {
    const archive = stateFor({ prState: "closed" }).actions[0];
    expect(archive.behavior).toBe("archive");
    expect(isActionGatedWhileAgentWorking(archive)).toBe(false);

    const showChecks = stateFor({
      pr: readyPr("unstable"),
    }).actions[0];
    expect(showChecks.behavior).toBe("show-checks");
    expect(isActionGatedWhileAgentWorking(showChecks)).toBe(false);
  });
});
