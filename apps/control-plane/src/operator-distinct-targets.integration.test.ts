import {randomBytes, randomUUID} from "node:crypto";
import pg from "pg";
import {describe, expect, it} from "vitest";
import {createMigrationPool, createPool} from "./db.js";
import {runMigrations} from "./migrate.js";
import {manageCloudAgentRuntime, type CloudAgentRuntimeChange} from "./manage-cloud-agent-runtime.js";
import {applyCloudComputeGrant, planCloudComputeGrant} from "./manage-cloud-compute-credit.js";
import {DatabaseComputeUserFunding} from "./cloud-workspaces/compute-funding.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("operator approvals across distinct database targets", () => {
  it("rejects copied approvals on identical data and mutates only the approved target", async () => {
    const control = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL, max:1});
    const suffix = randomBytes(6).toString("hex");
    const names = [`operator_a_${suffix}`, `operator_b_${suffix}`];
    const urls = names.map(name => {
      const value = new URL(process.env.TEST_DATABASE_URL!); value.pathname = "/" + name; return value.toString();
    });
    const created:string[] = [], pools:pg.Pool[] = [];
    try {
      await control.query(`CREATE DATABASE ${names[0]}`); created.push(names[0]!);
      const seed = createMigrationPool(urls[0]!);
      const actor = randomUUID();
      try {
        await runMigrations(seed);
        await seed.query("INSERT INTO users(id,email,display_name,staff_role) VALUES($1,$2,'Target owner','platform_owner')", [actor, actor + "@example.test"]);
      } finally { await seed.end(); }
      // A database template preserves every subject ID, row, and owner. Only
      // the target changes, so copied approvals cannot pass due to fixture drift.
      await control.query(`CREATE DATABASE ${names[1]} TEMPLATE ${names[0]}`); created.push(names[1]!);
      const owners = urls.map(url => createMigrationPool(url)); pools.push(...owners);
      const runtimes = urls.map(url => createPool(url)); pools.push(...runtimes);
      const change:CloudAgentRuntimeChange = {
        operationId:randomUUID(), actorUserId:actor, enabled:true,
        reason:"Validate exact isolated target for runtime admission",
        evidence:{version:1, channel:"development", provider:"boat", runtimeClass:"linux-vm",
          imageRef:`boat:zeros-test-runtime@sha256:${"a".repeat(64)}`, profile:"zeros-cloud-worker-v3",
          runtimeContractSha256:"b".repeat(64), sourceCommit:"c".repeat(40), evidenceSha256:"d".repeat(64), qualifiedAt:new Date().toISOString(),
          credentials:[{kind:"cursor-api-key", renewal:false, checks:{privateCredentialIsolation:true,workloadCredentialDenial:true,actorAdmission:true,stopAndRevocation:true,nativeTurn:true,nativeResume:true,authentication:true}}]},
      };
      const options = urls.map(databaseUrl => ({databaseUrl, channel:"development"}));
      const first = await manageCloudAgentRuntime(owners[0]!, change, options[0]!);
      await expect(manageCloudAgentRuntime(owners[1]!, change, {...options[1]!, execute:true, approval:first.planSha256})).rejects.toThrow(/plan/i);
      for (const owner of owners) expect((await owner.query("SELECT count(*)::int AS n FROM cloud_agent_runtime_qualification_changes")).rows[0].n).toBe(0);
      const second = await manageCloudAgentRuntime(owners[1]!, change, options[1]!);
      expect(second.planSha256).not.toBe(first.planSha256);
      expect((await manageCloudAgentRuntime(owners[1]!, change, {...options[1]!, execute:true, approval:second.planSha256})).state).toBe("changed");
      expect((await owners[0]!.query("SELECT count(*)::int AS n FROM cloud_agent_runtime_qualifications")).rows[0].n).toBe(0);
      expect((await owners[1]!.query("SELECT count(*)::int AS n FROM cloud_agent_runtime_qualifications")).rows[0].n).toBe(1);

      const grant = {fundingScope:"user", channel:"development", userId:actor, actorUserId:actor,
        startsAt:new Date(Date.now()-60000).toISOString(), endsAt:new Date(Date.now()+3600000).toISOString(),
        amountMicroUsd:20000, policyId:"pilot-v1", idempotencyKey:randomUUID(), reason:"Validate individual Pro funding on exact target"};
      const plans = urls.map(url => planCloudComputeGrant(url, grant));
      await expect(applyCloudComputeGrant(runtimes[1]!, plans[1]!, plans[0]!.digest)).rejects.toThrow(/plan changed/);
      for (const runtime of runtimes) expect(await new DatabaseComputeUserFunding(runtime).balanceForUser(actor)).toEqual([]);
      await applyCloudComputeGrant(runtimes[1]!, plans[1]!, plans[1]!.digest);
      expect(await new DatabaseComputeUserFunding(runtimes[0]!).balanceForUser(actor)).toEqual([]);
      expect(await new DatabaseComputeUserFunding(runtimes[1]!).balanceForUser(actor)).toMatchObject([{grantedMicroUsd:20000,availableMicroUsd:20000}]);
    } finally {
      for (const pool of pools) await pool.end();
      for (const name of created.reverse()) await control.query(`DROP DATABASE ${name}`);
      await control.end();
    }
  }, 60000);
});
