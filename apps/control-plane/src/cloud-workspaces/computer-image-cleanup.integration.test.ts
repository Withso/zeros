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
import type { BoatApiClient } from "./boat-client.js";
import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudComputerService } from "./computer.js";
import { cloudWorkspaceProvisioningProfile } from "./provisioning-profile.js";
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
  async create(
    image: ComputerImage,
    role: "builder" | "verifier",
    beforeDispatch: () => Promise<void>,
  ) {
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
d("V12 adversarial image review", () => {
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

  it("V12 pre-dispatch rejection releases the reserved slot without provider allocation", async () => {
    const { BoatComputerImageDriver } =
      await import("./computer-image-boat.js");
    const request = vi.fn();
    const realDriver = new BoatComputerImageDriver(
      { request } as unknown as BoatApiClient,
      "fixture",
    );
    worker = new ComputerImageWorker(pool, "fixture", realDriver);
    await build();
    vi.stubEnv("ZEROS_DEV_ENVIRONMENT", "hosted");
    vi.stubEnv(
      "ZEROS_DEV_ADMISSION_EXPIRES_AT",
      new Date(Date.now() - 1000).toISOString(),
    );
    try {
      await drain();
      expect(request).not.toHaveBeenCalled();
      expect((await read()).history[0]).toMatchObject({
        state: "failed",
        cleanupState: "complete",
        artifact: { state: "retired" },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("V12 a failed build after a certified create refusal never allocates a cleanup-only VM", async () => {
    const { BoatCreateRejectedError } = await import("./boat-client.js");
    const create = driver.create.bind(driver);
    let refuse = true;
    vi.spyOn(driver, "create").mockImplementation(
      async (image, role, beforeDispatch) => {
        if (refuse) {
          refuse = false;
          await beforeDispatch();
          throw new BoatCreateRejectedError(
            "provider_rate_limited",
            true,
            "limit_reached",
            {},
          );
        }
        return create(image, role, beforeDispatch);
      },
    );
    await build();
    await drain();
    expect(driver.creates).toEqual([]);
    expect((await read()).history[0]).toMatchObject({
      state: "failed",
      cleanupState: "complete",
    });
  });
  it("V12 failed build and cancelled verifier still delete the known builder if replay is blocked", async () => {
    const create = driver.create.bind(driver);
    vi.spyOn(driver, "create").mockImplementation(
      async (image, role, beforeDispatch) => {
        if (role === "verifier")
          throw new ComputerImageError("image_build_admission_expired");
        return create(image, role, beforeDispatch);
      },
    );
    const deleted = vi.spyOn(driver, "removeSandbox");
    const { id } = await build();
    await drain();
    await drain();
    expect(deleted).toHaveBeenCalledWith(
      `builder-${id}`,
      null,
      expect.any(Function),
    );
    expect((await read()).history[0]).toMatchObject({
      state: "failed",
      cleanupState: "complete",
    });
  });
  it("V12 a lost capture response with an observable snapshot is cleaned", async () => {
    const capture = driver.capture.bind(driver);
    vi.spyOn(driver, "capture").mockImplementation(async (image) => {
      await capture(image);
      throw new Error("synthetic lost response");
    });
    await build();
    await drain();
    await drain();
    expect(driver.snapshots.size).toBe(0);
    expect((await read()).history[0]).toMatchObject({
      state: "failed",
      cleanupState: "complete",
      artifact: { state: "retired" },
    });
  });
  it("V12 image activation requires fresh qualification for every base credential kind", async () => {
    const { id } = await build();
    await drain();
    await qualify(id);
    await pool.query(
      `INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,qualified_at) VALUES('boat',$1,$2,'claude-api-key','zeros-cloud-worker-v3',true,now())`,
      [base, "d".repeat(64)],
    );
    await expect(
      service.activate(fixture.organizationId, fixture.userId, 1, 1, id),
    ).rejects.toMatchObject({ code: "cloud_computer_qualification_required" });
    await pool.query(
      `DELETE FROM cloud_agent_runtime_qualifications WHERE credential_kind='claude-api-key'`,
    );
    await pool.query(
      `UPDATE cloud_agent_runtime_qualifications SET qualified_at=now()-interval '1 hour' WHERE image_ref<>$1`,
      [base],
    );
    await expect(
      service.activate(fixture.organizationId, fixture.userId, 1, 1, id),
    ).rejects.toMatchObject({ code: "cloud_computer_qualification_required" });
  });
  it("V12 image retirement completes the persisted build cleanup after an offline interval", async () => {
    await build();
    for (let i = 0; i < 7; i++) await worker.tick();
    expect((await read()).history[0]).toMatchObject({
      state: "succeeded",
      cleanupState: "pending",
    });
    await pool.query(
      `UPDATE cloud_computer_images SET created_at=now()-interval '8 days'`,
    );
    await worker.retire();
    await drain();
    expect((await read()).history[0]).toMatchObject({
      state: "succeeded",
      cleanupState: "complete",
      artifact: { state: "retired" },
    });
  });
  it("V12 rolling deployment keeps a base promoted by a newer worker protected", async () => {
    const { id } = await build();
    await drain();
    const ref = (await read()).history[0]!.artifact!.imageRef!;
    await pool.query(
      "UPDATE cloud_computer_images SET created_at=now()-interval '8 days' WHERE id=$1",
      [id],
    );
    const newDeployment = new ComputerImageWorker(pool, "fixture", driver, [
      ref,
    ]);
    await newDeployment.retire();
    expect((await read()).history[0]!.artifact!.state).toBe("attested");
    const oldDeployment = new ComputerImageWorker(pool, "fixture", driver, [
      base,
    ]);
    await oldDeployment.tick();
    await oldDeployment.tick();
    expect((await read()).history[0]!.artifact!.state).toBe("attested");
    expect(driver.snapshots.has(`zeros-org-${id.replaceAll("-", "")}`)).toBe(
      true,
    );
  });
  it("V12 the runtime role cannot self-qualify an image", async () => {
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled) VALUES('boat','v12-unqualified-fixture',$1,'codex-api-key','zeros-cloud-worker-v3',true)`,
          ["a".repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it.each(["local", "certified"] as const)(
    "retains an earlier uncertain dispatch after a later %s refusal, while deleting the known builder",
    async (refusal) => {
      const { BoatCreateRejectedError } = await import("./boat-client.js");
      const create = driver.create.bind(driver);
      let lost = false;
      vi.spyOn(driver, "create").mockImplementation(
        async (image, role, dispatch) => {
          if (role === "builder") return create(image, role, dispatch);
          if (!lost) {
            lost = true;
            await create(image, role, dispatch);
            await service.cancel(
              fixture.organizationId,
              fixture.userId,
              image.id,
            );
            throw new Error("synthetic lost verifier response");
          }
          if (refusal === "local")
            throw new ComputerImageError("image_build_admission_expired");
          await dispatch();
          throw new BoatCreateRejectedError(
            "provider_rate_limited",
            true,
            "limit_reached",
            {},
          );
        },
      );
      const deleted = vi.spyOn(driver, "removeSandbox");
      const { id } = await build();
      // Lose verifier identity, then cancel while cleanup has an unresolved VM.
      for (let i = 0; i < 6; i++) await worker.tick();
      await drain();
      expect(deleted).toHaveBeenCalledWith(
        `builder-${id}`,
        null,
        expect.any(Function),
      );
      expect((await read()).history[0]).toMatchObject({
        state: "cancelled",
        cleanupState: "requested",
      });
      expect(driver.snapshots.size).toBe(1);
      const attempts = await pool.query(
        "SELECT state FROM cloud_computer_image_create_attempts WHERE image_id=$1 AND role='verifier'",
        [id],
      );
      expect(
        attempts.rows.filter((row) => row.state === "dispatched"),
      ).toHaveLength(1);
      if (refusal === "local")
        expect(attempts.rows.every((row) => row.state === "dispatched")).toBe(
          true,
        );
      else
        expect(attempts.rows.some((row) => row.state === "rejected")).toBe(
          true,
        );
    },
  );

  it("protects a promoted base even from an older retirement update and forbids runtime unpinning", async () => {
    const { id } = await build();
    await drain();
    const ref = (await read()).history[0]!.artifact!.imageRef!;
    await new ComputerImageWorker(pool, "fixture", driver, [ref]).retire();
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_computer_images SET state='retiring' WHERE id=$1",
          [id],
        ),
      ),
    ).rejects.toThrow("Configured base image is protected");
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "DELETE FROM cloud_computer_image_base_references WHERE image_ref=$1",
          [ref],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("pins a deployment base during admission before that deployment's first worker tick", async () => {
    const { id } = await build();
    await drain();
    const ref = (await read()).history[0]!.artifact!.imageRef!;
    await withSystemTx(pool, tx => resolveComputerImage(tx, fixture.organizationId, {
      ...cloudWorkspaceProvisioningProfile(config, "boat"), imageRef: ref,
    }));
    await pool.query("UPDATE cloud_computer_images SET created_at=now()-interval '8 days' WHERE id=$1", [id]);
    await worker.retire();
    await worker.tick();
    expect((await read()).history[0]!.artifact!.state).toBe("attested");
    expect(driver.snapshots.size).toBe(1);
  });

  it("rejects promotion after retirement starts instead of using a disappearing base", async () => {
    const { id } = await build();
    await drain();
    const ref = (await read()).history[0]!.artifact!.imageRef!;
    await pool.query(
      "UPDATE cloud_computer_images SET state='retiring' WHERE id=$1",
      [id],
    );
    await expect(
      new ComputerImageWorker(pool, "fixture", driver, [ref]).tick(),
    ).rejects.toThrow("Configured base image is unavailable");
  });

  it("retains a timestamp-only dispatch from an older worker after a certified replay refusal", async () => {
    const { BoatCreateRejectedError } = await import("./boat-client.js");
    const { id } = await build();
    await pool.query("UPDATE cloud_computer_images SET state='failed',builder_dispatched_at=now() WHERE id=$1", [id]);
    await pool.query("UPDATE cloud_computer_builds SET state='failed' WHERE id=$1", [id]);
    vi.spyOn(driver, "create").mockImplementation(async (_image, _role, dispatch) => {
      await dispatch();
      throw new BoatCreateRejectedError("provider_rate_limited", true, "limit_reached", {});
    });
    await worker.tick();
    await worker.tick();
    expect((await read()).history[0]).toMatchObject({ state: "failed", cleanupState: "requested", artifact: { state: "failed" } });
  });

  it("repairs retired artifact bookkeeping without another provider deletion", async () => {
    const { id } = await build();
    await drain();
    await pool.query(
      "UPDATE cloud_computer_images SET created_at=now()-interval '8 days' WHERE id=$1",
      [id],
    );
    await worker.retire();
    await drain();
    await pool.query(
      "UPDATE cloud_computer_builds SET cleanup_state='requested' WHERE id=$1",
      [id],
    );
    const remove = vi.spyOn(driver, "removeSnapshot");
    await worker.tick();
    expect((await read()).history[0]).toMatchObject({
      state: "succeeded",
      cleanupState: "complete",
      artifact: { state: "retired" },
    });
    expect(remove).not.toHaveBeenCalled();
  });
});
