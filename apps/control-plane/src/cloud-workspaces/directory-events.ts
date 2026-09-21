import type pg from "pg";
import {withSystemTx} from "../db.js";

const publishers=new WeakMap<pg.Pool,{after:string|null;active:Promise<void>|null}>();

/** Metadata may coalesce while every agent event retains its own sequence.
 * Parent locks never wait: another tenant's mutation cannot pin a stream. A
 * rotating, bounded scan makes progress even when a whole page is locked.
 * The cursor is scheduling state, not an authorization or delivery cursor. */
export function publishCloudWorkspaceDirectoryChanges(pool:pg.Pool):Promise<void> {
  let state=publishers.get(pool);
  if(!state){state={after:null,active:null};publishers.set(pool,state);}
  if(state.active)return state.active;
  const current=state;
  current.active=(async()=>{
    const candidates=await withSystemTx(pool,async tx=>{
      const rows=(await tx.query<{workspace_id:string;org_id:string}>(
        "SELECT workspace_id,org_id FROM cloud_workspace_directory_outbox WHERE ($1::uuid IS NULL OR workspace_id>$1) ORDER BY workspace_id LIMIT 20",[current.after])).rows;
      if(rows.length<20&&current.after)rows.push(...(await tx.query<{workspace_id:string;org_id:string}>(
        "SELECT workspace_id,org_id FROM cloud_workspace_directory_outbox WHERE workspace_id<=$1 ORDER BY workspace_id LIMIT $2",[current.after,20-rows.length])).rows);
      return rows;
    });
    for(const candidate of candidates){
      await withSystemTx(pool,async tx=>{
        const org=await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE SKIP LOCKED",[candidate.org_id]);
        if(!org.rowCount&&(await tx.query("SELECT 1 FROM organizations WHERE id=$1",[candidate.org_id])).rowCount)return;
        const workspace=await tx.query<{org_id:string;deleted_at:Date|null;version:string}>(
          "SELECT org_id,deleted_at,version FROM cloud_workspaces WHERE id=$1 FOR SHARE SKIP LOCKED",[candidate.workspace_id]);
        if(!workspace.rowCount&&(await tx.query("SELECT 1 FROM cloud_workspaces WHERE id=$1",[candidate.workspace_id])).rowCount)return;
        const row=(await tx.query<{workspace_id:string;org_id:string;owner_user_id:string|null;guest_user_ids:string[];removed:boolean}>(
          "SELECT * FROM cloud_workspace_directory_outbox WHERE workspace_id=$1 AND org_id=$2 FOR UPDATE SKIP LOCKED",[candidate.workspace_id,candidate.org_id])).rows[0];
        if(!row)return;
        if(org.rowCount===1&&!row.removed&&workspace.rows[0]?.org_id===row.org_id&&!workspace.rows[0].deleted_at){
          await tx.query(`INSERT INTO security_events(kind,workspace_id,org_id,data_revision,payload)
            VALUES ('workspace.authorization_changed',$1,$2,$3,'{"reason":"workspace_changed"}')`,[row.workspace_id,row.org_id,workspace.rows[0].version]);
        }else{
          // A deleted host has no FK target. Surviving external recipients still
          // need a content-free refresh; they receive no deleted tenant identity.
          const orgId=org.rowCount===1?row.org_id:null;
          const recipients=[row.owner_user_id,...row.guest_user_ids].filter((value):value is string=>value!==null);
          const users=(await tx.query<{expected:string[];locked:string[]}>(`WITH targets AS MATERIALIZED (
              SELECT id FROM users WHERE id=ANY($1::uuid[]) AND auth_status='active' AND deleted_at IS NULL
            ), locked AS MATERIALIZED (
              SELECT id FROM users WHERE id IN (SELECT id FROM targets) FOR KEY SHARE SKIP LOCKED
            ) SELECT ARRAY(SELECT id FROM targets) AS expected,ARRAY(SELECT id FROM locked) AS locked`,[recipients])).rows[0]!;
          // FK checks must not wait for an account purge while holding its
          // outbox row. Retain the whole invalidation and retry after the purge.
          if(users.expected.length!==users.locked.length)return;
          if(orgId)await tx.query(`INSERT INTO security_events(kind,org_id,payload)
            VALUES ('organization.data_changed',$1,'{"reason":"workspace_directory_changed"}')`,[orgId]);
          await tx.query(`INSERT INTO security_events(kind,org_id,user_id,payload)
            SELECT 'organization.data_changed',$1,account.id,'{"reason":"workspace_directory_changed"}' FROM users account
            WHERE account.id=ANY($2::uuid[]) AND account.auth_status='active' AND account.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM organization_members member WHERE member.org_id=$1 AND member.user_id=account.id)`,
          [orgId,users.locked]);
        }
        await tx.query("DELETE FROM cloud_workspace_directory_outbox WHERE workspace_id=$1",[row.workspace_id]);
      });
      current.after=candidate.workspace_id;
    }
  })().finally(()=>{current.active=null;});
  return current.active;
}
