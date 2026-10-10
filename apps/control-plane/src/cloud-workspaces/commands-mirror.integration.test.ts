import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { seedRecordedCloudWorkspaceActor } from "./recorded-actor-test-fixture.js";
import { DatabaseCloudWorkspaceCommandService, type CloudCommandEngineScope, type CloudLocalCommandMirrorBatch, type CloudLocalCommandMirrorChange } from "./commands.js";
import { canonicalCloudHistoryJson, HISTORY_WORKSPACE_BYTES } from "./history-local-contract.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("actual authenticated CP mirror commits", () => {
  let pool: pg.Pool, workspace: ReadyCloudWorkspaceFixture, scope: CloudCommandEngineScope,
    service: DatabaseCloudWorkspaceCommandService, bootId: string, writerEpoch: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool); workspace = await seedReadyCloudWorkspace(pool);
    scope = await seedRecordedCloudWorkspaceActor(pool, workspace); service = new DatabaseCloudWorkspaceCommandService({ pool });
    bootId = (await pool.query("SELECT runtime_boot_id AS id FROM cloud_workspace_engine_instances WHERE id=$1", [workspace.engineInstanceId])).rows[0]!.id;
    writerEpoch = randomUUID(); const bindingId = randomUUID();
    // Relational fixture only: real service authorization/projection is tested,
    // not native/FULL cache readiness or production bootstrap qualification.
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers(workspace_id,org_id,generation,engine_instance_id,
      boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch) VALUES($1,$2,1,$3,$4,$5,$6,1)`,
    [workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings(id,workspace_id,org_id,generation,engine_instance_id,
      boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,credentials_initialized)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true)`,
    [bindingId, workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [writerEpoch]);
    await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [workspace.workspaceId, bindingId]);
  });
  const bootScope = () => ({ organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, generation: 1,
    engineInstanceId: workspace.engineInstanceId, bootId, writerEpoch, fundingOwnerUserId: workspace.userId, fundingOwnerEpoch: 1 });
  const actor = () => ({ scope: bootScope(), actor: { userId: workspace.userId, deviceId: randomUUID(), deviceKeyVersion: 1,
    fingerprint: "a".repeat(64), role: "owner" as const }, actorSessionId: scope.actorSessionId!, authorityEpoch: 1,
  confirmedUntilMs: Date.now() + 30_000, fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const } });
  const change = (extra: Partial<CloudLocalCommandMirrorChange> = {}): CloudLocalCommandMirrorChange => ({ sequence: 1, conversationId: "chat", revision: 1, paused: false, ...extra });
  const flight = (changes = [change()], after = 0): CloudLocalCommandMirrorBatch => ({ version: 1, bootId, writerEpoch,
    batchId: randomUUID(), after, through: after + changes.length, changes: changes.map((entry, index) => ({ ...entry, sequence: after + index + 1 })) });
  const hash = (value: unknown) => createHash("sha256").update(canonicalCloudHistoryJson(value)).digest("hex");
  const part = (kind: "record" | "manifest", value: unknown) => {
    const bytes = Buffer.from(canonicalCloudHistoryJson(value)); return { version: 1 as const, kind, sha256: hash(value), index: 0, count: 1, bytes: bytes.length, data: bytes.toString("base64") };
  };
  function terminal() {
    const commandId = randomUUID(), result = { version: 1 as const, terminal: { commandId, conversationId: "chat", executionId: "execution", turnId: "turn", agentId: "cursor",
      status: "failed" as const, stopReason: null, error: "Synthetic invalid credential", failure: { kind: "auth-required" as const, message: "Synthetic invalid credential", stage: "prompt" as const } } };
    const entry = { commandId, position: 1, state: "failed" as const, payload: null, executionId: "execution", generation: 1,
      resultCode: "cloud_provider_prompt_auth_required", result, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const intent = { userMessageId: "turn", agentId: "cursor" }, source = { kind: "command" as const, commandId, executionId: "execution", intent, nativeResultSha256: hash(result) };
    const history = { restoreRevision: 1, recordSequence: 4, eventSequence: 9, incompleteReason: "capture_unavailable" as const };
    return change({ entry, intent, originWriterEpoch: writerEpoch, actor: actor(), history,
      historyHead: { originWriterEpoch: writerEpoch, source, deleted: false, history } });
  }
  const rows = (table: string) => pool.query(`SELECT * FROM ${table} WHERE workspace_id=$1`, [workspace.workspaceId]);
  function stagedTerminal() {
    const original = terminal(), record = { version: 1, conversationId: "chat", entityKind: "message", entityId: "message",
      schemaVersion: 1, sourceRevision: 4, document: { version: 1, chatId: "chat", msgId: "message", text: "Canonical fixture bytes" } };
    const manifest = { version: 1, snapshot: "full", scope: bootScope(), conversationId: "chat", restoreRevision: 3, deleted: false,
      tombstones: [], recordSequence: 4, eventSequence: 9, source: original.historyHead!.source,
      records: [{ entityKind: "message", entityId: "message", schemaVersion: 1, sourceRevision: 4, sha256: hash(record) }] };
    const history = { restoreRevision: 3, recordSequence: 4, eventSequence: 9, manifestSha256: hash(manifest) };
    const receipt = { ...original, revision: 2, history }; delete receipt.historyHead;
    const interim = change({ revision: 2, historyHead: { ...original.historyHead!,
      history: { restoreRevision: 2, recordSequence: 4, eventSequence: 9, incompleteReason: "capture_unavailable" } } });
    return { original, record, manifest, history, receipt, interim };
  }
  const seal = (sequence: number, recordSequence = 0, eventSequence = 0) => {
    const fields = { version: 1 as const, scope: bootScope(), sealId: randomUUID(), sequence, recordSequence, eventSequence, inventorySha256: "a".repeat(64) };
    return { ...fields, sha256: hash(fields) };
  };

  it("stores one exact immutable seal and ACK after mirrored drain, with concurrent/lost-ACK replay and no lifecycle advance", async () => {
    const batch = flight(); await service.mirror(scope, batch);
    const value = seal(1, 4, 9), results = await Promise.all([service.seal(scope, value), service.seal(scope, value)]);
    const ack = { version: 1, sealId: value.sealId, writerEpoch, sequence: 1, recordSequence: 4, eventSequence: 9, inventorySha256: value.inventorySha256, sha256: value.sha256 };
    expect(results).toEqual([ack, ack]); expect(await service.seal(scope, value)).toEqual(ack);
    expect((await rows("cloud_workspace_local_command_writers")).rows).toMatchObject([{ state: "active", mirrored_sequence: "1",
      sealed_sequence: "1", seal_record_sequence: "4", seal_event_sequence: "9", seal: value, seal_ack: ack }]);
    await expect(service.mirror(scope, flight([change()], 1))).rejects.toMatchObject({ code: "command_context_changed" });
    await expect(service.mirror(scope, batch)).rejects.toMatchObject({ code: "command_context_changed" });
    expect((await rows("cloud_workspace_local_command_mirror_batches")).rowCount).toBe(1);
  });
  it("accepts a drained empty writer at zero without inventing source retirement", async () => {
    const value = seal(0), result = await service.seal(scope, value);
    expect(result).toMatchObject({ sequence: 0, recordSequence: 0, eventSequence: 0 });
    expect((await rows("cloud_workspace_local_command_writers")).rows).toMatchObject([{ state: "active", sealed_sequence: "0" }]);
  });
  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)("rejects foreign seal scope %s before storage", async field => {
    const value = seal(0);
    if (field === "generation" || field === "fundingOwnerEpoch") value.scope[field] = 2;
    else value.scope[field] = randomUUID();
    const { sha256: _digest, ...fields } = value; value.sha256 = hash(fields);
    await expect(service.seal(scope, value)).rejects.toMatchObject({ code: "command_context_changed" });
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.sealed_sequence).toBeNull();
  });
  it.each(["gap", "stale", "hash", "record-watermark", "event-watermark"])("refuses a seal with changed %s without storage", async kind => {
    await service.mirror(scope, flight([terminal()]));
    const value = seal(kind === "gap" ? 2 : kind === "stale" ? 0 : 1, kind === "record-watermark" ? 3 : 4, kind === "event-watermark" ? 8 : 9);
    if (kind === "hash") value.sha256 = "f".repeat(64);
    await expect(service.seal(scope, value)).rejects.toMatchObject({ code: "command_conflict" });
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.sealed_sequence).toBeNull();
  });
  it.each(["queued", "dispatching"] as const)("refuses to seal a mirrored %s command", async state => {
    const pending = terminal(); pending.entry = { ...pending.entry!, state, resultCode: null,
      executionId: state === "queued" ? null : "execution", payload: { agentId: "cursor", userMessageId: "turn", model: "fixture-model",
        modeRevision: 0, prompt: [{ type: "text", text: "Synthetic seal fixture" }] } };
    delete pending.history; delete pending.historyHead; delete pending.entry.result;
    await service.mirror(scope, flight([pending]));
    await expect(service.seal(scope, seal(1))).rejects.toMatchObject({ code: "command_conflict" });
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.sealed_sequence).toBeNull();
  });
  it.each(["same-id-changed-body", "new-id", "retired"])("refuses changed or stale seal replay (%s)", async kind => {
    const value = seal(0); await service.seal(scope, value);
    const changed = { ...value };
    if (kind === "same-id-changed-body") changed.recordSequence++;
    if (kind === "new-id") changed.sealId = randomUUID();
    const { sha256: _digest, ...fields } = changed; changed.sha256 = hash(fields);
    if (kind === "retired") await pool.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now() WHERE writer_epoch=$1", [writerEpoch]);
    await expect(service.seal(scope, changed)).rejects.toMatchObject({ code: kind === "retired" ? "command_context_changed" : "command_conflict" });
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.seal).toEqual(value);
  });

  it("atomically advances one cursor, persists exact ACK and resolves concurrent/lost-ACK retries", async () => {
    const value = flight(), results = await Promise.all([service.mirror(scope, value), service.mirror(scope, value)]);
    expect(results[0]).toEqual(results[1]); expect(results[0]).toEqual({ version: 1, writerEpoch, batchId: value.batchId, through: 1 });
    expect(await service.mirror(scope, value)).toEqual(results[0]);
    expect((await rows("cloud_workspace_local_command_mirror_batches")).rows).toMatchObject([{ ack: results[0], through_sequence: "1" }]);
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.mirrored_sequence).toBe("1");
    expect((await rows("cloud_workspace_commands")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_stream_events")).rowCount).toBe(0);
  });
  it("rejects altered retry bodies, gaps and duplicate ranges with another batch identity", async () => {
    const value = flight(); await service.mirror(scope, value);
    await expect(service.mirror(scope, { ...value, changes: [{ ...value.changes[0]!, paused: true }] })).rejects.toMatchObject({ code: "command_conflict" });
    await expect(service.mirror(scope, { ...value, batchId: randomUUID() })).rejects.toMatchObject({ code: "command_conflict" });
    await expect(service.mirror(scope, flight([change()], 2))).rejects.toMatchObject({ code: "command_conflict" });
    expect((await rows("cloud_workspace_local_command_mirror_batches")).rowCount).toBe(1);
  });
  it.each(["boot", "writer", "tenant", "engine", "heartbeat", "retired", "legacy"])("fences %s before any projection", async kind => {
    const value = flight(); let supplied = scope;
    if (kind === "boot") value.bootId = randomUUID();
    if (kind === "writer") value.writerEpoch = randomUUID();
    if (kind === "tenant") supplied = { ...scope, organizationId: randomUUID() };
    if (kind === "engine") supplied = { ...scope, engineInstanceId: randomUUID() };
    if (kind === "heartbeat") supplied = { ...scope, heartbeatToken: `zwh_${"x".repeat(43)}` };
    if (kind === "retired") await pool.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now() WHERE writer_epoch=$1", [writerEpoch]);
    if (kind === "legacy") {
      const legacy = await seedReadyCloudWorkspace(pool);
      supplied = { organizationId: legacy.organizationId, workspaceId: legacy.workspaceId, generation: 1,
        engineInstanceId: legacy.engineInstanceId, heartbeatToken: legacy.heartbeatToken };
    }
    await expect(service.mirror(supplied, value)).rejects.toThrow(); expect((await rows("cloud_workspace_local_command_mirror_batches")).rowCount).toBe(0);
  });
  it("preserves the actual typed terminal received first with an honest incomplete restore head", async () => {
    const original = terminal(); await service.mirror(scope, flight([original]));
    expect((await rows("cloud_workspace_local_commands")).rows).toMatchObject([{ state: "failed", payload: null, result: original.entry!.result,
      writer_epoch: writerEpoch, user_message_id: "turn", agent_id: "cursor", history_incomplete_reason: "capture_unavailable" }]);
    expect((await rows("cloud_workspace_local_command_history_heads")).rows).toMatchObject([{ complete: false, incomplete_reason: "capture_unavailable" }]);
    const changed = { ...original, entry: { ...original.entry!, resultCode: "fixture_changed" }, revision: 2 };
    await expect(service.mirror(scope, flight([changed], 1))).rejects.toMatchObject({ code: "command_conflict" });
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.mirrored_sequence).toBe("1");
  });
  it.each(["fundingOwnerUserId", "fundingOwnerEpoch", "engineInstanceId", "generation"] as const)("rejects forged origin actor %s", async key => {
    const original = terminal(); original.actor!.scope[key] = (key === "generation" || key === "fundingOwnerEpoch" ? 2 : randomUUID()) as never;
    if (key === "fundingOwnerUserId") original.actor!.actor.userId = original.actor!.scope.fundingOwnerUserId;
    await expect(service.mirror(scope, flight([original]))).rejects.toMatchObject({ code: "command_conflict" });
    expect((await rows("cloud_workspace_local_commands")).rowCount).toBe(0);
  });
  it("publishes a complete transcript only after exact canonical records/manifest and command source validate", async () => {
    const original = terminal(); const record = { version: 1, conversationId: "chat", entityKind: "message", entityId: "message",
      schemaVersion: 1, sourceRevision: 4, document: { version: 1, chatId: "chat", msgId: "message", text: "Canonical fixture bytes" } };
    const manifest = { version: 1, snapshot: "full", scope: bootScope(), conversationId: "chat", restoreRevision: 1, deleted: false,
      tombstones: [], recordSequence: 4, eventSequence: 9, source: original.historyHead!.source,
      records: [{ entityKind: "message", entityId: "message", schemaVersion: 1, sourceRevision: 4, sha256: hash(record) }] };
    const history = { restoreRevision: 1, recordSequence: 4, eventSequence: 9, manifestSha256: hash(manifest) };
    const value = flight([change({ historyPart: part("record", record) }), change({ historyPart: part("manifest", manifest) }),
      { ...original, history, historyHead: { ...original.historyHead!, history } }]);
    await service.mirror(scope, value);
    expect((await rows("cloud_workspace_local_command_history_heads")).rows).toMatchObject([{ complete: true, manifest_sha256: Buffer.from(hash(manifest), "hex") }]);
    expect((await rows("cloud_workspace_local_command_history_blobs")).rowCount).toBe(2);
    expect((await rows("cloud_workspace_local_commands")).rows).toMatchObject([{ result: original.entry!.result, history_manifest_sha256: Buffer.from(hash(manifest), "hex") }]);
  });
  it("keeps complete receipt audit R separate from the adjacent command-owned interim R-1 and later verified complete R", async () => {
    const f = stagedTerminal(), pending: CloudLocalCommandMirrorChange = { ...f.original, entry: { ...f.original.entry!, state: "queued" as const,
      resultCode: null, executionId: null, payload: { agentId: "cursor", userMessageId: "turn", model: "fixture-model",
        modeRevision: 0, prompt: [{ type: "text", text: "Synthetic queue fixture" }] } },
      historyHead: { ...f.original.historyHead!, source: { ...f.original.historyHead!.source, executionId: null, nativeResultSha256: null } } };
    delete pending.history; delete pending.entry!.result;
    await service.mirror(scope, flight([pending]));
    const value = flight([f.receipt, f.interim], 1), ack = await service.mirror(scope, value);
    expect((await rows("cloud_workspace_local_commands")).rows).toMatchObject([{ result: f.original.entry!.result,
      history_restore_revision: "3", history_manifest_sha256: Buffer.from(hash(f.manifest), "hex") }]);
    expect((await rows("cloud_workspace_local_command_history_heads")).rows).toMatchObject([{ restore_revision: "2", complete: false,
      manifest_sha256: null, incomplete_reason: "capture_unavailable", source: f.original.historyHead!.source }]);
    expect(await service.mirror(scope, value)).toEqual(ack);
    const complete = flight([change({ revision: 2, historyPart: part("record", f.record) }),
      change({ revision: 2, historyPart: part("manifest", f.manifest) }),
      change({ revision: 2, historyHead: { ...f.original.historyHead!, history: f.history } })], value.through);
    await service.mirror(scope, complete);
    expect((await rows("cloud_workspace_local_command_history_heads")).rows).toMatchObject([{ restore_revision: "3", complete: true,
      manifest_sha256: Buffer.from(hash(f.manifest), "hex"), source: f.original.historyHead!.source }]);
    expect((await rows("cloud_workspace_local_commands")).rows).toMatchObject([{ result: f.original.entry!.result, history_restore_revision: "3" }]);
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.mirrored_sequence).toBe(String(complete.through));
    const changedAtSameRevision = change({ revision: 2, historyHead: { ...f.original.historyHead!, history: {
      restoreRevision: 3, recordSequence: 4, eventSequence: 9, incompleteReason: "capture_unavailable" } } });
    await expect(service.mirror(scope, flight([changedAtSameRevision], complete.through))).rejects.toThrow();
    expect((await rows("cloud_workspace_local_command_history_heads")).rows).toMatchObject([{ restore_revision: "3", complete: true }]);
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.mirrored_sequence).toBe(String(complete.through));
  });
  it.each(["missing", "nonadjacent", "revision", "record-watermark", "event-watermark", "conversation", "writer",
    "command", "intent-provider", "intent-turn", "execution", "native-result", "deleted", "reason", "paused", "control-revision"])("refuses an unpaired complete audit (%s) atomically", async kind => {
    const f = stagedTerminal();
    const head = f.interim.historyHead!, source = head.source;
    if (source.kind !== "command") throw new Error("fixture_source");
    if (kind === "revision") f.interim.historyHead!.history.restoreRevision = 4;
    if (kind === "record-watermark") f.interim.historyHead!.history.recordSequence = 5;
    if (kind === "event-watermark") f.interim.historyHead!.history.eventSequence = 10;
    if (kind === "conversation") f.interim.conversationId = "foreign";
    if (kind === "writer") head.originWriterEpoch = randomUUID();
    if (kind === "command") source.commandId = randomUUID();
    if (kind === "intent-provider") source.intent = { ...source.intent, agentId: "claude" };
    if (kind === "intent-turn") source.intent = { ...source.intent, userMessageId: "foreign" };
    if (kind === "execution") source.executionId = "foreign";
    if (kind === "native-result") source.nativeResultSha256 = "f".repeat(64);
    if (kind === "deleted") head.deleted = true;
    if (kind === "reason") head.history = { restoreRevision: 2, recordSequence: 4, eventSequence: 9, incompleteReason: "history_limit" };
    if (kind === "paused") f.interim.paused = true;
    if (kind === "control-revision") f.interim.revision = 3;
    const changes = kind === "missing" ? [f.receipt] : kind === "nonadjacent" ? [f.receipt, change({ revision: 2 }), f.interim] : [f.receipt, f.interim];
    await expect(service.mirror(scope, flight(changes))).rejects.toMatchObject({ code: "command_conflict" });
    expect((await rows("cloud_workspace_local_commands")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_history_heads")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_mirror_batches")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.mirrored_sequence).toBe("0");
  });
  it("rolls back terminal, controls, cursor and ACK when a complete reference lacks canonical bytes", async () => {
    const original = terminal(), history = { restoreRevision: 1, recordSequence: 4, eventSequence: 9, manifestSha256: "f".repeat(64) };
    await expect(service.mirror(scope, flight([{ ...original, history, historyHead: { ...original.historyHead!, history } }]))).rejects.toThrow();
    expect((await rows("cloud_workspace_local_commands")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_controls")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_mirror_batches")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_writers")).rows[0]!.mirrored_sequence).toBe("0");
  });
  it("commits exact quota feedback with the original receipt and replays it after capacity changes", async () => {
    const original = terminal(), record = { version: 1, conversationId: "chat", entityKind: "message", entityId: "message",
      schemaVersion: 1, sourceRevision: 4, document: { text: "Canonical quota fixture" } };
    const manifest = { version: 1, snapshot: "full", scope: bootScope(), conversationId: "chat", restoreRevision: 1, deleted: false,
      tombstones: [], recordSequence: 4, eventSequence: 9, source: original.historyHead!.source,
      records: [{ entityKind: "message", entityId: "message", schemaVersion: 1, sourceRevision: 4, sha256: hash(record) }] };
    const history = { restoreRevision: 1, recordSequence: 4, eventSequence: 9, manifestSha256: hash(manifest) };
    const value = flight([change({ historyPart: part("record", record) }), change({ historyPart: part("manifest", manifest) }),
      { ...original, history, historyHead: { ...original.historyHead!, history } }]);
    let capacityFull = true, inventoryReads = 0;
    // Only the checked capacity inventory is injected. Authorization, row
    // locking, projection, ACK storage and rollback use the real own-DB client;
    // this does not claim that this test writes 1GiB of physical content.
    const capacityPool = new Proxy(pool, { get(target, property) {
      if (property === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, key) {
          if (key === "query") return (sql: unknown, ...args: unknown[]) => {
            if (capacityFull && typeof sql === "string" && /sum\(octet_length\(data\)\)/.test(sql)) {
              inventoryReads++;
              return Promise.resolve({ rows: [{ bytes: String(HISTORY_WORKSPACE_BYTES) }], rowCount: 1 });
            }
            return Reflect.apply(connection.query, connection, [sql, ...args]);
          };
          const member = Reflect.get(connection, key);
          return typeof member === "function" ? member.bind(connection) : member;
        } });
      };
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    const capacityService = new DatabaseCloudWorkspaceCommandService({ pool: capacityPool });
    const ack = await capacityService.mirror(scope, value);
    expect(inventoryReads).toBeGreaterThan(0);
    expect(ack).toEqual({ version: 1, writerEpoch, batchId: value.batchId, through: 3,
      historyLimits: [{ conversationId: "chat", sha256: hash(record) }, { conversationId: "chat", sha256: hash(manifest) }] });
    expect((await rows("cloud_workspace_local_commands")).rows).toMatchObject([{ state: "failed", payload: null,
      result: original.entry!.result, history_manifest_sha256: Buffer.from(hash(manifest), "hex"), history_incomplete_reason: null }]);
    expect((await rows("cloud_workspace_local_command_history_heads")).rows).toMatchObject([{ complete: false,
      manifest_sha256: null, incomplete_reason: "history_limit", source: original.historyHead!.source }]);
    expect((await rows("cloud_workspace_local_command_history_blobs")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_mirror_batches")).rows).toMatchObject([{ ack }]);
    const previousReads = inventoryReads;
    capacityFull = false;
    expect(await capacityService.mirror(scope, value)).toEqual(ack);
    expect(await service.mirror(scope, value)).toEqual(ack);
    expect(inventoryReads).toBe(previousReads);
    expect((await rows("cloud_workspace_local_command_history_heads")).rows[0]!.complete).toBe(false);
  });
  it("refuses a receipt-only manifest digest without current-head evidence instead of deriving restore authority", async () => {
    const original = terminal(); delete original.historyHead;
    original.history = { restoreRevision: 1, recordSequence: 4, eventSequence: 9, manifestSha256: "f".repeat(64) };
    await expect(service.mirror(scope, flight([original]))).rejects.toMatchObject({ code: "command_conflict" });
    expect((await rows("cloud_workspace_local_commands")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_history_heads")).rowCount).toBe(0);
    expect((await rows("cloud_workspace_local_command_mirror_batches")).rowCount).toBe(0);
  });
  it("keeps permission and settlement cursors separate and refuses a missing original resolver", async () => {
    const original = terminal(), entry = { ...original.entry!, state: "dispatching" as const, resultCode: null, result: null,
      payload: { agentId: "cursor" as const, userMessageId: "turn", model: "fixture-model", prompt: [{ type: "text", text: "fixture-input" }], modeRevision: 0 } };
    const request = { version: 1 as const, eventSequence: 9, executionId: "execution", commandId: entry.commandId, turnId: "turn",
      frame: { id: "permission", type: "AGENT_PERMISSION_REQUEST" as const, source: "engine" as const, timestamp: 1, agentId: "cursor",
        cloudStream: { streamId: scope.engineInstanceId, sequence: 9 }, permissionId: "permission", request: { sessionId: "execution",
          toolCall: { toolCallId: "tool", title: "Read", rawInput: { path: "fixture" } }, options: [{ optionId: "once", name: "Allow", kind: "allow_once" as const }] } } };
    const running = { ...original, entry, event: request }; delete running.history; delete running.historyHead;
    await service.mirror(scope, flight([running]));
    const settled = { version: 1 as const, eventSequence: 10, executionId: "execution", commandId: entry.commandId, turnId: "turn",
      frame: { id: "settled", type: "AGENT_PERMISSION_SETTLED" as const, source: "engine" as const, timestamp: 2, agentId: "cursor",
        cloudStream: { streamId: scope.engineInstanceId, sequence: 10 }, permissionId: "permission", sessionId: "execution" } };
    await service.mirror(scope, flight([change({ revision: 2, event: settled })], 1));
    expect((await rows("cloud_workspace_local_agent_controls")).rows).toMatchObject([{ outbox_sequence: "1", local_sequence: "9" }, { outbox_sequence: "2", local_sequence: "10" }]);
    await expect(service.mirror(scope, flight([change({ revision: 3, event: { ...settled, eventSequence: 11,
      frame: { ...settled.frame, permissionId: "foreign", cloudStream: { streamId: scope.engineInstanceId, sequence: 11 } } } })], 2))).rejects.toThrow();
    expect((await rows("cloud_workspace_local_agent_controls")).rowCount).toBe(2);
  });
});
