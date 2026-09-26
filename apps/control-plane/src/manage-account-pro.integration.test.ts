import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {runMigrations} from './migrate.js';
import {withSystemTx} from './db.js';
import {manageAccountPro,type AccountProChange} from './manage-account-pro.js';
import {Hono} from 'hono';
import {ensureUser} from './auth.js';
import {createDeletionLifecycleRoutes} from './deletion-lifecycle.js';
const url=process.env.TEST_DATABASE_URL,d=url?describe:describe.skip;
d('explicit individual Pro operator authority',()=>{
 let pool:pg.Pool,actor:string,subject:string,input:AccountProChange;
 const options=()=>({databaseUrl:url!,channel:'development'});
 beforeAll(()=>{pool=new pg.Pool({connectionString:url,max:4});});
 afterAll(async()=>{await pool.end();});
 beforeEach(async()=>{
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await runMigrations(pool);
  actor=randomUUID();subject=randomUUID();
  await pool.query("INSERT INTO users(id,email,display_name,staff_role) VALUES($1,$2,'Owner','platform_owner'),($3,$4,'Pro member',NULL)",[actor,actor+'@example.test',subject,subject+'@example.test']);
  input={operationId:randomUUID(),channel:'development',actorUserId:actor,subjectUserId:subject,expectedEmail:subject+'@example.test',enabled:true,validFrom:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+3600000).toISOString(),reason:'Explicit individual Pro pilot qualification allowance'};
 });
 async function execute(change=input){const plan=await manageAccountPro(pool,change,options());return manageAccountPro(pool,change,{...options(),execute:true,approval:plan.planSha256});}
 it('records paid Pro alongside complimentary staff Pro once without an organization or compute budget',async()=>{
  await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1",[subject]);
  expect((await withSystemTx(pool,tx=>tx.query('SELECT cloud_workspace_pro_user_live($1) AS live',[subject]))).rows[0].live).toBe(true);
  const plan=await manageAccountPro(pool,input,options());expect(plan.state).toBe('planned');
  expect((await pool.query('SELECT count(*)::int AS n FROM account_entitlements')).rows[0].n).toBe(0);
  const result=await manageAccountPro(pool,input,{...options(),execute:true,approval:plan.planSha256});expect(result.state).toBe('changed');
  expect((await manageAccountPro(pool,input,{...options(),execute:true,approval:plan.planSha256})).state).toBe('replayed');
  expect((await pool.query('SELECT plan,status,cloud_workspaces_allowed,revision FROM account_entitlements WHERE user_id=$1',[subject])).rows[0]).toEqual({plan:'pro',status:'active',cloud_workspaces_allowed:true,revision:'1'});
  expect((await withSystemTx(pool,tx=>tx.query('SELECT cloud_workspace_pro_user_live($1) AS live',[subject]))).rows[0].live).toBe(true);
  expect((await pool.query('SELECT count(*)::int AS n FROM managed_compute_funding_receipts')).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int AS n FROM account_pro_entitlement_changes')).rows[0].n).toBe(1);
 });
 it('acknowledges a committed operation after subject eligibility or email changes without reapplying authority',async()=>{
  const plan=await manageAccountPro(pool,input,options());await manageAccountPro(pool,input,{...options(),execute:true,approval:plan.planSha256});
  await pool.query("UPDATE users SET auth_status='suspended',email=$2 WHERE id=$1",[subject,'changed-'+subject+'@example.test']);
  const before=(await pool.query('SELECT revision FROM account_entitlements WHERE user_id=$1',[subject])).rows[0].revision;
  expect((await manageAccountPro(pool,input,{...options(),execute:true,approval:plan.planSha256})).state).toBe('replayed');
  expect((await pool.query('SELECT revision FROM account_entitlements WHERE user_id=$1',[subject])).rows[0].revision).toBe(before);
 });
 it('revokes personal Pro immediately and refuses stale approval after grant/revoke/grant ABA',async()=>{
  await execute();const stale={...input,operationId:randomUUID(),enabled:false};const plan=await manageAccountPro(pool,stale,options());
  await execute({...input,operationId:randomUUID(),enabled:false});
  expect((await withSystemTx(pool,tx=>tx.query('SELECT cloud_workspace_pro_user_live($1) AS live',[subject]))).rows[0].live).toBe(false);
  await execute({...input,operationId:randomUUID()});
  await expect(manageAccountPro(pool,stale,{...options(),execute:true,approval:plan.planSha256})).rejects.toThrow(/plan/i);
  expect((await pool.query('SELECT revision FROM account_entitlements WHERE user_id=$1',[subject])).rows[0].revision).toBe('3');
 });
 it('revokes after actual account deletion scheduling and preserves the revocation on restore',async()=>{
  const now=Math.floor(Date.now()/1000),suffix=randomUUID().replaceAll('-','');
  const account=await ensureUser(pool,{provider:'workos',providerSubject:'user_'+suffix,email:'deletion-'+suffix+'@example.test',displayName:'Deletion qualification',session:{id:'session_'+suffix,clientKind:'web',authTime:now,tokenExpiresAt:now+3600}});
  const grant={...input,subjectUserId:account.id,expectedEmail:account.email};await execute(grant);
  const app=new Hono();app.use('*',async(c,next)=>{c.set('user',account);await next();});app.route('/',createDeletionLifecycleRoutes(pool));
  const response=await app.request('/v1/account/deletion',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation:'DELETE MY ACCOUNT'})});
  expect(response.status).toBe(202);const scheduled=await response.json() as {deletion:{id:string}};
  const before=(await pool.query('SELECT auth_status,deleted_at,deletion_request_id,auth_revision FROM users WHERE id=$1',[account.id])).rows[0];
  expect(before.auth_status).toBe('deletion_pending');expect(before.deleted_at).toBeInstanceOf(Date);expect(before.deletion_request_id).toBe(scheduled.deletion.id);
  const revoke={...grant,operationId:randomUUID(),enabled:false};await execute(revoke);
  expect(BigInt((await pool.query('SELECT auth_revision FROM users WHERE id=$1',[account.id])).rows[0].auth_revision)).toBe(BigInt(before.auth_revision)+1n);
  expect((await pool.query('SELECT status,revision FROM account_entitlements WHERE user_id=$1',[account.id])).rows[0]).toEqual({status:'cancelled',revision:'2'});
  expect((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE user_id=$1 AND kind='account.authorization_changed' AND payload->>'reason'='pro_entitlement_changed'",[account.id])).rows[0].n).toBe(2);
  await expect(execute({...grant,operationId:randomUUID()})).rejects.toThrow(/active/i);
  account.accountStatus='deletion_pending';
  const restored=await app.request('/v1/account/deletion/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:scheduled.deletion.id})});
  expect(restored.status).toBe(200);expect((await withSystemTx(pool,tx=>tx.query('SELECT cloud_workspace_pro_user_live($1) AS live',[account.id]))).rows[0].live).toBe(false);
  await pool.query("UPDATE users SET auth_status='deleted',deleted_at=now() WHERE id=$1",[account.id]);
  await expect(execute({...revoke,operationId:randomUUID()})).rejects.toThrow(/erased/i);
 });
 it('binds approval to routed login and deployment and checks the expected identity',async()=>{
  const plan=await manageAccountPro(pool,input,options());const target=new URL(url!);target.username='different_operator';
  await expect(manageAccountPro(pool,input,{...options(),databaseUrl:target.toString(),execute:true,approval:plan.planSha256})).rejects.toThrow(/plan/i);
  await expect(manageAccountPro(pool,{...input,expectedEmail:'other@example.test'},options())).rejects.toThrow(/identity/i);
  await expect(manageAccountPro(pool,input,{...options(),channel:'production'})).rejects.toThrow(/channel/i);
  expect((await pool.query('SELECT count(*)::int AS n FROM account_entitlements')).rows[0].n).toBe(0);
 });
 it('refuses to overwrite billing-owned authority or reuse an operation for another change',async()=>{
  await execute();await expect(execute({...input,enabled:false})).rejects.toThrow(/operation/i);
  await pool.query("UPDATE account_entitlements SET source='stripe' WHERE user_id=$1",[subject]);
  await expect(execute({...input,operationId:randomUUID(),enabled:false})).rejects.toThrow(/billing/i);
 });
 it('serializes concurrent first grants and rejects the losing stale approval',async()=>{
  const other={...input,operationId:randomUUID()};
  const plans=await Promise.all([manageAccountPro(pool,input,options()),manageAccountPro(pool,other,options())]);
  const results=await Promise.allSettled([manageAccountPro(pool,input,{...options(),execute:true,approval:plans[0]!.planSha256}),manageAccountPro(pool,other,{...options(),execute:true,approval:plans[1]!.planSha256})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const failure=results.find(result=>result.status==='rejected') as PromiseRejectedResult;expect(failure.reason.message).toMatch(/plan/i);
  expect((await pool.query('SELECT revision FROM account_entitlements WHERE user_id=$1',[subject])).rows[0].revision).toBe('1');
  expect((await pool.query('SELECT count(*)::int AS n FROM account_pro_entitlement_changes WHERE subject_user_id=$1',[subject])).rows[0].n).toBe(1);
 });
 it('requires both an active platform owner and the exact database owner, with immutable audit evidence',async()=>{
  await execute();
  const runtime=new pg.Pool({connectionString:url,options:'-c role=zeros_app',max:1});
  try{await expect(manageAccountPro(runtime,{...input,operationId:randomUUID()},options())).rejects.toThrow(/migration owner/i);}finally{await runtime.end();}
  for(const statement of ['DELETE FROM account_pro_entitlement_changes',"UPDATE account_pro_entitlement_changes SET reason='Forged operator evidence'",'TRUNCATE account_pro_entitlement_changes'])await expect(pool.query(statement)).rejects.toMatchObject({code:'55000'});
  await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1",[actor]);
  await expect(execute({...input,operationId:randomUUID(),enabled:false})).rejects.toThrow(/platform owner/i);
 });
 it('erases account-Pro evidence only after account anonymization, including former operator references',async()=>{
  await execute();
  await expect(withSystemTx(pool,tx=>tx.query('SELECT public.purge_account_pro_configuration($1)',[subject]))).rejects.toMatchObject({code:'55000'});
  await pool.query("UPDATE users SET auth_status='deleted',deleted_at=now() WHERE id=$1",[subject]);
  await withSystemTx(pool,tx=>tx.query('SELECT public.purge_account_pro_configuration($1)',[subject]));
  expect((await pool.query('SELECT count(*)::int AS n FROM account_pro_entitlement_changes')).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int AS n FROM account_entitlements')).rows[0].n).toBe(0);
 });
 it('invalidates plans on identity/lifecycle changes and exposes no audit rows to the app role',async()=>{
  const plan=await manageAccountPro(pool,input,options());
  await pool.query('UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1',[subject]);
  await expect(manageAccountPro(pool,input,{...options(),execute:true,approval:plan.planSha256})).rejects.toThrow(/plan/i);
  await expect(withSystemTx(pool,tx=>tx.query('SELECT * FROM account_pro_entitlement_changes'))).rejects.toMatchObject({code:'42501'});
  await pool.query("UPDATE users SET auth_status='deleted',deleted_at=now() WHERE id=$1",[subject]);
  await expect(execute({...input,operationId:randomUUID()})).rejects.toThrow(/active/i);
 });
});

d('individual Pro revocation and mutation permissions',()=>{
 let pool:pg.Pool;beforeAll(()=>{pool=new pg.Pool({connectionString:url,max:3});});afterAll(async()=>{await pool.end();});
 it('denies direct app entitlement writes and publishes a revision for inactive-account revocation',async()=>{
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await runMigrations(pool);
  const actor=randomUUID(),subject=randomUUID();
  await pool.query("INSERT INTO users(id,email,staff_role) VALUES($1,$2,'platform_owner'),($3,$4,'developer')",[actor,actor+'@example.test',subject,subject+'@example.test']);
  for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE'])expect((await pool.query("SELECT has_table_privilege('zeros_app','account_entitlements',$1) AS allowed",[privilege])).rows[0].allowed).toBe(false);
  const change={operationId:randomUUID(),channel:'development',actorUserId:actor,subjectUserId:subject,expectedEmail:subject+'@example.test',enabled:true,validFrom:new Date(Date.now()-60000).toISOString(),validUntil:null,reason:'Explicit Pro entitlement revocation qualification'};
  const options={databaseUrl:url!,channel:'development'};
  const plan=await manageAccountPro(pool,change,options);await manageAccountPro(pool,change,{...options,execute:true,approval:plan.planSha256});
  await pool.query("UPDATE users SET auth_status='suspended' WHERE id=$1",[subject]);
  const revoke={...change,operationId:randomUUID(),enabled:false};const before=(await pool.query('SELECT auth_revision FROM users WHERE id=$1',[subject])).rows[0].auth_revision;
  const revocation=await manageAccountPro(pool,revoke,options);await manageAccountPro(pool,revoke,{...options,execute:true,approval:revocation.planSha256});
  expect(BigInt((await pool.query('SELECT auth_revision FROM users WHERE id=$1',[subject])).rows[0].auth_revision)).toBe(BigInt(before)+1n);
  expect((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE user_id=$1 AND kind='account.authorization_changed' AND payload->>'reason'='pro_entitlement_changed'",[subject])).rows[0].n).toBe(2);
 });
});
