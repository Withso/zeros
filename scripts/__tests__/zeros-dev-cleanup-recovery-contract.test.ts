import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RunSchema, type RunHandle } from "../zeros-dev/receipts";
import { cleanupOutcome, retirementMatchesRun } from "../zeros-dev/cleanup-state";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import { ZerosDevError } from "../zeros-dev/errors";
import { ZerosDevRuntime } from "../zeros-dev/runtime";
import { fixtureRetirement } from "./zeros-dev-cleanup-fixture";
import type { Fixture } from "../zeros-dev/config";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function recoveredFixture() {
  const fixture: Fixture = { subject: "user_fixture", accountId: randomUUID(), email: "fixture@example.test",
    organizationId: randomUUID(), repository: { id: "123", owner: "fixture", name: "repository", installationId: randomUUID() } };
  const execution = { workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40) }, runId = randomUUID(), now = new Date().toISOString();
  const original = RunSchema.parse({ version: 1, runId, fixtureSha256: sha(fixture), deviceId: randomUUID(), createdAt: now,
    source: { revision: execution.sourceSha, dirty: false }, create: { key: randomUUID(), body: { name: `zd-${runId}`,
      repository: { forge: "github.com", owner: "fixture", name: "repository", revision: "main", githubInstallationId: fixture.repository.installationId } },
      result: { id: randomUUID(), createdBy: fixture.accountId, createdAt: now, generation: 1 } },
    lifecycle: [{ operation: "delete", key: randomUUID(), generation: 1, confirmed: false }], prompts: [],
    evidence: [{ phase: "cleanup", outcome: "failed", code: "cleanup_pending", durationMs: 110_000 }], deletionConfirmed: false,
    hourly: { version: 1, ...execution, credentials: [], histories: [], activeWindows: [], complete: false } });
  const reference = { version: 1 as const, sha256: "b".repeat(64), sourceArtifactSha256: "c".repeat(64),
    sourceRunSha256: sha(original), sourceExecution: execution, runId, workspaceId: original.create!.result!.id,
    generation: 1, failedDeleteKey: original.lifecycle[0]!.key, approvalId: randomUUID() };
  const run = { ...structuredClone(original), cleanupRecovery: reference };
  const proof = { ...fixtureRetirement(original, now), organizationId: fixture.organizationId,
    deleteIdempotencyKey: `operator-delete:${reference.approvalId}:${reference.workspaceId}` };
  const session = { fixture: async () => fixture, whoami: vi.fn(async () => fixture), accessToken: vi.fn(async () => "synthetic-access") };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(proof));
  const api = new ProductApi(session, new AlphaTransport(fetcher));
  const handle: RunHandle = { run, save: vi.fn(async () => {}) };
  return { fixture, original, reference, run, proof, session, fetcher, api, handle };
}

