// Pro ending, or changing, for an account with cloud workspaces in its Personal organization (C3): every write that
// ends or grants Pro commits, whatever state the workspaces are in.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureCloudPersonal, configureCloudTeamOwnership } from "../db-context.js";
import { manageAccountPro } from "../manage-account-pro.js";
import { CloudV2Computers } from "./computer.js";
import * as runtime from "./runtime-capabilities.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";
import { CloudWorkspaceApiTokens } from "./api/workspace-tokens.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Pro ending for an account with Personal cloud workspaces", () => {
  let pool: pg.Pool, operator: pg.Pool, f: ExecutionFixture | undefined;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
    // The operator's own pool, configured as its main() configures it on the deployed server.
    operator = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    configureCloudTeamOwnership(operator, true);
  });
  afterEach(async () => { await f?.close(); await f?.cp.teamSharing.signals.close(); f = undefined; configureCloudPersonal(pool, false); vi.restoreAllMocks(); });
  afterAll(async () => { await operator.end(); await pool.end(); });

  async function setup() {
    vi.spyOn(runtime, "activeRuntimeQualification").mockReturnValue(async () => ({ version: 1, sha256: "b".repeat(64),
      sourceSha256: "c".repeat(64), commit: "d".repeat(40), features: ["acting-user-v1", "sync-context-v1"] }));
    f = await executionFixture(pool, { personal: true, actingUserDefault: true, teamOwnership: true });
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const build = await computers.enqueue(f.organizationId, f.creator.id, { repositories: [{ repository: "example/project", branch: "main", setup: "" }] });
    await computers.claim(); await computers.activate(build.id, "fresh-fixture-snapshot");
    vi.spyOn(f.cp.routes, "remoteHead").mockResolvedValue("a".repeat(40));
    const owner = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name,staff_role) VALUES($1,$2,'Owner','platform_owner')", [owner, `${owner}@example.test`]);
    return { fixture: f, owner };
  }
  const change = (fixture: ExecutionFixture, owner: string, enabled: boolean) => ({ operationId: randomUUID(), channel: "development" as const,
    subjectUserId: fixture.creator.id, expectedEmail: fixture.creator.email.toLowerCase(), actorUserId: owner, enabled,
    validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: null, reason: "Local fixture: Pro ends while a Personal workspace exists" });
  const execute = async (input: ReturnType<typeof change>) => {
    const options = { databaseUrl: process.env.TEST_DATABASE_URL!, channel: "development" };
    const plan = await manageAccountPro(operator, input, options);
    return manageAccountPro(operator, input, { ...options, execute: true, approval: plan.planSha256 });
  };

  it("ends Pro through the operator while the Personal workspace runs with the worker's API token, then grants it again", async () => {
    const { fixture, owner } = await setup();
    await pool.query("UPDATE cloud_v2_workspaces SET state='running' WHERE id=$1", [fixture.workspace.id]);
    expect((await pool.query("SELECT state,execution_mode,private_owner_user_id IS NOT NULL AS private FROM cloud_v2_workspaces WHERE id=$1", [fixture.workspace.id])).rows[0])
      .toMatchObject({ state: "running", execution_mode: "legacy" });
    expect(await new CloudWorkspaceApiTokens(pool, fixture.keys as never).token(fixture.workspace.id)).toEqual(expect.any(String));
    expect((await execute(change(fixture, owner, false))).state).toBe("changed");
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [fixture.workspace.id])).rows[0].state).toBe("stopping");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_tokens WHERE workspace_id=$1 AND kind='api'", [fixture.workspace.id])).rows[0].n).toBe(0);
    // Granted again while the workspace exists (stopped now): commits, and the workspace waits to be opened.
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [fixture.workspace.id]);
    expect((await execute(change(fixture, owner, true))).state).toBe("changed");
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [fixture.workspace.id])).rows[0].state).toBe("stopped");
    expect((await pool.query("SELECT status FROM account_entitlements WHERE user_id=$1", [fixture.creator.id])).rows[0].status).toBe("active");
  });
});
