import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {runMigrations} from "../migrate.js";
import {seedReadyCloudWorkspace} from "./test-fixtures.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
type Plan={"Node Type":string;"Actual Rows":number;"Rows Removed by Filter"?:number;Plans?:Plan[]};
const nodes=(plan:Plan):Plan[]=>[plan,...(plan.Plans??[]).flatMap(nodes)];
/** Real historical rows matter here: live-only indexes cannot serve a page of
 * removed replicas or expired forwards. Keep a second tenant in the fixture. */
d("bounded cloud management history plans",()=>{
  let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(async()=>{
    pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
    await pool.query("DROP SCHEMA public CASCADE;CREATE SCHEMA public");await runMigrations(pool);
    fixture=await seedReadyCloudWorkspace(pool);const other=await seedReadyCloudWorkspace(pool);
    for(const f of [fixture,other]){
      const device=randomUUID(),blob=randomUUID(),digest=randomBytes(32);
      const values=[f.workspaceId,f.organizationId,f.userId];
      await pool.query(`INSERT INTO devices(id,user_id,label,platform,public_key,key_fingerprint)
        VALUES($1,$2,'Qualification','linux',$3,$3)`,[device,f.userId,randomBytes(32)]);
      await pool.query(`INSERT INTO workspace_replicas(workspace_id,org_id,user_id,device_id,authority_epoch,desired_state,observed_state,removed_at,updated_at)
        SELECT $1,$2,$3,$4,1,'removed','removed',now(),now()-(n*interval '1 second') FROM generate_series(1,5000)n`,[...values,device]);
      await pool.query(`INSERT INTO cloud_workspace_client_access_grants(id,workspace_id,generation,org_id,account_user_id,kind,
        remote_port,provider_resource_id,preview_proxy_label,token_hash,idempotency_key,request_sha256,state,requested_expires_at,expires_at,issued_at)
        SELECT gen_random_uuid(),$1,1,$2,$3,'preview',3000,'qualification-resource',md5($1::uuid::text||n::text),digest($1::uuid::text||n::text,'sha256'),'history-'||n,$4,'active',now()+interval '10 minutes',now()+interval '10 minutes',now()
        FROM generate_series(1,5000)n`,[...values,randomBytes(32)]);
      await pool.query(`INSERT INTO port_forward_sessions(workspace_id,org_id,user_id,generation,device_id,access_grant_id,remote_port,state,expires_at,updated_at)
        SELECT $1,$2,$3,1,$4,grant_row.id,3000,'stopped',now()+interval '10 minutes',now()-(row_number() OVER(ORDER BY grant_row.id)*interval '1 second')
        FROM cloud_workspace_client_access_grants grant_row WHERE workspace_id=$1`,[...values,device]);
      await pool.query(`INSERT INTO workspace_checkpoint_requests(workspace_id,org_id,generation,requested_by,reason,state,idempotency_key,deadline_at,completed_at,created_at)
        SELECT $1,$2,1,$3,'manual','expired','history-'||n,now(),now(),now()-(n*interval '1 second') FROM generate_series(1,5000)n`,values);
      await pool.query(`INSERT INTO workspace_content_heads(workspace_id,org_id,current_revision) VALUES($1,$2,5000)`,values.slice(0,2));
      await pool.query(`INSERT INTO workspace_content_revisions(workspace_id,org_id,revision,parent_revision,authority_epoch,generation,engine_instance_id,idempotency_key,request_sha256,changed_entry_count)
        SELECT $1,$2,n,n-1,1,1,$3,'history-'||n,$4,1 FROM generate_series(1,5000)n`,[f.workspaceId,f.organizationId,f.engineInstanceId,digest]);
      await pool.query(`INSERT INTO workspace_blobs(id,org_id,plaintext_sha256,ciphertext_sha256,plaintext_bytes,ciphertext_bytes,object_key,encryption_key_version,nonce,auth_tag,state,available_at)
        VALUES($1,$2,$3,$3,2,2,$4,1,$5,$6,'available',now())`,[blob,f.organizationId,digest,`qualification/${blob}`,randomBytes(12),randomBytes(16)]);
      await pool.query(`INSERT INTO workspace_checkpoints(workspace_id,org_id,idempotency_key,request_sha256,content_revision,record_revision,authority_epoch,generation,reason,manifest_blob_id,inclusion_policy,file_count,total_bytes,state,integrity_sha256,durable_at,created_at)
        SELECT $1,$2,'history-'||n,$3,n,0,1,1,'manual',$4,'{}',0,0,'durable',$3,now(),now()-(n*interval '1 second') FROM generate_series(1,5000)n`,[f.workspaceId,f.organizationId,digest,blob]);
      await pool.query(`INSERT INTO workspace_exports(workspace_id,org_id,requested_by,checkpoint_id,record_revision,content_revision,idempotency_key,request_sha256,state,created_at)
        SELECT $1,$2,$3,checkpoint.id,0,checkpoint.content_revision,'history-'||checkpoint.content_revision,$4,'failed',checkpoint.created_at
        FROM workspace_checkpoints checkpoint WHERE checkpoint.workspace_id=$1`,[...values,digest]);
    }
    for(const table of ["workspace_replicas","port_forward_sessions","workspace_checkpoint_requests","workspace_checkpoints","workspace_exports"])
      await pool.query(`ANALYZE ${table}`);
  },60000);
  afterAll(async()=>{await pool?.end();});
  it.each([
    ["workspace_replicas","user_id","updated_at DESC,id",100],
    ["port_forward_sessions","user_id","updated_at DESC,id",50],
    ["workspace_checkpoint_requests",null,"created_at DESC,id DESC",20],
    ["workspace_checkpoints",null,"created_at DESC,id DESC",20],
    ["workspace_exports","requested_by","created_at DESC,id DESC",20],
  ] as const)("reads a small %s page without scanning its full history",async(table,actor,order,limit)=>{
    const args=[fixture.workspaceId,fixture.organizationId,...(actor?[fixture.userId]:[])];
    const result=await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM ${table}
      WHERE workspace_id=$1 AND org_id=$2 ${actor?`AND ${actor}=$3`:""} ORDER BY ${order} LIMIT ${limit}`,args);
    const plan:Plan=result.rows[0]["QUERY PLAN"][0].Plan,all=nodes(plan);
    expect(plan["Actual Rows"]).toBe(limit);
    expect(all.some(node=>node["Node Type"].includes("Sort"))).toBe(false);
    expect(Math.max(...all.map(node=>node["Actual Rows"]+(node["Rows Removed by Filter"]??0)))).toBeLessThanOrEqual(limit+10);
  });
});
