import { randomUUID } from "node:crypto";

export function fixtureSetupEvidence(workspaceId = randomUUID()) {
  const createdAt = "2026-10-18T00:00:00.000Z", completedAt = "2026-10-18T00:00:20.000Z";
  return { version: 1 as const, workspaceId, generation: 1, setupRunId: randomUUID(), attempt: 1, claimCount: 1,
    executionFence: 1, state: "succeeded" as const, runtimeId: `r1-${"a".repeat(64)}`, createdAt, startedAt: createdAt, completedAt, truncated: false,
    claims: [{ executionFence: 1, claimCount: 1, outcome: "succeeded" as const, startedAt: createdAt, completedAt,
      reuseDecision: "candidate" as const, observations: { version: 1 as const, preparation: "reused" as const, readiness: "ready" as const },
      engine: { id: randomUUID(), createdAt, registeredAt: "2026-10-18T00:00:18.000Z" },
      timings: { version: 1 as const, clocks: [
        { source: "setup" as const, clockId: randomUUID(), startedAt: createdAt,
          spans: [{ stage: "image_launch" as const, startMs: 0, endMs: 16_000, outcome: "passed" as const },
            { stage: "engine_readiness" as const, startMs: 16_000, endMs: 20_000, outcome: "passed" as const }] },
        { source: "attester_launch" as const, clockId: randomUUID(), startedAt: createdAt,
          spans: [{ stage: "qualify_engine" as const, startMs: 1000, endMs: 15_000, outcome: "passed" as const }] },
      ] },
    }],
  };
}
