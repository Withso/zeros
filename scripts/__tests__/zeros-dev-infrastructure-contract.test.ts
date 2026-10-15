import { describe, expect, it } from "vitest";
import { InfrastructureSchema, initialInfrastructure } from "../zeros-dev/infrastructure-contract";
import { HourlySchema } from "../zeros-dev/hourly-contract";
import { Gate0Schema } from "../zeros-dev/gate0-contract";
import { infrastructureProof } from "./zeros-dev-infrastructure-fixture";
import { RunSchema } from "../zeros-dev/receipts";
import { randomUUID } from "node:crypto";

describe("explicit infrastructure coverage", () => {
  it("retains owner §7 exclusions even when every native requirement passed", () => {
    const proof = infrastructureProof();
    expect(InfrastructureSchema.safeParse(proof).success).toBe(true);
    expect(Object.values(proof.coverage)).toEqual(Array(4).fill("not_covered_owner_section7"));
    expect(Gate0Schema.safeParse(proof).success).toBe(false);
    const hourly = { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40), credentials: [], histories: [], activeWindows: [],
      complete: false, infrastructure: proof };
    expect(HourlySchema.safeParse(hourly).success).toBe(true);
    expect(HourlySchema.safeParse({ ...hourly, complete: true }).success).toBe(false);
    expect(HourlySchema.safeParse({ ...hourly, rehearsal: { version: 1, complete: false, models: [], cycles: [], transports: [] } }).success).toBe(false);
  });
  it.each(["short", "missing", "retried", "transport", "coverage", "native-gap", "truncated"])("refuses a complete %s proof", kind => {
    const proof = infrastructureProof();
    if (kind === "short") proof.detached!.durationMs = 30 * 60_000;
    if (kind === "missing") proof.detached = undefined;
    if (kind === "retried") proof.cycles[1]!.setup.claimCount = 2;
    if (kind === "transport") proof.transports[0]!.coverage = "unavailable";
    if (kind === "coverage") Object.assign(proof.coverage, { agents: "passed" });
    if (kind === "native-gap") proof.detached!.proof.maxHeartbeatGapMs = 90_001;
    if (kind === "truncated") Object.assign(proof.detached!.proof, { replayTruncated: true });
    expect(InfrastructureSchema.safeParse(proof).success).toBe(false);
  });
  it("keeps an incomplete initial checkpoint without claiming any native or agent coverage", () => {
    const value = initialInfrastructure();
    expect(InfrastructureSchema.safeParse(value).success).toBe(true);
    expect(InfrastructureSchema.safeParse({ ...value, complete: true }).success).toBe(false);
  });

  it.each(["intent", "task", "foreign-task", "scope", "program", "session", "window"])("refuses a complete proof with mismatched %s", kind => {
    const proof = infrastructureProof();
    if (kind === "intent") delete proof.intent;
    if (kind === "task") delete proof.task;
    if (kind === "foreign-task") proof.task = infrastructureProof().task;
    if (kind === "scope") proof.detached!.proof.scopeSha256 = "f".repeat(64);
    if (kind === "program") proof.detached!.proof.programSha256 = "f".repeat(64);
    if (kind === "session") proof.detached!.proof.sessionSha256 = "f".repeat(64);
    if (kind === "window") proof.detached!.completedAt = new Date(proof.task!.deadlineAtMs + 1).toISOString();
    expect(InfrastructureSchema.safeParse(proof).success).toBe(false);
  });

  it.each(["run", "fixture", "workspace", "generation", "agent"])("binds an infrastructure task to its outer signed %s", kind => {
    const proof = infrastructureProof(), task = proof.task!;
    const run = RunSchema.parse({ version: 1, runId: task.runId, fixtureSha256: task.fixtureSha256, deviceId: randomUUID(),
      createdAt: new Date(task.startedAtMs - 60_000).toISOString(), source: { revision: "a".repeat(40), dirty: false },
      create: { key: randomUUID(), body: { name: `zd-${task.runId}`, repository: { forge: "github.com", owner: "fixture", name: "fixture",
        revision: "main", githubInstallationId: randomUUID() } },
      result: { id: task.scope.workspaceId, createdBy: task.scope.fundingOwnerUserId, createdAt: new Date(task.startedAtMs - 60_000).toISOString(), generation: task.scope.generation } },
      prompts: [], lifecycle: [], evidence: [], deletionConfirmed: true,
      hourly: { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40), credentials: [], histories: [], activeWindows: [],
        complete: false, infrastructure: proof } });
    if (kind === "run") run.runId = randomUUID();
    if (kind === "fixture") run.fixtureSha256 = "f".repeat(64);
    if (kind === "workspace") run.create!.result!.id = randomUUID();
    if (kind === "generation") run.create!.result!.generation++;
    if (kind === "agent") run.prompts.push({ id: randomUUID(), conversationId: randomUUID(), agent: "codex", model: "fixture", sha256: "e".repeat(64), state: "succeeded" });
    expect(RunSchema.safeParse(run).success).toBe(false);
  });

  it("keeps an invalid nested task a schema refusal rather than throwing during safeParse", () => {
    const proof = infrastructureProof(); proof.task!.scope.generation++;
    expect(InfrastructureSchema.safeParse(proof).success).toBe(false);
  });
});
