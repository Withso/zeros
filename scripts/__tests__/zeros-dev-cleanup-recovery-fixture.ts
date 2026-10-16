import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunStore, type Run } from "../zeros-dev/receipts";
import { exportHourlyArtifact } from "../zeros-dev/hourly-artifact";
import { initialInfrastructure } from "../zeros-dev/infrastructure-contract";
import { recoveryDeleteKey } from "../zeros-dev/cleanup-recovery-contract";
import type { Fixture } from "../zeros-dev/config";
import { retireFixtureCompute } from "./zeros-dev-cleanup-fixture";

export async function cleanupRecoveryFixture(root: string) {
  const fixture: Fixture = { subject: "user_fixture", accountId: randomUUID(), email: "fixture@example.test", organizationId: randomUUID(),
    repository: { id: "123", owner: "fixture", name: "repository", installationId: randomUUID() } };
  const credential = { ...createCloudReplicaDeviceCredential(fixture.accountId), deviceId: randomUUID() };
  const source = new RunStore(path.join(root, "source"), fixture, credential), runId = randomUUID(), now = new Date().toISOString();
  const createdAt = new Date(Date.now() - 3_600_000).toISOString();
  const execution = { workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40) }, approvalId = randomUUID();
  let observed: ReturnType<typeof retireFixtureCompute>;
  await source.withRun(runId, { revision: execution.sourceSha, dirty: false }, async handle => {
    handle.run.createdAt = createdAt;
    handle.run.create = { key: randomUUID(), body: { name: `zd-${runId}`, repository: { forge: "github.com", owner: "fixture", name: "repository",
      revision: "main", githubInstallationId: fixture.repository.installationId } },
      result: { id: randomUUID(), createdBy: fixture.accountId, createdAt, generation: 1 } };
    handle.run.hourly = { version: 1, ...execution, credentials: [], histories: [], activeWindows: [], complete: false, infrastructure: initialInfrastructure() };
    observed = retireFixtureCompute(handle, now); observed.organizationId = fixture.organizationId;
    delete handle.run.retirement;
    handle.run.evidence = [{ phase: "detached_native_proof", outcome: "failed", code: "detached_proof_incomplete", durationMs: 1300 },
      { phase: "cleanup", outcome: "failed", code: "cleanup_pending", durationMs: 110_000 }];
    await handle.save();
  });
  const handoff = { sha256: "f".repeat(64), runIds: [randomUUID(), randomUUID()] };
  const artifact = path.join(root, "source-artifact.json"), file = path.join(root, "recovery.b64");
  await exportHourlyArtifact(artifact, source, credential, execution, { runId, success: false, code: "detached_proof_incomplete" },
    { profile: "infrastructure", handoff });
  const sourceBytes = await readFile(artifact), sourceArtifactSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const original = await source.read(runId), signal = new AbortController().signal;
  const api = { readRetirement: vi.fn(async (run: Run) => ({ ...observed!, deleteIdempotencyKey: recoveryDeleteKey(run.cleanupRecovery!) })) };
  return { root, fixture, credential, source, runId, execution, approvalId, handoff, artifact, file, original, sourceBytes,
    sourceArtifactSha256, api, proof: observed!,
    options: { artifact, file, runId, execution, approvalId, credential, fixture, api, signal } };
}
