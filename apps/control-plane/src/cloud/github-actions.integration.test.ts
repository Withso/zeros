import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudGithubActions } from "./github-actions.js";
import { CloudV2Store } from "./store.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

database("durable cloud PR action leases", () => {
  let pool: pg.Pool, actions: CloudGithubActions, workspaceId: string;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 2000,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const user = randomUUID(),
      org = randomUUID();
    workspaceId = randomUUID();
    actions = new CloudGithubActions(pool);
    await pool.query(
      "INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')",
      [user, `${user}@example.test`],
    );
    await grantTestPro(pool, user);
    await pool.query(
      "INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,true)",
      [org, `org-${org}`, user],
    );
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')",
      [org, user],
    );
    await new CloudV2Store(pool).createWorkspace({
      id: workspaceId,
      organizationId: org,
      creatorUserId: user,
      name: "Work",
      repository: "example/project",
      branch: "topic",
      baseBranch: "main",
      computerBuildId: null,
    });
  });
  it("rejects a concurrent process while leaving every database connection free during provider I/O", async () => {
    const entered = latch(),
      finish = latch();
    const first = actions.run(workspaceId, async () => {
      await actions.assertCurrent(workspaceId);
      entered.release();
      await finish.promise;
      return "confirmed";
    });
    await entered.promise;
    try {
      await expect(
        new CloudGithubActions(pool).run(workspaceId, async () => "duplicate"),
      ).rejects.toMatchObject({ code: "github_action_in_progress" });
      const clients = await Promise.all([pool.connect(), pool.connect()]);
      for (const client of clients) client.release();
    } finally {
      finish.release();
    }
    expect(await first).toBe("confirmed");
    expect(await actions.run(workspaceId, async () => "next")).toBe("next");
  });
  it("fences expiry and prevents an old action's cleanup from clearing its successor", async () => {
    const entered = latch(),
      finish = latch(),
      successorEntered = latch(),
      successorFinish = latch();
    const first = actions.run(workspaceId, async () => {
      entered.release();
      await finish.promise;
      await actions.assertCurrent(workspaceId);
    });
    const refused = expect(first).rejects.toMatchObject({
      code: "github_action_expired",
    });
    await entered.promise;
    await pool.query(
      "UPDATE cloud_v2_github_workspaces SET mutation_until=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
      [workspaceId],
    );
    const successor = new CloudGithubActions(pool).run(
      workspaceId,
      async () => {
        successorEntered.release();
        await successorFinish.promise;
      },
    );
    await successorEntered.promise;
    try {
      finish.release();
      await refused;
      await expect(
        actions.run(workspaceId, async () => {}),
      ).rejects.toMatchObject({ code: "github_action_in_progress" });
    } finally {
      successorFinish.release();
      await successor;
    }
  });
  it("does not start another provider operation near the lease deadline", async () => {
    await expect(
      actions.run(workspaceId, async () => {
        await pool.query(
          "UPDATE cloud_v2_github_workspaces SET mutation_until=clock_timestamp()+interval '19 seconds' WHERE workspace_id=$1",
          [workspaceId],
        );
        await actions.assertCurrent(workspaceId);
      }),
    ).rejects.toMatchObject({ code: "github_action_expired" });
    expect(await actions.run(workspaceId, async () => "released")).toBe(
      "released",
    );
  });
});
