import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { teamSharingFixture } from "./team-sharing/test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("chat cache migration with the deployment role", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => pool.end());

  it("applies without superuser and restores the writer's RLS settings after tracking", async () => {
    const f = await teamSharingFixture(pool);
    await f.store.writeHistory(f.workspace.id, { chats: [{ id: "chat" }] });
    const sql = readFileSync(new URL("../../migrations/0252_cloud_chat_cache.sql", import.meta.url), "utf8");
    const role = `cache_migrator_${randomUUID().replaceAll("-", "")}`;
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(`DROP TABLE cloud_v2_history_cache,cloud_v2_history_changes,cloud_v2_prompt_cache;
        DROP FUNCTION advance_cloud_history_cache(uuid,text,boolean,bigint),track_cloud_message_cache(),track_cloud_message_count(),track_cloud_chat_cache(),track_cloud_prompt_cache() CASCADE`);
      await tx.query(`CREATE ROLE ${role} NOSUPERUSER BYPASSRLS;
        GRANT zeros_app TO ${role};
        GRANT USAGE,CREATE ON SCHEMA public TO ${role};
        GRANT ALL ON cloud_v2_workspaces,cloud_v2_chats,cloud_v2_messages,cloud_v2_prompt_chats,cloud_v2_prompt_outbox TO ${role};
        GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};
        SET LOCAL ROLE ${role}`);
      expect((await tx.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper).toBe(false);
      await tx.query(sql);
      await tx.query("SELECT set_config('app.system','off',true),set_config('app.cloud_execution_protocol','0',true)");
      await tx.query(`INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms)
        VALUES($1,'chat','message','text','{}',1)`, [f.workspace.id]);
      await tx.query("UPDATE cloud_v2_messages SET payload='{}' WHERE workspace_id=$1", [f.workspace.id]);
      await tx.query("UPDATE cloud_v2_messages SET payload='changed' WHERE workspace_id=$1", [f.workspace.id]);
      await tx.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,'chat')", [f.workspace.id]);
      expect((await tx.query(`SELECT current_setting('app.system') AS system,current_setting('app.cloud_execution_protocol') AS protocol`)).rows[0])
        .toEqual({ system: "off", protocol: "0" });
      expect((await tx.query("SELECT revision::text FROM cloud_v2_history_cache WHERE workspace_id=$1", [f.workspace.id])).rows[0].revision).toBe("1");
      expect((await tx.query("SELECT revision::text FROM cloud_v2_prompt_cache WHERE workspace_id=$1", [f.workspace.id])).rows[0].revision).toBe("1");
      for (const failure of ["message revision", "chat revision", "message count", "prompt revision"]) {
        await tx.query("SAVEPOINT cache_failure");
        if (failure === "prompt revision") await tx.query(
          "UPDATE cloud_v2_prompt_cache SET revision=9007199254740991,last_txid=0 WHERE workspace_id=$1", [f.workspace.id]);
        else if (failure === "message count") await tx.query(
          "UPDATE cloud_v2_history_cache SET message_count=9007199254740991,count_initialized_txid=0 WHERE workspace_id=$1", [f.workspace.id]);
        else await tx.query("UPDATE cloud_v2_history_cache SET revision=9007199254740991,resync_revision=9007199254740991,last_txid=0 WHERE workspace_id=$1", [f.workspace.id]);
        const mutation = failure === "prompt revision" ? "UPDATE cloud_v2_prompt_chats SET epoch=epoch+1 WHERE workspace_id=$1"
          : failure === "message count" ? "INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms) VALUES($1,'chat','overflow','text','{}',1)"
          : failure === "chat revision" ? "UPDATE cloud_v2_chats SET row=row || '{\"historyState\":{\"revision\":1}}'::jsonb WHERE workspace_id=$1"
          : "UPDATE cloud_v2_messages SET payload='overflow' WHERE workspace_id=$1";
        await expect(tx.query(mutation, [f.workspace.id])).rejects.toMatchObject({ code: "23514" });
        await tx.query("ROLLBACK TO SAVEPOINT cache_failure; RELEASE SAVEPOINT cache_failure");
        expect((await tx.query("SELECT current_setting('app.system') AS system,current_setting('app.cloud_execution_protocol') AS protocol")).rows[0])
          .toEqual({ system: "off", protocol: "0" });
      }
      await tx.query("DELETE FROM cloud_v2_messages WHERE workspace_id=$1", [f.workspace.id]);
      await tx.query("DELETE FROM cloud_v2_chats WHERE workspace_id=$1", [f.workspace.id]);
      expect((await tx.query(`SELECT current_setting('app.system') AS system,current_setting('app.cloud_execution_protocol') AS protocol`)).rows[0])
        .toEqual({ system: "off", protocol: "0" });
    } finally {
      await tx.query("ROLLBACK"); tx.release();
    }
  });
});
