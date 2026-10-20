import pg from "pg";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { seedExistingDelete } from "./cloud-workspaces/owner-existing-delete-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("existing Delete loss CLI with a restricted migration login", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString:process.env.TEST_DATABASE_URL,max:4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  it("plans, executes and replays without any provider I/O or a superuser login", async () => {
    const f = await seedExistingDelete(pool), input = f.request;
    const directory=await mkdtemp(path.join(tmpdir(),"owner-existing-delete-cli-"));
    const suffix=randomUUID().replaceAll("-","");
    const ownerRole=`existing_delete_owner_${suffix}`,loginRole=`existing_delete_login_${suffix}`,password=randomUUID();
    const principal=(await pool.query("SELECT current_user AS name")).rows[0].name as string;
    await pool.query(`CREATE ROLE ${ownerRole} NOLOGIN;
      CREATE ROLE ${loginRole} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)};
      GRANT ${ownerRole} TO ${loginRole}; GRANT USAGE ON SCHEMA public TO ${ownerRole};
      GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ownerRole};
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ownerRole};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ownerRole};
      ALTER TABLE cloud_workspace_owner_existing_delete_receipts OWNER TO ${ownerRole}`);
    try {
      expect((await pool.query("SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=$1",[loginRole])).rows[0])
        .toEqual({rolsuper:false,rolbypassrls:false,rolinherit:false});
      const filename=path.join(directory,"request.json"),noNetwork=path.join(directory,"no-network.mjs");
      await writeFile(filename,JSON.stringify(input),{mode:0o600});
      await writeFile(noNetwork,"globalThis.fetch=()=>{throw new Error('Operator must not call provider');};",{mode:0o600});
      const databaseUrl=new URL(process.env.TEST_DATABASE_URL!); databaseUrl.username=loginRole;databaseUrl.password=password;
      const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:"test",DATABASE_URL:databaseUrl.toString(),
        DATABASE_MIGRATION_ROLE:ownerRole,AUTH0_DOMAIN:"tenant.example.test",AUTH_AUDIENCE:"https://api.example.test",
        GITHUB_APP_ID:"123",GITHUB_APP_CLIENT_ID:"fixture-client",GITHUB_APP_CLIENT_SECRET:"fixture-secret",
        GITHUB_OAUTH_CALLBACK_URL:"https://api.example.test/v1/github/oauth/callback",
        GITHUB_APP_WEBHOOK_SECRET:"fixture-webhook",GITHUB_APP_SLUG:"fixture-app",
        GITHUB_APP_PRIVATE_KEY:generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString(),
        CONTROL_PLANE_OWNER_DELETE_REQUEST_FILE:filename};
      const invoke=(execute=false,approval?:string)=>JSON.parse(execFileSync(process.execPath,
        ["--import","tsx","--import",noNetwork,fileURLToPath(new URL("./manage-cloud-owner-discard-delete.ts",import.meta.url)),...(execute?["--execute"]:[])],
        {env:{...env,...(approval?{CONTROL_PLANE_OWNER_DELETE_APPROVAL:approval}:{})},encoding:"utf8",timeout:15_000}));
      const plan=invoke(); expect(plan.state).toBe("planned");
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_existing_delete_receipts")).rows[0].n).toBe(0);
      const accepted=invoke(true,plan.approval); expect(accepted).toMatchObject({state:"deleting",providerDeletion:"pending",dataErasure:"pending"});
      expect(invoke(true,plan.approval)).toEqual({...accepted,state:"unchanged"});
      expect((await pool.query("SELECT database_principal FROM cloud_workspace_owner_existing_delete_receipts")).rows[0].database_principal).toBe(ownerRole);
    } finally {
      const quoted = pg.escapeIdentifier(principal);
      await pool.query(`ALTER TABLE cloud_workspace_owner_existing_delete_receipts OWNER TO ${quoted};
        DROP OWNED BY ${ownerRole}; DROP ROLE ${loginRole}; DROP ROLE ${ownerRole}`);
      await rm(directory,{recursive:true,force:true});
    }
  });
});
