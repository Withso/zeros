import pg from "pg";
import { migrateDevConnections } from "./migrate.js";

/** Runs in a temporary administrative deployment with no member routes.
 * The next deployment replaces the complete variable collection, removing both
 * owner URLs before the runtime process can serve or renew provider material. */
export async function bootstrapDevConnectionDatabase(env:NodeJS.ProcessEnv) {
  const admin=new URL(env.DEV_CONNECTIONS_ADMIN_DATABASE_URL!),owner=new URL(env.DEV_CONNECTIONS_MIGRATION_DATABASE_URL!),runtime=new URL(env.DEV_CONNECTIONS_DATABASE_URL!);
  if(env.ZEROS_DEPLOY_ENV!=='dev'||env.ZEROS_DEV_CONNECTIONS_ENABLED!=='true'||admin.pathname!=='/dev_connections'||
    [owner,runtime].some(u=>u.host!==admin.host||u.pathname!==admin.pathname)||owner.username!=='zeros_connections_owner'||runtime.username!=='zeros_connections_runtime'||
    ![admin,owner,runtime].every(u=>/^[A-Za-z0-9_-]{43}$/.test(u.password)))throw new Error('Invalid dedicated database bootstrap');
  const pool=new pg.Pool({connectionString:admin.href,max:1,connectionTimeoutMillis:5000});
  try {
    const tx=await pool.connect();
    try{
      await tx.query('BEGIN; SELECT pg_advisory_xact_lock(730318511)');
      if((await tx.query("SELECT to_regclass('public.users') AS product")).rows[0].product)throw new Error('Refuse product database bootstrap');
      for(const url of [owner,runtime]){
        const role=(await tx.query('SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1',[url.username])).rows[0];
        if(role&&(role.rolsuper||role.rolbypassrls||role.rolcreatedb||role.rolcreaterole))throw new Error('Unsafe persistent database role');
        if(!role)await tx.query(`CREATE ROLE ${url.username} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${url.password}'`);
      }
      await tx.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zeros_app') THEN CREATE ROLE zeros_app NOLOGIN NOBYPASSRLS; END IF; END $$");
      await tx.query('GRANT zeros_app TO zeros_connections_runtime,zeros_connections_owner');
      await tx.query('ALTER DATABASE dev_connections OWNER TO zeros_connections_owner; ALTER SCHEMA public OWNER TO zeros_connections_owner');
      await tx.query('COMMIT');
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
    const migration=new pg.Pool({connectionString:owner.href,max:1});
    try{await migrateDevConnections(migration);}finally{await migration.end();}
  }finally{await pool.end();}
}
