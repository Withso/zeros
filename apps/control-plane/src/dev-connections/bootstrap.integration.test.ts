import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { bootstrapDevConnectionDatabase } from "./bootstrap.js";
import { checkDevConnectionsSchema } from "./migrate.js";
import { quarantineRestoredConnections } from "./quarantine.js";
import { DevConnectionStore } from "./store.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("persistent database bootstrap and offline snapshot recovery",()=>{
  it("replays owner migrations, restricts the runtime login, and quarantines a stale snapshot before service start",async()=>{
    const base=new URL(process.env.TEST_DATABASE_URL!),admin=new pg.Pool({connectionString:base.href,max:1});
    const runId=randomUUID().replaceAll('-',''),adminRole=`dev_connections_admin_${runId}`,snapshotDatabase=`dev_connections_restore_${runId}`;
    const url=(name:string,database='dev_connections')=>{const value=new URL(base);value.pathname=`/${database}`;value.username=name;value.password=randomBytes(32).toString('base64url');return value.href;};
    const ownerUrl=url('zeros_connections_owner'),runtimeUrl=url('zeros_connections_runtime');
    const env={ZEROS_DEPLOY_ENV:'dev',ZEROS_DEV_CONNECTIONS_ENABLED:'true',DEV_CONNECTIONS_ADMIN_DATABASE_URL:url(adminRole),
      DEV_CONNECTIONS_MIGRATION_DATABASE_URL:ownerUrl,DEV_CONNECTIONS_DATABASE_URL:runtimeUrl};
    let runtime:pg.Pool|undefined,restored:pg.Pool|undefined;
    let databaseCreated=false;
    const rolesToDrop=[adminRole];
    try{
      // The product schema prepared by global setup must remain separate.
      expect((await admin.query("SELECT to_regclass('public.users') AS product")).rows[0].product).not.toBeNull();
      // Bootstrap requires a canonical database name and 43-character passwords.
      // Keep the server admin credentials intact; provision a disposable login.
      await admin.query(`CREATE ROLE "${adminRole}" LOGIN SUPERUSER PASSWORD '${new URL(env.DEV_CONNECTIONS_ADMIN_DATABASE_URL).password}'`);
      await admin.query('CREATE DATABASE dev_connections');
      databaseCreated=true;
      const brokerRoles=['zeros_connections_owner','zeros_connections_runtime'];
      const existingRoles=(await admin.query<{rolname:string}>('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[brokerRoles])).rows;
      rolesToDrop.push(...brokerRoles.filter(name=>!existingRoles.some(role=>role.rolname===name)));
      await bootstrapDevConnectionDatabase(env);await bootstrapDevConnectionDatabase(env);
      runtime=new pg.Pool({connectionString:runtimeUrl,max:1});await checkDevConnectionsSchema(runtime);
      expect((await runtime.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0])
        .toEqual({rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false});
      await expect(runtime.query('ALTER TABLE dev_connections.connections ADD COLUMN unsafe text')).rejects.toThrow();
      const keys={keys:{1:randomBytes(32).toString('base64url')},currentKeyVersion:1,
        refreshFingerprints:{keys:{1:randomBytes(32).toString('base64url')},currentKeyVersion:1}};
      const store=new DevConnectionStore(runtime,keys),registration={id:randomUUID(),owner:'a'.repeat(24),organization:'org_test',audience:'zeros-dev-connections-v1',
        credential:randomBytes(32).toString('base64url'),keyRevision:1,expiresAt:new Date(Date.now()+3600000).toISOString(),source:'hosted-dev' as const};
      await store.registerGeneration(registration);
      const context={member:{issuer:'https://identity.example.test',subject:'user_test',organization:'org_test',sessionId:'session_test',expiresAt:Date.now()+3600000},
        generation:{id:registration.id,credential:registration.credential,audience:registration.audience}};
      await store.connect(context,{id:randomUUID(),accountId:'member',appScope:'api',material:{kind:'cursor-api-key',apiKey:'synthetic-drill-key'},
        consent:{models:['test-model'],repositories:[],scopes:['agent']}});
      expect(await store.restore(context)).toHaveLength(1);
      expect((await runtime.query('SELECT * FROM dev_connections.members')).rowCount).toBe(0);
      await runtime.end();runtime=undefined;
      // A PostgreSQL template clone is a consistent stale DB snapshot. The
      // restored database stays offline until the owner-only quarantine ends.
      await admin.query(`CREATE DATABASE "${snapshotDatabase}" TEMPLATE dev_connections`);
      const restoreUrl=new URL(ownerUrl);restoreUrl.pathname=`/${snapshotDatabase}`;
      restored=new pg.Pool({connectionString:restoreUrl.href,max:1});
      await quarantineRestoredConnections(restored);await quarantineRestoredConnections(restored);
      const resumed=new DevConnectionStore(restored,keys);
      await expect(resumed.restore(context)).rejects.toThrow();
      await expect(resumed.registerGeneration(registration)).rejects.toThrow();
      expect((await restored.query("SELECT * FROM dev_connections.connection_versions")).rowCount).toBe(0);
      expect((await restored.query("SELECT to_regclass('public.users') AS product")).rows[0].product).toBeNull();
      expect((await admin.query("SELECT to_regclass('public.users') AS product")).rows[0].product).not.toBeNull();
    }finally{
      try{
        await runtime?.end();await restored?.end();
        await admin.query(`DROP DATABASE IF EXISTS "${snapshotDatabase}"`);
        if(databaseCreated)await admin.query('DROP DATABASE IF EXISTS dev_connections');
        for(const role of rolesToDrop)await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }finally{await admin.end();}
    }
  });
});
