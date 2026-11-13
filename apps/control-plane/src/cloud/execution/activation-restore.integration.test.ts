import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudProviderError } from "../provider-error.js";
import { sealCheckpointKey } from "../checkpoint.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";
import { claimExecutionRestore } from "./restore.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("active checkpoint restore authority and fresh-VM fence", () => {
  let pool: pg.Pool, f: ExecutionFixture, object: string;
  const ready = { exitCode: 0, stdout: "", timedOut: false };
  const row = async () => (await pool.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
  const restores = () => vi.mocked(f.cp.compute.exec).mock.calls.filter(([,command]) => command.includes("zeros-checkpoint-restored"));
  beforeAll(() => { pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8,statement_timeout:6000}); });
  beforeEach(async () => {
    f=await executionFixture(pool,{lifecycle:true});
    await f.cp.lifecycleChanges!.stop(); await f.cp.loginChanges.stop();
    await f.activate(f.viewer);
    const build=randomUUID(); object=`cloud-v2/checkpoints/${f.workspace.id}/${randomUUID()}.zck`;
    const key=sealCheckpointKey(randomBytes(32),f.workspace.id,object,f.keys);
    await pool.query(`INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,snapshot_id,created_by,source_policy_version)
      VALUES($1,$2,1,'{}','succeeded','fixture-snapshot',$3,2)`,[build,f.organizationId,f.creator.id]);
    await pool.query("INSERT INTO cloud_v2_computers(org_id,active_build_id,snapshot_name,refresh_next_at) VALUES($1,$2,'fixture-snapshot',clock_timestamp()+interval '1 day')",[f.organizationId,build]);
    await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2,checkpoint_key=$3,checkpoint_sha256=$4,
      checkpoint_bytes=42,checkpoint_saved_at=clock_timestamp(),checkpoint_stop_generation=stop_generation,
      lease_renewed_at=clock_timestamp() WHERE id=$1`,[f.workspace.id,object,key,"d".repeat(64)]);
    let created=0;
    vi.spyOn(f.cp.compute,"create").mockImplementation(async () => ({sandboxId:`bx_restore${++created}`}));
    vi.spyOn(f.cp.compute,"resume").mockRejectedValueOnce(new CloudProviderError("provider_not_found","Fixture missing VM",false)).mockResolvedValue(undefined);
    vi.spyOn(f.cp.compute,"delete").mockResolvedValue();
    vi.spyOn(f.cp.compute,"stop").mockResolvedValue();
    vi.spyOn(f.cp.compute,"hostPort").mockResolvedValue({url:"https://fixture.example.test",token:"synthetic-port-value"});
    vi.spyOn(f.cp.compute,"exec").mockImplementation(async (_id,command) => ({...ready,stdout:command.includes("zeros-checkpoint-restored")?"zeros-checkpoint-restored":""}));
    vi.spyOn(f.cp.runtimeUpdates,"tick").mockResolvedValue();
    f.fetcher.mockClear();
  });
  afterEach(async () => { await f?.close();vi.restoreAllMocks();vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("uses the persisted initiator and the hardened restore only on a newly created organization snapshot", async () => {
    await f.cp.lifecycle!.tick();
    expect(f.cp.compute.create).toHaveBeenCalledOnce();
    expect(vi.mocked(f.cp.compute.create).mock.calls[0]![0]).toMatchObject({from:"fixture-snapshot"});
    expect(restores()).toHaveLength(1);
    expect(restores()[0]![0]).toBe("bx_restore1");
    expect(restores()[0]![1].includes("/dev/shm/zeros-restore-auth-")).toBe(true);
    expect(restores()[0]![1].includes(Buffer.from(`synthetic-${f.viewer.id}`).toString("base64"))).toBe(true);
    expect(restores()[0]![1].includes(Buffer.from(`synthetic-${f.creator.id}`).toString("base64"))).toBe(false);
    expect(await row()).toMatchObject({restore_pending:false,execution_restore_claimed_at:expect.any(Date),checkpoint_object:object});
    expect(f.fetcher.mock.calls.every(([,init])=>new Headers(init?.headers).get("authorization")===`Bearer synthetic-${f.viewer.id}`)).toBe(true);
  });

  it("never sends another credential to a VM after an uncertain command and creates a new snapshot VM for the retry", async () => {
    let first=true;
    vi.mocked(f.cp.compute.exec).mockImplementation(async (_id,command) => {
      if(command.includes("zeros-checkpoint-restored")) {
        if(first) {first=false;throw new CloudProviderError("provider_request_failed","Fixture lost command result",true);}
        return {...ready,stdout:"zeros-checkpoint-restored"};
      }
      return ready;
    });
    await f.cp.lifecycle!.tick();
    expect(restores()).toHaveLength(1);
    await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1",[f.workspace.id]);
    await f.cp.lifecycle!.tick();
    expect(restores().map(([sandbox])=>sandbox)).toEqual(["bx_restore1","bx_restore2"]);
    expect(f.cp.compute.delete).toHaveBeenCalledWith("bx_restore1");
    expect(await row()).toMatchObject({restore_pending:false,checkpoint_object:object});
  });

  it("refuses github_access_required when the initiator loses repository access, without Creator fallback or checkpoint loss", async () => {
    f.denied.add(`${f.viewer.id}:42`);
    await pool.query("DELETE FROM cloud_github_source_verifications WHERE owner_user_id=$1",[f.viewer.id]);
    await f.cp.lifecycle!.tick();
    expect(restores()).toHaveLength(0);
    expect(vi.mocked(f.cp.compute.exec).mock.calls.some(([,command])=>command.includes("systemctl restart zeros-worker.service"))).toBe(false);
    expect(await row()).toMatchObject({state:"failed",error_code:"github_access_required",checkpoint_object:object});
  });

  it.each([401, 403, 404])("refuses github_access_required when credential delivery gets a late GitHub %s", async status => {
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => new URL(String(url)).pathname.endsWith("/branches")
      ? Response.json({ message: "Fixture access revoked" }, { status }) : original(url, init));
    await f.cp.lifecycle!.tick();
    expect(restores()).toHaveLength(0);
    expect(await row()).toMatchObject({ state: "failed", error_code: "github_access_required", checkpoint_object: object });
    expect(f.fetcher.mock.calls.some(([, init]) => new Headers(init?.headers).get("authorization") === `Bearer synthetic-${f.creator.id}`)).toBe(false);
  });

  it("does not create or fetch again when deletion of the consumed restore VM is uncertain", async () => {
    vi.mocked(f.cp.compute.exec).mockImplementation(async (_id, command) => {
      if (command.includes("zeros-checkpoint-restored")) throw new CloudProviderError("provider_request_failed", "Fixture lost reply", true);
      return ready;
    });
    await f.cp.lifecycle!.tick();
    expect(restores()).toHaveLength(1);
    vi.mocked(f.cp.compute.delete).mockRejectedValue(new CloudProviderError("provider_request_failed", "Fixture deletion unknown", true));
    await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [f.workspace.id]);
    await f.cp.lifecycle!.tick();
    expect(f.cp.compute.create).toHaveBeenCalledOnce();
    expect(restores()).toHaveLength(1);
    expect(await row()).toMatchObject({ state: "starting", boat_sandbox_id: "bx_restore1", restore_pending: true, checkpoint_object: object });
  });

  it("grants only one restore claim across concurrent CP instances and refuses a stale intent, run or snapshot", async () => {
    const target = (await f.cp.store.claimPending(4, 1)).find(workspace => workspace.id === f.workspace.id)!;
    const attempt = randomUUID();
    await pool.query(`UPDATE cloud_v2_workspaces SET restore_pending=true,restore_attempt=$2,
      computer_build_id=(SELECT active_build_id FROM cloud_v2_computers WHERE org_id=cloud_v2_workspaces.org_id),
      restore_create=jsonb_build_object('from','foreign-snapshot','name','fixture','env','{}'::jsonb,'requestedAt',clock_timestamp()) WHERE id=$1`,
    [f.workspace.id, attempt]);
    expect(await claimExecutionRestore(pool, target, target.boatSandboxId!)).toBe(false);
    await pool.query("UPDATE cloud_v2_workspaces SET restore_create=jsonb_set(restore_create,'{from}',to_jsonb('fixture-snapshot'::text)) WHERE id=$1", [f.workspace.id]);
    expect(await claimExecutionRestore(pool, { ...target, executionIntent: { ...target.executionIntent!, id: randomUUID() } }, target.boatSandboxId!)).toBe(false);
    expect(await claimExecutionRestore(pool, { ...target, stopGeneration: String(BigInt(target.stopGeneration) + 1n) }, target.boatSandboxId!)).toBe(false);
    const claims = await Promise.all([claimExecutionRestore(pool, target, target.boatSandboxId!), claimExecutionRestore(pool, target, target.boatSandboxId!)]);
    expect(claims.sort()).toEqual([false, true]);
    expect(await claimExecutionRestore(pool, target, target.boatSandboxId!)).toBe(false);
  });

  it("does not deliver a worker credential or complete restore after Stop wins during the held command", async () => {
    let entered!:()=>void, release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
    vi.mocked(f.cp.compute.exec).mockImplementation(async (_id,command) => {
      if(command.includes("zeros-checkpoint-restored")) {entered();await barrier;return {...ready,stdout:"zeros-checkpoint-restored"};}
      return ready;
    });
    const pending=f.cp.lifecycle!.tick();await started;
    try {
      expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`,"POST",undefined,f.viewer,{"X-Zeros-Team-Sharing":"1"})).status).toBe(202);
    } finally {release();await pending;}
    expect(vi.mocked(f.cp.compute.exec).mock.calls.some(([,command])=>command.includes("systemctl restart zeros-worker.service"))).toBe(false);
    expect(await row()).toMatchObject({state:"stopping",restore_pending:true,checkpoint_object:object});
  });
});
