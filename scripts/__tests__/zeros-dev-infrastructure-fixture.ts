import { createHash, randomUUID } from "node:crypto";
import { initialInfrastructure, type Infrastructure } from "../zeros-dev/infrastructure-contract";
import { InfrastructureNativeTaskSchema, infrastructureNativeProgram, type InfrastructureNativeTask } from "../zeros-dev/infrastructure-native";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export function infrastructureTask(startedAtMs: number, binding: {
  runId?: string; fixtureSha256?: string; workspaceId?: string; generation?: number;
  organizationId?: string; fundingOwnerUserId?: string;
} = {}): InfrastructureNativeTask {
  const runId = binding.runId ?? randomUUID(), nonce = randomUUID();
  const scope = { organizationId: binding.organizationId ?? randomUUID(), workspaceId: binding.workspaceId ?? randomUUID(),
    generation: binding.generation ?? 1, engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: binding.fundingOwnerUserId ?? randomUUID(), fundingOwnerEpoch: 1, authorityEpoch: 1,
    rootSha256: sha("/workspace/repository"), engineWorkspaceId: randomUUID() };
  return InfrastructureNativeTaskSchema.parse({ version: 1, kind: "native-terminal-task", runId,
    fixtureSha256: binding.fixtureSha256 ?? "a".repeat(64), sessionId: `zd-infra-${runId}`, nonce, scope,
    scopeSha256: sha(JSON.stringify(scope)), programSha256: sha(infrastructureNativeProgram({ runId, nonce })),
    startedAtMs, deadlineAtMs: startedAtMs + 40 * 60_000, firstRow: { n: 0, ms: 0, run: runId, nonce } });
}

export function infrastructureProof(startedAt = "2026-10-14T00:00:00.000Z", binding: Parameters<typeof infrastructureTask>[1] = {}): Infrastructure {
  const start = Date.parse(startedAt), setup = { attempt: 1, claimCount: 1, state: "succeeded" as const, errorCode: null };
  const task = infrastructureTask(start + 60_000, binding), { firstRow: _first, ...intent } = task;
  return { ...initialInfrastructure(), complete: true,
    runtimePin: { buildId: randomUUID(), version: 1, runtimeId: `r1-${"a".repeat(64)}`, baseImageId: "fixture-base" },
    initialSetup: setup, fileChecks: 4, terminalChecks: 4, intent, task,
    cycles: [1, 2, 3].map(index => ({ index, stopMs: 1000, resumeMs: 10_000, usableMs: 11_000,
      stoppedAt: new Date(start + index * 15_000).toISOString(), readyAt: new Date(start + index * 15_000 + 10_000).toISOString(), setup })),
    detached: { startedAt: new Date(start + 60_000).toISOString(), completedAt: new Date(start + 32 * 60_000).toISOString(),
      durationMs: 31 * 60_000, authRemainingMs: 40 * 60_000, proof: { version: 1, kind: "native-terminal-task", scopeSha256: task.scopeSha256,
        sessionSha256: sha(task.sessionId), programSha256: task.programSha256, outputSha256: "e".repeat(64), rowCount: 32,
        taskDurationMs: 31 * 60_000, maxHeartbeatGapMs: 60_000, replayBytes: 6000, replayTruncated: false } },
    transports: [{ connectionId: randomUUID(), coverage: "complete", directAttempts: 1, directReady: 1, relayAttempts: 0, relayReady: 0,
      lostConnections: 0, authorityCloses: 0, unexplainedAuthorityCloses: 0 }],
  };
}
