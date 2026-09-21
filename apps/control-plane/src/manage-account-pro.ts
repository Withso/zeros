import {createHash} from "node:crypto";
import {constants,openSync,fstatSync,readFileSync,closeSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import type pg from "pg";
import {z} from "zod";
import {createMigrationPool} from "./db.js";
import {parseDatabaseTarget} from "./database-target.js";

const ChangeSchema=z.object({
  operationId:z.string().uuid(),
  channel:z.enum(["development","alpha","beta","production"]),
  subjectUserId:z.string().uuid(),
  expectedEmail:z.string().trim().email().max(320).transform(value=>value.toLowerCase()),
  actorUserId:z.string().uuid(),
  enabled:z.boolean(),
  validFrom:z.string().datetime({offset:true}).transform(value=>new Date(value).toISOString()),
  validUntil:z.string().datetime({offset:true}).transform(value=>new Date(value).toISOString()).nullable(),
  reason:z.string().trim().min(16).max(512),
}).strict().refine(value=>value.validUntil===null||value.validUntil>value.validFrom,"Invalid entitlement validity interval");
export type AccountProChange=z.input<typeof ChangeSchema>;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
type State={plan:string;status:string;cloudWorkspacesAllowed:boolean;source:string;validFrom:string;validUntil:string|null;revision:string};
type User={id:string;email:string;staff_role:string|null;auth_status:string;deleted_at:Date|null;auth_revision:string};

/** Explicit operator authority while billing is deferred. Staff membership,
 * organization activation and compute credits never fabricate a Pro grant. */
export async function manageAccountPro(pool:pg.Pool,input:unknown,options:{databaseUrl:string;channel:string;execute?:boolean;approval?:string|undefined}) {
  const parsed=ChangeSchema.safeParse(input);
  if(!parsed.success)throw new Error("Individual Pro document is invalid");
  const request=parsed.data;
  if(request.channel!==options.channel)throw new Error("Individual Pro deployment channel mismatch");
  const target=parseDatabaseTarget(options.databaseUrl);
  const targetSha256=hash([request.channel,target.hostname,target.port,target.pathname,decodeURIComponent(target.username)]);
  const requestSha256=hash(request);
  const client=await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; SELECT set_config('app.system','on',true)");
    const authority=(await client.query<{principal:string;database:string;allowed:boolean}>(`SELECT current_user AS principal,current_database() AS database,
      current_user<>'zeros_app' AND bool_and(pg_get_userbyid(relowner)=current_user) AS allowed FROM pg_class
      WHERE oid IN ('public.account_entitlements'::regclass,'public.account_pro_entitlement_changes'::regclass)`)).rows[0];
    if(!authority?.allowed||authority.database!==decodeURIComponent(target.pathname.slice(1)))throw new Error("Individual Pro requires the exact database migration owner");
    // One ordered account lock also serializes two absent entitlement inserts.
    const users=(await client.query<User>("SELECT id,email,staff_role,auth_status,deleted_at,auth_revision FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",[[request.actorUserId,request.subjectUserId]])).rows;
    const actor=users.find(row=>row.id===request.actorUserId),subject=users.find(row=>row.id===request.subjectUserId);
    if(!actor||actor.auth_status!=="active"||actor.deleted_at||actor.staff_role!=="platform_owner")throw new Error("Individual Pro requires an active platform owner");
    const receipt=(await client.query<{target_sha256:string;request_sha256:string;plan_sha256:string}>("SELECT target_sha256,request_sha256,plan_sha256 FROM account_pro_entitlement_changes WHERE operation_id=$1",[request.operationId])).rows[0];
    if(receipt){
      if(receipt.target_sha256!==targetSha256||receipt.request_sha256!==requestSha256)throw new Error("Individual Pro operation already identifies another change");
      if(options.execute&&options.approval!==receipt.plan_sha256)throw new Error("Individual Pro plan changed");
      await client.query("ROLLBACK");
      return {state:options.execute?"replayed" as const:"committed" as const,planSha256:receipt.plan_sha256,targetSha256};
    }
    if(!subject||subject.auth_status==="deleted"||(request.enabled&&(subject.auth_status!=="active"||subject.deleted_at)))throw new Error("Individual Pro grants require an active subject; erased accounts cannot change");
    if(subject.email.toLowerCase()!==request.expectedEmail)throw new Error("Individual Pro expected identity does not match");
    const row=(await client.query<{plan:string;status:string;cloud_workspaces_allowed:boolean;source:string;valid_from:Date;valid_until:Date|null;revision:string}>("SELECT plan,status,cloud_workspaces_allowed,source,valid_from,valid_until,revision FROM account_entitlements WHERE user_id=$1 FOR UPDATE",[request.subjectUserId])).rows[0];
    if(row&&row.source!=="operator")throw new Error("Individual Pro cannot overwrite billing or migration-owned authority");
    const previous:State|null=row?{plan:row.plan,status:row.status,cloudWorkspacesAllowed:row.cloud_workspaces_allowed,source:row.source,validFrom:row.valid_from.toISOString(),validUntil:row.valid_until?.toISOString()??null,revision:String(row.revision)}:null;
    const revision=String(BigInt(previous?.revision??"0")+1n);
    const next:State={plan:"pro",status:request.enabled?"active":"cancelled",cloudWorkspacesAllowed:request.enabled,source:"operator",validFrom:request.validFrom,validUntil:request.validUntil,revision};
    const sequence=(await client.query<{revision:string}>("SELECT coalesce(max(change_sequence),0)::text AS revision FROM account_pro_entitlement_changes WHERE subject_user_id=$1",[request.subjectUserId])).rows[0]!.revision;
    const planSha256=hash({targetSha256,requestSha256,previous,next,sequence,actorRevision:String(actor.auth_revision),subjectRevision:String(subject.auth_revision),principal:authority.principal});
    if(!options.execute){await client.query("ROLLBACK");return{state:"planned" as const,planSha256,targetSha256,previous,next};}
    if(options.approval!==planSha256)throw new Error("Individual Pro plan changed; inspect the current target before execution");
    await client.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source,source_reference,valid_from,valid_until,revision)
      VALUES($1,'pro',$2,$3,'operator',$4,$5,$6,$7)
      ON CONFLICT(user_id) DO UPDATE SET plan=EXCLUDED.plan,status=EXCLUDED.status,cloud_workspaces_allowed=EXCLUDED.cloud_workspaces_allowed,
      source=EXCLUDED.source,source_reference=EXCLUDED.source_reference,valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,revision=EXCLUDED.revision,updated_at=clock_timestamp()`,
      [request.subjectUserId,next.status,next.cloudWorkspacesAllowed,request.operationId,next.validFrom,next.validUntil,next.revision]);
    const changed=(await client.query<{auth_revision:string}>("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1 RETURNING auth_revision",[request.subjectUserId])).rows[0]!;
    await client.query("INSERT INTO security_events(kind,user_id,account_revision,payload) VALUES('account.authorization_changed',$1,$2,jsonb_build_object('reason','pro_entitlement_changed'))",[request.subjectUserId,changed.auth_revision]);
    await client.query(`INSERT INTO account_pro_entitlement_changes(operation_id,subject_user_id,actor_user_id,deployment_channel,target_sha256,request_sha256,plan_sha256,previous_state,next_state,database_principal,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,[request.operationId,request.subjectUserId,request.actorUserId,request.channel,targetSha256,requestSha256,planSha256,JSON.stringify(previous),JSON.stringify(next),authority.principal,request.reason]);
    await client.query("COMMIT");
    return{state:"changed" as const,planSha256,targetSha256,previous,next};
  } catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
}

async function main(){
  const file=process.env.ACCOUNT_PRO_CHANGE_FILE,databaseUrl=process.env.DATABASE_URL,channel=process.env.RAILWAY_ENVIRONMENT_NAME??process.env.CONTROL_PLANE_ACCOUNT_PRO_CHANNEL;
  if(!file||!databaseUrl||!channel)throw new Error("Individual Pro configuration is incomplete");
  const args=process.argv.slice(2);if(args.some(arg=>arg!=="--execute")||args.length>1)throw new Error("Unsupported operator arguments");
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let input:unknown;
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>16384)throw new Error("Invalid operator document");input=JSON.parse(readFileSync(fd,"utf8"));}finally{closeSync(fd);}
  const pool=createMigrationPool(databaseUrl);
  try{const result=await manageAccountPro(pool,input,{databaseUrl,channel,execute:args.includes("--execute"),approval:process.env.ACCOUNT_PRO_PLAN_SHA256});console.log(JSON.stringify(result));}
  finally{await pool.end();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))void main().catch(()=>{console.error("[account-pro] request failed; inspect the target, owner, identity, validity and approval");process.exitCode=1;});
