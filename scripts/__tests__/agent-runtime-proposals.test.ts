import { describe, expect, it } from "vitest";
import { hash } from "../agent-runtime/contracts.mjs";
import {
  held,
  ownedProposal,
  planProposal,
  proposalMarker,
  recordWritten,
} from "../agent-runtime/proposals.mjs";
const now = "2026-10-12T12:00:00.000Z";
const branch = "automation/agent-runtime/codex/012345abcdef";
const pr = () => ({
  number: 42,
  state: "open",
  head: {
    sha: "a".repeat(40),
    ref: branch,
    repo: { full_name: "Withso/zeros" },
  },
  base: { ref: "main" },
  user: { type: "Bot", login: "runtime-updater[bot]" },
  body: proposalMarker("codex", branch),
  labels: [],
});
const input = () => ({
  provider: "codex",
  registry: {
    status: "complete",
    data: {
      pin: "1.0.0",
      latest: "1.2.0",
      candidate: "1.2.0",
      installable: true,
    },
  },
  previous: {},
  main: "b".repeat(40),
  automation: "c".repeat(40),
  now,
});

describe("one working runtime PR", () => {
  it("keeps the same branch and PR after a maintainer commit and a new upstream release", () => {
    const result = planProposal({
      ...input(),
      openPr: pr(),
      headVersion: "1.1.0",
      previous: { lastBotCommit: "d".repeat(40) },
    });
    expect(result.task.pr).toBe(42);
    expect(result.task.branch).toBe(branch);
    expect(result.task.head).toBe("a".repeat(40));
    expect(result.task.head).not.toBe(result.task.main);
    expect(result.task.version).toBe("1.2.0");
  });
  it("coalesces a major release into that PR instead of a new branch", () => {
    const context = input();
    context.registry.data.candidate = context.registry.data.latest = "2.0.0";
    expect(
      planProposal({ ...context, openPr: pr(), headVersion: "1.1.0" }).task
        .branch,
    ).toBe(branch);
  });
  it("acknowledges a hold at the current head and queues the new version", () => {
    const open: any = pr();
    open.labels = [{ name: "agent-runtime:hold" }];
    const result = planProposal({
      ...input(),
      openPr: open,
      headVersion: "1.1.0",
    });
    expect(result.task).toBeNull();
    expect(result.proposal).toMatchObject({
      status: "held",
      frozenHead: open.head.sha,
      queued: "1.2.0",
    });
    expect(held({ ...open, labels: [], auto_merge: { enabledAt: now } })).toBe(
      true,
    );
    expect(
      held({ ...open, labels: [], mergeQueueEntry: { id: "fixture" } }),
    ).toBe(true);
  });
  it("does not churn a current PR or downgrade after a registry rollback", () => {
    expect(
      planProposal({ ...input(), openPr: pr(), headVersion: "1.2.0" }).task,
    ).toBeNull();
    expect(
      planProposal({ ...input(), openPr: pr(), headVersion: "1.3.0" }).proposal
        .status,
    ).toBe("registry-rollback");
  });
  it("retains the same task identity across a bounded retry", () => {
    const first = planProposal(input());
    const retry = planProposal({
      ...input(),
      previous: first.proposal,
      now: "2026-10-12T16:00:00.000Z",
    });
    expect(retry.task.id).toBe(first.task.id);
    const blocked = planProposal({
      ...input(),
      previous: {
        ...first.proposal,
        lastAttempt: { ...first.proposal.lastAttempt, count: 3 },
      },
    });
    expect(blocked.task).toBeNull();
  });
  it("does not recreate a declined candidate, but permits a later one", () => {
    const previous = { pr: 42, version: "1.2.0", branch };
    const result = planProposal({
      ...input(),
      previous,
      closedPr: { merged_at: null },
      closedHeadVersion: "1.2.0",
    });
    expect(result.proposal.status).toBe("declined");
    expect(result.task).toBeNull();
    const newer = input();
    newer.registry.data.candidate = newer.registry.data.latest = "1.3.0";
    expect(
      planProposal({ ...newer, previous: result.proposal }).task.pr,
    ).toBeNull();
  });
  it("declines the closed head pin and starts a newer proposal from main's pin", () => {
    const context = {
      ...input(),
      previous: { pr: 42, version: "1.1.0", branch },
      closedPr: { merged_at: null },
      closedHeadVersion: "1.2.0",
    };
    const declined = planProposal(context);
    expect(declined.task).toBeNull();
    expect(declined.proposal.declined).toBe("1.2.0");
    expect(() =>
      planProposal({ ...context, closedHeadVersion: undefined }),
    ).toThrow("closed");
    const newer = input();
    newer.registry.data.candidate = newer.registry.data.latest = "1.3.0";
    expect(
      planProposal({ ...context, ...newer, previous: context.previous }).task,
    ).toMatchObject({
      from: "1.0.0",
      version: "1.3.0",
      pr: null,
    });
  });
  it("requires bot, branch, repository, base and marker ownership together", () => {
    expect(ownedProposal(pr(), "codex", "runtime-updater")).toBe(true);
    expect(
      ownedProposal(
        { ...pr(), user: { type: "User", login: "runtime-updater[bot]" } },
        "codex",
        "runtime-updater",
      ),
    ).toBe(false);
    expect(
      ownedProposal(
        { ...pr(), body: "human branch" },
        "codex",
        "runtime-updater",
      ),
    ).toBe(false);
  });
  it("binds successful outcomes to the task and new commit", () => {
    const { task, proposal } = planProposal(input());
    expect(() =>
      recordWritten(
        proposal,
        task,
        { taskId: hash("other"), status: "written" },
        now,
      ),
    ).toThrow();
    expect(
      recordWritten(
        proposal,
        task,
        { taskId: task.id, status: "written", pr: 42, head: "f".repeat(40) },
        now,
      ),
    ).toMatchObject({
      pr: 42,
      lastBotCommit: "f".repeat(40),
      version: "1.2.0",
    });
  });
});
