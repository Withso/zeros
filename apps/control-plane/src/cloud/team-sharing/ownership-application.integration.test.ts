import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import type { Config } from "../../config.js";
import { withSystemTx } from "../../db.js";
import { workosTestAuth } from "../../test-workos-env.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("Creator loss through the application's separate database pool", () => {
  let workers: pg.Pool, api: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => {
    workers = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    api = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  });
  beforeEach(async () => {
    f = await teamSharingFixture(workers, { ownership: true });
    await workers.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id=$1", [f.workspace.id]);
  });
  afterAll(async () => { await workers.end(); await api.end(); });

  it.each([true, false])("sets the ownership switch to %s on the API pool independently of cloud services", async enabled => {
    createApp({ auth: workosTestAuth(), workos: null, github: null, cloudV2: { teamOwnership: enabled },
      deploymentChannel: "development", inviteLinkBase: "https://app.example.test/invite" } as Config, api,
    { from: null, apiKey: null } as never);
    await withSystemTx(api, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    const row = (await workers.query("SELECT creator_user_id,creator_absent_reason FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    expect(row).toEqual(enabled ? { creator_user_id: null, creator_absent_reason: "left" }
      : { creator_user_id: f.creator.id, creator_absent_reason: null });
  });
});
