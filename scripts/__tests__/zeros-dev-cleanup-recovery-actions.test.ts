import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runActions } from "../zeros-dev/hourly-main";
import { exportCleanupRecovery } from "../zeros-dev/cleanup-recovery";
import { recoveryDeleteKey } from "../zeros-dev/cleanup-recovery-contract";
import { verifyPublicHourlyArtifact, type HourlyExecution } from "../zeros-dev/hourly-artifact";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import { ZerosDevError } from "../zeros-dev/errors";
import type { Run, RunHandle } from "../zeros-dev/receipts";
import { cleanupRecoveryFixture } from "./zeros-dev-cleanup-recovery-fixture";

const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("live network forbidden"); }));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zd-recovery-actions-")); roots.push(root);
  const f = await cleanupRecoveryFixture(root);
  await exportCleanupRecovery(f.options);
  const encoded = await readFile(f.file, "utf8");
  const proof = { ...f.proof, deleteIdempotencyKey: recoveryDeleteKey({ approvalId: f.approvalId, workspaceId: f.original.create!.result!.id }) };
  let currentProof: unknown = proof;
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/deletion-retirement")) {
      expect(options?.method).toBe("POST");
      expect(JSON.parse(String(options?.body))).toEqual({ generation: 1, deleteIdempotencyKey: proof.deleteIdempotencyKey });
      return Response.json(currentProof);
    }
    expect(options?.method).not.toBe("DELETE");
    if (pathname.endsWith("/cloud-workspaces")) return Response.json({ workspaces: [], nextCursor: null });
    if (pathname.endsWith("/pending-deletion")) return Response.json({ truncated: false, pendingDeletion: proof.deletionConfirmed ? [] : [{
      workspaceId: proof.workspaceId, generation: 1, state: "observing", reserved: proof.reserved,
    }] });
    throw new Error("unexpected product operation");
  });
  const session = { fixture: async () => f.fixture, whoami: vi.fn(async () => f.fixture), accessToken: vi.fn(async () => "synthetic-access"),
    login: vi.fn(async () => {}), logout: vi.fn(async () => {}),
    prepareLaunchAuth: vi.fn(async () => { throw new Error("not reached by recovery admission test"); }) };
  const api = new ProductApi(session, new AlphaTransport(fetcher));
  const create = vi.spyOn(api, "createWorkspace").mockImplementation(async () => { throw new ZerosDevError("runtime_unavailable"); });
  const credentials = { cleanup: vi.fn(async () => {}), install: vi.fn(async () => { throw new Error("agent install forbidden"); }) };
  const connect = vi.fn(async () => { throw new Error("runtime connect forbidden"); });
  const infrastructure = vi.fn(async (options: { predecessors: Run[]; handle: RunHandle }) => {
    await api.assertFixtureEmpty(undefined, options.predecessors);
    await api.createWorkspace(options.handle); // Deliberate closed failure after admission; no fake lifecycle proof.
  });
  const stage = async (file = f.artifact, previous: HourlyExecution = f.execution) => {
    const checkout = path.join(root, randomUUID()), temporary = path.join(checkout, "temporary");
    await mkdir(checkout, { mode: 0o700 }); await mkdir(path.join(checkout, ".git"), { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 }); await mkdir(path.join(temporary, "zeros-dev-previous"), { mode: 0o700 });
    await copyFile(file, path.join(temporary, "zeros-dev-previous", "receipt.json"));
    const execution = { ...previous, workflowRunId: String(Number(previous.workflowRunId) + 1), sourceSha: "b".repeat(40) };
    const values = { ZEROS_DEV_PASSWORD: "synthetic-password", ZEROS_DEV_WORKOS_SUBJECT: f.fixture.subject, ZEROS_DEV_ACCOUNT_ID: f.fixture.accountId,
      ZEROS_DEV_EMAIL: f.fixture.email, ZEROS_DEV_ORGANIZATION_ID: f.fixture.organizationId, ZEROS_DEV_REPOSITORY: "fixture/repository",
      ZEROS_DEV_REPOSITORY_ID: f.fixture.repository.id, ZEROS_DEV_GITHUB_INSTALLATION_ID: f.fixture.repository.installationId,
      ZEROS_DEV_DEVICE_PRIVATE_KEY_B64: Buffer.from(JSON.stringify(f.credential)).toString("base64") };
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Withso/zeros", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ID: execution.workflowRunId, GITHUB_RUN_ATTEMPT: String(execution.attempt), GITHUB_SHA: execution.sourceSha,
      GITHUB_WORKFLOW_REF: "Withso/zeros/.github/workflows/zeros-dev-e2e.yml@refs/heads/main", GITHUB_WORKSPACE: checkout, RUNNER_TEMP: temporary,
      ZEROS_DEV_PROFILE: "infrastructure", ZEROS_DEV_E2E_START_MS: String(Date.now()), ZEROS_DEV_CLEANUP_HANDOFF_B64: encoded,
      ZEROS_DEV_FIXTURE_B64: Buffer.from(JSON.stringify(values)).toString("base64"),
      ZEROS_DEV_E2E_PLAN: JSON.stringify({ execution, profile: "infrastructure", previous, bootstrap: false, artifactId: "11" }) };
    const artifact = path.join(temporary, "zeros-dev-output", "receipt.json"), output: unknown[] = [];
    const checkpoint = async () => verifyPublicHourlyArtifact(JSON.parse(await readFile(artifact, "utf8")),
      { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey }, execution);
    const run = () => runActions(env, { factory: () => ({ session, api, credentials, connect,
      health: async () => ({ ready: true, cloud: { enabled: true }, sourceSha: execution.sourceSha }) }),
      infrastructure, write: (row: unknown) => output.push(row) } as never);
    return { run, env, artifact, output, checkpoint, execution };
  };
  return { ...f, encoded, proof, session, fetcher, create, credentials, infrastructure, stage,
    setProof: (value: unknown) => { currentProof = value; } };
}

