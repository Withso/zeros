import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { reserveLocalCloudCommandWriter } from "./commands.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import * as mutations from "./agent-credential-mutations.js";
import type { CloudAgentBootScope } from "./agent-boot-contract.js";
import {retireCloudAgentBootSources} from "./agent-boot-credentials.js";
import {interceptQueries} from "./authority-deadline-test-utils.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("durable credential removal and engine controls", () => {
  let pool: pg.Pool, workspace: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let scope: CloudAgentBootScope, credentialId: string, operationId: string;
  let credentials: DatabaseCloudAgentCredentialService;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  const tx = <T>(fn: Parameters<typeof withSystemTx<T>>[1]) => withSystemTx(pool, fn);
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    workspace = await seedReadyCloudWorkspace(pool);
    credentials = new DatabaseCloudAgentCredentialService(pool, { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } });
    credentialId = randomUUID(); operationId = randomUUID();
    await credentials.put({ credentialId, ownerUserId: workspace.userId, operationId: randomUUID(), expectedRevision: 0,
      organizationId: workspace.organizationId, displayName: "Test Codex", material: { kind: "codex-api-key", apiKey: "synthetic-codex-removal-key" } });
    await credentials.setOrganizationConnection(workspace.userId,workspace.organizationId,"codex",{expectedRevision:0,
      credentialId,credentialRevision:1,models:["gpt-5.4"],consent:"zeros-managed"});
    scope = await tx(async client => {
      const bootId = (await client.query<{ runtime_boot_id: string }>("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [workspace.engineInstanceId])).rows[0]!.runtime_boot_id;
      const writerEpoch = await reserveLocalCloudCommandWriter(client, { organizationId: workspace.organizationId, workspaceId: workspace.workspaceId,
        generation: 1, engineInstanceId: workspace.engineInstanceId, heartbeatToken: workspace.heartbeatToken }, bootId, workspace.userId, 1);
      await client.query(`INSERT INTO cloud_agent_boot_bindings(workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
        VALUES($1,$2,1,$3,$4,$5,$6,1)`, [workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
      return { organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, generation: 1, engineInstanceId: workspace.engineInstanceId,
        bootId, writerEpoch, fundingOwnerUserId: workspace.userId, fundingOwnerEpoch: 1 };
    });
    await tx(client => mutations.recordCloudAgentBootCredentialDelivery(client, scope, { provider: "codex", credentialId }));
  });
  const prepare = (target: unknown = { kind: "revoke-credential", credentialId, expectedCredentialRevision: 1 }) =>
    tx(client => mutations.prepareCloudAgentCredentialRemoval(client, workspace.userId, { version: 1, operationId, target }));
  const read = () => tx(client => mutations.readCloudAgentCredentialRemoval(client, workspace.userId, operationId));
  const decide = (action: "confirm" | "cancel", expectedRevision: number, requestId = randomUUID()) =>
    tx(client => mutations.decideCloudAgentCredentialRemoval(client, workspace.userId, operationId, action, { version: 1, requestId, expectedRevision }));
  const exchange = (acknowledgements: unknown[] = []) => tx(client => mutations.exchangeCloudAgentCredentialControls(client,
    { ...scope, heartbeatToken: workspace.heartbeatToken, workosEnabled: false }, { version: 1, mode: "boot-owner-v1",
      organizationId: scope.organizationId, workspaceId: scope.workspaceId, generation: 1, engineInstanceId: scope.engineInstanceId,
      bootId: scope.bootId, writerEpoch: scope.writerEpoch, acknowledgements }));
  const ack = (control: mutations.CloudAgentCredentialControlRequest, phase: "fenced" | "released" | "retired", running = false) => ({
    ...scope, version: 1, mutationId: control.mutationId, controlRequestId: control.controlRequestId, fenceEpoch: control.fenceEpoch,
    controlRevision: phase === "fenced" ? 1 : 2, phase, mutationFenced: phase !== "released", startsFenced: phase !== "released",
    desiredCacheRevision: null, readyCacheRevision: 1, proofId: phase === "retired" ? randomUUID() : null,
    activity: { complete: true, foreground: running ? 1 : 0, reservedLaunches: 0, background: 0, idleHosts: 0,
      scopes: running ? [{ executionId: randomUUID(), conversationId: randomUUID(), commandId: randomUUID(), phase: "foreground",
        credentialRun: { version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch, cacheRevision: 1, provider: "codex",
          fundingOwnerUserId: scope.fundingOwnerUserId, fundingOwnerEpoch: 1, credentialId, credentialRevision: 1,
          connectionRevision: 1, materialVersion: 1, adoptionId: randomUUID(), displayName: "Test Codex" } }] : [] },
  });
  const first = async () => (await exchange()).controls[0]!;
  const revoked = async () => Boolean((await pool.query("SELECT revoked_at FROM cloud_agent_credentials WHERE id=$1", [credentialId])).rows[0]?.revoked_at);
  it("fences before inventory and never infers idle from mirror absence", async () => {
    expect(await prepare()).toMatchObject({ state: "pending", phase: "preparing" });
    expect((await first()).operation).toBe("pause-starts");
    expect(await read()).toMatchObject({ state: "pending", phase: "preparing" });
    expect(await revoked()).toBe(false);
  });
  it("replays the exact durable request after an unknown prepare acknowledgement", async () => {
    const result = await prepare(), control = await first();
    expect(await prepare()).toEqual(result); expect(await first()).toEqual(control);
    await expect(prepare({ kind: "remove-organization-credential", credentialId, organizationId: workspace.organizationId,
      expectedCredentialRevision: 1 })).rejects.toMatchObject({ status: 409 });
  });
  it("waits for complete positive activity and recognizes old running epochs", async () => {
    await prepare(); const control = await first();
    await exchange([{ ...ack(control, "fenced"), activity: { complete: false, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] } }]);
    expect(await read()).toMatchObject({ state: "pending", phase: "preparing" });
    const retry = await first();
    expect(retry.controlRequestId).not.toBe(control.controlRequestId);
    expect(retry.selectors).toEqual(control.selectors);
    expect(retry.fenceEpoch).toBe(control.fenceEpoch);
    await exchange([{ ...ack(retry, "fenced", true), controlRevision: 2 }]);
    expect(await read()).toMatchObject({ state: "awaiting-confirmation", confirmedRunning: true });
    expect(await revoked()).toBe(false);
  });
  it("preserves a failed retirement receipt and retries with a new request ID under the same irreversible fence", async () => {
    await prepare(); const pause = await first(); await exchange([ack(pause, "fenced")]);
    const retire = (await exchange()).controls.find(value => value.operation === "retire")!;
    await exchange([{ ...ack(retire, "retired"), phase: "failed", proofId: null, activity: { complete: false,
      foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] } }]);
    expect(await read()).toMatchObject({ state: "pending", phase: "removing" }); expect(await revoked()).toBe(false);
    const retry = (await exchange()).controls.find(value => value.operation === "retire")!;
    expect(retry.controlRequestId).not.toBe(retire.controlRequestId);
    expect(retry.fenceEpoch).toBe(retire.fenceEpoch);
    await exchange([ack(retry, "retired")]);
    expect(await read()).toMatchObject({ state: "removed" });
  });
  it("keeps accepted Yes irreversible and commits only after positive retirement", async () => {
    await prepare(); const pause = await first(); await exchange([ack(pause, "fenced", true)]);
    const ready = await read(), requestId = randomUUID();
    expect(await decide("confirm", ready.revision, requestId)).toMatchObject({ state: "pending", phase: "removing" });
    expect(await decide("cancel", ready.revision)).toMatchObject({ state: "pending", phase: "removing" });
    expect(await decide("confirm", ready.revision, requestId)).toMatchObject({ state: "pending", phase: "removing" });
    expect(await revoked()).toBe(false);
    const retire = (await exchange()).controls.find(value => value.operation === "retire")!;
    await exchange([ack(retire, "retired")]);
    expect(await read()).toMatchObject({ state: "removed" }); expect(await revoked()).toBe(true);
    expect(await decide("confirm", ready.revision, requestId)).toMatchObject({ state: "removed" });
  });
  it("makes cancellation first-wins and waits for the exact release acknowledgement", async () => {
    const pending = await prepare(), requestId = randomUUID();
    expect(await decide("cancel", pending.revision, requestId)).toMatchObject({ state: "pending", phase: "cancelling" });
    const release = (await exchange()).controls.find(value => value.operation === "release")!;
    await exchange([ack(release, "released")]);
    expect(await read()).toMatchObject({ state: "cancelled" }); expect(await revoked()).toBe(false);
    expect(await decide("cancel", pending.revision, requestId)).toMatchObject({ state: "cancelled" });
    await expect(decide("confirm", pending.revision, requestId)).rejects.toMatchObject({ status: 409 });
  });
  it("automatically removes an idle source only after retiring its credential-holding hosts", async () => {
    await prepare(); const pause = await first();
    await exchange([{ ...ack(pause, "fenced"), activity: { complete: true, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 1,
      scopes: [{ ...ack(pause, "fenced", true).activity.scopes[0]!, phase: "idle" }] } }]);
    expect(await read()).toMatchObject({ state: "pending", phase: "removing" }); expect(await revoked()).toBe(false);
    const retire = (await exchange()).controls.find(value => value.operation === "retire")!;
    await exchange([ack(retire, "retired")]);
    expect(await read()).toMatchObject({ state: "removed" });
  });
  it("rejects a forged ACK, changed control body and foreign credential inventory", async () => {
    await prepare(); const control = await first();
    for (const value of [{ ...ack(control, "fenced"), controlRequestId: randomUUID() },
      { ...ack(control, "fenced"), fenceEpoch: control.fenceEpoch + 1 },
      { ...ack(control, "fenced", true), activity: { ...ack(control, "fenced", true).activity,
        scopes: [{ ...ack(control, "fenced", true).activity.scopes[0]!, credentialRun: {
          ...ack(control, "fenced", true).activity.scopes[0]!.credentialRun, credentialId: randomUUID() } }] } }])
      await expect(exchange([value])).rejects.toMatchObject({ status: 403 });
    expect(await read()).toMatchObject({ state: "pending", phase: "preparing" });
  });
  it("refuses a new positive delivery while removal is fenced, including a late boot", async () => {
    await prepare();
    await expect(tx(client => mutations.recordCloudAgentBootCredentialDelivery(client, scope, { provider: "codex", credentialId })))
      .rejects.toMatchObject({ status: 409 });
  });
  it("keeps organization Remove distinct from global revoke", async () => {
    await prepare({ kind: "remove-organization-credential", organizationId: workspace.organizationId, credentialId, expectedCredentialRevision: 1 });
    const pause = await first(); await exchange([ack(pause, "fenced")]);
    const retire = (await exchange()).controls.find(value => value.operation === "retire")!; await exchange([ack(retire, "retired")]);
    expect(await read()).toMatchObject({ state: "removed" }); expect(await revoked()).toBe(false);
    expect((await pool.query("SELECT 1 FROM cloud_agent_credential_organizations WHERE credential_id=$1 AND org_id=$2", [credentialId, workspace.organizationId])).rowCount).toBe(0);
  });
  it("clears obsolete access and advances the desired revision after positive removal",async()=>{
    await tx(async client=>{
      const id=(await client.query("SELECT id FROM cloud_agent_boot_bindings WHERE engine_instance_id=$1",[scope.engineInstanceId])).rows[0]!.id;
      await client.query("INSERT INTO cloud_agent_boot_credentials(binding_id,provider,metadata) VALUES($1,'codex',$2)",[id,{status:"unavailable",provider:"codex",code:"cloud_agent_credential_required"}]);
    });
    await prepare({kind:"remove-organization-credential",organizationId:workspace.organizationId,credentialId,expectedCredentialRevision:1});
    const pause=await first();await exchange([ack(pause,"fenced")]);
    const retire=(await exchange()).controls.find(value=>value.operation==="retire")!;await exchange([ack(retire,"retired")]);
    expect((await pool.query("SELECT cache_revision::int,desired_cache_revision::int FROM cloud_agent_boot_bindings")).rows[0]).toEqual({cache_revision:1,desired_cache_revision:2});
    expect((await pool.query("SELECT * FROM cloud_agent_boot_credentials")).rowCount).toBe(0);
  });
  it("advances the selected connection's real source revision with an acknowledged key replacement",async()=>{
    const replacement={credentialId,ownerUserId:workspace.userId,operationId:randomUUID(),expectedRevision:1,
      displayName:"Updated",material:{kind:"codex-api-key",apiKey:"synthetic-updated-key"}};
    await expect(credentials.put(replacement)).rejects.toMatchObject({status:503});
    const pause=await first();await exchange([ack(pause,"fenced",true)]);await credentials.put(replacement);
    expect((await pool.query("SELECT credential_revision::int,revision::int FROM cloud_agent_organization_connections WHERE credential_id=$1",[credentialId])).rows[0])
      .toEqual({credential_revision:2,revision:2});
  });
  it("keeps retired deliveries immutable while admitting only a genuinely newer association",async()=>{
    await prepare({kind:"remove-organization-credential",organizationId:workspace.organizationId,credentialId,expectedCredentialRevision:1});
    const pause=await first();await exchange([ack(pause,"fenced")]);
    const retire=(await exchange()).controls.find(value=>value.operation==="retire")!;await exchange([ack(retire,"retired")]);
    await credentials.put({credentialId,ownerUserId:workspace.userId,organizationId:workspace.organizationId,operationId:randomUUID(),expectedRevision:1,
      displayName:"Reassociated",material:{kind:"codex-api-key",apiKey:"synthetic-reassociated-key"}});
    await credentials.setOrganizationConnection(workspace.userId,workspace.organizationId,"codex",{expectedRevision:2,credentialId,credentialRevision:2,models:["gpt-5.4"],consent:"zeros-managed"});
    await tx(client=>client.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=3,cache_revision=3 WHERE engine_instance_id=$1",[scope.engineInstanceId]));
    const deliver=(connectionRevision:number)=>tx(client=>mutations.recordCloudAgentBootCredentialDelivery(client,scope,{provider:"codex",credentialId},{cacheRevision:3,connectionRevision}));
    await expect(deliver(1)).rejects.toThrow();
    await deliver(3);
    const history=(await pool.query("SELECT connection_revision::int,retired_proof_id FROM cloud_agent_boot_source_deliveries ORDER BY connection_revision")).rows;
    expect(history).toHaveLength(2);expect(history[0]!.retired_proof_id).not.toBeNull();expect(history[1]).toEqual({connection_revision:3,retired_proof_id:null});
  });
  it("keeps foreign accounts and user RLS away from operations, controls and source deliveries", async () => {
    await prepare(); const other = await seedReadyCloudWorkspace(pool);
    await expect(tx(client => mutations.readCloudAgentCredentialRemoval(client, other.userId, operationId))).rejects.toMatchObject({ status: 403 });
    const rows = await withUserTx(pool, workspace.userId, async client => [
      await client.query("SELECT * FROM cloud_agent_credential_mutations"), await client.query("SELECT * FROM cloud_agent_credential_controls"),
      await client.query("SELECT * FROM cloud_agent_boot_source_deliveries"),
    ]);
    expect(rows.map(value => value.rowCount)).toEqual([0, 0, 0]);
  });
  it.each(["global", "organization"])("refuses a legacy %s destructive bypass while a new-mode source may be held", async kind => {
    await expect(kind === "global" ? credentials.revoke(workspace.userId, credentialId) :
      credentials.removeOrganizationCredential(workspace.userId, workspace.organizationId, credentialId))
      .rejects.toMatchObject({ status: 409, code: "cloud_runtime_upgrade_required" });
    expect(await revoked()).toBe(false);
    expect((await pool.query("SELECT 1 FROM cloud_agent_credential_organizations WHERE credential_id=$1", [credentialId])).rowCount).toBe(1);
  });
  it("keeps each recorded receipt immutable after an unknown acknowledgement", async () => {
    await prepare(); const control = await first(), value = ack(control, "fenced", true);
    await exchange([value]); expect(await exchange([value])).toEqual({ version: 1, mode: "boot-owner-v1", controls: [] });
    await expect(exchange([{ ...value, controlRevision: 2 }])).rejects.toMatchObject({ status: 409 });
    await expect(pool.query("UPDATE cloud_agent_credential_controls SET request=request||'{\"fenceEpoch\":999}'::jsonb WHERE id=$1", [control.controlRequestId]))
      .rejects.toMatchObject({ code: "23514" });
  });
  it("requires all affected boots to acknowledge even if one reports idle", async () => {
    const other = await seedReadyCloudWorkspace(pool, { ownerUserId: workspace.userId });
    await tx(async client => {
      const bootId = (await client.query<{ runtime_boot_id: string }>("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [other.engineInstanceId])).rows[0]!.runtime_boot_id;
      const otherEngine = { organizationId: other.organizationId, workspaceId: other.workspaceId, generation: 1,
        engineInstanceId: other.engineInstanceId, heartbeatToken: other.heartbeatToken };
      const writerEpoch = await reserveLocalCloudCommandWriter(client, otherEngine, bootId, other.userId, 1);
      await client.query(`INSERT INTO cloud_agent_boot_bindings(workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
        VALUES($1,$2,1,$3,$4,$5,$6,1)`, [other.workspaceId, other.organizationId, other.engineInstanceId, bootId, writerEpoch, other.userId]);
      await mutations.recordCloudAgentBootCredentialDelivery(client, { organizationId: other.organizationId, workspaceId: other.workspaceId,
        generation: 1, engineInstanceId: other.engineInstanceId, bootId, writerEpoch, fundingOwnerUserId: other.userId, fundingOwnerEpoch: 1 }, { provider: "codex", credentialId });
    });
    await prepare(); const pause = await first(); await exchange([ack(pause, "fenced")]);
    expect(await read()).toMatchObject({ state: "pending", phase: "preparing" }); expect(await revoked()).toBe(false);
  });
  it("publishes a replacement only after the exact start fence and commits a dirty next-run epoch", async () => {
    const replacement = { credentialId, ownerUserId: workspace.userId, operationId: randomUUID(), expectedRevision: 1,
      displayName: "Replacement Codex", material: { kind: "codex-api-key", apiKey: "synthetic-replacement-key" } };
    await expect(credentials.put(replacement)).rejects.toMatchObject({ status: 503, code: "cloud_agent_credential_busy" });
    expect((await pool.query("SELECT revision::int FROM cloud_agent_credentials WHERE id=$1", [credentialId])).rows[0]!.revision).toBe(1);
    const pause = await first(); expect(pause.operation).toBe("pause-starts");
    await exchange([ack(pause, "fenced", true)]);
    expect((await credentials.put(replacement)).credential.revision).toBe(2);
    expect((await credentials.put(replacement)).replayed).toBe(true);
    const binding = (await pool.query("SELECT cache_revision::int,desired_cache_revision::int FROM cloud_agent_boot_bindings WHERE engine_instance_id=$1", [scope.engineInstanceId])).rows[0]!;
    expect(binding).toEqual({ cache_revision: 1, desired_cache_revision: 2 });
    const publication = (await exchange()).controls.find(value => value.operation === "publish-desired")!;
    expect(publication.desiredCacheRevision).toBe(2); expect(publication.fenceEpoch).toBe(pause.fenceEpoch);
    expect(publication.selectors).toEqual(pause.selectors);
    const stored = await pool.query("SELECT target,source_snapshot FROM cloud_agent_credential_mutations");
    expect(JSON.stringify(stored.rows)).not.toContain(replacement.material.apiKey);
  });
  it("does not apply key replacement from incomplete activity or a failed fence", async () => {
    const replacement = { credentialId, ownerUserId: workspace.userId, operationId: randomUUID(), expectedRevision: 1,
      displayName: "Replacement Codex", material: { kind: "codex-api-key", apiKey: "synthetic-replacement-key" } };
    await expect(credentials.put(replacement)).rejects.toMatchObject({ status: 503 });
    const pause = await first(); await exchange([{ ...ack(pause, "fenced"), activity: { complete: false,
      foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] } }]);
    await expect(credentials.put(replacement)).rejects.toMatchObject({ status: 503 });
    expect((await pool.query("SELECT revision::int FROM cloud_agent_credentials WHERE id=$1", [credentialId])).rows[0]!.revision).toBe(1);
  });
  it("fences account selection before returning Settings success and keeps the original request replay",async()=>{
    const added=await credentials.put({credentialId:randomUUID(),ownerUserId:workspace.userId,organizationId:workspace.organizationId,
      operationId:randomUUID(),expectedRevision:0,displayName:"Another account",material:{kind:"codex-api-key",apiKey:"synthetic-another-account-key"}});
    const request={expectedRevision:1,credentialId:added.credential.id,credentialRevision:1,models:["gpt-5.4"],consent:"zeros-managed"};
    await expect(credentials.setOrganizationConnection(workspace.userId,workspace.organizationId,"codex",request)).rejects.toMatchObject({status:503});
    expect((await pool.query("SELECT credential_id FROM cloud_agent_organization_connections WHERE owner_user_id=$1 AND org_id=$2",[workspace.userId,workspace.organizationId])).rows[0]!.credential_id).toBe(credentialId);
    const pause=await first(); expect(pause.selectors.map(value=>value.credentialId)).toEqual(expect.arrayContaining([credentialId,added.credential.id]));
    await exchange([ack(pause,"fenced",true)]);
    expect(await credentials.setOrganizationConnection(workspace.userId,workspace.organizationId,"codex",request)).toEqual({revision:2,replayed:false});
    expect(await credentials.setOrganizationConnection(workspace.userId,workspace.organizationId,"codex",request)).toEqual({revision:2,replayed:true});
    expect((await exchange()).controls.find(value=>value.operation==="publish-desired")?.desiredCacheRevision).toBe(2);
  });
  it("serializes a legacy revoke against the first access delivery before declaring that no engine holds it",async()=>{
    const nextId=randomUUID(); await credentials.put({credentialId:nextId,ownerUserId:workspace.userId,operationId:randomUUID(),
      expectedRevision:0,displayName:"Race",material:{kind:"codex-api-key",apiKey:"synthetic-first-delivery-race-key"}});
    let release!:()=>void, entered!: (pid:number)=>void;
    const ready=new Promise<number>(resolve=>{entered=resolve;}), barrier=new Promise<void>(resolve=>{release=resolve;});
    const delivery=tx(async client=>{await mutations.recordCloudAgentBootCredentialDelivery(client,scope,{provider:"codex",credentialId:nextId});
      entered((await client.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid); await barrier;});
    const blocker=await ready; let finished=false;
    const revoke=credentials.revoke(workspace.userId,nextId).then(result=>{finished=true;return {result};},error=>{finished=true;return {error};});
    let blocked=false;
    try {
      const deadline=Date.now()+2000;
      while(Date.now()<deadline&&!finished) {
        blocked=(await pool.query("SELECT 1 FROM pg_stat_activity activity WHERE activity.datname=current_database() AND $1=ANY(pg_blocking_pids(activity.pid))",[blocker])).rowCount!==0;
        if(blocked)break; await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
    } finally {release();await delivery;}
    expect(await revoke).toMatchObject({error:{status:409,code:"cloud_runtime_upgrade_required"}});
    expect((await pool.query("SELECT revoked_at FROM cloud_agent_credentials WHERE id=$1",[nextId])).rows[0]!.revoked_at).toBeNull();
  });
  it.each(["removal","publication"] as const)("serializes a late %s outbox against the exact positively retired boot",async scenario=>{
    const intentId=randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,
      idempotency_key,request_sha256,state,completed_at) VALUES($1,$2,$3,1,$4,'stop',$5,$6,'succeeded',now())`,
      [intentId,workspace.workspaceId,workspace.organizationId,workspace.userId,randomUUID(),randomBytes(32)]);
    let enter!: (pid:number)=>void, release!:()=>void, preparePid!: (pid:number)=>void;
    const atProof=new Promise<number>(resolve=>{enter=resolve;}), barrier=new Promise<void>(resolve=>{release=resolve;}),
      atPrepare=new Promise<number>(resolve=>{preparePid=resolve;});
    const retiring=interceptQueries(pool,async(sql,client)=>{
      if(!sql.includes("INSERT INTO cloud_agent_credential_source_retirements"))return;
      enter((await client.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);await barrier;
    });
    const retired=withSystemTx(retiring,client=>retireCloudAgentBootSources(client,scope,{kind:"provider-lifecycle",intentId}));
    void retired.catch(()=>undefined);
    const blocker=await atProof;
    const preparing=interceptQueries(pool,async(sql,client)=>{
      if(sql.includes("INSERT INTO cloud_agent_credential_mutations"))preparePid((await client.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
    });
    let finished=false;
    const preparation=scenario==="removal"?withSystemTx(preparing,client=>mutations.prepareCloudAgentCredentialRemoval(client,workspace.userId,
      {version:1,operationId,target:{kind:"revoke-credential",credentialId,expectedCredentialRevision:1}})):
      new DatabaseCloudAgentCredentialService(preparing,{currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")}}).put({credentialId,
        ownerUserId:workspace.userId,operationId,expectedRevision:1,displayName:"After physical retirement",
        material:{kind:"codex-api-key",apiKey:"synthetic-late-publication-key"}});
    const prepared=preparation
      .then(result=>{finished=true;return result;},error=>{finished=true;throw error;});
    void prepared.catch(()=>undefined);
    const waiting=await atPrepare;let blocked=false;
    try{
      const deadline=Date.now()+2000;
      while(Date.now()<deadline&&!finished){
        blocked=(await pool.query<{blocked:boolean}>("SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked",[waiting,blocker])).rows[0]!.blocked;
        if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
    }finally{release();await retired;await prepared;}
    if(scenario==="removal"){expect(await read()).toMatchObject({state:"removed"});expect(await revoked()).toBe(true);}
    else{
      expect((await pool.query("SELECT state FROM cloud_agent_credential_mutations WHERE id=$1",[operationId])).rows[0]).toEqual({state:"published"});
      expect((await pool.query("SELECT revision::int FROM cloud_agent_credentials WHERE id=$1",[credentialId])).rows[0]).toEqual({revision:2});
    }
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_agent_credential_controls")).rows[0]).toEqual({count:0});
  });
});
