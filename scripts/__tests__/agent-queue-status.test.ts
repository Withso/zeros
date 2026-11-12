import { describe, expect, it, vi } from "vitest";
import { describeQueue, runQueueStatus } from "../agent-queue-status.mjs";

const entry = (position: number, number: number, state = "AWAITING_CHECKS") =>
  ({ position, state, enqueuedAt: "2026-11-12T01:00:00Z", pullRequest: { number, title: `PR ${number}` } });

describe("agent queue status", () => {
  it("lists queue entries and surfaces an ejected PR with its reason and failing job", () => {
    const text = describeQueue({
      entries: [entry(1, 1035), entry(2, 1034)],
      prs: [{ number: 1027, state: "OPEN", isInMergeQueue: false, mergeQueueEntry: null,
        timelineItems: { nodes: [{ __typename: "AddedToMergeQueueEvent", createdAt: "2026-11-12T01:00:00Z" },
          { __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-11-12T01:31:00Z", reason: "failed_checks" }] },
        failures: [{ workflow: "Preflight", job: "tests-ui-smoke (2/3)", conclusion: "failure", url: "https://github.com/Withso/zeros/actions/runs/1/job/2" }] }],
    });
    expect(text).toContain("1. #1035 AWAITING_CHECKS");
    expect(text).toContain("#1027: open, not in the queue");
    expect(text).toContain("last removed 2026-11-12T01:31:00Z: failed_checks");
    expect(text).toContain("failed in merge group: Preflight / tests-ui-smoke (2/3) (failure) https://github.com/Withso/zeros/actions/runs/1/job/2");
  });

  it("only reads GitHub and never echoes gh output on failure", () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: "", stderr: "token-like-secret-value" }));
    const stderr = vi.fn();
    expect(runQueueStatus([], { spawn, stdout: vi.fn(), stderr })).toBe(1);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("token-like-secret-value");
    expect(spawn.mock.calls.every(([, args]) => (args as string[])[0] === "api" && !(args as string[]).includes("--method"))).toBe(true);
    expect(runQueueStatus(["abc"], { spawn, stdout: vi.fn(), stderr })).toBe(2);
  });
});
