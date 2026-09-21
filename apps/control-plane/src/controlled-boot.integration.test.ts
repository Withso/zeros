import {generateKeyPairSync,randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import pg from "pg";
import {describe,expect,it} from "vitest";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("controlled migration service boot",()=>{
  it.each([{install:true,maintenance:false},{install:false,maintenance:false},{install:true,maintenance:true},{install:false,maintenance:true}])("starts writers only with a complete schema outside maintenance ($install, $maintenance)",async ({install,maintenance})=>{
    const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");await pool.end();
    const listener=createServer();listener.listen(0,"127.0.0.1");await once(listener,"listening");
    const port=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
    const privateKey=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
    const child=spawn(process.execPath,["--import","tsx","src/index.ts"],{
      cwd:fileURLToPath(new URL("../",import.meta.url)),stdio:["ignore","pipe","pipe"],
      // Do not inherit provider credentials or feature flags from the operator.
      env:{PATH:process.env.PATH,NODE_ENV:"test",PORT:String(port),DATABASE_URL:process.env.TEST_DATABASE_URL,
        DATABASE_MIGRATIONS_ON_BOOT:String(install),
        DATABASE_MAINTENANCE_MODE:String(maintenance),
        AUTH0_DOMAIN:"tenant.example.test",AUTH_AUDIENCE:"https://api.example.test",
        ...(maintenance?{AUTH_PROVIDER:"workos",APP_ORIGIN:"https://app.example.test",
          AUTH_ISSUER:"https://identity.example.test/user_management/client_web",AUTH_JWKS_URL:"https://identity.example.test/sso/jwks/client_web",
          AUTH_WEB_CLIENT_ID:"client_web",AUTH_DESKTOP_CLIENT_ID:"client_desktop",WORKOS_API_KEY:"not-a-live-key-for-tests",
          WORKOS_COOKIE_PASSWORD:"test-cookie-password".repeat(3),WORKOS_WEBHOOK_SECRET:"test-webhook-secret"}:{}),
        GITHUB_APP_ID:"123456",GITHUB_APP_CLIENT_ID:"Iv1.test",GITHUB_APP_CLIENT_SECRET:"test-client-secret",
        GITHUB_APP_SLUG:"zeros-test",GITHUB_OAUTH_CALLBACK_URL:"https://api.example.test/v1/github/oauth/callback",GITHUB_APP_PRIVATE_KEY:privateKey,
        CLOUD_WORKSPACES_ENABLED:"true",DAYTONA_API_KEY:"not-a-live-key-for-tests",DAYTONA_API_URL:"https://api.example.test",
        DAYTONA_SNAPSHOT_ID:"snap_test",ZEROS_CLOUD_SOURCE_COMMIT:"a".repeat(40),
        CLOUD_WORKSPACE_SECRET_KEY_V1:randomBytes(32).toString("base64url"),RESEND_API_KEY:"not-a-live-key",EMAIL_FROM:"test@example.test"},
    });
    let output="";const exited=once(child,"exit");
    const ready=new Promise<boolean>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Service did not become ready")),20_000);timer.unref();
      const consume=(chunk:Buffer)=>{output+=chunk.toString();if(output.includes("[control-plane] listening")){clearTimeout(timer);resolve(true);}};
      child.stdout.on("data",consume);child.stderr.on("data",consume);
      child.once("exit",()=>{clearTimeout(timer);if(!output.includes("[control-plane] listening"))resolve(false);});
    });
    try {
      expect(await ready,output.slice(-3000)).toBe(install||maintenance);
      if(maintenance){
        expect(output).not.toContain("reconciliation enabled");
        expect(output).not.toContain("WorkOS reconciliation");
        expect((await fetch(`http://127.0.0.1:${port}/v1/auth/snapshot`)).status).toBe(503);
        expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({ok:true,maintenance:true});
        const audit=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
        try{expect((await audit.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rowCount).toBe(0);}finally{await audit.end();}
      }else if(install){
        expect(output).toContain("cloud workspace reconciliation enabled");
        const response=await fetch(`http://127.0.0.1:${port}/v1/auth/snapshot`);
        expect(response.status).toBe(401);
      }else{
        expect(output).not.toContain("cloud workspace reconciliation enabled");
        expect(child.exitCode).not.toBe(0);
      }
    } finally {
      child.kill("SIGTERM");const force=setTimeout(()=>child.kill("SIGKILL"),3000);await exited;clearTimeout(force);
    }
  },30_000);
});
