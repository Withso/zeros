import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it,vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedRuntimeBundle, runtimeWitness } from "./runtime-test-fixtures.js";
import { seedProviderLossAttestation, seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { bindCloudAllocationProvider } from "./allocation-provider.js";
import type { CloudWorkspaceProvider } from "./provider.js";
import { CloudWorkspaceComputeLeaseCoordinator } from "./compute-leases.js";
import { DatabaseManagedComputeCreditLedger } from "./compute-credits.js";
import { requestManagedComputeStop } from "./compute-credit-stop.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { completeCloudWorkspaceGenerationTransition,cancelCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { queueCloudWorkspaceSetupVerification } from "./runtime-access.js";
import { readCloudRuntimeResumeProofEpoch } from "./runtime-transition.js";
import { DatabaseCloudRuntimeTransitionService } from "./runtime-transfer.js";
import type { CloudActiveRuntime } from "./runtime-contract.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { DatabaseCloudRuntimeQuietTrigger } from "./runtime-quiet-trigger.js";
import type { CloudRuntimeQuietSnapshot } from "./runtime-quiet-contract.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { ensureUser } from "../auth.js";
import { DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";

(process.env.TEST_DATABASE_URL ? describe : describe.skip)("retained cloud runtime transitions", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let service: DatabaseCloudRuntimeTransitionService;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
    await pool.query(`INSERT INTO cloud_workspace_setup_attestations (
      setup_run_id,workspace_id,generation,org_id,execution_fence,image_ref,image_source_commit,
      repository_revision,repository_commit,settings_version,settings_snapshot_sha256,
      engine_instance_id,engine_protocol_version,engine_health,durable_record_connected,
      runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
      runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
      SELECT run.id,run.workspace_id,run.generation,run.org_id,run.execution_fence,g.image_ref,g.source_commit,
        'main',$2,1,spec.settings_snapshot_sha256,engine.id,engine.protocol_version,'ready',true,
        g.runtime_id,g.runtime_manifest_sha256,g.runtime_base_image_id,g.runtime_base_compatibility_id,g.runtime_profile,g.runtime_engine_protocol_version,
        engine.runtime_installer_receipt_sha256,engine.runtime_boot_id,engine.runtime_supervisor_session_id
      FROM cloud_workspace_setup_runs run JOIN cloud_workspace_generations g USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_setup_specs spec USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_engine_instances engine ON engine.setup_run_id=run.id WHERE run.workspace_id=$1`,
    [fixture.workspaceId, "c".repeat(40)]);
    await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "2", releaseOrder: 2 }));
    service = new DatabaseCloudRuntimeTransitionService({ pool, qualificationMode: "full", workosEnabled: false,heartbeatEndpoint:"https://control.example/internal/cloud-workspaces/engine/heartbeat" });
  });

  const offer = () => service.offer({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 1, sourceEngineInstanceId: fixture.engineInstanceId, operationId: randomUUID(), mode: "engine" });
  const sourceActive = (): CloudActiveRuntime => ({ ...runtimeWitness,schema:"zeros.active-runtime/v1",
    root:`/opt/zeros-infra/${runtimeWitness.runtimeId}`,cgroupRoot:"/sys/fs/cgroup/system.slice/zeros-host.service" });
  async function claimed() {
    const transition = await offer();
    if (!transition) throw new Error("Expected a retained transition");
    const claim = await service.claim({ workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,
      transitionId:transition.transitionId },"zeros-v2-test-hu-worker");
    if (!claim) throw new Error("Expected the first worker claim");
    return claim;
  }
  async function qualifyTransfer() {
    await pool.query(`INSERT INTO cloud_runtime_transfer_qualifications
      (source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode,enabled,evidence_sha256)
      VALUES($1,$2,$1,$3,'engine','full',true,$4)`,
    [runtimeWitness.runtimeId,`r1-${"2".repeat(64)}`,runtimeWitness.baseCompatibilityId,Buffer.alloc(32)]);
  }
  const targetActive = (): CloudActiveRuntime => ({ ...sourceActive(),runtimeId:`r1-${"2".repeat(64)}`,
    manifestSha256:"2".repeat(64),root:`/opt/zeros-infra/r1-${"2".repeat(64)}`,
    installerReceiptSha256:"8".repeat(64),supervisorSessionId:randomUUID() });
  const report = (active: CloudActiveRuntime): Record<string, unknown> => {
    const { schema: _schema,root: _root,cgroupRoot: _cgroup,...runtime } = active;
    return { version:1,profile:"zeros-cloud-worker-v4",qualified:true,runtime,
      helpers:{ trusted:{node:true,bwrap:true,setpriv:true,supervisor:true},deploymentTrusted:Object.fromEntries([
        "runtimeProfile","engineLauncher","engineView","engineCgroup","runtimeLayout","resourceInspector","resourceAdmission",
        "setupProcess","admissionConsumer","previewLinkInstaller","githubCredentialInstaller","githubRefreshRequestHelper","gitAskpass",
        "workerSupervisor","setupHelper","attester","engineNamespace","launcher","engineQualification","engineAppArmor","runtimeTree","admissionDirectory",
      ].map(key=>[key,true])) },
      resources:{finite:true,cpuMax:"200000 100000",memoryMax:"4294967296",pidsMax:"4096",
        allocation:{cpuMillicores:2000,memoryBytes:4294967296,storageBytes:21474836480}},
      qualification:{secure:true,identity:{secure:true,hostUid:10003,namespaceUid:0,noNewPrivs:1,seccompMode:2},
        workload:{secure:true},capture:{secure:true},humanServices:{secure:true},actorTools:{secure:true}},
      setupQualification:{secure:true,unprivileged:true,detachedDescendantsRetired:true,timeoutRetired:true} };
  };
  async function activated() {
    const claim = await claimed();
    await qualifyTransfer();
    await service.staged(claim);
    expect(await service.activate(claim,{controller:sourceActive(),policy:{id:"zeros_test_live_handoff",async authorize() {return true;} }})).toBe(true);
    return claim;
  }

  describe("resident handoff journal", () => {
    async function prepared() {
      const claim = await claimed(); await qualifyTransfer(); await service.staged(claim);
      const handoff = { challenge: randomUUID(), organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
        generation: 1, engineInstanceId: fixture.engineInstanceId, hostId: randomUUID(), fence: 1, expiresAtMs: Date.now() + 60_000 };
      const resident = { hostId: handoff.hostId, organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
        protocol: "zeros.resident-pty/v1" as const, runtimeId: runtimeWitness.runtimeId, manifestSha256: runtimeWitness.manifestSha256,
        bootId: runtimeWitness.bootId, supervisorSessionId: runtimeWitness.supervisorSessionId,
        scope: `${sourceActive().cgroupRoot}/engine-workload-${handoff.hostId}`, fence: 1, engineId: fixture.engineInstanceId, generation: 1 };
      await pool.query(`INSERT INTO cloud_runtime_resident_transfer_qualifications
        (source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode,
          resident_runtime_id,enabled,evidence_sha256) VALUES($1,$2,$1,$3,'engine','full',$1,true,$4)`,
      [runtimeWitness.runtimeId, targetActive().runtimeId, runtimeWitness.baseCompatibilityId, Buffer.alloc(32)]);
      return { claim, handoff, resident, controller: sourceActive(),
        receipt: { ...handoff, version: 1 as const, phase: "fenced" as const, activityRevision: 3 },
        policy: { id: "zeros_test_resident", async authorize() { return true; } } };
    }
    const sourceState = async () => (await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0].state;
    const journal = async (id: string) => (await pool.query("SELECT phase FROM cloud_workspace_runtime_handoffs WHERE transition_id=$1", [id])).rows[0]?.phase;
    async function queueActor() {
      const user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`,
        email: `durable-${fixture.userId}@example.test`, displayName: "Queue owner",
        session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now()/1000), tokenExpiresAt: Math.floor(Date.now()/1000)+3600 } });
      expect(user.id).toBe(fixture.userId);
      user.accountRevision = Number((await pool.query("SELECT auth_revision FROM users WHERE id=$1", [user.id])).rows[0].auth_revision);
      await pool.query(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
        VALUES($1,$2,$3,'desktop',now()+interval '1 hour')`, [user.authentication.sessionId,user.identity.subject,user.id]);
      await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1", [fixture.engineInstanceId]);
      const pair = generateKeyPairSync("ed25519"), publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
      const device = (await pool.query<{ id: string }>(`INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint)
        VALUES($1,'Queue device','macos',$2,$3) RETURNING id`, [user.id,publicKey,createHash("sha256").update(publicKey).digest()])).rows[0]!;
      const fields = { deviceId: device.id, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
      const actors = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393, bridgeUrl: "wss://control.example/bridge", workosEnabled: false });
      const grant = await actors.issue({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
        actorUserId: user.id, authenticatedUser: user, proof: { ...fields, signature: sign(null, cloudWorkspaceDeviceProofMessage({ ...fields,
          accountUserId: user.id, action: "engine.connect", payload: { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId } }), pair.privateKey).toString("base64url") } });
      const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
        engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
      const admitted = await actors.consume({ ...scope, token: grant.grantToken });
      return { ...scope, actorSessionId: admitted.actorSessionId, deviceId: device.id };
    }
    it("records consumption authorization and consumption separately before retiring source authority", async () => {
      const f = await prepared();
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(true);
      expect(await sourceState()).toBe("ready");
      expect(await journal(f.claim.transitionId)).toBe("consumption_authorized");
      expect(await service.retireResidentSource(f.claim)).toBe(false);
      const detached = { ...f.resident, fence: 2, engineId: null, generation: null };
      expect(await service.recordResidentConsumption(f.claim, { handoff: f.handoff, resident: detached })).toBe(true);
      expect(await journal(f.claim.transitionId)).toBe("consumed");
      expect(await sourceState()).toBe("ready");
      expect(await service.retireResidentSource(f.claim)).toBe(true);
      expect(await journal(f.claim.transitionId)).toBe("source_retired");
      expect(await sourceState()).toBe("revoked");
      expect(await service.retireResidentSource(f.claim)).toBe(true);
    });
    it("never cancels an ambiguous authorized consumption or takes the ordinary activation path", async () => {
      const f = await prepared();
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(true);
      expect(await service.cancelStaging(f.claim)).toBe(false);
      expect(await service.activate(f.claim, f)).toBe(false);
      expect(await service.reconcile(f.claim)).toBe("inspect");
      await pool.query("UPDATE cloud_workspace_runtime_handoffs SET deadline_at=clock_timestamp()-interval '1 second' WHERE transition_id=$1", [f.claim.transitionId]);
      expect(await service.reconcile(f.claim)).toBe("recovery_required");
      expect(await journal(f.claim.transitionId)).toBe("uncertain");
      expect(await sourceState()).toBe("revoked");
    });
    it("releases a consumption intent only after root proves cancellation under the same live source", async () => {
      const f = await prepared();
      await service.authorizeResidentConsumption(f.claim, f);
      expect(await service.cancelResidentConsumption(f.claim, { handoff: f.handoff, resident: { ...f.resident, fence: 2 } })).toBe(false);
      expect(await service.cancelResidentConsumption(f.claim, f)).toBe(true);
      expect(await journal(f.claim.transitionId)).toBe("cancelled");
      expect(await sourceState()).toBe("ready");
      expect(await withSystemTx(pool, tx => readCloudRuntimeResumeProofEpoch(tx, { ...f.claim, generation: 1 }))).toBe(fixture.engineInstanceId);
      expect(await service.recordResidentConsumption(f.claim, { handoff: f.handoff,
        resident: { ...f.resident, engineId: null, generation: null, fence: 2 } })).toBe(false);
      const commands = new DatabaseCloudWorkspaceCommandService({ pool }), commandId = randomUUID();
      const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
        engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
      await commands.mutate(scope, { conversationId: "after-cancel", operationId: randomUUID(), expectedRevision: 0,
        action: { kind: "enqueue", commandId, payload: { agentId: "claude", userMessageId: randomUUID(),
          prompt: [{ type: "text", text: "fixture prompt" }], modeRevision: 0 } } });
      expect((await commands.claim(scope, "after-cancel", "resumed-source"))?.commandId).toBe(commandId);
    });
    it("keeps the resume proof epoch invalid when a lifecycle stop cancels an unresolved consumption", async () => {
      const f = await prepared();
      await service.authorizeResidentConsumption(f.claim, f);
      await withSystemTx(pool, tx => cancelCloudWorkspaceGenerationTransition(tx, { ...f.claim, reason: "workspace_stop_requested" }));
      expect(await journal(f.claim.transitionId)).toBe("consumption_authorized");
      expect(await withSystemTx(pool, tx => readCloudRuntimeResumeProofEpoch(tx, { ...f.claim, generation: 1 }))).toBeNull();
    });
    it.each(["foreign", "unfenced", "expired", "unqualified"] as const)("rejects %s handoff evidence without retiring source", async kind => {
      const f = await prepared();
      if (kind === "foreign") f.resident.workspaceId = randomUUID();
      if (kind === "unfenced") Object.assign(f.receipt, { phase: "draining" });
      if (kind === "expired") f.handoff.expiresAtMs = f.receipt.expiresAtMs = Date.now() - 1;
      if (kind === "unqualified") await pool.query("UPDATE cloud_runtime_resident_transfer_qualifications SET enabled=false");
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(false);
      expect(await journal(f.claim.transitionId)).toBeUndefined();
      expect(await sourceState()).toBe("ready");
    });
    it("requires explicit qualification of a distinct older resident runtime", async () => {
      const f = await prepared();
      const older = await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "3", releaseOrder: 3,
        engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION - 1, confirmed: false }));
      f.resident.runtimeId = older.pin.runtimeId; f.resident.manifestSha256 = older.pin.manifestSha256;
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(false);
      await pool.query(`INSERT INTO cloud_runtime_resident_transfer_qualifications
        (source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode,
          resident_runtime_id,enabled,evidence_sha256) VALUES($1,$2,$1,$3,'engine','full',$4,true,$5)`,
      [runtimeWitness.runtimeId,targetActive().runtimeId,runtimeWitness.baseCompatibilityId,older.pin.runtimeId,Buffer.alloc(32)]);
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(true);
    });
    it("rejects a superseded candidate without consuming the source", async () => {
      const f = await prepared();
      await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "3", releaseOrder: 3 }));
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(false);
      expect(await sourceState()).toBe("ready");
      expect(await journal(f.claim.transitionId)).toBeUndefined();
    });
    it("does not let persisted identity or phase edits erase a consumption fence", async () => {
      const f = await prepared();
      await service.authorizeResidentConsumption(f.claim, f);
      await expect(pool.query(`UPDATE cloud_workspace_runtime_handoffs SET request='{}' WHERE transition_id=$1`, [f.claim.transitionId])).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(`UPDATE cloud_workspace_runtime_handoffs SET phase='source_retired',source_retired_at=clock_timestamp()
        WHERE transition_id=$1`, [f.claim.transitionId])).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(`UPDATE cloud_workspace_runtime_handoffs SET deadline_at=deadline_at+interval '1 second'
        WHERE transition_id=$1`, [f.claim.transitionId])).rejects.toMatchObject({ code: "23514" });
      await service.recordResidentConsumption(f.claim, { handoff: f.handoff, resident: { ...f.resident, engineId: null, generation: null, fence: 2 } });
      await expect(pool.query(`UPDATE cloud_workspace_runtime_handoffs SET phase='consumption_authorized',consumed_at=NULL,consumed_resident=NULL
        WHERE transition_id=$1`, [f.claim.transitionId])).rejects.toMatchObject({ code: "23514" });
      expect(await service.reconcile(f.claim)).toBe("inspect");
      expect(await journal(f.claim.transitionId)).toBe("source_retired");
      expect(await sourceState()).toBe("revoked");
    });
    it("rejects a forged detached witness and lets a fresh worker finish confirmed consumption", async () => {
      const f = await prepared();
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(true);
      const detached = { ...f.resident, fence: 2, engineId: null, generation: null };
      for (const change of [{ hostId: randomUUID() }, { fence: 1 }, { engineId: fixture.engineInstanceId }, { runtimeId: targetActive().runtimeId }])
        expect(await service.recordResidentConsumption(f.claim, { handoff: f.handoff, resident: { ...detached, ...change } })).toBe(false);
      expect(await service.recordResidentConsumption(f.claim, { handoff: f.handoff, resident: detached })).toBe(true);
      expect(await service.recordResidentConsumption(f.claim, { handoff: f.handoff, resident: detached })).toBe(true);
      await service.release(f.claim);
      const next = await service.claim(f.claim, "zeros-v2-test-hu-recovery");
      expect(await service.retireResidentSource(f.claim)).toBe(false);
      expect(await service.reconcile(next!)).toBe("inspect");
      expect(await service.retireResidentSource(next!)).toBe(true);
      expect(await sourceState()).toBe("revoked");
    });
    it("binds target and rollback health to the resident host and a fresh attachment fence", async () => {
      const f = await prepared();
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(true);
      const detached = { ...f.resident, fence: 2, engineId: null, generation: null };
      await service.recordResidentConsumption(f.claim, { handoff: f.handoff, resident: detached });
      await service.retireResidentSource(f.claim);
      const active = targetActive(), evidence = { active, controller: f.controller, report: report(active), rollback: false };
      expect(await service.enroll(f.claim, evidence)).toBeNull();
      expect(await service.enroll(f.claim, { ...evidence, resident: { ...detached, fence: 4 } })).toBeNull();
      const enrollment = (await service.enroll(f.claim, { ...evidence, resident: detached }))!;
      expect(enrollment.resident).toEqual({ hostId: f.resident.hostId, fence: 3 });
      await expect(pool.query("UPDATE cloud_workspace_runtime_enrollments SET resident_witness=NULL WHERE id=$1", [enrollment.id])).rejects.toMatchObject({ code: "23514" });
      await service.register({ ...f.claim, generation: 2, setupRunId: enrollment.id, executionFence: enrollment.executionFence,
        engineInstanceId: enrollment.engineInstanceId, token: enrollment.token, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
        actorProtocolVersion: 2, agentRuntime: { ...report(active).runtime as object, profile: "zeros-cloud-worker-v4" } });
      const probe = (challenge: string) => ({ challenge, executionFence: f.claim.executionFence, active,
        engineInstanceId: enrollment.engineInstanceId, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
        health: "ready" as const, durableRecordConnected: true as const });
      expect(await service.verifyHealth(f.claim, async challenge => probe(challenge))).toBe(false);
      const attached = { ...detached, engineId: enrollment.engineInstanceId, generation: 2, fence: 3 };
      expect(await service.verifyHealth(f.claim, async challenge => ({ ...probe(challenge), resident: { ...attached, fence: 2 } }))).toBe(false);
      expect(await service.verifyHealth(f.claim, async challenge => ({ ...probe(challenge), resident: attached }))).toBe(true);
      await service.beginRollback(f.claim);
      const restored = { ...sourceActive(), supervisorSessionId: randomUUID() };
      const rollback = (await service.enroll(f.claim, { active: restored, controller: f.controller, report: report(restored),
        rollback: true, resident: { ...detached, fence: 4 } }))!;
      expect(rollback.resident).toEqual({ hostId: f.resident.hostId, fence: 5 });
      expect(rollback.engineInstanceId).not.toBe(enrollment.engineInstanceId);
      expect(rollback.engineInstanceId).not.toBe(fixture.engineInstanceId);
    });
    it.each([false, true])("preserves queued pause=%s across a verified swap and claims each command once", async paused => {
      const f = await prepared(), commands = new DatabaseCloudWorkspaceCommandService({ pool });
      const source = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
        engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
      const input = { conversationId: "resident-queue", operationId: randomUUID(), expectedRevision: 0,
        action: { kind: "enqueue" as const, commandId: randomUUID(), payload: { agentId: "claude" as const,
          userMessageId: randomUUID(), prompt: [{ type: "text" as const, text: "fixture prompt" }], modeRevision: 0 } } };
      const actor = await queueActor();
      await commands.mutate(actor, input);
      if (paused) await commands.stop(actor, input.conversationId, randomUUID());
      expect(await service.authorizeResidentConsumption(f.claim, f)).toBe(true);
      expect(await commands.claim(source, input.conversationId, "during-handoff")).toBeNull();
      const detached = { ...f.resident, fence: 2, engineId: null, generation: null };
      await service.recordResidentConsumption(f.claim, { handoff: f.handoff, resident: detached });
      await service.retireResidentSource(f.claim);
      const active = targetActive();
      const enrollment = (await service.enroll(f.claim, { active, controller: f.controller, report: report(active), rollback: false, resident: detached }))!;
      const registration = await service.register({ ...f.claim, generation: 2, setupRunId: enrollment.id, executionFence: enrollment.executionFence,
        engineInstanceId: enrollment.engineInstanceId, token: enrollment.token, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
        actorProtocolVersion: 2, agentRuntime: { ...report(active).runtime as object, profile: "zeros-cloud-worker-v4" } });
      const target = { ...source, generation: 2, engineInstanceId: enrollment.engineInstanceId, heartbeatToken: registration.heartbeat.token };
      await expect(commands.claim(target, input.conversationId, "before-health")).rejects.toThrow();
      expect(await service.verifyHealth(f.claim, async challenge => ({ challenge, executionFence: f.claim.executionFence, active,
        engineInstanceId: enrollment.engineInstanceId, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, health: "ready", durableRecordConnected: true,
        resident: { ...detached, fence: 3, engineId: enrollment.engineInstanceId, generation: 2 } }))).toBe(true);
      expect(await service.finish(f.claim, receipt(f.claim, active))).toBe(true);
      if (paused) expect(await commands.claim(target, input.conversationId, "still-paused")).toBeNull();
      else {
        const claimId = randomUUID();
        const dispatch = await commands.claim(target, input.conversationId, "after-health", claimId);
        expect(dispatch?.commandId).toBe(input.action.commandId);
        expect(dispatch?.dispatchAllowed).not.toBe(false);
        expect(await commands.claim(target, input.conversationId, "after-health", claimId)).toEqual(dispatch);
        expect(await commands.claim(target, input.conversationId, "another-execution")).toBeNull();
        await commands.settle(target, { commandId: input.action.commandId, claimId, state: "succeeded", resultCode: null });
        expect(await commands.claim(target, input.conversationId, "after-health", claimId)).toBeNull();
      }
      expect((await pool.query("SELECT paused FROM cloud_workspace_conversation_controls WHERE workspace_id=$1 AND conversation_id=$2",
        [fixture.workspaceId,input.conversationId])).rows[0].paused).toBe(paused);
      await expect(commands.claim(source, input.conversationId, "stale-source")).rejects.toThrow();
    });
  });

  describe("running quiet trigger", () => {
    const scope = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      sourceEngineInstanceId: fixture.engineInstanceId, mode: "engine" as const });
    function reader() {
      const state = { version: 1 as const, workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
        engineInstanceId: fixture.engineInstanceId, activityRevision: 3, quietForMs: 60_000, stable: true,
        recordSync: "ready" as const, workloadBusy: false, livePty: false, userProcesses: "idle" as const, presence: "absent" as const };
      const read = vi.fn(async ({ challenge }: { challenge: string }): Promise<CloudRuntimeQuietSnapshot> => ({ ...state, challenge }));
      return { state, read, trigger: new DatabaseCloudRuntimeQuietTrigger({ service, readQuiet: read }) };
    }
    it("defers a present client, then joins one immutable candidate when quiet", async () => {
      const f = reader(), read = f.read.getMockImplementation()!;
      f.read.mockImplementation(async input => ({ ...await read(input), presence: "present" }));
      expect(await f.trigger.consider(scope())).toBeNull();
      expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
      f.read.mockImplementation(read);
      const [first, second] = await Promise.all([f.trigger.consider(scope()), f.trigger.consider(scope())]);
      expect(first).toMatchObject({ sourceGeneration: 1, candidateGeneration: 2, phase: "offered" });
      expect(second?.transitionId).toBe(first?.transitionId);
      expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0].state).toBe("ready");
    });
    it.each(["activity", "presence", "pty", "workload", "processes", "record", "engine"] as const)("rechecks %s at activation and keeps a refused source usable", async kind => {
      const claim = await claimed(); await qualifyTransfer(); await service.staged(claim);
      const f = reader(), policy = await f.trigger.prepareActivation(claim);
      expect(policy).not.toBeNull();
      const read = f.read.getMockImplementation()!;
      f.read.mockImplementation(async input => ({ ...await read(input), ...{
        activity: { activityRevision: 4 }, presence: { presence: "present" as const }, pty: { livePty: true },
        workload: { workloadBusy: true }, processes: { userProcesses: "unknown" as const },
        record: { recordSync: "pending" as const }, engine: { engineInstanceId: randomUUID() },
      }[kind] }));
      expect(await service.activate(claim, { controller: sourceActive(), policy: policy! })).toBe(false);
      expect(f.read).toHaveBeenCalledTimes(2);
      expect((await pool.query("SELECT phase FROM cloud_workspace_runtime_transitions WHERE transition_id=$1", [claim.transitionId])).rows[0].phase).toBe("staged");
      expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0].state).toBe("ready");
    });
    it("authorizes only the prepared claim and fresh unchanged revision", async () => {
      const claim = await claimed(); await qualifyTransfer(); await service.staged(claim);
      const f = reader(), policy = await f.trigger.prepareActivation(claim);
      expect(await withSystemTx(pool, tx => policy!.authorize(tx, { ...claim, workerFence: randomUUID() }))).toBe(false);
      expect(await service.activate(claim, { controller: sourceActive(), policy: policy! })).toBe(true);
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.read.mock.calls[0][0].challenge === f.read.mock.calls[1][0].challenge).toBe(false);
    });
    async function queue(paused: boolean) {
      const conversationId = randomUUID(), commandId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_conversation_controls(workspace_id,org_id,conversation_id,paused,next_position)
        VALUES($1,$2,$3,$4,2)`, [fixture.workspaceId, fixture.organizationId, conversationId, paused]);
      await pool.query(`INSERT INTO cloud_workspace_commands(workspace_id,org_id,id,conversation_id,position,state,payload,generation,engine_instance_id,user_message_id)
        VALUES($1,$2,$3,$4,1,'queued',$5,1,$6,$7)`, [fixture.workspaceId, fixture.organizationId, commandId, conversationId,
        { agentId: "claude", userMessageId: commandId, prompt: [{ type: "text", text: "fixture" }], modeRevision: 0 }, fixture.engineInstanceId, commandId]);
      return { conversationId, commandId };
    }
    it("defers queued runnable work before either probe without changing its pause state", async () => {
      const claim = await claimed(); await service.staged(claim);
      const { commandId } = await queue(false), f = reader();
      expect(await f.trigger.consider(scope())).toBeNull();
      expect(await f.trigger.prepareActivation(claim)).toBeNull();
      expect(f.read).not.toHaveBeenCalled();
      expect((await pool.query(`SELECT command.state,control.paused FROM cloud_workspace_commands command
        JOIN cloud_workspace_conversation_controls control USING(workspace_id,org_id,conversation_id)
        WHERE command.id=$1`, [commandId])).rows[0]).toEqual({ state: "queued", paused: false });
    });
    it.each(["before", "during"] as const)("rechecks server work %s the final VM read", async when => {
      const claim = await claimed(); await qualifyTransfer(); await service.staged(claim);
      const { conversationId } = await queue(true), f = reader();
      const policy = await f.trigger.prepareActivation(claim);
      expect(policy).not.toBeNull();
      const unpause = () => pool.query(`UPDATE cloud_workspace_conversation_controls SET paused=false
        WHERE workspace_id=$1 AND conversation_id=$2`, [fixture.workspaceId, conversationId]);
      if (when === "before") await unpause();
      else {
        const read = f.read.getMockImplementation()!;
        f.read.mockImplementation(async input => { await unpause(); return read(input); });
      }
      expect(await service.activate(claim, { controller: sourceActive(), policy: policy! })).toBe(false);
      expect(f.read).toHaveBeenCalledTimes(when === "before" ? 1 : 2);
      expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0].state).toBe("ready");
    });
    it("rejects an expired or reclaimed worker before probing and before activation", async () => {
      const claim = await claimed(); await qualifyTransfer(); await service.staged(claim);
      const f = reader(), policy = await f.trigger.prepareActivation(claim);
      await pool.query(`UPDATE cloud_workspace_runtime_transitions SET worker_expires_at=clock_timestamp()-interval '1 second'
        WHERE transition_id=$1`, [claim.transitionId]);
      expect(await f.trigger.prepareActivation(claim)).toBeNull();
      const replacement = await service.claim(claim, "replacement-worker");
      expect(replacement).not.toBeNull();
      expect(await service.activate(replacement!, { controller: sourceActive(), policy: policy! })).toBe(false);
      expect(f.read).toHaveBeenCalledOnce();
    });
    it("keeps the observation policy replaceable for a qualified live handoff", async () => {
      const f = reader(), read = f.read.getMockImplementation()!;
      f.read.mockImplementation(async input => ({ ...await read(input), presence: "present" }));
      const policy = { id: "zeros_test_safe_point", accepts: vi.fn(() => true) };
      const trigger = new DatabaseCloudRuntimeQuietTrigger({ service, readQuiet: f.read, policy });
      expect(await trigger.consider(scope())).not.toBeNull();
      expect(policy.accepts).toHaveBeenCalledOnce();
    });
  });

  it("stages a new immutable generation without provider lifecycle intents or changing the source", async () => {
    const transition = await offer();
    expect(transition).toMatchObject({ sourceGeneration: 1, candidateGeneration: 2, phase: "offered" });
    const source = (await pool.query(`SELECT workspace.current_generation,engine.state,engine.runtime_id
      FROM cloud_workspaces workspace JOIN cloud_workspace_engine_instances engine ON engine.workspace_id=workspace.id
      WHERE workspace.id=$1`, [fixture.workspaceId])).rows[0];
    expect(source).toEqual({ current_generation: 1, state: "ready", runtime_id: runtimeWitness.runtimeId });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_setup_runs WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rowCount).toBe(0);
  });

  it("joins one transition when two workers offer concurrently", async () => {
    const [first, second] = await Promise.all([offer(), offer()]);
    expect(first).not.toBeNull();
    expect(second?.transitionId).toBe(first?.transitionId);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
  });

  it("rejects a stale source engine without creating a candidate", async () => {
    expect(await service.offer({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      generation: 1, sourceEngineInstanceId: randomUUID(), operationId: randomUUID(), mode: "engine" })).toBeNull();
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
  });

  it("requires both reversible controller/target qualification and a pluggable activation policy", async () => {
    const claim = await claimed();
    expect(await service.staged(claim)).toBe(true);
    let calls = 0;
    const policy = { id:"zeros_test_live_handoff",async authorize() { calls++; return true; } };
    expect(await service.activate(claim,{ controller:sourceActive(),policy })).toBe(false);
    expect(calls).toBe(0);
    await qualifyTransfer();
    expect(await service.activate(claim,{ controller:sourceActive(),policy })).toBe(true);
    expect(calls).toBe(1);
    expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0].state).toBe("revoked");
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].current_generation).toBe(1);
  });

  it("leaves the source usable when policy refuses and can retry without another generation", async () => {
    const claim = await claimed();
    await qualifyTransfer();
    expect(await service.staged(claim)).toBe(true);
    expect(await service.activate(claim,{ controller:sourceActive(),policy:{ id:"zeros_test_defer",async authorize() { return false; } } })).toBe(false);
    expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0].state).toBe("ready");
    expect((await pool.query("SELECT phase FROM cloud_workspace_runtime_transitions WHERE transition_id=$1", [claim.transitionId])).rows[0].phase).toBe("staged");
  });

  it("fences an expired worker before allowing another claim", async () => {
    const claim = await claimed();
    expect(await service.claim(claim,"zeros-v2-test-hu-other-worker")).toBeNull();
    await pool.query("UPDATE cloud_workspace_runtime_transitions SET worker_expires_at=clock_timestamp()-interval '1 second' WHERE transition_id=$1", [claim.transitionId]);
    const next = await service.claim(claim,"zeros-v2-test-hu-other-worker");
    expect(next?.workerFence === claim.workerFence).toBe(false);
    expect(await service.staged(claim)).toBe(false);
    expect(await service.staged(next!)).toBe(true);
  });

  it("releases a staged claim immediately without changing its execution fence or source", async () => {
    const claim = await claimed(); await service.staged(claim);
    expect(await service.release(claim)).toBe(true);
    expect(await service.release(claim)).toBe(false);
    expect(await service.renew(claim)).toBe(false);
    const next = await service.claim(claim,"zeros-v2-test-hu-next");
    expect(next!.executionFence).toBe(claim.executionFence);
    expect(next!.workerFence === claim.workerFence).toBe(false);
    expect(await service.release(claim)).toBe(false);
    expect(await service.cancelStaging(claim)).toBe(false);
    expect((await pool.query("SELECT phase FROM cloud_workspace_runtime_transitions WHERE transition_id=$1",[claim.transitionId])).rows[0].phase).toBe("staged");
    expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1",[fixture.engineInstanceId])).rows[0].state).toBe("ready");
  });

  it.each(["offered","staged"])("cancels %s idempotently without retiring or stopping the source",async phase=>{
    const claim=await claimed(); if (phase==='staged') await service.staged(claim);
    expect(await service.cancelStaging(claim)).toBe(true);
    const completed=(await pool.query("SELECT completed_at FROM cloud_workspace_runtime_transitions WHERE transition_id=$1",[claim.transitionId])).rows[0].completed_at;
    expect(await service.cancelStaging(claim)).toBe(true);
    expect((await pool.query("SELECT completed_at FROM cloud_workspace_runtime_transitions WHERE transition_id=$1",[claim.transitionId])).rows[0].completed_at).toEqual(completed);
    expect(await service.claim(claim,"zeros-v2-test-hu-next")).toBeNull();
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1",[claim.transitionId])).rows[0].state).toBe("cancelled");
    expect((await pool.query("SELECT current_generation,status FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0]).toEqual({current_generation:1,status:"ready"});
    expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1",[fixture.engineInstanceId])).rows[0].state).toBe("ready");
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(0);
    expect((await offer())?.candidateGeneration).toBe(3);
  });

  it("rejects foreign and expired release/cancel claims, including terminal replay",async()=>{
    const claim=await claimed();
    for (const key of ['workspaceId','organizationId','transitionId','workerId','workerFence','executionFence'] as const) {
      const forged={...claim,[key]:randomUUID()};
      expect(await service.release(forged)).toBe(false);
      expect(await service.cancelStaging(forged)).toBe(false);
    }
    await pool.query("UPDATE cloud_workspace_runtime_transitions SET worker_expires_at=clock_timestamp()-interval '1 second' WHERE transition_id=$1",[claim.transitionId]);
    expect(await service.release(claim)).toBe(false); expect(await service.cancelStaging(claim)).toBe(false);
    const next=(await service.claim(claim,"zeros-v2-test-hu-next"))!;
    expect(await service.cancelStaging(next)).toBe(true);
    expect(await service.cancelStaging(claim)).toBe(false);
  });

  it("rejects staging cancellation after activation",async()=>{
    const activatedClaim=await activated();
    expect(await service.cancelStaging(activatedClaim)).toBe(false);
  });

  it("orders staging cancellation against activation under the common lock",async()=>{
    const claim=await claimed(); await qualifyTransfer(); await service.staged(claim);
    const results=await Promise.all([service.cancelStaging(claim),service.activate(claim,{controller:sourceActive(),
      policy:{id:"zeros_test_cancel_race",async authorize(){return true;}}})]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const phase=(await pool.query("SELECT phase FROM cloud_workspace_runtime_transitions WHERE transition_id=$1",[claim.transitionId])).rows[0].phase;
    expect(phase).toBe(results[0]?'cancelled':'activated');
  });

  it("rechecks source lease expiry after awaited policy evidence", async () => {
    const claim = await claimed();
    await qualifyTransfer();
    await service.staged(claim);
    expect(await service.activate(claim,{controller:sourceActive(),policy:{id:"zeros_test_expiry",async authorize(tx) {
      await tx.query(`UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=clock_timestamp()-interval '2 seconds',
        lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [fixture.engineInstanceId]);
      return true;
    }}})).toBe(false);
    expect((await pool.query("SELECT phase FROM cloud_workspace_runtime_transitions WHERE transition_id=$1", [claim.transitionId])).rows[0].phase).toBe("staged");
  });

  it("enrolls a fresh engine and moves the binding and pin together only at registration", async () => {
    const observationAt=new Date('2026-01-01T00:00:00.000Z');
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_target='retained-target',last_observed_at=$2 WHERE workspace_id=$1",[fixture.workspaceId,observationAt]);
    const claim = await activated(), active = targetActive();
    const enrollment = await service.enroll(claim,{active,controller:sourceActive(),report:report(active),rollback:false});
    expect(enrollment !== null).toBe(true);
    expect(enrollment!.engineInstanceId === fixture.engineInstanceId).toBe(false);
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].current_generation).toBe(1);
    const registered = await service.register({ ...claim,generation:2,setupRunId:enrollment!.id,executionFence:enrollment!.executionFence,
      engineInstanceId:enrollment!.engineInstanceId,token:enrollment!.token,protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,actorProtocolVersion:2,
      agentRuntime:{...report(active).runtime as object,profile:"zeros-cloud-worker-v4"} });
    expect(registered.engineInstanceId).toBe(enrollment!.engineInstanceId);
    expect((await pool.query("SELECT provider_target,last_observed_at FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=2",[fixture.workspaceId])).rows[0])
      .toEqual({provider_target:'retained-target',last_observed_at:observationAt});
    const bindings = (await pool.query(`SELECT generation,provider_resource_id FROM cloud_workspace_provider_bindings
      WHERE workspace_id=$1 ORDER BY generation`, [fixture.workspaceId])).rows;
    expect(bindings).toEqual([{generation:1,provider_resource_id:null},{generation:2,provider_resource_id:`sandbox-${fixture.workspaceId}`}]);
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].current_generation).toBe(2);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_setup_runs WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rowCount).toBe(0);
  });

  it("rejects forged attestation and keeps enrollment one-use without issuing a second engine", async () => {
    const claim = await activated(), active = targetActive();
    const forged = report(active);
    forged.setupQualification = {secure:true,unprivileged:true,detachedDescendantsRetired:false,timeoutRetired:true};
    expect(await service.enroll(claim,{active,controller:sourceActive(),report:forged,rollback:false})).toBeNull();
    const valid = {active,controller:sourceActive(),report:report(active),rollback:false};
    const enrollment = await service.enroll(claim,valid);
    expect(enrollment !== null).toBe(true);
    expect(await service.enroll(claim,valid)).toBeNull();
    expect((await pool.query("SELECT 1 FROM cloud_workspace_engine_instances WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rowCount).toBe(1);
  });
  async function registered() {
    const claim=await activated(),active=targetActive();
    const enrollment=await service.enroll(claim,{active,controller:sourceActive(),report:report(active),rollback:false});
    if (!enrollment) throw new Error("Expected enrollment");
    const result=await service.register({...claim,generation:2,setupRunId:enrollment.id,executionFence:enrollment.executionFence,
      engineInstanceId:enrollment.engineInstanceId,token:enrollment.token,protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      actorProtocolVersion:2,agentRuntime:{...report(active).runtime as object,profile:"zeros-cloud-worker-v4"}});
    return {claim,active,enrollment,result};
  }

  const receipt=(claim:{workspaceId:string;organizationId:string;transitionId:string;executionFence:string},active:CloudActiveRuntime,rollback=false)=>({
    schema:"zeros.runtime-update/v1" as const,transitionId:claim.transitionId,fence:claim.executionFence,
    scope:{workspaceId:claim.workspaceId,organizationId:claim.organizationId,sourceGeneration:1,candidateGeneration:2,sourceEngineInstanceId:fixture.engineInstanceId},
    operation:"activate" as const,outcome:rollback?"rolled_back" as const:"healthy" as const,active});
  it("opens admissions and a fresh proof epoch only after a bound health challenge",async()=>{
    const {claim,active,enrollment,result}=await registered();
    const scope={...claim,generation:2};
    expect(await withSystemTx(pool,tx=>readCloudRuntimeResumeProofEpoch(tx,scope))).toBeNull();
    const probe=async (challenge:string)=>({challenge,executionFence:claim.executionFence,active,engineInstanceId:enrollment.engineInstanceId,
      protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,health:"ready" as const,durableRecordConnected:true as const});
    expect(await service.verifyHealth(claim,async()=>probe("forged"))).toBe(false);
    expect(await service.verifyHealth(claim,probe)).toBe(true);
    expect(await withSystemTx(pool,tx=>readCloudRuntimeResumeProofEpoch(tx,scope))).toBeNull();
    expect(await service.finish(claim,receipt(claim,active))).toBe(true);
    expect((await withSystemTx(pool,tx=>assertCurrentCloudEngineAuthority(tx,{...scope,
      engineInstanceId:enrollment.engineInstanceId,heartbeatToken:result.heartbeat.token,workosEnabled:false}))).engineInstanceId)
      .toBe(enrollment.engineInstanceId);
    expect(await withSystemTx(pool,tx=>readCloudRuntimeResumeProofEpoch(tx,scope))).toBe(enrollment.engineInstanceId);
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0].status).toBe("ready");
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(0);
  });

  it("rolls back with a new enrollment and preserves the original immutable pin",async()=>{
    const {claim}=await registered();
    expect(await service.beginRollback(claim)).toBe(true);
    const active={...sourceActive(),supervisorSessionId:randomUUID()};
    const enrollment=await service.enroll(claim,{active,controller:sourceActive(),report:report(active),rollback:true});
    expect(enrollment!==null).toBe(true);
    expect(enrollment!.engineInstanceId===fixture.engineInstanceId).toBe(false);
    await service.register({...claim,generation:1,setupRunId:enrollment!.id,executionFence:enrollment!.executionFence,
      engineInstanceId:enrollment!.engineInstanceId,token:enrollment!.token,protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      actorProtocolVersion:2,agentRuntime:{...report(active).runtime as object,profile:"zeros-cloud-worker-v4"}});
    expect(await service.verifyHealth(claim,async challenge=>({challenge,executionFence:claim.executionFence,active,
      engineInstanceId:enrollment!.engineInstanceId,protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,health:"ready",durableRecordConnected:true}))).toBe(true);
    expect(await service.finish(claim,receipt(claim,active,true))).toBe(true);
    expect(await withSystemTx(pool,tx=>readCloudRuntimeResumeProofEpoch(tx,{...claim,generation:1}))).toBe(enrollment!.engineInstanceId);
    expect((await pool.query("SELECT runtime_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1",[fixture.workspaceId])).rows[0].runtime_id).toBe(runtimeWitness.runtimeId);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_allocation_transfers WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(2);
  });

  it("recovers a lost registration response using health without replaying enrollment",async()=>{
    const {claim,active,enrollment}=await registered();
    await pool.query("UPDATE cloud_workspace_runtime_transitions SET worker_expires_at=clock_timestamp()-interval '1 second' WHERE transition_id=$1",[claim.transitionId]);
    const next=await service.claim(claim,"zeros-v2-test-hu-recovery");
    expect(next!.executionFence).toBe(claim.executionFence);
    expect(await service.verifyHealth(claim,async()=>{throw new Error("Stale worker must not probe");})).toBe(false);
    expect(await service.verifyHealth(next!,async challenge=>({challenge,executionFence:claim.executionFence,active,
      engineInstanceId:enrollment.engineInstanceId,protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,health:"ready",durableRecordConnected:true}))).toBe(true);
  });

  it("bounds crash reconciliation without guessing the VM pin or deleting the allocation",async()=>{
    const claim=await activated();
    await pool.query("UPDATE cloud_workspace_runtime_transitions SET activation_deadline_at=clock_timestamp()-interval '1 second' WHERE transition_id=$1",[claim.transitionId]);
    expect(await service.reconcile(claim)).toBe("rollback");
    await pool.query("UPDATE cloud_workspace_runtime_transitions SET rollback_deadline_at=clock_timestamp()-interval '1 second' WHERE transition_id=$1",[claim.transitionId]);
    expect(await service.reconcile(claim)).toBe("recovery_required");
    expect((await pool.query("SELECT current_generation,status FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0]).toEqual({current_generation:1,status:"failed"});
    expect((await pool.query("SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=1",[fixture.workspaceId])).rows[0].provider_resource_id).toBe(`sandbox-${fixture.workspaceId}`);
  });

  it("keeps ordinary admissions closed while permitting durable record synchronization",async()=>{
    const sourceScope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,generation:1,
      engineInstanceId:fixture.engineInstanceId,heartbeatToken:fixture.heartbeatToken,workosEnabled:false};
    expect((await withSystemTx(pool,tx=>assertCurrentCloudEngineAuthority(tx,sourceScope))).engineInstanceId).toBe(fixture.engineInstanceId);
    const {claim,enrollment,result}=await registered();
    await expect(withSystemTx(pool,tx=>assertCurrentCloudEngineAuthority(tx,sourceScope))).rejects.toThrow();
    const scope={...claim,generation:2,engineInstanceId:enrollment.engineInstanceId,heartbeatToken:result.heartbeat.token,workosEnabled:false};
    await expect(withSystemTx(pool,tx=>assertCurrentCloudEngineAuthority(tx,scope))).rejects.toThrow();
    expect((await withSystemTx(pool,tx=>assertCurrentCloudEngineAuthority(tx,{...scope,transitionRecordSync:true}))).engineInstanceId).toBe(enrollment.engineInstanceId);
    await withSystemTx(pool,tx=>queueCloudWorkspaceSetupVerification(tx,scope));
    expect((await pool.query("SELECT 1 FROM cloud_workspace_setup_runs WHERE workspace_id=$1 AND generation=2",[fixture.workspaceId])).rowCount).toBe(0);
    expect(await withSystemTx(pool,tx=>completeCloudWorkspaceGenerationTransition(tx,scope))).toBeNull();
  });

  it("cancels a transferred allocation without switching the pin back or queuing candidate deletion",async()=>{
    const {claim}=await registered();
    expect(await withSystemTx(pool,tx=>cancelCloudWorkspaceGenerationTransition(tx,{...claim,reason:"workspace_stop_requested"}))).toBe(2);
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0].current_generation).toBe(2);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(0);
    expect(await withSystemTx(pool,tx=>readCloudRuntimeResumeProofEpoch(tx,{...claim,generation:2}))).toBeNull();
  });

  function providerFixture() {
    const expiresAt=new Date(Date.now()+900_000).toISOString();
    const resource=()=>({resourceId:`sandbox-${fixture.workspaceId}`,workspaceId:fixture.workspaceId,generation:1,state:"running" as const,
      target:null,metadata:{computeLeaseExpiresAt:expiresAt}});
    return {name:"boat",inspect:vi.fn(async()=>resource()),find:vi.fn(async(_identity:{workspaceId:string;generation:number})=>[resource()]),create:vi.fn(async()=>resource()),
      start:vi.fn(async()=>resource()),stop:vi.fn(async()=>resource()),archive:vi.fn(async()=>resource()),delete:vi.fn(async()=>{}),
      async *listManaged(){yield resource();},computeWeight:()=>({numerator:1,denominator:1}),
      createWithComputeLease:vi.fn(async()=>resource()),startWithComputeLease:vi.fn(async()=>resource()),
      readComputeUsage:vi.fn(async(id:string,window:{since:Date;until:Date})=>({resourceId:id,since:window.since.toISOString(),until:window.until.toISOString(),
        billableSeconds:1,secondsPerDollar:100000,listPriceMicroUsd:10,running:true})),
      renewComputeLease:vi.fn(async()=>({expiresAt:new Date(Date.now()+900_000).toISOString()}))};
  }

  it("preserves compute funding identity while metering and safety stop follow the new owner",async()=>{
    const raw=providerFixture();
    const scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,generation:1};
    const coordinator=new CloudWorkspaceComputeLeaseCoordinator({pool,workosEnabled:false,
      providerResolver:{async resolve(input){return {provider:bindCloudAllocationProvider(pool,raw,input),connectionId:randomUUID(),connectionVersion:1,credentialSource:"hosted"};}} as never,
      policy:{provider:"boat",policyId:"zeros-test-hu",secondsPerDollar:100000,minimumTtlSeconds:600,maximumTtlSeconds:900,requestMarginSeconds:60}});
    const ledger=new DatabaseManagedComputeCreditLedger({pool,workosEnabled:false});
    await ledger.grant({organizationId:fixture.organizationId,userId:fixture.userId,startsAt:new Date(Date.now()-3600_000),
      endsAt:new Date(Date.now()+3600_000),amountMicroUsd:20000,policyId:"zeros-test-hu",idempotencyKey:randomUUID()});
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=true WHERE provider='boat'");
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=NULL WHERE workspace_id=$1",[fixture.workspaceId]);
    const intentId=randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,operation,idempotency_key,request_sha256)
      VALUES($1,$2,$3,1,'create',($1::uuid)::text,$4)`,[intentId,fixture.workspaceId,fixture.organizationId,Buffer.alloc(32)]);
    await coordinator.allocate({...scope,intentId,idempotencyKey:intentId,imageRef:"fixture",architecture:"linux/amd64",cpuMillicores:2000,memoryMiB:4096,storageMiB:20480},raw,null);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1",[fixture.workspaceId,`sandbox-${fixture.workspaceId}`]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1",[intentId]);
    const before=(await pool.query("SELECT id,generation,billing_epoch,funded_until,provider_expires_at FROM managed_compute_allocation_leases WHERE workspace_id=$1",[fixture.workspaceId])).rows[0];
    const {claim,active,enrollment}=await registered();
    expect((await pool.query("SELECT cloud_workspace_compute_authority_live($1,2) AS live",[fixture.workspaceId])).rows[0].live).toBe(true);
    expect((await pool.query("SELECT id,generation,billing_epoch,funded_until,provider_expires_at FROM managed_compute_allocation_leases WHERE workspace_id=$1",[fixture.workspaceId])).rows[0]).toEqual(before);
    expect(await coordinator.runOnce()).toBe(false);
    expect(await service.verifyHealth(claim,async challenge=>({challenge,executionFence:claim.executionFence,active,engineInstanceId:enrollment.engineInstanceId,
      protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,health:"ready",durableRecordConnected:true}))).toBe(true);
    expect(await service.finish(claim,receipt(claim,active))).toBe(true);
    await withSystemTx(pool,tx=>seedRuntimeBundle(tx,{digit:"3",releaseOrder:3}));
    const next=await service.offer({...claim,generation:2,sourceEngineInstanceId:enrollment.engineInstanceId,operationId:randomUUID(),mode:"engine"});
    expect(next?.sourceGeneration).toBe(2);
    expect((await pool.query("SELECT allocation_lease_id,original_generation,current_generation FROM cloud_workspace_allocation_owners WHERE workspace_id=$1",[fixture.workspaceId])).rows[0])
      .toEqual({allocation_lease_id:before.id,original_generation:1,current_generation:2});
    await withSystemTx(pool,tx=>cancelCloudWorkspaceGenerationTransition(tx,{...claim,reason:"workspace_stop_requested"}));
    await pool.query("UPDATE managed_compute_credit_reservations SET meter_since=meter_since-interval '10 seconds',meter_through=meter_through-interval '10 seconds' WHERE id=$1",[before.id]);
    await coordinator.runOnce();
    expect(raw.readComputeUsage).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT generation,state FROM managed_compute_credit_reservations WHERE id=$1",[before.id])).rows[0]).toEqual({generation:1,state:"open"});
    await requestManagedComputeStop(pool,{leaseId:before.id,reason:"compute_credit_exhausted",force:true});
    expect((await pool.query("SELECT generation FROM cloud_workspace_lifecycle_intents WHERE id=(SELECT stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1)",[before.id])).rows[0].generation).toBe(2);
    await pool.query(`INSERT INTO cloud_workspace_provider_operations(provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id)
      VALUES('boat','zeros-test-hu-account',$1,1,$2,$3,$4,$5)`,[fixture.workspaceId,fixture.organizationId,randomUUID(),'0'.repeat(64),`sandbox-${fixture.workspaceId}`]);
    await seedProviderLossAttestation(pool,{provider:'boat',accountScope:'zeros-test-hu-account',workspaceId:fixture.workspaceId,
      resourceId:`sandbox-${fixture.workspaceId}`,attestedBy:fixture.userId});
    const period=(await pool.query("SELECT period_id FROM managed_compute_credit_reservations WHERE id=$1",[before.id])).rows[0].period_id;
    expect((await ledger.finalizeLost({reservationId:before.id,periodId:period,resourceId:`sandbox-${fixture.workspaceId}`})).state).toBe('final');

  });

  it("maps provider receipts without letting a stale source worker stop the transferred VM",async()=>{
    const {claim}=await registered(),raw=providerFixture();
    const current=bindCloudAllocationProvider(pool,raw,{...claim,generation:2});
    expect((await current.find({workspaceId:claim.workspaceId,generation:2}))[0]?.generation).toBe(2);
    expect(raw.find.mock.calls[0]?.[0]).toMatchObject({generation:1});
    const stale=bindCloudAllocationProvider(pool,raw,{...claim,generation:1});
    await expect(stale.stop(`sandbox-${fixture.workspaceId}`)).rejects.toThrow();
    expect(raw.stop).not.toHaveBeenCalled();
  });

  it("keeps an unknown destructive provider outcome blocking activation after its caller exits",async()=>{
    const claim=await claimed(),raw=providerFixture();
    await qualifyTransfer();await service.staged(claim);
    raw.stop.mockRejectedValueOnce(new Error("Provider outcome unknown"));
    const wrapped=bindCloudAllocationProvider(pool,raw as CloudWorkspaceProvider,{...claim,generation:1});
    await expect(wrapped.stop(`sandbox-${fixture.workspaceId}`)).rejects.toThrow();
    expect(await service.activate(claim,{controller:sourceActive(),policy:{id:"zeros_test_policy",async authorize(){return true;}}})).toBe(false);
  });

  it("rejects replayed and cross-tenant enrollment capabilities",async()=>{
    const {claim,enrollment,active}=await registered();
    const input={...claim,generation:2,setupRunId:enrollment.id,executionFence:enrollment.executionFence,
      engineInstanceId:enrollment.engineInstanceId,token:enrollment.token,protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      actorProtocolVersion:2,agentRuntime:{...report(active).runtime as object,profile:"zeros-cloud-worker-v4"}};
    await expect(service.register(input)).rejects.toThrow("registration rejected");
    await expect(service.register({...input,organizationId:randomUUID()})).rejects.toThrow("registration rejected");
    expect((await pool.query("SELECT 1 FROM cloud_workspace_allocation_transfers WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(1);
  });

  it("rechecks qualification immediately before enrollment and leaves the source pin unchanged",async()=>{
    const claim=await activated(),active=targetActive();
    await pool.query("UPDATE cloud_runtime_transfer_qualifications SET enabled=false");
    expect(await service.enroll(claim,{active,controller:sourceActive(),report:report(active),rollback:false})).toBeNull();
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0].current_generation).toBe(1);
  });

  it("rejects forged health and final journal identities after successful registration",async()=>{
    const {claim,active,enrollment}=await registered();
    const probe=async(challenge:string)=>({challenge,executionFence:claim.executionFence,active,engineInstanceId:enrollment.engineInstanceId,
      protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,health:"ready" as const,durableRecordConnected:true as const});
    expect(await service.verifyHealth(claim,async challenge=>({...await probe(challenge),engineInstanceId:fixture.engineInstanceId}))).toBe(false);
    expect(await service.verifyHealth(claim,probe)).toBe(true);
    expect(await service.finish(claim,{...receipt(claim,active),fence:randomUUID()})).toBe(false);
    expect(await service.finish(claim,receipt(claim,{...active,supervisorSessionId:randomUUID()}))).toBe(false);
    expect(await withSystemTx(pool,tx=>readCloudRuntimeResumeProofEpoch(tx,{...claim,generation:2}))).toBeNull();
  });

  it("renews only the current worker without extending the activation deadline",async()=>{
    const claim=await activated();
    const before=(await pool.query("SELECT activation_deadline_at FROM cloud_workspace_runtime_transitions WHERE transition_id=$1",[claim.transitionId])).rows[0];
    expect(await service.renew(claim)).toBe(true);
    expect(await service.renew({...claim,workerFence:randomUUID()})).toBe(false);
    expect((await pool.query("SELECT activation_deadline_at FROM cloud_workspace_runtime_transitions WHERE transition_id=$1",[claim.transitionId])).rows[0]).toEqual(before);
  });

  it("allows a one-time bootstrap using exact target-controller qualification on the same base",async()=>{
    const offered=await service.offer({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,generation:1,
      sourceEngineInstanceId:fixture.engineInstanceId,operationId:randomUUID(),mode:"bootstrap"});
    const claim=await service.claim({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,transitionId:offered!.transitionId},"zeros-v2-test-hu-bootstrap");
    await pool.query(`INSERT INTO cloud_runtime_transfer_qualifications
      (source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode,enabled,evidence_sha256)
      VALUES($1,$2,$2,$3,'bootstrap','full',true,$4)`,[runtimeWitness.runtimeId,`r1-${"2".repeat(64)}`,runtimeWitness.baseCompatibilityId,Buffer.alloc(32)]);
    await service.staged(claim!);
    expect(await service.activate(claim!,{controller:null,policy:{id:"zeros_test_bootstrap",async authorize(){return true;}}})).toBe(true);
    const active=targetActive();
    expect(await service.enroll(claim!,{active,controller:sourceActive(),report:report(active),rollback:false})).toBeNull();
    expect((await service.enroll(claim!,{active,controller:active,report:report(active),rollback:false}))!==null).toBe(true);
  });

  it("does not resurrect the old proof epoch when activation is cancelled before registration",async()=>{
    const claim=await activated();
    await withSystemTx(pool,tx=>cancelCloudWorkspaceGenerationTransition(tx,{...claim,reason:"workspace_stop_requested"}));
    expect(await withSystemTx(pool,tx=>readCloudRuntimeResumeProofEpoch(tx,{...claim,generation:1}))).toBeNull();
  });

  it("allows qualification row locks but forbids application publication or mutation",async()=>{
    await qualifyTransfer();
    await expect(withSystemTx(pool,tx=>tx.query("UPDATE cloud_runtime_transfer_qualifications SET enabled=false"))).rejects.toThrow();
    expect((await withSystemTx(pool,tx=>tx.query("DELETE FROM cloud_runtime_transfer_qualifications"))).rowCount).toBe(0);
  });

  it.each(['invalid','foreign','pin','duplicate'])("rejects %s enrollment-shaped INSERTs in the database",async kind=>{
    const {enrollment}=await registered();
    const changes:Record<string,unknown>={id:randomUUID(),state:'starting'};
    if(kind==='invalid')changes.runtime_transition_enrollment_id=randomUUID();
    if(kind==='foreign')changes.workspace_id=randomUUID();
    if(kind==='pin')changes.runtime_manifest_sha256='3'.repeat(64);
    await expect(withSystemTx(pool,tx=>tx.query(`INSERT INTO cloud_workspace_engine_instances
      SELECT (jsonb_populate_record(NULL::cloud_workspace_engine_instances,to_jsonb(engine)||$2::jsonb)).*
      FROM cloud_workspace_engine_instances engine WHERE id=$1`,[enrollment.engineInstanceId,JSON.stringify(changes)]))).rejects.toThrow();
  });

  it("rejects an expired enrollment at the database engine boundary",async()=>{
    const claim=await activated(),active=targetActive();
    const enrollment=await service.enroll(claim,{active,controller:sourceActive(),report:report(active),rollback:false});
    await expect(withSystemTx(pool,async tx=>{
      const id=randomUUID(),engineId=randomUUID();
      await tx.query("UPDATE cloud_workspace_runtime_transitions SET enrollment_sequence=enrollment_sequence+1 WHERE transition_id=$1",[claim.transitionId]);
      await tx.query(`INSERT INTO cloud_workspace_runtime_enrollments SELECT (jsonb_populate_record(NULL::cloud_workspace_runtime_enrollments,
        to_jsonb(enrollment)||jsonb_build_object('id',$2::text,'engine_instance_id',$3::text,'sequence',sequence+1,
          'created_at',clock_timestamp()-interval '2 minutes','expires_at',clock_timestamp()-interval '1 second',
          'token_hash',digest(gen_random_uuid()::text,'sha256')))).*
        FROM cloud_workspace_runtime_enrollments enrollment WHERE id=$1`,[enrollment!.id,id,engineId]);
      await tx.query(`INSERT INTO cloud_workspace_engine_instances SELECT (jsonb_populate_record(NULL::cloud_workspace_engine_instances,
        to_jsonb(engine)||jsonb_build_object('id',$2::text,'runtime_transition_enrollment_id',$3::text))).*
        FROM cloud_workspace_engine_instances engine WHERE id=$1`,[enrollment!.engineInstanceId,engineId,id]);
    })).rejects.toMatchObject({code:'23514'});
  });

  it("prevents changing or clearing enrollment identity to bypass a trigger",async()=>{
    const {enrollment}=await registered();
    await expect(pool.query("UPDATE cloud_workspace_engine_instances SET runtime_transition_enrollment_id=NULL WHERE id=$1",[enrollment.engineInstanceId])).rejects.toThrow();
    await expect(pool.query("UPDATE cloud_workspace_engine_instances SET runtime_transition_enrollment_id=$2 WHERE id=$1",[fixture.engineInstanceId,enrollment.id])).rejects.toThrow();
    await expect(pool.query("UPDATE cloud_workspace_engine_instances SET runtime_transition_enrollment_id=$2 WHERE id=$1",[enrollment.engineInstanceId,randomUUID()])).rejects.toThrow();
  });

  it("can roll back a revoked candidate to the still-qualified source",async()=>{
    const claim=await activated();
    await pool.query("UPDATE cloud_runtime_bundles SET revoked_at=clock_timestamp() WHERE runtime_id=$1",[`r1-${"2".repeat(64)}`]);
    expect(await service.beginRollback(claim)).toBe(true);
    const active={...sourceActive(),supervisorSessionId:randomUUID()};
    expect((await service.enroll(claim,{active,controller:sourceActive(),report:report(active),rollback:true}))!==null).toBe(true);
  });

  it("invalidates a retained proof epoch when a later activation is cancelled before enrollment",async()=>{
    const {claim,active,enrollment}=await registered();
    expect(await service.verifyHealth(claim,async challenge=>({challenge,executionFence:claim.executionFence,active,
      engineInstanceId:enrollment.engineInstanceId,protocolVersion:CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,health:"ready",durableRecordConnected:true}))).toBe(true);
    expect(await service.finish(claim,receipt(claim,active))).toBe(true);
    await withSystemTx(pool,tx=>seedRuntimeBundle(tx,{digit:"3",releaseOrder:3}));
    const next=await service.offer({...claim,generation:2,sourceEngineInstanceId:enrollment.engineInstanceId,operationId:randomUUID(),mode:"engine"});
    const nextClaim=(await service.claim({...claim,transitionId:next!.transitionId},"zeros-v2-test-hu-next"))!;
    await pool.query(`INSERT INTO cloud_runtime_transfer_qualifications
      (source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode,enabled,evidence_sha256)
      VALUES($1,$2,$3,$4,'engine','full',true,$5)`,[active.runtimeId,`r1-${"3".repeat(64)}`,runtimeWitness.runtimeId,runtimeWitness.baseCompatibilityId,Buffer.alloc(32)]);
    await service.staged(nextClaim);
    expect(await service.activate(nextClaim,{controller:sourceActive(),policy:{id:"zeros_test_handoff",async authorize(){return true;}}})).toBe(true);
    await withSystemTx(pool,tx=>cancelCloudWorkspaceGenerationTransition(tx,{...claim,reason:"workspace_stop_requested"}));
    expect(await withSystemTx(pool,tx=>readCloudRuntimeResumeProofEpoch(tx,{...claim,generation:2}))).toBeNull();
  });

  it("lets existing workspace erasure cascade through retained-transition records",async()=>{
    const {claim}=await registered();
    await pool.query("DELETE FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId]);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_runtime_transitions WHERE transition_id=$1",[claim.transitionId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_allocation_owners WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(0);
  });

});