describe("Actions consumes the approved cleanup recovery through its existing masked input", () => {
  it("checkpoints custody before login and rechecks exact retirement and inventory before allocation", async () => {
    const f = await fixture(), invocation = await f.stage();
    f.session.login.mockImplementation(async () => {
      const checkpoint = await invocation.checkpoint();
      expect(checkpoint.schema).toBe("zeros.dev-infrastructure/v1");
      expect("cleanupRecovery" in checkpoint && checkpoint.cleanupRecovery?.approvalId).toBe(f.approvalId);
      expect(checkpoint.runs.find(run => run.runId === f.runId)?.retirement).toBeUndefined();
      expect(f.fetcher).not.toHaveBeenCalled();
    });
    expect(await invocation.run()).toBe(1);
    const checkpoint = await invocation.checkpoint();
    expect(checkpoint.result.code).toBe("runtime_unavailable");
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/deletion-retirement"))).toHaveLength(2);
    const recovered = checkpoint.runs.find(run => run.runId === f.runId)!;
    expect(recovered.lifecycle).toEqual(f.original.lifecycle);
    expect(recovered.evidence.slice(0, f.original.evidence.length)).toEqual(f.original.evidence);
    expect(recovered).toMatchObject({ deletionConfirmed: false, retirement: { status: "compute_retired_storage_pending" } });
    expect("handoff" in checkpoint && checkpoint.handoff).toEqual(f.handoff);
    expect(f.credentials.install).not.toHaveBeenCalled();
    expect(await readFile(f.artifact)).toEqual(f.sourceBytes);
  });

  it.each(["stale", "generation", "foreign-key", "live-authority", "missing"])("blocks allocation on a %s fresh response despite producer proof", async condition => {
    const f = await fixture(), invocation = await f.stage(), proof: any = structuredClone(f.proof);
    if (condition === "stale") {
      proof.observedAt = proof.requestedAt = new Date(Date.now() - 600_000).toISOString();
      for (const row of proof.generations) {
        row.requestedAt = proof.requestedAt;
        row.expectedBy = new Date(Date.parse(proof.observedAt) + 6 * 3_600_000).toISOString();
      }
    }
    if (condition === "generation") proof.currentGeneration++;
    if (condition === "foreign-key") proof.deleteIdempotencyKey = randomUUID();
    if (condition === "live-authority") proof.accessRetired = false;
    f.setProof(condition === "missing" ? {} : proof);
    expect(await invocation.run()).toBe(1);
    expect(f.session.login).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled(); expect(f.infrastructure).not.toHaveBeenCalled();
    const checkpoint = await invocation.checkpoint();
    expect(checkpoint.result.success).toBe(false);
    expect(checkpoint.runs.find(run => run.runId === f.runId)?.lifecycle).toEqual(f.original.lifecycle);
  });

  it("carries consumed recovery and local handoff through a later execution with the unchanged secret", async () => {
    const f = await fixture(), first = await f.stage();
    expect(await first.run()).toBe(1);
    const before = await first.checkpoint(), next = await f.stage(first.artifact, first.execution);
    expect(await next.run()).toBe(1);
    const after = await next.checkpoint();
    expect(after.result.code).toBe("runtime_unavailable"); expect(f.create).toHaveBeenCalledTimes(2);
    expect("cleanupRecovery" in after && after.cleanupRecovery).toEqual("cleanupRecovery" in before && before.cleanupRecovery);
    expect("handoff" in after && after.handoff).toEqual(f.handoff);
    expect(after.runs.filter(run => run.runId === f.runId)).toHaveLength(1);
  });

  it("refuses a validly signed but byte-different predecessor before authentication", async () => {
    const f = await fixture(), changed = path.join(f.root, "changed.json");
    await writeFile(changed, f.sourceBytes.toString("utf8") + "\n", { mode: 0o600 });
    const invocation = await f.stage(changed);
    expect(await invocation.run()).toBe(1);
    expect((await invocation.checkpoint()).result.code).toBe("artifact_invalid");
    expect(f.session.login).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
});
