import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import {
  DatabaseCloudComputerService,
  CloudComputerBuildWorker,
  authorizeCloudComputerBuild,
} from "./computer.js";
import { resolveDatabaseCloudWorkspaceSettings } from "./settings.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const config = {
  provider: "boat",
  setupExecution: {},
  cpuMillicores: 4000,
  memoryMiB: 8192,
  storageMiB: 70000,
} as CloudWorkspaceBackendConfig;
const document = {
  repositories: [],
  installScript: "printf 'setup-ok\\n'",
  timeoutSeconds: 30,
};
d("organization Cloud Computer lifecycle", () => {
  let pool: pg.Pool,
    service: DatabaseCloudComputerService,
    fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudComputerService(pool, config);
  });
  const save = (
    expectedRevision = 0,
    operationId = randomUUID(),
    recipe = document,
  ) =>
    service.save(fixture.organizationId, fixture.userId, {
      expectedRevision,
      operationId,
      document: recipe,
      sources: [],
    });
  async function build(version = 1) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,requested_by,workspace_id,repository_owner,repository_name)
      SELECT $1,org_id,profile_id,$2,$3,$4,'withso','zeros' FROM cloud_computers WHERE org_id=$5`,
      [
        id,
        version,
        fixture.userId,
        fixture.workspaceId,
        fixture.organizationId,
      ],
    );
    return id;
  }
  it("saves immutable drafts, retries idempotently, rejects races, and never activates an unbuilt version", async () => {
    const operation = randomUUID();
    expect(await save(0, operation)).toEqual({ revision: 1, version: 1 });
    expect(await save(0, operation)).toEqual({ revision: 1, version: 1 });
    await expect(save()).rejects.toMatchObject({ status: 409 });
    await expect(
      service.activate(fixture.organizationId, fixture.userId, 1, 1),
    ).rejects.toMatchObject({ code: "cloud_computer_not_built" });
    await save(1);
    expect(
      await service.read(fixture.organizationId, fixture.userId),
    ).toMatchObject({
      revision: 2,
      draftVersion: 2,
      activeVersion: null,
      document,
    });
    expect(
      (
        await pool.query(
          "SELECT version FROM environment_profile_versions ORDER BY version",
        )
      ).rows,
    ).toEqual([{ version: "1" }, { version: "2" }]);
    expect(
      (await pool.query("SELECT 1 FROM environment_profiles WHERE is_default"))
        .rowCount,
    ).toBe(0);
  });
  it("only administers its own organization and requires current repository access", async () => {
    const other = await seedReadyCloudWorkspace(pool);
    await expect(
      service.read(fixture.organizationId, other.userId),
    ).rejects.toMatchObject({ status: 404 });
    await pool.query(
      "UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2",
      [fixture.organizationId, fixture.userId],
    );
    await expect(save()).rejects.toMatchObject({ status: 403 });
    await pool.query(
      "UPDATE organization_members SET role='owner' WHERE org_id=$1 AND user_id=$2",
      [fixture.organizationId, fixture.userId],
    );
    await expect(
      service.save(fixture.organizationId, fixture.userId, {
        expectedRevision: 0,
        operationId: randomUUID(),
        document: {
          ...document,
          repositories: [
            {
              id: "123",
              owner: "withso",
              name: "zeros",
              defaultBranch: "main",
              private: true,
            },
          ],
        },
        sources: [],
      }),
    ).rejects.toMatchObject({
      code: "github_cloud_source_authorization_required",
    });
  });
  it("retires legacy ready workspaces without claiming they are attested images", async () => {
    await save();
    const id = await build();
    const worker = new CloudComputerBuildWorker(pool);
    await worker.tick();
    await worker.tick();
    const current = await service.read(fixture.organizationId, fixture.userId);
    expect(current).toMatchObject({
      activeVersion: null,
      history: [{ id, state: "failed", errorCode: "image_build_required", cleanupState: "requested" }],
    });
    expect(
      (
        await pool.query(
          "SELECT operation FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1",
          [fixture.workspaceId],
        )
      ).rows,
    ).toEqual([{ operation: "delete" }]);
    expect(
      (
        await pool.query(
          "SELECT desired_state,status FROM cloud_workspaces WHERE id=$1",
          [fixture.workspaceId],
        )
      ).rows,
    ).toEqual([{ desired_state: "deleted", status: "deleting" }]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM cloud_workspace_engine_instances WHERE workspace_id=$1 AND revoked_at IS NULL",
          [fixture.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    await expect(service.activate(fixture.organizationId, fixture.userId, 1, 1)).rejects.toMatchObject({ code: "cloud_computer_not_built" });
    await save(1);
    expect(await service.read(fixture.organizationId, fixture.userId)).toMatchObject({ activeVersion: null, draftVersion: 2 });
  });
  it("keeps the persisted legacy setup contract until the generation uses a baked image", async () => {
    // Store the validated recipe directly here; source-proof admission has a
    // separate regression above and the create-route suite exercises both.
    const repository = (
      await pool.query(
        "SELECT forge_repository_id FROM repositories WHERE id=$1",
        [fixture.repositoryId],
      )
    ).rows[0];
    await save();
    const profile = (
      await pool.query(
        "SELECT profile_id FROM cloud_computers WHERE org_id=$1",
        [fixture.organizationId],
      )
    ).rows[0].profile_id;
    const configured = {
      ...document,
      repositories: [
        {
          id: repository.forge_repository_id,
          owner: "withso",
          name: "zeros",
          defaultBranch: "main",
          private: true,
        },
      ],
    };
    await pool.query(
      "INSERT INTO environment_profile_versions(profile_id,org_id,version,document,created_by) VALUES($1,$2,2,$3,$4)",
      [
        profile,
        fixture.organizationId,
        {
          values: { cloudComputer: configured },
          setupCommands: [
            { command: document.installScript, timeoutSeconds: 30 },
          ],
        },
        fixture.userId,
      ],
    );
    await pool.query(
      "UPDATE cloud_computers SET draft_version=2 WHERE org_id=$1",
      [fixture.organizationId],
    );
    await build(2);
    await new CloudComputerBuildWorker(pool).tick();
    // Simulate a profile activated by the previous backend during rollout.
    await pool.query("UPDATE environment_profiles SET is_default=true,current_version=2 WHERE id=$1", [profile]);
    await pool.query("UPDATE cloud_computers SET active_version=2 WHERE org_id=$1", [fixture.organizationId]);
    await pool.query(
      "INSERT INTO repository_settings_versions(org_id,repository_id,scope,version,document) VALUES($1,$2,'cloud',1,$3)",
      [
        fixture.organizationId,
        fixture.repositoryId,
        {
          values: {},
          setupCommands: [
            { command: "printf repository-setup", timeoutSeconds: 30 },
          ],
        },
      ],
    );
    await pool.query(
      "INSERT INTO repository_settings_heads(org_id,repository_id,scope,current_version) VALUES($1,$2,'cloud',1)",
      [fixture.organizationId, fixture.repositoryId],
    );
    const resolved = await withSystemTx(pool, (tx) =>
      resolveDatabaseCloudWorkspaceSettings(tx, {
        organizationId: fixture.organizationId,
        actorUserId: fixture.userId,
        workspaceId: fixture.workspaceId,
        repositoryId: fixture.repositoryId,
        generation: 1,
        isPersonal: false,
      }),
    );
    expect(resolved.resolved.snapshot.setupCommands).toEqual([
      { command: document.installScript, timeoutSeconds: 30 },
      { command: "printf repository-setup", timeoutSeconds: 30 },
    ]);
    await pool.query(
      "UPDATE repositories SET forge_repository_id='999999999' WHERE id=$1",
      [fixture.repositoryId],
    );
    const unrelated = await withSystemTx(pool, (tx) =>
      resolveDatabaseCloudWorkspaceSettings(tx, {
        organizationId: fixture.organizationId,
        actorUserId: fixture.userId,
        workspaceId: fixture.workspaceId,
        repositoryId: fixture.repositoryId,
        generation: 1,
        isPersonal: false,
      }),
    );
    expect(unrelated.resolved.snapshot.setupCommands).toEqual([
      { command: "printf repository-setup", timeoutSeconds: 30 },
    ]);
  });
  it("times out builds, retires their authority, and cannot activate a failure", async () => {
    await save();
    const id = await build();
    await pool.query(
      "UPDATE cloud_computer_builds SET deadline_at=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    await new CloudComputerBuildWorker(pool).tick();
    expect(
      (await service.read(fixture.organizationId, fixture.userId)).history[0],
    ).toMatchObject({
      state: "failed",
      errorCode: "build_timed_out",
      cleanupState: "requested",
    });
    await expect(
      service.activate(fixture.organizationId, fixture.userId, 1, 1),
    ).rejects.toMatchObject({ code: "cloud_computer_not_built" });
  });

  it("reflects a different default profile without allowing generic edits to its managed recipe", async () => {
    await save(); await build(); await new CloudComputerBuildWorker(pool).tick();
    await pool.query("UPDATE environment_profiles SET is_default=true WHERE id=(SELECT profile_id FROM cloud_computers WHERE org_id=$1)", [fixture.organizationId]);
    await pool.query("UPDATE cloud_computers SET active_version=1 WHERE org_id=$1", [fixture.organizationId]);
    const management=new DatabaseCloudWorkspaceManagementService(pool,config,{workosEnabled:false});
    const profileId=(await pool.query("SELECT profile_id FROM cloud_computers WHERE org_id=$1",[fixture.organizationId])).rows[0].profile_id;
    await expect(management.updateEnvironmentProfile({id:profileId,organizationId:fixture.organizationId,actorUserId:fixture.userId,expectedVersion:1,name:"Bypass"})).rejects.toMatchObject({code:"cloud_computer_managed_profile"});
    await management.createEnvironmentProfile({id:randomUUID(),organizationId:fixture.organizationId,actorUserId:fixture.userId,name:"Different default",placement:"cloud",isDefault:true,document:{values:{}}});
    expect((await service.read(fixture.organizationId,fixture.userId)).activeVersion).toBeNull();
    await expect(service.activate(fixture.organizationId,fixture.userId,1,1)).rejects.toMatchObject({code:"cloud_computer_not_built"});
  });

  it("does not let an older running build starve another organization's cleanup", async () => {
    await save();
    const first = await build();
    await pool.query(
      "UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1",
      [fixture.workspaceId],
    );
    fixture = await seedReadyCloudWorkspace(pool);
    await save();
    const second = await build();
    const worker = new CloudComputerBuildWorker(pool, 1);
    await worker.tick();
    expect(
      (await service.read(fixture.organizationId, fixture.userId)).history[0]
        .state,
    ).toBe("building");
    await worker.tick();
    expect(
      (await service.read(fixture.organizationId, fixture.userId)).history[0],
    ).toMatchObject({
      id: second,
      state: "failed",
      cleanupState: "requested",
    });
    expect(
      (
        await pool.query(
          "SELECT state FROM cloud_computer_builds WHERE id=$1",
          [first],
        )
      ).rows[0].state,
    ).toBe("building");
  });
  it("cancels builds durably without needing an open desktop and rejects a different recipe revision", async () => {
    await save();
    const id = await build();
    await service.cancel(fixture.organizationId, fixture.userId, id);
    await new CloudComputerBuildWorker(pool).tick();
    expect(
      (await service.read(fixture.organizationId, fixture.userId)).history[0],
    ).toMatchObject({ state: "cancelled", cleanupState: "requested" });
    await expect(
      withSystemTx(pool, (tx) =>
        authorizeCloudComputerBuild(tx, {
          organizationId: fixture.organizationId,
          actorUserId: fixture.userId,
          version: 2,
          repositoryOwner: "withso",
          repositoryName: "zeros",
        }),
      ),
    ).rejects.toMatchObject({ code: "cloud_computer_changed" });
  });
});
