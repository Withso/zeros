import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { ComputerTemplateWorker, type ComputerTemplateWorkerDependencies } from "./computer-template-worker.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { seedComputerTemplateRuntime, templateRuntime as runtime } from "./computer-template-test-fixtures.js";
import { CloudComputerBuildQualificationSchema, canonicalBuildQualification, type CloudComputerBuildQualification } from "./computer-build-qualification-contract.js";
import { ComputerTemplateSnapshots } from "./computer-template-snapshots.js";
import { verifyComputerTemplateSavedTree, type ComputerNamedSnapshot, type ComputerTemplateSnapshotProvider } from "./computer-template-snapshot-boat.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const tcb = "e".repeat(64), accountScope = "fixture-account", billingOrg = "fixture-wallet";
const diagnostic = (stage: string, component = "build") => ({ schema: "zeros.diagnostic/v1", component, stage,
  ok: true, exitCode: 0, timedOut: false, failedChecks: [] });
const sample = JSON.parse(readFileSync(new URL("../../../../packages/protocol/src/__tests__/fixtures/cloud-build-qualification.valid.json", import.meta.url), "utf8"));

database("Computer worker build qualification checkpoint", () => {
  let pool: pg.Pool, service: DatabaseCloudComputerV2Service;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let deps: ComputerTemplateWorkerDependencies, provider: ComputerTemplateSnapshotProvider;
  let enabled: boolean, offer: "build" | "full" | "invalid";
  let produced: CloudComputerBuildQualification | undefined;
  let afterProduce: (() => Promise<void>) | undefined, duringProof: (() => Promise<void>) | undefined;
  let calls: Array<{ command: string; value: any }>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await seedComputerTemplateRuntime(pool, { buildQualificationVersion: 1, qualified: true });
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    service = new DatabaseCloudComputerV2Service(pool, { settingsSecretKeyV1: randomBytes(32).toString("base64url") } as CloudWorkspaceBackendConfig);
    enabled = true; offer = "build"; produced = undefined; afterProduce = undefined; duringProof = undefined; calls = [];
    const operations = new DatabaseBuilderVmOperationStore(pool, accountScope);
    const names = new Map<string, ComputerNamedSnapshot>();
    provider = {
      assertStopped: vi.fn(async () => {}),
      get: vi.fn(async name => names.get(name) ?? null),
      save: vi.fn(async (sourceSandboxId, name) => { names.set(name, { name, sourceSandboxId, status: "ready", snapshotId: `capture_${name}`, sizeBytes: 4096 }); }),
      prove: vi.fn(async (identity, required) => {
        const root = `__system__/srv/zeros/runtime-installs/build-qualifications/${required?.buildId}`;
        const entries = [{ path: "__system__/srv/zeros/computer-template.json", kind: "file", size: 512 },
          ...(required ? [{ path: `${root}/integrity.json`, kind: "file", size: 8192 },
            { path: `${root}/evidence.json`, kind: "file", size: required.evidenceBytes },
            { path: `${root}/report.json`, kind: "file", size: 2048 }] : [])];
        const proof = verifyComputerTemplateSavedTree({ ok: true, type: "snapshot.tree", snapshotId: identity.snapshotId,
          sandboxId: identity.sourceSandboxId, treeAvailable: true, truncated: false, entries }, identity, required);
        await duringProof?.();
        return proof;
      }),
      remove: vi.fn(async value => { names.delete(value.name); return true; }),
    };
    deps = {
      pool, service, operations, accountScope, billingOrg, pollMs: 0, channel: "alpha",
      flags: { enabled: org => enabled && org === fixture.organizationId, anyEnabled: () => enabled },
      runtime: { select: async () => runtime, load: async () => runtime, validate: async () => true },
      artifacts: { presignGet: async () => ({ url: "https://artifacts.example.test/runtime", expiresAt: new Date(Date.now() + 900_000).toISOString() }) },
      github: { mintContentsRead: async () => { throw new Error("no repository in this fixture"); }, revoke: async () => {} },
      snapshots: new ComputerTemplateSnapshots(pool, { provider, channel: "alpha", accountScope, billingOrg, pollMs: 0 }),
      vms: {
        create: vi.fn(async intent => {
          await operations.beginCreateAttempt(intent.operationKey, randomUUID());
          await operations.bind(intent.operationKey, "bx_23456789");
          await operations.state(intent.operationKey, "ready");
          return { sandboxId: "bx_23456789", purpose: intent.purpose, operationKey: intent.operationKey };
        }),
        baseStatus: async () => ({ schema: "zeros.base-status/v1", baseCompatibilityId: runtime.baseCompatibilityId,
          currentRuntimeId: null, bootId: randomUUID(), hostState: "idle" }),
        waitForBase: async vm => deps.vms.baseStatus(vm),
        stop: vi.fn(async vm => { await operations.state(vm.operationKey, "archived"); return { archived: true }; }),
        delete: vi.fn(async vm => { await operations.state(vm.operationKey, "deleted"); }),
        runFixed: vi.fn(async (vm, command, input) => {
          const value = input ? JSON.parse(command === "install-runtime" ? Buffer.from(input.toString(), "base64url").toString() : input.toString()) : {};
          calls.push({ command, value });
          let result: unknown, stage = "done", component = "build";
          if (command === "install-runtime") component = "installer";
          else if (command === "runtime-self-test") { stage = "self_test"; component = "qualification"; }
          else if (command === "computer:clone-repos") {
            stage = "repositories"; result = { schema: "zeros.computer-repositories/v1", buildId: value.buildId, repositories: [] };
          } else if (command === "computer:verify-tcb") {
            stage = "integrity"; result = { schema: "zeros.computer-tcb/v1", buildId: value.buildId, runtimeId: runtime.descriptor.runtimeId,
              baseCompatibilityId: runtime.baseCompatibilityId, protectedContractDigest: tcb };
          } else if (command === "computer:run-install") {
            stage = "install"; result = { schema: "zeros.computer-install/v1", buildId: value.buildId, workerFence: value.workerFence,
              state: "succeeded", exitCode: 0, timedOut: false, truncated: false, chunks: [], nextAfter: 0 };
          } else if (command === "computer:qualify-build") {
            stage = "integrity";
            if (offer === "build") {
              produced = CloudComputerBuildQualificationSchema.parse({ ...structuredClone(sample), scope: value.scope,
                builder: { ...value.builder, helperFence: value.workerFence, workerFence: value.producerFence, bootId: randomUUID() },
                runtime: { ...value.runtime, installerReceiptSha256: "9".repeat(64) },
                base: { ...value.base, protectedContractSha256: value.protectedContractSha256, bootIntegritySha256: "8".repeat(64) },
                sanitationManifestSha256: value.sanitationManifestSha256, qualifiedAt: new Date().toISOString() });
              result = { schema: "zeros.computer-build-producer/v1", mode: "build", evidence: produced };
            } else result = { schema: "zeros.computer-build-producer/v1", mode: offer };
            await afterProduce?.();
          } else if (command === "computer:sanitize") {
            stage = "sanitation";
            const row = (await pool.query("SELECT evidence_sha256 FROM cloud_computer_build_qualifications WHERE build_id=$1", [value.buildId])).rows[0];
            if (produced) expect(value.qualification).toEqual({ evidenceSha256: row?.evidence_sha256.toString("hex") });
            result = { schema: "zeros.computer-sanitation/v1", buildId: value.buildId, clean: true, manifestSha256: value.manifestSha256 };
          } else throw new Error("unexpected fixed helper");
          return { exitCode: 0, stdout: result ? JSON.stringify(result) : "", diagnostic: diagnostic(stage, component) };
        }),
      },
    };
  });
  const request = () => service.build(fixture.organizationId, fixture.userId, { expectedRevision: 0, operationId: randomUUID(),
    draft: { repositories: [], installScript: "", timeoutSeconds: 900 } });
  const state = async () => (await pool.query("SELECT id,state,stage,worker_fence,helper_fence,started_at,deadline_at,error_code FROM cloud_computer_v2_builds")).rows[0];
  const count = (command: string) => calls.filter(call => call.command === command).length;
  const recorded = async () => (await pool.query("SELECT id,canonical_evidence,evidence_sha256 FROM cloud_computer_build_qualifications")).rows;
  const revoke = () => withSystemTx(pool, tx => tx.query(`UPDATE cloud_computer_build_qualifications SET revoked_at=clock_timestamp(),
    revocation_reason='qualification_withdrawn' WHERE build_id=$1`, [produced!.scope.buildId]));

  it("records the one complete producer result before sanitation and requires it in the exact saved artifact", async () => {
    await request(); await new ComputerTemplateWorker(deps).tick();
    expect(await state()).toMatchObject({ state: "succeeded", stage: "done" });
    expect(count("computer:qualify-build")).toBe(1); expect(count("runtime-self-test")).toBe(0);
    const rows = await recorded(); expect(rows).toHaveLength(1);
    expect(rows[0].canonical_evidence).toBe(canonicalBuildQualification(produced!));
    const evidenceSha256 = createHash("sha256").update(rows[0].canonical_evidence).digest("hex");
    expect(provider.prove).toHaveBeenCalledWith(expect.objectContaining({ sourceSandboxId: "bx_23456789" }),
      { buildId: produced!.scope.buildId, evidenceSha256, evidenceBytes: Buffer.byteLength(rows[0].canonical_evidence) });
  });

  it.each(["flag off", "old runtime"])("retains full qualification without records for %s", async cohort => {
    if (cohort === "flag off") enabled = false; else offer = "full";
    await request(); await new ComputerTemplateWorker(deps).tick();
    expect(await state()).toMatchObject({ state: "succeeded" });
    expect(count("runtime-self-test")).toBe(1); expect(await recorded()).toHaveLength(0);
    expect(count("computer:qualify-build")).toBe(cohort === "flag off" ? 0 : 1);
    expect(calls.find(call => call.command === "computer:sanitize")?.value.qualification).toBeUndefined();
  });

  it("refuses an unsupported present producer result without running a fallback self-test", async () => {
    offer = "invalid"; await request(); await new ComputerTemplateWorker(deps).tick();
    expect(await state()).toMatchObject({ state: "failed", error_code: "integrity_failed" });
    expect(count("runtime-self-test")).toBe(0); expect(count("computer:sanitize")).toBe(0); expect(await recorded()).toHaveLength(0);
  });

  it("does not publish evidence when the original build deadline expires during the helper", async () => {
    afterProduce = async () => { await pool.query("UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [produced!.scope.buildId]); };
    await request(); await new ComputerTemplateWorker(deps).tick();
    expect(await recorded()).toHaveLength(0); expect(count("computer:sanitize")).toBe(0);
    expect((await state()).state).toBe("failed");
  });

  it("refuses a stale local producer result instead of adopting it as an acknowledgement", async () => {
    afterProduce = async () => { produced!.builder.workerFence--; };
    await request(); await new ComputerTemplateWorker(deps).tick();
    expect(await state()).toMatchObject({ state: "failed", error_code: "integrity_failed" });
    expect(await recorded()).toHaveLength(0); expect(count("runtime-self-test")).toBe(0);
  });

  it("keeps acknowledged evidence across shutdown and a flag-off handoff without rerunning probes", async () => {
    await request();
    let reached!: () => void, release!: () => void;
    const atStage = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const mark = service.markBuildStage.bind(service);
    vi.spyOn(service, "markBuildStage").mockImplementation(async (...args) => {
      const result = await mark(...args);
      if (args[2] === "sanitation") { reached(); await held; }
      return result;
    });
    const stop = new ComputerTemplateWorker(deps).start();
    try {
      await atStage;
      const original = await state(), rows = await recorded();
      expect(rows).toHaveLength(1);
      const stopping = stop(); release(); await stopping; enabled = false;
      await new ComputerTemplateWorker(deps).tick();
      expect(await state()).toMatchObject({ state: "succeeded", helper_fence: original.helper_fence,
        started_at: original.started_at, deadline_at: original.deadline_at });
      expect(await recorded()).toEqual(rows);
      expect(count("computer:qualify-build")).toBe(1); expect(count("runtime-self-test")).toBe(0);
    } finally { release(); await stop(); }
  });

  it("rechecks evidence revocation after saved-tree I/O before publishing a ready snapshot", async () => {
    duringProof = async () => { await revoke(); };
    await request(); await new ComputerTemplateWorker(deps).tick();
    expect((await state()).state).toBe("failed");
    expect((await pool.query("SELECT state FROM cloud_computer_template_snapshots")).rows.every(row => row.state !== "ready")).toBe(true);
    expect(count("runtime-self-test")).toBe(0);
  });
});
