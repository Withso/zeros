import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { HttpError } from "../authz.js";
import { createCloudComputerRoutes } from "./computer-routes.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { ensureCloudComputerIdentity } from "./computer-identity.js";
import {
  CloudComputerRetirementWorker,
  ComputerImageRetirementWorker,
  type RetiredComputerImage as ComputerImage,
} from "./computer-retirement.js";
import { createCloudRecoveryTransition } from "./automatic-recovery.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const account = "zeros-v2-test-retirement-account";
const base = `boat:zeros-v2-test-base@sha256:${"a".repeat(64)}`;
const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("historical Cloud Computer retirement", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  const driver = {
    inventory: vi.fn(async () => []),
    create: vi.fn(
      async (
        _image: ComputerImage,
        _role: string,
        dispatch: () => Promise<void>,
      ) => {
        await dispatch();
        return "bx_23456789";
      },
    ),
    ready: vi.fn(async () => true),
    install: vi.fn(async () => true),
    sanitize: vi.fn(async () => ({ buildSha256: "b".repeat(64) })),
    capture: vi.fn(async () => {}),
    attest: vi.fn(async () => null),
    snapshot: vi.fn(async (image: ComputerImage) => ({
      name: image.snapshot_name,
      id: image.snapshot_id,
      source: image.builder_id!,
      ready: true,
    })),
    removeSandbox: vi.fn(async () => true),
    removeSnapshot: vi.fn(async () => true),
    releaseAdmission: vi.fn(async () => {}),
  };
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    await withSystemTx(pool, (tx) =>
      ensureCloudComputerIdentity(tx, fixture.organizationId, fixture.userId),
    );
    for (const spy of Object.values(driver)) spy.mockClear();
  });
  async function historical(state = "installing", buildState = "building") {
    const id = randomUUID(),
      name = `zeros-org-${id.replaceAll("-", "")}`;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,requested_by,repository_owner,repository_name,state)
        SELECT $1,org_id,profile_id,1,$3,'','',$4 FROM cloud_computers WHERE org_id=$2`,
        [id, fixture.organizationId, fixture.userId, buildState],
      );
      await tx.query(
        `INSERT INTO cloud_computer_images(id,org_id,account_scope,snapshot_name,base_image_ref,base_source_commit,recipe_sha256,profile,state,builder_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'bx_23456789')`,
        [
          id,
          fixture.organizationId,
          account,
          name,
          base,
          "c".repeat(40),
          "d".repeat(64),
          {
            provider: "boat",
            imageRef: base,
            sourceCommit: "c".repeat(40),
            cpuMillicores: 4000,
            memoryMiB: 8192,
            storageMiB: 20480,
            architecture: "linux/amd64",
          },
          state,
        ],
      );
    });
    return id;
  }
  async function captured() {
    const id = await historical("installing", "cancelled");
    await pool.query(
      `UPDATE cloud_computer_images SET snapshot_id='snapshot-fixture',capture_dispatched_at=now(),
      image_ref='boat:'||snapshot_name||'@sha256:'||$2,build_sha256=$2,source_contract=$2,image_contract=$2,
      attested_at=now(),attestation_sha256=$2,state='attested' WHERE id=$1`,
      [id, "b".repeat(64)],
    );
    return id;
  }
  async function generationReference(id: string) {
    const image = await row(id);
    await pool.query(
      `INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,
      architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id)
      SELECT workspace_id,2,org_id,provider,$2,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id
      FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`,
      [fixture.workspaceId, image.image_ref],
    );
  }
  const row = async (id: string) =>
    (
      await pool.query(
        `SELECT build.state AS build_state,build.cleanup_state,build.error_code,image.*
    FROM cloud_computer_builds build JOIN cloud_computer_images image USING(id) WHERE id=$1`,
        [id],
      )
    ).rows[0];
  const tick = () =>
    new ComputerImageRetirementWorker(pool, account, driver).tick();

  it("refuses every historical authenticated endpoint without saving, building or activating", async () => {
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [
      fixture.userId,
    ]);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { id: fixture.userId });
      await next();
    });
    app.route("/", createCloudComputerRoutes(pool));
    app.onError((error, c) => {
      if (error instanceof HttpError)
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      throw error;
    });
    const root = `/v1/organizations/${fixture.organizationId}/cloud-computer`;
    for (const [method, suffix] of [
      ["GET", ""],
      ["PUT", ""],
      ["POST", "/builds"],
      ["POST", "/activate"],
      ["POST", "/rollback"],
      ["POST", `/builds/${randomUUID()}/cancel`],
    ]) {
      const response = await app.request(root + suffix, {
        method,
        ...(method === "GET"
          ? {}
          : { body: "{}", headers: { "content-type": "application/json" } }),
      });
      const reply = await response.json();
      expect(response.status, JSON.stringify({ method, suffix, reply })).toBe(
        409,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(reply).toMatchObject({
        error: { code: "cloud_workspace_v2_required" },
      });
    }
    expect(
      (
        await pool.query(
          "SELECT 1 FROM cloud_computer_builds WHERE org_id=$1",
          [fixture.organizationId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT active_image_id,active_version FROM cloud_computers WHERE org_id=$1",
          [fixture.organizationId],
        )
      ).rows[0],
    ).toEqual({ active_image_id: null, active_version: null });
    await pool.query("UPDATE users SET auth_status='suspended' WHERE id=$1", [
      fixture.userId,
    ]);
    expect((await app.request(root)).status).toBe(404);
  });

  it("cancels historical production without installing, capturing, publishing or activating", async () => {
    const id = await historical();
    await tick();
    expect(await row(id)).toMatchObject({
      build_state: "cancelled",
      cleanup_state: "complete",
      state: "retired",
    });
    for (const operation of [
      driver.create,
      driver.install,
      driver.sanitize,
      driver.capture,
      driver.attest,
    ])
      expect(operation).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT active_image_id,active_version FROM cloud_computers WHERE org_id=$1",
          [fixture.organizationId],
        )
      ).rows[0],
    ).toEqual({ active_image_id: null, active_version: null });
  });

  it("never replays an unknown dispatched create and still deletes an independently known verifier", async () => {
    const id = await historical("cancelled", "cancelled");
    await pool.query(
      "UPDATE cloud_computer_images SET builder_id=NULL,builder_dispatched_at=now(),verifier_id='bx_3456789A' WHERE id=$1",
      [id],
    );
    await tick();
    expect(driver.create).not.toHaveBeenCalled();
    expect(driver.removeSandbox).toHaveBeenCalledWith(
      "bx_3456789A",
      null,
      expect.any(Function),
    );
    expect(await row(id)).toMatchObject({
      builder_id: null,
      verifier_deleted: true,
      cleanup_state: "requested",
    });
    expect(driver.releaseAdmission).not.toHaveBeenCalled();
  });
  it.each([
    "active",
    "previous",
    "stopped generation",
    "archived generation",
    "base",
    "dependent image",
  ])(
    "retains a snapshot referenced by %s while releasing only disposable compute",
    async (reference) => {
      const id = await captured(),
        image = await row(id);
      if (reference === "active" || reference === "previous") {
        await pool.query(
          `UPDATE cloud_computers SET ${reference}_image_id=$1 WHERE org_id=$2`,
          [id, fixture.organizationId],
        );
      } else if (reference.endsWith("generation")) {
        await generationReference(id);
        await pool.query(
          "UPDATE cloud_workspaces SET status=$2,desired_state='stopped' WHERE id=$1",
          [
            fixture.workspaceId,
            reference.startsWith("archived") ? "archived" : "stopped",
          ],
        );
      } else if (reference === "base") {
        await withSystemTx(pool, (tx) =>
          tx.query(
            `INSERT INTO cloud_computer_image_base_references(account_scope,snapshot_name,image_ref)
          VALUES($1,$2,$3)`,
            [account, image.snapshot_name, image.image_ref],
          ),
        );
      } else {
        const dependent = await historical("cancelled", "cancelled");
        await pool.query(
          "UPDATE cloud_computer_images SET base_image_ref=$2,builder_id=NULL,builder_dispatched_at=now() WHERE id=$1",
          [dependent, image.image_ref],
        );
      }
      await tick();
      expect(driver.removeSnapshot).not.toHaveBeenCalled();
      expect(driver.releaseAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        { computeDeleted: true, snapshotDeleted: false },
      );
      expect(await row(id)).toMatchObject({
        state: "attested",
        builder_deleted: true,
        cleanup_state: "complete",
      });
    },
  );

  it("holds the builder during a pending capture but retires an independently known verifier", async () => {
    const id = await historical("capturing", "cancelled"),
      image = await row(id);
    await pool.query(
      "UPDATE cloud_computer_images SET capture_dispatched_at=now(),verifier_id='bx_3456789A' WHERE id=$1",
      [id],
    );
    driver.snapshot.mockResolvedValueOnce({
      name: image.snapshot_name,
      id: "snapshot-fixture",
      source: image.builder_id,
      ready: false,
    });
    await tick();
    expect(driver.removeSandbox).toHaveBeenCalledTimes(1);
    expect(driver.removeSandbox).toHaveBeenCalledWith(
      "bx_3456789A",
      null,
      expect.any(Function),
    );
    expect(await row(id)).toMatchObject({
      builder_deleted: false,
      verifier_deleted: true,
      cleanup_state: "requested",
    });
    driver.snapshot.mockResolvedValueOnce({
      name: image.snapshot_name,
      id: "snapshot-fixture",
      source: image.builder_id,
      ready: true,
    });
    await tick();
    expect(await row(id)).toMatchObject({
      state: "retired",
      builder_deleted: true,
      cleanup_state: "complete",
    });
  });

  it("does not settle a pending capture with a foreign snapshot source", async () => {
    const id = await historical("capturing", "cancelled"),
      image = await row(id);
    await pool.query(
      "UPDATE cloud_computer_images SET capture_dispatched_at=now() WHERE id=$1",
      [id],
    );
    driver.snapshot.mockResolvedValueOnce({
      name: image.snapshot_name,
      id: "foreign",
      source: "bx_3456789A",
      ready: true,
    });
    await tick();
    expect(driver.removeSandbox).not.toHaveBeenCalled();
    expect(driver.removeSnapshot).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({
      snapshot_id: null,
      builder_deleted: false,
      cleanup_state: "requested",
    });
  });

  it.each([false, true])(
    "preserves unknown dispatch when a later certified refusal exists: %s",
    async (earlierDispatch) => {
      const id = await historical("cancelled", "cancelled");
      await pool.query(
        "UPDATE cloud_computer_images SET builder_id=NULL,builder_dispatched_at=now() WHERE id=$1",
        [id],
      );
      if (earlierDispatch)
        await pool.query(
          `INSERT INTO cloud_computer_image_create_attempts(id,image_id,role,state) VALUES($1,$2,'builder','dispatched')`,
          [randomUUID(), id],
        );
      await pool.query(
        `INSERT INTO cloud_computer_image_create_attempts(id,image_id,role,state,rejection_code)
      VALUES($1,$2,'builder','rejected','limit_reached')`,
        [randomUUID(), id],
      );
      await tick();
      expect(driver.create).not.toHaveBeenCalled();
      expect((await row(id)).cleanup_state).toBe(
        earlierDispatch ? "requested" : "complete",
      );
      expect(driver.releaseAdmission).toHaveBeenCalledTimes(
        earlierDispatch ? 0 : 1,
      );
    },
  );

  it("waits for exact deletion proof before releasing admission", async () => {
    const id = await historical();
    driver.removeSandbox.mockResolvedValueOnce(false);
    await tick();
    expect(await row(id)).toMatchObject({
      builder_deleted: false,
      cleanup_state: "requested",
    });
    expect(driver.releaseAdmission).not.toHaveBeenCalled();
    await tick();
    expect(await row(id)).toMatchObject({
      builder_deleted: true,
      cleanup_state: "complete",
    });
  });

  it("does not touch an image in a different provider account", async () => {
    const id = await historical();
    await new ComputerImageRetirementWorker(
      pool,
      "foreign-account",
      driver,
    ).tick();
    expect(driver.removeSandbox).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({
      build_state: "building",
      builder_deleted: false,
    });
  });

  it("blocks new generation references before starting snapshot deletion", async () => {
    const id = await captured();
    driver.removeSnapshot.mockImplementationOnce(async () => {
      await expect(generationReference(id)).rejects.toThrow(
        "Cloud Computer image is unavailable",
      );
      return true;
    });
    await tick();
    expect(await row(id)).toMatchObject({
      state: "retired",
      cleanup_state: "complete",
    });
  });

  it("repairs retired cleanup bookkeeping without another provider deletion", async () => {
    const id = await captured();
    await pool.query(
      "UPDATE cloud_computer_images SET state='retired',builder_deleted=true,verifier_deleted=true,snapshot_deletion_requested_at=now() WHERE id=$1",
      [id],
    );
    await tick();
    expect(driver.removeSandbox).not.toHaveBeenCalled();
    expect(driver.removeSnapshot).not.toHaveBeenCalled();
    expect((await row(id)).cleanup_state).toBe("complete");
  });

  it.each([false, true])(
    "refuses recovery admission before checkpoint/funding for an unsupported source (v4 pin: %s)",
    async (runtimeV4) => {
      fixture = await seedReadyCloudWorkspace(pool, {
        runtimeV4,
        supportedGeneration: false,
      });
      await pool.query(
        "UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1",
        [fixture.workspaceId],
      );
      await expect(
        withSystemTx(pool, (tx) =>
          createCloudRecoveryTransition(tx, {
            workspaceId: fixture.workspaceId,
            organizationId: fixture.organizationId,
            sourceGeneration: 1,
            checkpointId: randomUUID(),
            actorUserId: fixture.userId,
            workosEnabled: false,
            config: {
              provider: "boat",
              runtime: { qualificationMode: "full" },
            } as CloudWorkspaceBackendConfig,
            idempotencyKey: randomUUID(),
            requestDigest: Buffer.alloc(32),
          }),
        ),
      ).rejects.toMatchObject({ code: "cloud_workspace_v2_required" });
      expect(
        (
          await pool.query(
            "SELECT generation FROM cloud_workspace_generations WHERE workspace_id=$1",
            [fixture.workspaceId],
          )
        ).rows,
      ).toEqual([{ generation: 1 }]);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM cloud_workspace_generation_transitions WHERE workspace_id=$1",
            [fixture.workspaceId],
          )
        ).rowCount,
      ).toBe(0);
    },
  );

  it("keeps configured base pins immutable for the application cleanup role", async () => {
    const id = await captured(),
      image = await row(id);
    await new ComputerImageRetirementWorker(pool, account, driver, [
      image.image_ref,
    ]).tick();
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "DELETE FROM cloud_computer_image_base_references WHERE image_ref=$1",
          [image.image_ref],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_computer_images SET state='retiring' WHERE id=$1",
          [id],
        ),
      ),
    ).rejects.toThrow("Configured base image is protected");
    expect(driver.removeSnapshot).not.toHaveBeenCalled();
  });

  it("fairly advances another organization while an older workspace deletion remains pending", async () => {
    const first = fixture,
      firstId = randomUUID();
    const insert = async (id: string) => {
      await withSystemTx(pool, (tx) =>
        ensureCloudComputerIdentity(tx, fixture.organizationId, fixture.userId),
      );
      await pool.query(
        `INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,workspace_id,requested_by,repository_owner,repository_name)
        SELECT $1,org_id,profile_id,1,$3,$4,'','' FROM cloud_computers WHERE org_id=$2`,
        [id, fixture.organizationId, fixture.workspaceId, fixture.userId],
      );
    };
    await insert(firstId);
    await pool.query(
      "UPDATE cloud_computer_builds SET last_checked_at=now()-interval '1 hour' WHERE id=$1",
      [firstId],
    );
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    const secondId = randomUUID();
    await insert(secondId);
    const worker = new CloudComputerRetirementWorker(pool, 1);
    await worker.tick();
    await worker.tick();
    expect(
      (
        await pool.query(
          "SELECT state,cleanup_state FROM cloud_computer_builds WHERE id=ANY($1::uuid[]) ORDER BY state",
          [[firstId, secondId]],
        )
      ).rows,
    ).toEqual([
      { state: "cancelled", cleanup_state: "requested" },
      { state: "cancelled", cleanup_state: "requested" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT status FROM cloud_workspaces WHERE id=ANY($1::uuid[])",
          [[first.workspaceId, fixture.workspaceId]],
        )
      ).rows,
    ).toEqual([{ status: "deleting" }, { status: "deleting" }]);
  });

  it("cancels and requests durable deletion for a disposable historical workspace", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,workspace_id,requested_by,repository_owner,repository_name)
      SELECT $1,org_id,profile_id,1,$3,$4,'','' FROM cloud_computers WHERE org_id=$2`,
      [id, fixture.organizationId, fixture.workspaceId, fixture.userId],
    );
    await new CloudComputerRetirementWorker(pool).tick();
    await new CloudComputerRetirementWorker(pool).tick();
    expect(
      (
        await pool.query(
          "SELECT state,cleanup_state FROM cloud_computer_builds WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "cancelled", cleanup_state: "requested" });
    expect(
      (
        await pool.query(
          "SELECT status,desired_state FROM cloud_workspaces WHERE id=$1",
          [fixture.workspaceId],
        )
      ).rows[0],
    ).toEqual({ status: "deleting", desired_state: "deleted" });
    expect(
      (
        await pool.query(
          "SELECT operation FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'",
          [fixture.workspaceId],
        )
      ).rows,
    ).toEqual([{ operation: "delete" }]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM workspace_deletion_jobs WHERE workspace_id=$1",
          [fixture.workspaceId],
        )
      ).rowCount,
    ).toBe(1);
  });
});
