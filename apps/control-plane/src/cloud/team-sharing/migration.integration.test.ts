import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../../db.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("team sharing expand migration and hot-table cost", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL,max: 6 }); });
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  afterAll(async () => { await pool.end(); });

  it("backfills pre-migration Creators without changing lifecycle timestamps", async () => {
    const migration = await readFile(new URL("../../../migrations/0236_cloud_team_sharing.sql",import.meta.url),"utf8");
    const tx = await pool.connect(); await tx.query("BEGIN");
    try {
      await tx.query(`DROP FUNCTION cloud_v2_original_creator() CASCADE;
        DROP FUNCTION notify_cloud_v2_team_rows() CASCADE;
        DROP TABLE cloud_v2_workspace_presence,cloud_v2_workspace_followers,cloud_v2_workspace_pins;
        ALTER TABLE cloud_v2_workspaces DROP COLUMN created_by_user_id,DROP CONSTRAINT cloud_v2_workspaces_id_org CASCADE;
        DROP INDEX cloud_v2_workspaces_organization_page;`);
      const id = randomUUID();
      await tx.query("SET LOCAL ROLE zeros_app"); await tx.query("SELECT set_config('app.system','on',true)");
      await tx.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,updated_at)
        VALUES($1,$2,$3,'Before migration','example/project','before','main','stopped','2026-01-01T00:00:00Z')`,[id,f.organizationId,f.creator.id]);
      await tx.query("RESET ROLE");
      await tx.query(migration);
      const row = (await tx.query("SELECT created_by_user_id,updated_at,active_at,state FROM cloud_v2_workspaces WHERE id=$1",[id])).rows[0];
      expect(row).toEqual({ created_by_user_id: f.creator.id,updated_at: new Date("2026-01-01T00:00:00Z"),active_at: null,state: "stopped" });
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("uses indexed organization, source, follower and presence access", async () => {
    await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/follow`,"POST");
    const proof = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    const connection = await f.sharing.events.presence.open(proof);
    const source = await f.github.source.viewer(f.organizationId, f.viewer.id, [{ repository: f.workspace.repository, repositoryId: "42" }]);
    await withSystemTx(pool,async tx => {
      // Tiny fixtures otherwise prefer sequential scans, or another index plus a
      // sort when parallel suites shift the table statistics. This checks that the
      // production predicates and orderings have usable indexes, not a planner-cost ratio.
      await tx.query("SET LOCAL enable_seqscan=off"); await tx.query("SET LOCAL enable_sort=off");
      const plans = [
        ["list","SELECT id FROM cloud_v2_workspaces WHERE org_id=$1 AND state<>'deleted' ORDER BY created_at DESC,id LIMIT 50",[f.organizationId],"cloud_v2_workspaces_organization_page"],
        ["source","SELECT verified_at FROM cloud_github_source_verifications WHERE org_id=$1 AND owner_user_id=$2 AND repository_id=ANY($3::bigint[]) AND fingerprint=$4",
          [f.organizationId,f.viewer.id,["42"],source.fingerprint],"cloud_github_source_verifications_pkey"],
        ["followers","SELECT user_id FROM cloud_v2_workspace_followers WHERE workspace_id=$1 ORDER BY user_id LIMIT 200",[f.workspace.id],"cloud_v2_workspace_followers_pkey"],
        ["presence","SELECT user_id FROM cloud_v2_workspace_presence WHERE workspace_id=$1 AND expires_at>clock_timestamp()",[f.workspace.id],"cloud_v2_workspace_presence_workspace"],
      ] as const;
      for (const [name,sql,params,index] of plans) {
        const plan = (await tx.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,[...params])).rows[0]["QUERY PLAN"];
        if (name === "presence") {
          // PG18 may prefer a skip scan on the person index for one row. The
          // workspace index must exist, but its cost need not win this fixture.
          const definition = (await tx.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1",[index])).rows[0]?.indexdef;
          expect(definition).toContain("USING btree (workspace_id, expires_at)");
          type IndexPlan = { "Index Name"?: string; "Index Cond"?: string; Plans?: IndexPlan[] };
          const keyed = (node: IndexPlan): boolean =>
            Boolean(node["Index Name"] && node["Index Cond"]?.includes("workspace_id =")) || Boolean(node.Plans?.some(keyed));
          expect(keyed(plan[0].Plan)).toBe(true);
        } else expect(JSON.stringify(plan)).toContain(index);
        process.stdout.write(`[team-sharing] indexed-plan ${JSON.stringify({ name,plan })}\n`);
      }
    });
    await f.sharing.events.presence.close(connection);
  });

  it("measures 1000-row and multi-megabyte history batches without touching the workspace row", async () => {
    const tx = await pool.connect(), lock = await pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR NO KEY UPDATE",[f.workspace.id]);
    try {
      await tx.query("BEGIN"); await tx.query("SET LOCAL statement_timeout='5s'");
      const before = (await tx.query("SELECT xmin::text,updated_at FROM cloud_v2_workspaces WHERE id=$1",[f.workspace.id])).rows[0];
      const timings: { bytesPerRow: number; enabled: boolean; medianMs: number }[] = [];
      for (const bytes of [128,8192]) for (const enabled of [false,true]) {
        for (const action of ["insert","update","delete"]) await tx.query(`ALTER TABLE cloud_v2_messages ${enabled ? "ENABLE" : "DISABLE"} TRIGGER team_messages_${action}`);
        const samples: number[] = [];
        for (let run=0;run<5;run++) {
          await tx.query("SAVEPOINT batch");
          await tx.query("SET LOCAL ROLE zeros_app"); await tx.query("SELECT set_config('app.system','on',true)");
          const start = performance.now();
          const inserted = await tx.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms)
            SELECT $1,'benchmark',n::text,'text',$2,n FROM generate_series(1,1000) n`,[f.workspace.id,JSON.stringify({ role: "assistant",text: "x".repeat(bytes) })]);
          samples.push(performance.now()-start); expect(inserted.rowCount).toBe(1000);
          expect((await tx.query("SELECT xmin::text,updated_at FROM cloud_v2_workspaces WHERE id=$1",[f.workspace.id])).rows[0]).toEqual(before);
          await tx.query("ROLLBACK TO SAVEPOINT batch");
        }
        timings.push({ bytesPerRow: bytes,enabled,medianMs: Number(samples.sort((a,b) => a-b)[2]!.toFixed(3)) });
      }
      process.stdout.write(`[team-sharing] history-batch-cost ${JSON.stringify({ rows: 1000,timings })}\n`);
    } finally { await tx.query("ROLLBACK"); tx.release(); await lock.query("ROLLBACK"); lock.release(); }
  },20_000);
});
