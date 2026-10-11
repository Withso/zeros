import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { BuilderVmError, prepareBuilderVmOperation, type BaseStatus, type BuilderVm, type CloudBuilderVms } from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore, type BuilderVmIntent } from "./cloud-builder-vm-store.js";
import type { ClosedDiagnostic } from "./cloud-builder-commands.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { CloudProviderError } from "./provider.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { RuntimeImageWorker, lockReadyRuntimeImage, quarantineRuntimeImage, type RuntimeImageSnapshot,
  type RuntimeImageSnapshots } from "./runtime-images.js";
import { runtimeBase, seedRuntimeBase, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const SCOPE = "zeros-v2-test-account";
const WALLET = "team_11111111-1111-4111-8111-111111111111";
const SANDBOXES = [..."23456789abcdefghjkmnpqrstuvwxyz"].map(first => `bx_${first}2345678`);
const ok = (component: string, stage: string): ClosedDiagnostic => ({ schema: "zeros.diagnostic/v1", component, stage,
  ok: true, exitCode: 0, timedOut: false, failedChecks: [] });
const failed = (component: string, stage: string, check: string): ClosedDiagnostic => ({ schema: "zeros.diagnostic/v1",
  component, stage, ok: false, exitCode: 1, timedOut: false, failedChecks: [check] });

type Sandbox = { key: string; from: string | null; runtimeId: string | null; hostState: string; archived: boolean; deleted: boolean };

/** Two independent provider sandboxes over the real builder journal. */
class FakeVms implements CloudBuilderVms {
  readonly sandboxes = new Map<string, Sandbox>();
  readonly calls: string[] = [];
  readonly installs: Array<{ purpose: string; runtime: { runtimeId: string } }> = [];
  readonly tcbInputs: Array<Record<string, unknown>> = [];
  installDiagnostic: ClosedDiagnostic | null = ok("installer", "done");
  tcbDiagnostic: ClosedDiagnostic | null = ok("build", "integrity");
  probeRuntime: string | null | undefined;
  deleteFails = false;
  beforeDelete?: (vm: BuilderVm) => Promise<void>;
  beforeTcb?: () => Promise<void>;
  constructor(private readonly operations: DatabaseBuilderVmOperationStore, private readonly snapshots: FakeSnapshots) {}

  async create(intent: BuilderVmIntent): Promise<BuilderVm> {
    const row = await prepareBuilderVmOperation(this.operations, intent, async () => { throw new Error("unprepared intent"); });
    const vm = { sandboxId: row.sandbox_id ?? "", purpose: intent.purpose, operationKey: intent.operationKey };
    if (row.sandbox_id) return vm;
    await this.operations.beginCreateAttempt(intent.operationKey, randomUUID());
    const id = SANDBOXES[this.sandboxes.size]!;
    await this.operations.bind(intent.operationKey, id);
    const from = row.provider_request.body.from ?? null;
    const restored = from ? this.snapshots.saved.get(from) : undefined;
    this.sandboxes.set(id, { key: intent.operationKey, from, runtimeId: restored ? this.probeRuntime === undefined ? restored.runtimeId : this.probeRuntime : null,
      hostState: restored ? "idle" : "waiting_for_runtime", archived: false, deleted: false });
    await this.operations.state(intent.operationKey, "ready");
    this.calls.push(`create ${intent.operationKey.split(":")[0]} from ${restored ? "image" : from}`);
    return { ...vm, sandboxId: id };
  }
  private status(vm: BuilderVm): BaseStatus {
    const sandbox = this.sandboxes.get(vm.sandboxId)!;
    return { schema: "zeros.base-status/v1", baseCompatibilityId: runtimeBase.compatibilityId,
      bootId: "11111111-1111-4111-8111-111111111111", currentRuntimeId: sandbox.runtimeId, hostState: sandbox.hostState } as BaseStatus;
  }
  async baseStatus(vm: BuilderVm) { return this.status(vm); }
  async waitForBase(vm: BuilderVm) { return this.status(vm); }
  async runFixed(vm: BuilderVm, command: string, input?: Buffer) {
    const sandbox = this.sandboxes.get(vm.sandboxId)!;
    this.calls.push(`${command} on ${vm.operationKey.split(":")[0]}`);
    if (command === "install-runtime") {
      const value = JSON.parse(Buffer.from(input!.toString(), "base64url").toString());
      this.installs.push(value);
      if (this.installDiagnostic?.ok) { sandbox.runtimeId = value.runtime.runtimeId; sandbox.hostState = "idle"; }
      return { exitCode: this.installDiagnostic?.ok ? 0 : 1, stdout: "", diagnostic: this.installDiagnostic };
    }
    await this.beforeTcb?.();
    const value = JSON.parse(input!.toString());
    this.tcbInputs.push(value);
    const proof = { schema: "zeros.computer-tcb/v1", buildId: value.buildId, runtimeId: sandbox.runtimeId,
      baseCompatibilityId: value.baseCompatibilityId, protectedContractDigest: "e".repeat(64) };
    return { exitCode: this.tcbDiagnostic?.ok ? 0 : 1, diagnostic: this.tcbDiagnostic,
      stdout: `${JSON.stringify(proof)}\n${JSON.stringify(this.tcbDiagnostic)}\n` };
  }
  async stop(vm: BuilderVm, options?: { requireSnapshot?: boolean }) {
    this.calls.push(`stop ${vm.operationKey.split(":")[0]}${options?.requireSnapshot ? " with snapshot" : ""}`);
    this.sandboxes.get(vm.sandboxId)!.archived = true;
    await this.operations.state(vm.operationKey, "archived");
    return { archived: true as const };
  }
  async delete(vm: BuilderVm) {
    await this.beforeDelete?.(vm);
    if (this.deleteFails) throw new BuilderVmError("cleanup_unconfirmed");
    const row = await this.operations.find(vm.operationKey);
    if (!row || row.purpose !== vm.purpose || row.sandbox_id !== vm.sandboxId) throw new BuilderVmError("cleanup_unconfirmed");
    if (row.state === "deleted") return;
    this.calls.push(`delete ${vm.operationKey.split(":")[0]}`);
    this.sandboxes.get(vm.sandboxId)!.deleted = true;
    await this.operations.state(vm.operationKey, "deleting");
    await this.operations.state(vm.operationKey, "deleted");
  }
}

class FakeSnapshots implements RuntimeImageSnapshots {
  readonly saved = new Map<string, { status: "saving" | "ready" | "failed"; sourceSandboxId: string; runtimeId: string | null }>();
  readonly removed: string[] = [];
  saves = 0;
  lostSaves = 0;
  acceptLostSaves = false;
  saveStatus: "ready" | "failed" = "ready";
  vms!: FakeVms;
  async save(sandboxId: string, name: string) {
    this.saves++;
    const source = this.vms.sandboxes.get(sandboxId);
    if (!source?.archived) throw new Error("save from a running builder");
    const record = () => this.saved.set(name, { status: this.saveStatus, sourceSandboxId: sandboxId, runtimeId: source.runtimeId });
    if (this.lostSaves > 0) {
      this.lostSaves--;
      if (this.acceptLostSaves) record();
      throw new CloudProviderError("provider_request_timeout", "lost", true);
    }
    record();
    return "saving" as const;
  }
  async get(name: string): Promise<RuntimeImageSnapshot | null> {
    const value = this.saved.get(name);
    return value ? { name, status: value.status, sourceSandboxId: value.sourceSandboxId,
      ...(value.status === "ready" ? { snapshotId: `snap_${name.slice(-8)}`, sizeBytes: 3_221_225_472 } : {}) } : null;
  }
  async remove(name: string) {
    this.removed.push(name);
    this.saved.delete(name);
    return "gone" as const;
  }
}

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("runtime images with PostgreSQL and fake Boat", () => {
  let pool: pg.Pool;
  let operations: DatabaseBuilderVmOperationStore;
  let snapshots: FakeSnapshots;
  let vms: FakeVms;
  let artifacts: RuntimeArtifactStore;
  let clock: number;
  let runtimeId: string;
  const worker = (enabled = true, options: { accountScope?: string } = {}) => new RuntimeImageWorker({ pool, enabled, channel: "alpha",
    mode: "full", accountScope: options.accountScope ?? SCOPE, billingOrg: WALLET, vms, operations, artifacts, snapshots,
    now: () => clock, wait: async ms => { clock += ms; } });
  const images = () => withSystemTx(pool, async tx => (await tx.query(`SELECT * FROM cloud_runtime_images ORDER BY created_at,image_id`)).rows);
  const lockInput = (overrides: Partial<Parameters<typeof lockReadyRuntimeImage>[1]> = {}) => ({ channel: "alpha" as const, runtimeId,
    baseImageId: runtimeBase.id, baseCompatibilityId: runtimeBase.compatibilityId, accountScope: SCOPE, billingOrg: WALLET, ...overrides });

  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    clock = Date.now();
    operations = new DatabaseBuilderVmOperationStore(pool, SCOPE);
    snapshots = new FakeSnapshots();
    vms = new FakeVms(operations, snapshots);
    snapshots.vms = vms;
    artifacts = { head: vi.fn(), presignCreatePut: vi.fn(), presignGet: vi.fn(async () => ({
      url: "https://objects.example.test/private-artifact-value", expiresAt: new Date(clock + 600_000).toISOString(),
    })) };
    runtimeId = await withSystemTx(pool, async tx => { await seedRuntimeBase(tx); return (await seedRuntimeBundle(tx)).descriptor.runtimeId; });
  });

  it("publishes a cold-verified image only after its builder and probe are deleted", async () => {
    vms.beforeDelete = async () => { expect((await images())[0].state).toBe("building"); };
    await worker().tick();
    const [image] = await images();
    expect(image).toMatchObject({ state: "ready", channel: "alpha", runtime_id: runtimeId, base_image_id: runtimeBase.id,
      account_scope: SCOPE, billing_org: WALLET, snapshot_id: expect.stringMatching(/^snap_/), size_bytes: "3221225472",
      verified_at: expect.any(Date), ready_at: expect.any(Date), cleanup_confirmed_at: expect.any(Date), diagnostic: null });
    expect(image.snapshot_name).toMatch(new RegExp(`^zeros-rtimg-alpha-${runtimeId.slice(3, 15)}-[a-f0-9]{8}$`));
    expect(vms.calls).toEqual(["create runtime-image from zeros-v2-test-base", "install-runtime on runtime-image",
      "stop runtime-image with snapshot", "create runtime-image-probe from image", "computer:verify-tcb on runtime-image-probe",
      "delete runtime-image-probe", "delete runtime-image"]);
    expect(vms.installs).toEqual([expect.objectContaining({ purpose: "build", runtime: expect.objectContaining({ runtimeId }) })]);
    expect(vms.tcbInputs).toEqual([{ schema: "zeros.computer-tcb-input/v1", buildId: image.image_id, workerFence: 1,
      runtimeId, baseCompatibilityId: runtimeBase.compatibilityId, action: "baseline" }]);
    const probe = await operations.find(`runtime-image-probe:${image.image_id}`);
    expect(probe?.provider_request).toEqual({ path: "/sandboxes", body: { from: image.snapshot_name, name: `zeros-v2-rtimg-probe-${runtimeId.slice(3, 15)}`,
      type: "default", ttlSeconds: 1800, noEnv: true, env: {}, snapshots: true, monitoring: false } });
    expect((await operations.find(`runtime-image:${image.image_id}`))?.provider_request.body).toMatchObject({ from: "zeros-v2-test-base", snapshots: true });

    await worker().tick();
    expect(vms.sandboxes.size).toBe(2);
    expect(await withSystemTx(pool, tx => lockReadyRuntimeImage(tx, lockInput()))).toEqual({ imageId: image.image_id, snapshotName: image.snapshot_name });
    for (const foreign of [{ channel: "beta" as const }, { accountScope: "zeros-v2-other-account" }, { billingOrg: "team_other" },
      { baseCompatibilityId: `bc1-${"9".repeat(64)}` }])
      expect(await withSystemTx(pool, tx => lockReadyRuntimeImage(tx, lockInput(foreign)))).toBeNull();
  });

  it("starts nothing while disabled yet still reconciles an overdue attempt and its name", async () => {
    await worker(false).tick();
    expect(await images()).toHaveLength(0);
    // A replica died after saving: builder bound, name requested and saved.
    const image = (await withSystemTx(pool, async tx => (await tx.query(`INSERT INTO cloud_runtime_images
      (channel,account_scope,billing_org,runtime_id,base_image_id,base_compatibility_id,snapshot_name,deadline_at)
      VALUES ('alpha',$1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour') RETURNING *`,
    [SCOPE, WALLET, runtimeId, runtimeBase.id, runtimeBase.compatibilityId, `zeros-rtimg-alpha-${runtimeId.slice(3, 15)}-0000aaaa`])).rows[0]));
    const intent: BuilderVmIntent = { purpose: "runtime-image", source: { kind: "base", baseImageId: runtimeBase.id },
      name: `zeros-v2-rtimg-${runtimeId.slice(3, 15)}`, operationKey: `runtime-image:${image.image_id}`, ttlSeconds: 1800 };
    await prepareBuilderVmOperation(operations, intent, async () => "zeros-v2-test-base");
    const builder = await vms.create(intent);
    await vms.stop(builder, { requireSnapshot: true });
    await snapshots.save(builder.sandboxId, image.snapshot_name);
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_runtime_images SET builder_sandbox_id=$2,snapshot_requested_at=clock_timestamp()
      WHERE image_id=$1`, [image.image_id, builder.sandboxId]));
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_runtime_images SET deadline_at=deadline_at+interval '1 hour'
      WHERE image_id=$1`, [image.image_id]))).rejects.toThrow(/immutable/);
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_runtime_images SET deadline_at=clock_timestamp()-interval '1 second' WHERE image_id=$1`, [image.image_id]));
    await worker(false).tick();
    expect(snapshots.removed).toEqual([image.snapshot_name]);
    expect(vms.sandboxes.get(builder.sandboxId)?.deleted).toBe(true);
    expect((await images())[0]).toMatchObject({ state: "failed", finished_at: expect.any(Date), cleanup_confirmed_at: expect.any(Date),
      diagnostic: { component: "qualification", stage: "reconcile", failedChecks: ["timeout"] } });
    expect(vms.sandboxes.size).toBe(1);
  });

  it("never reconciles another provider account's attempt", async () => {
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_runtime_images
      (channel,account_scope,billing_org,runtime_id,base_image_id,base_compatibility_id,snapshot_name,deadline_at,snapshot_requested_at,builder_sandbox_id)
      VALUES ('alpha','zeros-v2-other-account',$1,$2,$3,$4,$5,clock_timestamp()-interval '1 second',clock_timestamp(),$6)`,
    [WALLET, runtimeId, runtimeBase.id, runtimeBase.compatibilityId, `zeros-rtimg-alpha-${runtimeId.slice(3, 15)}-0000bbbb`, SANDBOXES[9]]));
    await worker(false).tick();
    expect(snapshots.removed).toEqual([]);
    expect((await images())[0]).toMatchObject({ state: "building", cleanup_lease_until: null });
  });

  it("deletes the builder of a failed install, saves no name and does not retry at once", async () => {
    vms.installDiagnostic = failed("installer", "download", "http_status");
    await worker().tick();
    expect((await images())[0]).toMatchObject({ state: "failed", snapshot_requested_at: null,
      diagnostic: { component: "installer", stage: "download", failedChecks: ["http_status"] } });
    expect(snapshots.saves).toBe(0);
    expect(vms.calls.at(-1)).toBe("delete runtime-image");
    await worker().tick();
    expect(await images()).toHaveLength(1);
  });

  it("stops after five failed attempts for one runtime and base", async () => {
    const insertFailed = (count: number) => withSystemTx(pool, async tx => {
      for (let index = 0; index < count; index++) await tx.query(`INSERT INTO cloud_runtime_images
        (channel,account_scope,billing_org,runtime_id,base_image_id,base_compatibility_id,snapshot_name,deadline_at,state,finished_at,cleanup_confirmed_at)
        VALUES ('alpha',$1,$2,$3,$4,$5,$6,clock_timestamp()-interval '2 hours','failed',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour')`,
      [SCOPE, WALLET, runtimeId, runtimeBase.id, runtimeBase.compatibilityId, `zeros-rtimg-alpha-${runtimeId.slice(3, 15)}-${randomUUID().slice(0, 8)}`]);
    });
    await insertFailed(5);
    await worker().tick();
    expect((await images()).filter(row => row.state !== "failed")).toHaveLength(0);
    await resetMigratedTestDatabase(pool);
    await withSystemTx(pool, async tx => { await seedRuntimeBase(tx); await seedRuntimeBundle(tx); });
    await insertFailed(4);
    await worker().tick();
    expect((await images()).filter(row => row.state === "ready")).toHaveLength(1);
  });

  it.each([
    ["restores without the runtime", () => { vms.probeRuntime = null; }, { stage: "probe", failedChecks: ["runtime_identity"] }],
    ["fails the full TCB proof", () => { vms.tcbDiagnostic = failed("build", "integrity", "tcb_modified"); },
      { component: "build", stage: "integrity", failedChecks: ["tcb_modified"] }],
    ["proves another runtime", () => { vms.probeRuntime = `r1-${"9".repeat(64)}`; }, { stage: "probe", failedChecks: ["runtime_identity"] }],
  ])("never publishes a probe that %s and deletes its name", async (_label, arrange, diagnostic) => {
    arrange();
    await worker().tick();
    const [image] = await images();
    expect(image).toMatchObject({ state: "failed", ready_at: null, diagnostic });
    expect(snapshots.removed).toEqual([image.snapshot_name]);
    expect([...vms.sandboxes.values()].every(sandbox => sandbox.deleted)).toBe(true);
  });

  it("reads back an ambiguous save instead of saving twice", async () => {
    Object.assign(snapshots, { lostSaves: 1, acceptLostSaves: true });
    await worker().tick();
    expect(snapshots.saves).toBe(1);
    expect((await images())[0].state).toBe("ready");
  });

  it("resends a save that never became readable after the grace period", async () => {
    Object.assign(snapshots, { lostSaves: 1, acceptLostSaves: false });
    const save = vi.spyOn(snapshots, "save");
    await worker().tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect((await images())[0].state).toBe("ready");
  });

  it("abandons a save that Boat reports failed", async () => {
    snapshots.saveStatus = "failed";
    await worker().tick();
    const [image] = await images();
    expect(image).toMatchObject({ state: "failed", diagnostic: { stage: "save", failedChecks: ["snapshot_failed"] } });
    expect(snapshots.removed).toEqual([image.snapshot_name]);
  });

  it("does not publish an image whose runtime was revoked while it was verified", async () => {
    vms.beforeTcb = async () => {
      await withSystemTx(pool, tx => tx.query(`UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1`, [runtimeId]));
    };
    await worker().tick();
    const [image] = await images();
    expect(image).toMatchObject({ state: "failed", diagnostic: { stage: "publish", failedChecks: ["runtime_ineligible"] } });
    expect(snapshots.removed).toEqual([image.snapshot_name]);
  });

  it("keeps a published image and its name when the publication reply is lost after commit", async () => {
    const producer = worker();
    const publish = (producer as unknown as { publish(row: unknown): Promise<string> }).publish;
    vi.spyOn(producer as unknown as { publish(row: unknown): Promise<string> }, "publish").mockImplementation(async function (this: unknown, row) {
      expect(await publish.call(this, row)).toBe("published");
      return "late";
    });
    await producer.tick();
    const [image] = await images();
    expect(image).toMatchObject({ state: "ready", cleanup_lease_until: null });
    expect(snapshots.removed).toEqual([]);
    expect(snapshots.saved.has(image.snapshot_name)).toBe(true);
  });

  it("hands an attempt with unconfirmed cleanup to reconciliation at once", async () => {
    vms.deleteFails = true;
    await worker().tick();
    let [image] = await images();
    expect(image).toMatchObject({ state: "building", verified_at: expect.any(Date), diagnostic: { stage: "cleanup", failedChecks: ["cleanup_unconfirmed"] } });
    expect(image.deadline_at.getTime()).toBeLessThanOrEqual(Date.now());
    vms.deleteFails = false;
    await worker().tick();
    [image] = await images();
    expect(image).toMatchObject({ state: "failed", diagnostic: { stage: "reconcile", failedChecks: ["timeout"] } });
    expect(snapshots.removed).toEqual([image.snapshot_name]);
  });

  it("keeps the two newest images and deletes an older name only after builders recorded with it are done", async () => {
    await worker().tick();
    for (const [digit, order] of [["b", 2], ["c", 3]] as const) {
      await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit, releaseOrder: order }));
      await worker().tick();
    }
    const [oldest] = await images();
    expect((await images()).map(row => row.state)).toEqual(["ready", "ready", "ready"]);
    const template = await seedTemplate(oldest.image_id);
    await worker().tick();
    expect((await images()).map(row => row.state)).toEqual(["retiring", "ready", "ready"]);
    expect((await images())[0].diagnostic).toMatchObject({ stage: "retire", failedChecks: ["superseded"] });
    expect(snapshots.removed).toEqual([]);
    expect(await withSystemTx(pool, tx => lockReadyRuntimeImage(tx, lockInput()))).toBeNull();
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_computer_templates SET state='quarantined' WHERE build_id=$1`, [template]));
    await worker().tick();
    expect(snapshots.removed).toEqual([]);
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_computer_templates SET cleanup_confirmed_at=now() WHERE build_id=$1`, [template]));
    await worker().tick();
    expect(snapshots.removed).toEqual([oldest.snapshot_name]);
    expect((await images()).map(row => row.state)).toEqual(["retired", "ready", "ready"]);
  });

  it("retires a revoked image without letting it use up the newest kept slots", async () => {
    await worker().tick();
    for (const [digit, order] of [["b", 2], ["c", 3]] as const) {
      await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit, releaseOrder: order }));
      await worker().tick();
    }
    const newest = (await images()).at(-1)!;
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_runtime_qualifications SET enabled=false,mcp_qualified=false,revoked_at=now()
      WHERE runtime_id=$1`, [newest.runtime_id]));
    await worker().tick();
    expect((await images()).map(row => row.state)).toEqual(["ready", "ready", "retired"]);
    expect((await images())[2].diagnostic).toMatchObject({ stage: "retire", failedChecks: ["runtime_revoked"] });
  });

  it("withdraws a ready image whose name disappeared and then retires it", async () => {
    await worker().tick();
    const [image] = await images();
    snapshots.saved.delete(image.snapshot_name);
    clock += 11 * 60_000;
    await worker().tick();
    expect((await images())[0]).toMatchObject({ state: "retired", retired_at: expect.any(Date),
      diagnostic: { component: "build", stage: "runtime", failedChecks: ["snapshot_missing"] } });
  });

  it("quarantines only a ready image and keeps its publication evidence", async () => {
    await worker().tick();
    const [image] = await images();
    vi.spyOn(snapshots, "get").mockResolvedValue({ name: image.snapshot_name, status: "ready" });
    const template = await seedTemplate(image.image_id);
    expect(await quarantineRuntimeImage(pool, image.image_id, "tcb_modified")).toBe(true);
    expect(await quarantineRuntimeImage(pool, image.image_id, "tcb_modified")).toBe(false);
    expect(await withSystemTx(pool, tx => lockReadyRuntimeImage(tx, lockInput()))).toBeNull();
    await worker().tick();
    expect((await images())[0]).toMatchObject({ state: "retiring", snapshot_id: image.snapshot_id, verified_at: image.verified_at,
      diagnostic: { component: "build", stage: "runtime", failedChecks: ["tcb_modified"] } });
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_computer_templates SET builder_source_image_id=NULL WHERE build_id=$1`,
      [template]))).rejects.toThrow(/immutable/);
  });

  it("enforces image identity, lifecycle and name contracts in the database", async () => {
    await worker().tick();
    const [image] = await images();
    const attempt = (sql: string, values: unknown[] = []) => withSystemTx(pool, tx => tx.query(sql, values));
    for (const sql of [`UPDATE cloud_runtime_images SET state='building' WHERE image_id=$1`,
      `UPDATE cloud_runtime_images SET state='failed',finished_at=now() WHERE image_id=$1`,
      `UPDATE cloud_runtime_images SET snapshot_id='snap_other' WHERE image_id=$1`,
      `UPDATE cloud_runtime_images SET runtime_id=runtime_id||'' , channel='beta' WHERE image_id=$1`,
      `DELETE FROM cloud_runtime_images WHERE image_id=$1`])
      await expect(attempt(sql, [image.image_id])).rejects.toThrow();
    for (const name of ["zeros-alpha-rt-aaaaaaaaaaaa-00000000", `zeros-rtimg-beta-${runtimeId.slice(3, 15)}-00000000`,
      `zeros-rtimg-alpha-${"9".repeat(12)}-00000000`])
      await expect(attempt(`INSERT INTO cloud_runtime_images (channel,account_scope,billing_org,runtime_id,base_image_id,
        base_compatibility_id,snapshot_name,deadline_at) VALUES ('alpha',$1,$2,$3,$4,$5,$6,now())`,
      [SCOPE, `${WALLET}-x`, runtimeId, runtimeBase.id, runtimeBase.compatibilityId, name])).rejects.toThrow();
  });

  async function seedTemplate(imageId: string) {
    const fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    const service = new DatabaseCloudComputerV2Service(pool, {} as CloudWorkspaceBackendConfig);
    const { configId } = await service.saveDraft(fixture.organizationId, fixture.userId,
      { expectedRevision: 0, repositories: [], installScript: "", timeoutSeconds: 900 });
    const buildId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_computer_v2_builds(id,org_id,version,config_id,accepted_revision,state,stage,requested_by,
          operation_id,base_image_id,runtime_id,completed_at)
        VALUES($1,$2,1,$3,1,'failed','runtime',$4,$5,$6,$7,now())`,
      [buildId, fixture.organizationId, configId, fixture.userId, randomUUID(), runtimeBase.id, runtimeId]);
      await tx.query(`INSERT INTO cloud_computer_templates(build_id,org_id,account_scope,billing_org,builder_operation_key,builder_name,
          allocation_requested_at,builder_source_image_id) VALUES($1,$2,$3,$4,$5,'zeros-v2-c-test',clock_timestamp(),$6)`,
      [buildId, fixture.organizationId, SCOPE, WALLET, `computer-build:${buildId}`, imageId]);
    });
    return buildId;
  }
});
