import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { seedReadyCloudWorkspace } from './test-fixtures.js';
import { pauseBeforeQuery } from './authority-deadline-test-utils.js';
import { DatabaseCloudCustomizationService } from './customization-store.js';
import { readFile } from 'node:fs/promises';

describe.runIf(!!process.env.TEST_DATABASE_URL)('customization authorization and migration compatibility', () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  beforeAll(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await runMigrations(pool); });
  afterAll(async () => { await pool.end(); });
  it('rechecks the administrator role on the locked membership row', async () => {
    const org = await seedReadyCloudWorkspace(pool), admin = await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')", [org.organizationId, admin.userId]);
    const barrier = pauseBeforeQuery(pool, /SELECT member.role FROM organization_members/);
    const service = new DatabaseCloudCustomizationService(barrier.pool, { keys: {1:randomBytes(32).toString('base64url')}, currentKeyVersion:1 });
    const saving = service.save(org.organizationId, admin.userId, 'organization', { expectedRevision:0, document:{ servers:[],skills:[{name:'after-demotion',content:'This admin has already been demoted.'}],cursorTeamSettings:'disabled' } });
    await barrier.atBarrier;
    try { await pool.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [org.organizationId,admin.userId]); }
    finally { barrier.release(); }
    await expect(saving).rejects.toMatchObject({status:403});
  });

  it('keeps old qualification readers and writers compatible while 0115 defaults both old and new rows to false', async () => {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      // Reconstruct only the additive 0115 boundary inside a rolled-back
      // transaction; execute the exact migration artifact, not a mock DDL.
      await client.query('DROP TABLE cloud_customization_execution_snapshots,cloud_customization; ALTER TABLE cloud_agent_execution_leases DROP COLUMN customization_digest; ALTER TABLE cloud_agent_runtime_qualifications DROP COLUMN mcp_qualified');
      const legacyInsert=`INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled) VALUES('boat',$1,$2,'cursor-api-key','zeros-cloud-worker-v3',true)`;
      await client.query(legacyInsert,['v7-before','a'.repeat(64)]);
      await client.query(await readFile(new URL('../../migrations/0115_cloud_customization.sql', import.meta.url),'utf8'));
      await client.query(legacyInsert,['v7-after','a'.repeat(64)]);
      expect((await client.query("SELECT enabled,mcp_qualified FROM cloud_agent_runtime_qualifications WHERE image_ref IN ('v7-before','v7-after') ORDER BY image_ref")).rows).toEqual([{enabled:true,mcp_qualified:false},{enabled:true,mcp_qualified:false}]);
      await client.query("UPDATE cloud_agent_runtime_qualifications SET enabled=false WHERE image_ref='v7-before'");
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_agent_runtime_qualifications WHERE image_ref LIKE 'v7-%' AND enabled")).rows[0].n).toBe(1);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