describe("signed cleanup recovery selects an exact operator successor without rewriting failure", () => {
  it("accepts the additive custody field and retains every original field", () => {
    const f = recoveredFixture(), parsed = RunSchema.parse(f.run);
    expect(parsed).toEqual(f.run);
    const { cleanupRecovery: _recovery, ...original } = parsed as typeof f.run;
    expect(original).toEqual(f.original);
  });

  it("matches the exact successor proof while leaving the failed lifecycle key unconfirmed", () => {
    const f = recoveredFixture();
    expect(retirementMatchesRun(f.run, f.proof)).toBe(true);
    expect(cleanupOutcome({ ...f.run, retirement: f.proof })).toBe("compute_retired_storage_pending");
    expect(f.run.lifecycle).toEqual(f.original.lifecycle);
  });

  it("requests retirement for the approved operator key, never the old failed key", async () => {
    const f = recoveredFixture();
    await expect(f.api.readRetirement(f.run)).resolves.toEqual(f.proof);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual({ generation: 1, deleteIdempotencyKey: f.proof.deleteIdempotencyKey });
  });

  it("does not relabel the original failed DELETE when the successor physically completes", async () => {
    const f = recoveredFixture();
    const proof = { ...f.proof, status: "physically_deleted" as const, deletionConfirmed: true,
      reserved: { cpuMillicores: 0 as const, memoryMiB: 0 as const, storageMiB: 0 },
      generations: f.proof.generations.map(row => ({ ...row, status: "physically_deleted" as const,
        storageStage: "completed" as const, expectedBy: null,
        reserved: { cpuMillicores: 0 as const, memoryMiB: 0 as const, storageMiB: 0 } })) };
    vi.spyOn(f.api, "readRetirement").mockResolvedValue(proof);
    await f.api.observeRetirement(f.handle);
    expect(f.handle.run.deletionConfirmed).toBe(true);
    expect(f.handle.run.lifecycle).toEqual(f.original.lifecycle);
    expect(f.handle.run.evidence).toEqual(f.original.evidence);
  });

  it("never falls back to dispatching DELETE when a recovery receipt is unavailable", async () => {
    const f = recoveredFixture();
    vi.spyOn(f.api, "readRetirement").mockRejectedValue(new ZerosDevError("cleanup_pending"));
    const workspace = vi.spyOn(f.api, "workspace").mockRejectedValue(new ZerosDevError("internal"));
    const lifecycle = vi.spyOn(f.api, "lifecycle").mockRejectedValue(new ZerosDevError("internal"));
    await expect(f.api.cleanup(f.handle, true, undefined, { allowStoragePending: true })).rejects.toMatchObject({ code: "cleanup_pending" });
    expect(workspace).not.toHaveBeenCalled(); expect(lifecycle).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not promote a recovery boolean without its matching positive receipt", () => {
    const f = recoveredFixture();
    expect(cleanupOutcome({ ...f.run, deletionConfirmed: true })).toBe("unconfirmed");
  });

  it.each(["run", "workspace", "generation", "failed-key", "execution", "approval"])("rejects %s custody/proof substitution", field => {
    const f = recoveredFixture(), run = structuredClone(f.run);
    if (field === "run") run.cleanupRecovery.runId = randomUUID();
    if (field === "workspace") run.cleanupRecovery.workspaceId = randomUUID();
    if (field === "generation") run.cleanupRecovery.generation++;
    if (field === "failed-key") run.cleanupRecovery.failedDeleteKey = randomUUID();
    if (field === "execution") run.cleanupRecovery.sourceExecution.attempt++;
    if (field === "approval") run.cleanupRecovery.approvalId = randomUUID();
    expect(retirementMatchesRun(run, f.proof)).toBe(false);
  });

  it("keeps ordinary legacy matching and serialized field order unchanged", () => {
    const f = recoveredFixture(), before = JSON.stringify(f.original), ordinary = fixtureRetirement(f.original);
    expect(JSON.stringify(RunSchema.parse(f.original))).toBe(before);
    expect(retirementMatchesRun(f.original, ordinary)).toBe(true);
    expect(retirementMatchesRun(f.original, f.proof)).toBe(false);
  });

  it("makes recovery custody cleanup-only before any product admission or runtime access", async () => {
    const f = recoveredFixture();
    for (const operation of [() => f.api.createWorkspace(f.handle), () => f.api.buildComputer(f.handle),
      () => f.api.lifecycle(f.handle, "wake"), () => f.api.lifecycle(f.handle, "stop"), () => f.api.lifecycle(f.handle, "delete"),
      () => f.api.grant(f.run, "claude", "fixture"), () => ZerosDevRuntime.connect(f.session as never, f.api, f.run)])
      await expect(operation()).rejects.toMatchObject({ code: "forbidden" });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.session.whoami).not.toHaveBeenCalled();
  });

  it("refuses ordinary lifecycle observation that could relabel the failed DELETE", async () => {
    const f = recoveredFixture();
    for (const target of ["running", "stopped", "deleted"] as const)
      await expect(f.api.waitWorkspace(f.handle, target)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.handle.run.lifecycle).toEqual(f.original.lifecycle);
  });
});
