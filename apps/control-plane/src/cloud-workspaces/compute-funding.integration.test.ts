import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withSystemTx,withUserTx} from '../db.js';
import {runMigrations} from '../migrate.js';
import {seedReadyCloudWorkspace,type ReadyCloudWorkspaceFixture} from './test-fixtures.js';
import {DatabaseManagedComputeCreditLedger} from './compute-credits.js';
import {DatabaseComputeUserFunding,lockComputeUserFunding,prepareComputeUserPeriods,allocateComputeUserFunding} from './compute-funding.js';
import {applyCloudComputeGrant,planCloudComputeGrant} from '../manage-cloud-compute-credit.js';

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d('individual Pro compute conservation',()=>{
  let pool:pg.Pool,a:ReadyCloudWorkspaceFixture,b:ReadyCloudWorkspaceFixture,funding:DatabaseComputeUserFunding,ledger:DatabaseManagedComputeCreditLedger,now:number;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await runMigrations(pool);
    a=await seedReadyCloudWorkspace(pool);b=await seedReadyCloudWorkspace(pool,{ownerUserId:a.userId});
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1",[a.userId]);
    await pool.query("UPDATE organization_entitlements SET plan='pro',seat_limit=NULL WHERE org_id=ANY($1::uuid[])",[[a.organizationId,b.organizationId]]);
    await pool.query("UPDATE workspace_billing_epochs SET entitlement_scope='account',entitlement_plan='pro' WHERE workspace_id=ANY($1::uuid[])",[[a.workspaceId,b.workspaceId]]);
    now=Date.now();funding=new DatabaseComputeUserFunding(pool);ledger=new DatabaseManagedComputeCreditLedger({pool,workosEnabled:false});
  });
  const receipt=(amountMicroUsd=20_000)=>({userId:a.userId,startsAt:new Date(now-3600_000),endsAt:new Date(now+3600_000),amountMicroUsd,
    source:{kind:'operator' as const,id:randomUUID(),lineItemId:'monthly'},operator:{actorUserId:a.userId,reason:'Explicit isolated qualification allowance',targetFingerprint:'a'.repeat(64)}});
  const child=async(f:ReadyCloudWorkspaceFixture)=>withSystemTx(pool,async tx=>{
    await lockComputeUserFunding(tx,a.userId);await prepareComputeUserPeriods(tx,{userId:a.userId,organizationId:f.organizationId});
    return (await tx.query<{id:string}>("SELECT id FROM managed_compute_credit_periods WHERE org_id=$1 AND user_id=$2",[f.organizationId,a.userId])).rows[0]!.id;
  });
  const reserve=(f:ReadyCloudWorkspaceFixture,periodId:string,amount=15_000,changes={})=>ledger.reserve({organizationId:f.organizationId,workspaceId:f.workspaceId,
    generation:1,billingEpoch:1,reservationId:randomUUID(),policyId:'allocated-time-v1',secondsPerDollar:100_000,
    allocations:[{periodId,meterSince:new Date(now-600_000),coveredUntil:new Date(now+600_000),authorizationMicroUsd:amount}],...changes});

  it('funds one global receipt exactly once, without exposing another user through tenant RLS',async()=>{
    const input=receipt(),first=await funding.fund(input);
    expect(await funding.fund(input)).toEqual({...first,replayed:true});
    await expect(funding.fund({...input,amountMicroUsd:21_000})).rejects.toMatchObject({code:'compute_credit_conflict'});
    const other=await seedReadyCloudWorkspace(pool);
    await expect(funding.fund({...input,userId:other.userId})).rejects.toMatchObject({code:'compute_credit_conflict'});
    expect(await funding.balanceForUser(a.userId)).toMatchObject([{grantedMicroUsd:20_000,availableMicroUsd:20_000}]);
    expect((await withUserTx(pool,a.userId,tx=>tx.query('SELECT 1 FROM managed_compute_user_periods'))).rowCount).toBe(0);
  });
  it('executes an explicit user-scoped operator plan once across multiple Pro organizations',async()=>{
    const input=receipt();
    const plan=planCloudComputeGrant(process.env.TEST_DATABASE_URL!,{fundingScope:'user',channel:'development',
      userId:a.userId,actorUserId:a.userId,startsAt:input.startsAt.toISOString(),endsAt:input.endsAt.toISOString(),
      amountMicroUsd:input.amountMicroUsd,policyId:'pilot-v1',idempotencyKey:input.source.id,reason:input.operator.reason});
    await expect(applyCloudComputeGrant(pool,plan,'0'.repeat(64))).rejects.toThrow('plan changed');
    const first=await applyCloudComputeGrant(pool,plan,plan.digest);
    expect(await applyCloudComputeGrant(pool,plan,plan.digest)).toEqual({...first,replayed:true});
    expect((await pool.query('SELECT count(*)::int AS n FROM managed_compute_user_periods')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM managed_compute_credit_periods')).rows[0].n).toBe(0);
    const pa=await child(a),pb=await child(b);
    await reserve(a,pa,10_000);await reserve(b,pb,10_000);
    expect(await funding.balanceForUser(a.userId)).toMatchObject([{grantedMicroUsd:20_000,reservedMicroUsd:20_000,availableMicroUsd:0}]);
  });
  it('serializes reservations in different organizations against a single allowance',async()=>{
    await funding.fund(receipt());const pa=await child(a),pb=await child(b);
    const outcomes=await Promise.allSettled([reserve(a,pa),reserve(b,pb)]);
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(await funding.balanceForUser(a.userId)).toMatchObject([{grantedMicroUsd:20_000,reservedMicroUsd:15_000,availableMicroUsd:5_000}]);
    const total=(await pool.query('SELECT sum(granted_micro_usd-returned_micro_usd) AS allocated,sum(reserved_micro_usd) AS reserved FROM managed_compute_credit_periods')).rows[0];
    expect(Number(total.allocated)).toBe(15_000);expect(Number(total.reserved)).toBe(15_000);
  });
  it('moves only unreserved money from a previous org, even after leaving it, and meters the original payer',async()=>{
    await funding.fund(receipt());const pa=await child(a),pb=await child(b);
    await withSystemTx(pool,async tx=>{await lockComputeUserFunding(tx,a.userId);await allocateComputeUserFunding(tx,{periodId:pa,userId:a.userId,requiredAvailableMicroUsd:10_000});});
    await pool.query('DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2',[a.organizationId,a.userId]);
    const [hold]=await reserve(b,pb);
    expect((await pool.query('SELECT returned_micro_usd FROM managed_compute_credit_periods WHERE id=$1',[pa])).rows[0].returned_micro_usd).toBe('5000');
    expect(await ledger.balanceSystem({organizationId:a.organizationId,userId:a.userId})).toMatchObject([{availableMicroUsd:5_000}]);
    await ledger.meter({reservationId:hold!.reservationId,periodId:pb,usage:{resourceId:`sandbox-${b.workspaceId}`,
      since:new Date(now-600_000).toISOString(),until:new Date(now-550_000).toISOString(),billableSeconds:50,secondsPerDollar:100_000,listPriceMicroUsd:500,running:false},finalReason:'allocation_stopped'});
    expect(await funding.balanceForUser(a.userId)).toMatchObject([{debitedMicroUsd:500,reservedMicroUsd:0,availableMicroUsd:19_500}]);
  });
  it('rolls back funding movements when any period segment is unavailable',async()=>{
    await funding.fund(receipt());const pa=await child(a);
    await expect(reserve(a,pa,10_000,{allocations:[{periodId:pa,meterSince:new Date(now-600_000),coveredUntil:new Date(now+600_000),authorizationMicroUsd:10_000},
      {periodId:randomUUID(),meterSince:new Date(now+600_000),coveredUntil:new Date(now+700_000),authorizationMicroUsd:10_000}]})).rejects.toBeDefined();
    expect((await pool.query('SELECT count(*)::int AS n FROM managed_compute_funding_movements')).rows[0].n).toBe(0);
    expect(await funding.balanceForUser(a.userId)).toMatchObject([{availableMicroUsd:20_000,reservedMicroUsd:0}]);
  });
  it('does not use Pro money for Business authority',async()=>{
    await funding.fund(receipt());const pa=await child(a);
    await pool.query("UPDATE workspace_billing_epochs SET entitlement_scope='organization',entitlement_plan='business' WHERE workspace_id=$1",[a.workspaceId]);
    await pool.query("UPDATE organization_entitlements SET plan='business',seat_limit=5 WHERE org_id=$1",[a.organizationId]);
    await expect(reserve(a,pa)).rejects.toMatchObject({code:'compute_credit_scope_rejected'});
    expect(await funding.balanceForUser(a.userId)).toMatchObject([{availableMicroUsd:20_000,reservedMicroUsd:0}]);
  });
  it('does not add a Business grant to a period backed by individual Pro funds',async()=>{
    const input=receipt();await funding.fund(input);const pa=await child(a),pb=await child(b);
    await withSystemTx(pool,async tx=>{await lockComputeUserFunding(tx,a.userId);await allocateComputeUserFunding(tx,{periodId:pa,userId:a.userId,requiredAvailableMicroUsd:10_000});});
    await pool.query("UPDATE organization_entitlements SET plan='business',seat_limit=5 WHERE org_id=$1",[a.organizationId]);
    const before=(await pool.query('SELECT * FROM managed_compute_credit_periods ORDER BY id')).rows;
    await expect(ledger.grant({organizationId:a.organizationId,userId:a.userId,startsAt:input.startsAt,endsAt:input.endsAt,
      amountMicroUsd:20_000,policyId:'business-test-v1',idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'compute_credit_funding_mode_conflict'});
    expect((await pool.query('SELECT * FROM managed_compute_credit_periods ORDER BY id')).rows).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM managed_compute_credit_grants WHERE policy_id='business-test-v1'")).rows[0].n).toBe(0);
    await reserve(b,pb);
    expect(await funding.balanceForUser(a.userId)).toMatchObject([{grantedMicroUsd:20_000,reservedMicroUsd:15_000,availableMicroUsd:5_000}]);
  });
  it('does not lock an unrelated empty child when the root already covers the allocation',async()=>{
    await funding.fund(receipt());const pa=await child(a),pb=await child(b);
    const blocker=await pool.connect();
    try{
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM managed_compute_credit_periods WHERE id=$1 FOR UPDATE',[pb]);
      await withSystemTx(pool,async tx=>{
        await tx.query("SET LOCAL lock_timeout='250ms'");await lockComputeUserFunding(tx,a.userId);
        await allocateComputeUserFunding(tx,{periodId:pa,userId:a.userId,requiredAvailableMicroUsd:10_000});
      });
    }finally{await blocker.query('ROLLBACK');blocker.release();}
    expect(await funding.balanceForUser(a.userId)).toMatchObject([{availableMicroUsd:20_000}]);
  });
});
