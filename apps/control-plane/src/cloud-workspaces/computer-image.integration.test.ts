import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { ensureHostedCloudProviderConnection } from "./provider-connections.js";
import { DatabaseCloudComputerService } from "./computer.js";
import {
  ComputerImageWorker,
  ComputerImageError,
  resolveComputerImage,
  type ComputerImage,
  type ComputerImageDriver,
  type ComputerSnapshot,
} from "./computer-image.js";

const base = `boat:release-base@sha256:${"a".repeat(64)}`;
const config = {
  provider: "boat",
  imageRef: base,
  sourceCommit: "b".repeat(40),
  architecture: "linux/amd64",
  cpuMillicores: 4000,
  memoryMiB: 8192,
  storageMiB: 70000,
  setupExecution: {},
  boat: { accountScope: "fixture", billingOrg: "fixture" },
} as CloudWorkspaceBackendConfig;
class FakeImages implements ComputerImageDriver {
  snapshots = new Map<string, ComputerSnapshot>();
  files = new Map<string, string[]>();
  creates: Array<{ role: string; image: string }> = [];
  failInstall = false;
  inventory = async () => [...this.snapshots.values()];
  async create(image: ComputerImage, role: "builder" | "verifier", beforeDispatch: () => Promise<void>) {
    await beforeDispatch();
    const id = `${role}-${image.id}`;
    if (!this.files.has(id)) {
      this.creates.push({
        role,
        image: role === "builder" ? image.base_image_ref : image.image_ref!,
      });
      this.files.set(
        id,
        role === "builder" ? [] : [...this.files.get(image.snapshot_name)!],
      );
    }
    return id;
  }
  ready = async () => true;
  async install(image: ComputerImage) {
    if (this.failInstall) throw new ComputerImageError("image_recipe_failed");
    this.files.set(image.builder_id!, [
      "bin/org-tool",
      "share/tool-data",
      ".codex/auth.json:synthetic-private-canary",
    ]);
    return true;
  }
  async sanitize(image: ComputerImage) {
    this.files.set(
      image.builder_id!,
      this.files
        .get(image.builder_id!)!
        .filter((file) => !file.includes("canary")),
    );
    return { buildSha256: "c".repeat(64) };
  }
  async capture(image: ComputerImage) {
    this.snapshots.set(image.snapshot_name, {
      name: image.snapshot_name,
      id: `snapshot-${image.id}`,
      source: image.builder_id!,
      ready: true,
    });
    this.files.set(image.snapshot_name, [
      ...this.files.get(image.builder_id!)!,
    ]);
  }
  snapshot = async (image: ComputerImage) =>
    this.snapshots.get(image.snapshot_name) ?? null;
  async attest(image: ComputerImage) {
    expect(this.files.get(image.verifier_id!)).toEqual([
      "bin/org-tool",
      "share/tool-data",
    ]);
    return {
      qualified: true,
      profile: "zeros-cloud-worker-v3",
      setupQualification: { secure: true },
      metadata: {
        buildSha256: image.build_sha256,
        build: {
          source: {
            commit: config.sourceCommit,
            contractSha256: "d".repeat(64),
          },
          imageContractSha256: "e".repeat(64),
        },
      },
    };
  }
  removeSandbox = async (_id: string) => true;
  async removeSnapshot(image: ComputerImage) {
    this.snapshots.delete(image.snapshot_name);
    return true;
  }
}
const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("sanitized organization images (fake Boat only)", () => {
  let pool: pg.Pool,
    service: DatabaseCloudComputerService,
    driver: FakeImages,
    worker: ComputerImageWorker;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 8,
    });
  });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    driver = new FakeImages();
    service = new DatabaseCloudComputerService(pool, config, driver);
    worker = new ComputerImageWorker(pool, "fixture", driver);
    await service.save(fixture.organizationId, fixture.userId, {
      expectedRevision: 0,
      operationId: randomUUID(),
      document: {
        repositories: [],
        installScript: "mkdir -p $PREFIX/bin",
        timeoutSeconds: 30,
      },
      sources: [],
    });
    await pool.query(
      `INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,qualified_at)
      VALUES('boat',$1,$2,'codex-api-key','zeros-cloud-worker-v3',true,now()) ON CONFLICT DO NOTHING`,
      [base, "d".repeat(64)],
    );
  });
  const build = (revision = 1, version = 1) =>
    service.build(fixture.organizationId, fixture.userId, {
      id: randomUUID(),
      expectedRevision: revision,
      version,
    });
  const drain = async () => {
    for (let i = 0; i < 11; i++) await worker.tick();
  };
  const read = () => service.read(fixture.organizationId, fixture.userId);
  const qualify = async (id: string) =>
    pool.query(
      `INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,qualified_at)
    SELECT 'boat',image_ref,$2,'codex-api-key','zeros-cloud-worker-v3',true,clock_timestamp() FROM cloud_computer_images WHERE id=$1`,
      [id, "d".repeat(64)],
    );
  it("captures installed tools/files, removes the canary, attests a fresh clone, and requires exact qualification", async () => {
    const { id } = await build();
    await drain();
    expect((await read()).history[0]).toMatchObject({
      id,
      state: "succeeded",
      artifact: { state: "attested", snapshotId: `snapshot-${id}` },
    });
    expect(driver.creates.map((row) => row.role)).toEqual([
      "builder",
      "verifier",
    ]);
    expect(JSON.stringify([...driver.files.values()])).not.toContain(
      "synthetic-private-canary",
    );
    await expect(
      service.activate(fixture.organizationId, fixture.userId, 1, 1, id),
    ).rejects.toMatchObject({ code: "cloud_computer_qualification_required" });
    await qualify(id);
    await service.activate(fixture.organizationId, fixture.userId, 1, 1, id);
    expect(
      (
        await withSystemTx(pool, (tx) =>
          resolveComputerImage(tx, fixture.organizationId, config),
        )
      ).imageRef,
    ).toContain(`zeros-org-${id.replaceAll("-", "")}`);
  });
  it("rejects stale activation and rolls back atomically without changing existing generations", async () => {
    const first = await build();
    await drain();
    await qualify(first.id);
    await service.activate(
      fixture.organizationId,
      fixture.userId,
      1,
      1,
      first.id,
    );
    await service.save(fixture.organizationId, fixture.userId, {
      expectedRevision: 2,
      operationId: randomUUID(),
      document: { repositories: [], installScript: "true", timeoutSeconds: 30 },
      sources: [],
    });
    const second = await build(3, 2);
    await drain();
    await qualify(second.id);
    await expect(
      service.activate(fixture.organizationId, fixture.userId, 2, 2, second.id),
    ).rejects.toMatchObject({ code: "cloud_computer_changed" });
    await service.activate(
      fixture.organizationId,
      fixture.userId,
      3,
      2,
      second.id,
    );
    await service.rollback(fixture.organizationId, fixture.userId, 4, first.id);
    expect((await read()).activeArtifactId).toBe(first.id);
    expect(
      (
        await pool.query(
          "SELECT image_ref FROM cloud_workspace_generations WHERE workspace_id=$1",
          [fixture.workspaceId],
        )
      ).rows[0].image_ref,
    ).not.toContain("zeros-org-");
  });
  it("serializes concurrent builders and reserves before allocation", async () => {
    const outcomes = await Promise.allSettled([build(), build()]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(driver.creates).toEqual([]);
    await Promise.all([
      worker.tick(),
      new ComputerImageWorker(pool, "fixture", driver).tick(),
    ]);
    await drain();
    expect(driver.creates.filter((row) => row.role === "builder")).toHaveLength(
      1,
    );
  });
  it("lets the provider accept a capture beyond ten names after a plan upgrade", async () => {
    for (let i = 0; i < 20; i++)
      driver.snapshots.set(`release-${i}`, {
        name: `release-${i}`,
        id: `snapshot-${i}`,
        source: "release",
        ready: true,
      });
    await expect(build()).resolves.toBeDefined();
    expect(driver.creates).toEqual([]);
    await drain();
    expect(driver.snapshots.size).toBe(21);
  });
  it("counts another organization's pending reservation before the provider has captured it", async () => {
    for (let i = 0; i < 9; i++) driver.snapshots.set(`release-${i}`, { name: `release-${i}`, id: `snapshot-${i}`, source: "release", ready: true });
    await build();
    fixture = await seedReadyCloudWorkspace(pool);
    await service.save(fixture.organizationId, fixture.userId, { expectedRevision: 0, operationId: randomUUID(),
      document: { repositories: [], installScript: "true", timeoutSeconds: 30 }, sources: [] });
    const assertCapacity = vi.fn(async (_names: string[]) => {});
    Object.assign(driver, { assertCapacity });
    await expect(build()).resolves.toBeDefined();
    expect(new Set(assertCapacity.mock.calls[0]![0]).size).toBe(10);
    expect(driver.creates).toEqual([]);
  });
  it("does not let the previous workspace worker mark an image build complete", async () => {
    const { id } = await build();
    await expect(pool.query("UPDATE cloud_computer_builds SET state='failed',cleanup_state='complete' WHERE id=$1", [id])).rejects.toThrow("image worker owns");
    expect((await read()).history[0]).toMatchObject({ state: "building", artifact: { state: "reserved" } });
  });
  it("rejects a fresh build when its payer loses Pro admission", async () => {
    await pool.query("UPDATE users SET staff_role=null WHERE id=$1", [fixture.userId]);
    await pool.query("UPDATE account_entitlements SET plan='free',cloud_workspaces_allowed=false WHERE user_id=$1", [fixture.userId]);
    await expect(build()).rejects.toMatchObject({ code: "cloud_account_entitlement_required" });
    expect(driver.creates).toEqual([]);
  });
  it("failed and cancelled builds never activate", async () => {
    driver.failInstall = true;
    const first = await build();
    await drain();
    expect((await read()).history[0]).toMatchObject({
      state: "failed",
      errorCode: "image_recipe_failed",
    });
    driver.failInstall = false;
    const second = await build();
    await service.cancel(fixture.organizationId, fixture.userId, second.id);
    await drain();
    expect(
      (await read()).history.find((row) => row.id === second.id),
    ).toMatchObject({ state: "cancelled" });
    await expect(
      service.activate(fixture.organizationId, fixture.userId, 1, 1, first.id),
    ).rejects.toMatchObject({ code: "cloud_computer_not_built" });
  });
  it("cancels a reserved build without allocating a cleanup VM", async () => {
    const { id } = await build();
    await service.cancel(fixture.organizationId, fixture.userId, id);
    await drain();
    expect(driver.creates).toEqual([]);
    expect((await read()).history[0]).toMatchObject({
      state: "cancelled",
      cleanupState: "complete",
    });
  });
  it("recovers an ambiguous verifier create before releasing its reservation", async () => {
    const create = driver.create.bind(driver);
    let lost = true;
    vi.spyOn(driver, "create").mockImplementation(async (image, role, beforeDispatch) => {
      const id = await create(image, role, beforeDispatch);
      if (role === "verifier" && lost) {
        lost = false;
        throw new Error("synthetic lost reply");
      }
      return id;
    });
    const deleted = vi.spyOn(driver, "removeSandbox");
    const { id } = await build();
    await drain();
    await drain();
    expect(
      deleted.mock.calls.some((args) => args[0] === `verifier-${id}`),
    ).toBe(true);
    expect((await read()).history[0]).toMatchObject({
      state: "failed",
      cleanupState: "complete",
    });
  });
  it("cancellation during attestation cannot publish success", async () => {
    const attest = driver.attest.bind(driver);
    vi.spyOn(driver, "attest").mockImplementation(async (image) => {
      await service.cancel(fixture.organizationId, fixture.userId, image.id);
      return attest(image);
    });
    await build();
    await drain();
    expect((await read()).history[0]).toMatchObject({ state: "cancelled" });
    expect((await read()).activeArtifactId).toBeNull();
  });
  it("keeps active, rollback and generation references; retires only unreferenced org images", async () => {
    const first = await build();
    await drain();
    await qualify(first.id);
    await service.activate(
      fixture.organizationId,
      fixture.userId,
      1,
      1,
      first.id,
    );
    await pool.query(
      "UPDATE cloud_computer_images SET created_at=now()-interval '8 days' WHERE id=$1",
      [first.id],
    );
    await worker.retire();
    expect((await read()).history[0]?.artifact?.state).toBe("attested");
    await pool.query(
      "UPDATE cloud_computers SET active_image_id=null,previous_image_id=$1 WHERE org_id=$2",
      [first.id, fixture.organizationId],
    );
    await worker.retire();
    expect((await read()).history[0]?.artifact?.state).toBe("attested");
    await pool.query(
      "UPDATE cloud_computers SET previous_image_id=null WHERE org_id=$1",
      [fixture.organizationId],
    );
    const connection = await withSystemTx(pool, (tx) =>
      ensureHostedCloudProviderConnection(tx, {
        organizationId: fixture.organizationId,
        ownerUserId: fixture.userId,
        isPersonal: false,
        provider: "boat",
        actorUserId: fixture.userId,
      }),
    );
    await pool.query(
      `INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id)
      SELECT g.workspace_id,2,g.org_id,'boat',image.image_ref,g.architecture,g.cpu_millicores,g.memory_mib,g.storage_mib,g.source_commit,g.created_by,$3
      FROM cloud_workspace_generations g JOIN cloud_computer_images image ON image.id=$2 WHERE g.workspace_id=$1 AND g.generation=1`,
      [fixture.workspaceId, first.id, connection.id],
    );
    await worker.retire();
    expect((await read()).history[0]?.artifact?.state).toBe("attested");
    const second = await build(2);
    await drain();
    await pool.query(
      "UPDATE cloud_computer_images SET created_at=now()-interval '8 days' WHERE id=$1",
      [second.id],
    );
    await worker.retire();
    await drain();
    expect(driver.snapshots.size).toBe(1);
  });
  it("keeps an unreferenced org image promoted to the configured base", async () => {
    const { id } = await build();
    await drain();
    const imageRef = (await read()).history[0]!.artifact!.imageRef!;
    await pool.query("UPDATE cloud_computer_images SET created_at=now()-interval '8 days' WHERE id=$1", [id]);
    const promoted = new ComputerImageWorker(pool, "fixture", driver, [imageRef]);
    await promoted.retire();
    expect((await read()).history[0]!.artifact!.state).toBe("attested");
    expect(driver.snapshots.size).toBe(1);
  });
});
