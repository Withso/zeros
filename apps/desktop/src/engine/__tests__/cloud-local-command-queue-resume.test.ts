import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentBootScope, CloudAgentCredentialRunInfo } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudLocalCommandWriterLifecycle } from "../cloud-local-command-queue-lifecycle";
import { restoreCloudLocalCommandCheckpointLedger, verifiedCloudLocalCommandPredecessor,
  type CloudLocalCommandPredecessor } from "../cloud-local-command-queue-checkpoint";
import { CloudCredentialStartFences, type CloudAgentCredentialControlRequest } from "../cloud-local-command-queue-start-fences";
import { openSqlite } from "../db/sqlite";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const successor = (scope: CloudAgentBootScope): CloudAgentBootScope => ({ ...scope,
  engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID() });
function controls(file: string, scope: CloudAgentBootScope, predecessor?: CloudLocalCommandPredecessor | null,
  synchronize = async () => {}, limits: { maxOperations?: number; maxMutations?: number } = {},
  verifyPredecessor: typeof verifiedCloudLocalCommandPredecessor | null = verifiedCloudLocalCommandPredecessor) {
  const value = new CloudCredentialStartFences({ file, scope, predecessor, ...limits, engineLive: () => true,
    ...(verifyPredecessor ? { verifyPredecessor } : {}),
    activity: () => ({ complete: true, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] }),
    retire: async () => {}, markDesired: () => {}, readyRevision: () => 2, synchronize,
    associationFloor: () => ({ cacheRevision: 2, connectionRevision: 1 }) });
  cleanup.push(() => value.close()); return value;
}
function inventory(file: string) {
  const db = openSqlite(file, { readonly: true });
  try { return {
    fences: db.prepare("SELECT mutation_id,identity_sha256,selectors,fence_epoch,phase,desired_revision,proof_id FROM local_credential_start_fences ORDER BY mutation_id").all(),
    operations: db.prepare("SELECT request_id,request_sha256,acknowledgement,ack_bytes,ack_delivered FROM local_credential_control_operations ORDER BY request_id").all(),
    floors: db.prepare("SELECT mutation_id,provider,credential_id,cache_revision,connection_revision FROM local_credential_retirement_floors ORDER BY mutation_id,provider,credential_id").all(),
  }; } finally { db.close(); }
}
async function seal(file: string, scope: CloudAgentBootScope, root: string) {
  const registry = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanup.push(() => registry.dispose());
  const normal = openSqlite(path.join(path.dirname(file), "normal.sqlite"));
  cleanup.push(() => { if (normal.open) normal.close(); });
  normal.pragma("journal_mode = WAL"); normal.pragma("synchronous = NORMAL");
  normal.exec("CREATE TABLE IF NOT EXISTS sync_meta(id INTEGER PRIMARY KEY,next_rev INTEGER NOT NULL); INSERT OR IGNORE INTO sync_meta VALUES(0,8)");
  const queue = new CloudLocalCommandQueue({ file, scope, actors: registry, engineLive: () => true,
    ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) });
  cleanup.push(() => queue.close());
  const events = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true }); cleanup.push(() => events.close());
  const lifecycle = new CloudLocalCommandWriterLifecycle({ file, queue, normalDb: () => normal, assertQuiescent: () => {},
    heads: (source = normal) => ({ recordSequence: (source.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number }).rev,
      eventSequence: events.head }) });
  cleanup.push(() => lifecycle.close());
  await lifecycle.drainAndSeal({ mirror: { flush: async () => {} }, retireNative: async () => {}, waitForWork: async () => {},
    freezeNormal: () => normal.close(), request: async value => { const { scope: _scope, ...body } = value; return { ...body, writerEpoch: scope.writerEpoch }; } });
  await lifecycle.captureCheckpoint(root);
  lifecycle.close(); events.close(); queue.close();
}
async function fixture(legacy = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-resume-fences-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const file = path.join(directory, "queue.sqlite"), root = path.join(directory, "checkpoint");
  const run: CloudAgentCredentialRunInfo = { version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch, cacheRevision: 2,
    provider: "claude", fundingOwnerUserId: scope.fundingOwnerUserId, fundingOwnerEpoch: 1, credentialId: randomUUID(),
    credentialRevision: 1, connectionRevision: 1, adoptionId: randomUUID(), materialVersion: 1, displayName: "Synthetic account" };
  const request: CloudAgentCredentialControlRequest = { ...scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(),
    fenceEpoch: 1, selectors: [{ provider: run.provider, credentialId: run.credentialId }], operation: "pause-starts", desiredCacheRevision: null };
  const old = controls(file, scope);
  await old.handle(request);
  const retired = await old.handle({ ...request, controlRequestId: randomUUID(), operation: "retire" });
  const pending = await old.handle({ ...request, controlRequestId: randomUUID(), mutationId: randomUUID() });
  old.close();
  if (legacy) {
    const db = openSqlite(file);
    try {
      for (const table of ["local_credential_start_fences", "local_credential_control_operations", "local_credential_retirement_floors"]) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (columns.some(column => column.name === "writer_epoch")) {
          db.exec(`DROP INDEX IF EXISTS ${table}_writer; ALTER TABLE ${table} DROP COLUMN writer_epoch`);
        }
      }
      db.exec("DROP TABLE IF EXISTS local_credential_control_scopes");
    } finally { db.close(); }
  }
  await seal(file, scope, root);
  const before = inventory(file);
  const restored = await restoreCloudLocalCommandCheckpointLedger({ root, file, scope, expectedWriterEpoch: scope.writerEpoch });
  cleanup.push(restored.cleanup);
  return { directory, file, root, scope, run, request, retired, pending, before, predecessor: restored.predecessor };
}

describe("credential-control custody across verified writer replacement", () => {
  it.each([false, true])("preserves eight sealed handoffs and identifies an unsealed successor (interrupted=%s)", async interrupted => {
    const f = await fixture();
    let scope: CloudAgentBootScope = f.scope;
    let predecessor = f.predecessor;
    for (let cycle = 1; cycle <= 8; cycle++) {
      const next = successor(scope), current = controls(f.file, next, predecessor);
      const request = { ...f.request, ...next, mutationId: randomUUID(), controlRequestId: randomUUID() };
      const ack = await current.handle(request);
      current.confirmAcknowledgement(ack);
      current.close();
      await seal(f.file, next, f.root);
      const restored = await restoreCloudLocalCommandCheckpointLedger({
        root: f.root, file: f.file, scope: next, expectedWriterEpoch: next.writerEpoch,
      });
      cleanup.push(restored.cleanup);
      expect(restored.predecessor?.scope).toEqual(next);
      const retained = inventory(f.file);
      expect(retained.fences).toEqual(expect.arrayContaining(f.before.fences));
      expect(retained.operations).toEqual(expect.arrayContaining(f.before.operations));
      expect(retained.floors).toEqual(f.before.floors);
      scope = next; predecessor = restored.predecessor;
    }
    const db = openSqlite(f.file, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM local_command_writer_seals WHERE ack IS NOT NULL").get()).toEqual({ n: 9 });
      expect(db.prepare("SELECT count(*) AS n FROM local_credential_control_scopes WHERE retired=1").get()).toEqual({ n: 8 });
    } finally { db.close(); }
    if (interrupted) {
      const unsealed = successor(scope), current = controls(f.file, unsealed, predecessor);
      const ack = await current.handle({ ...f.request, ...unsealed, mutationId: randomUUID(), controlRequestId: randomUUID() });
      current.confirmAcknowledgement(ack); current.close();
      const actors = new CloudActorAuthorityRegistry({ scope: unsealed, engineLive: () => true });
      const queue = new CloudLocalCommandQueue({ file: f.file, scope: unsealed, actors,
        engineLive: () => true, ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) });
      // A provider stop retired this writer before drain/seal/capture. Its FULL
      // ledger must remain available for an explicitly authorized recovery.
      queue.close(); actors.dispose();
      const before = readFileSync(f.file), manifest = readFileSync(path.join(f.root, "manifest.json"));
      const retained = inventory(f.file);
      await expect(restoreCloudLocalCommandCheckpointLedger({
        root: f.root, file: f.file, scope: unsealed, expectedWriterEpoch: unsealed.writerEpoch,
      })).rejects.toMatchObject({ code: "checkpoint_expected_writer_mismatch" });
      expect(readFileSync(f.file)).toEqual(before);
      expect(readFileSync(path.join(f.root, "manifest.json"))).toEqual(manifest);
      expect(inventory(f.file)).toEqual(retained);
    }
  });

  it.each(["missing", "rejected"] as const)("refuses real predecessor custody when the injected verifier is %s", async mode => {
    const f = await fixture();
    const verifyPredecessor = mode === "missing" ? null : vi.fn<typeof verifiedCloudLocalCommandPredecessor>((receipt, file, db) => {
      expect(receipt).toBe(f.predecessor);
      expect(file).toBe(f.file);
      expect(db.inTransaction).toBe(true);
      return null;
    });
    expect(() => controls(f.file, successor(f.scope), f.predecessor, undefined, {}, verifyPredecessor))
      .toThrow("credential_control_authority_rejected");
    if (verifyPredecessor) expect(verifyPredecessor).toHaveBeenCalledOnce();
    expect(inventory(f.file)).toEqual(f.before);
    const db = openSqlite(f.file, { readonly: true });
    try {
      const stored = db.prepare("SELECT value FROM local_credential_control_metadata WHERE key='scope'").get() as { value: string };
      expect(JSON.parse(stored.value)).toEqual(f.scope);
    } finally { db.close(); }
  });

  it.each([false, true])("retains every original ACK/fence/floor while activating a fresh namespace (legacy=%s)", async legacy => {
    const f = await fixture(legacy), next = successor(f.scope), value = controls(f.file, next, f.predecessor);
    expect(inventory(f.file)).toEqual(f.before);
    expect(value.pendingAcknowledgement()).toBeNull();
    expect(value.canStart(f.run)).toBe(false);
    const admitted = { ...f.run, bootId: next.bootId, writerEpoch: next.writerEpoch };
    expect(value.canStart(admitted)).toBe(true);
    expect(() => value.confirmAcknowledgement(f.retired)).toThrow("credential_control_conflict");
    await expect(value.handle({ ...f.request, ...next })).rejects.toThrow("credential_control_conflict");
    await expect(value.handle({ ...f.request, ...next, controlRequestId: randomUUID() })).rejects.toThrow("credential_control_conflict");
    expect(inventory(f.file)).toEqual(f.before);
    const current = { ...f.request, ...next, mutationId: randomUUID(), controlRequestId: randomUUID() };
    const ack = await value.handle(current);
    expect(ack).toMatchObject({ writerEpoch: next.writerEpoch, controlRevision: 1, startsFenced: true });
    expect(value.canStart(admitted)).toBe(false);
    value.close();
    const reopened = controls(f.file, next);
    expect(reopened.pendingAcknowledgement()).toEqual(ack);
    expect(await reopened.handle(current)).toEqual(ack);
    expect(reopened.canStart(admitted)).toBe(false);
  });

  it.each(["missing", "structural-copy", "foreign-file", "source-not-authenticated", "replaced-inode"])(
    "rejects %s custody without changing old controls", async kind => {
      const f = await fixture(), next = successor(f.scope);
      let proof = f.predecessor, file = f.file;
      if (kind === "missing") proof = null;
      if (kind === "structural-copy") proof = structuredClone(f.predecessor);
      if (kind === "foreign-file") { file = path.join(f.directory, "copy.sqlite"); copyFileSync(f.file, file); }
      if (kind === "source-not-authenticated" || kind === "replaced-inode") {
        const restored = await restoreCloudLocalCommandCheckpointLedger({ root: f.root, file, scope: f.scope,
          ...(kind === "replaced-inode" ? { expectedWriterEpoch: f.scope.writerEpoch } : {}) });
        cleanup.push(restored.cleanup);
        if (kind === "source-not-authenticated") proof = restored.predecessor;
      }
      expect(() => controls(file, next, proof)).toThrow("credential_control_authority_rejected");
      expect(inventory(file)).toEqual(f.before);
    });

  it.each(["organization", "workspace", "generation", "engine", "writer"])(
    "refuses an invalid successor %s even with real predecessor custody", async kind => {
      const f = await fixture(), next = successor(f.scope);
      if (kind === "organization") next.organizationId = randomUUID();
      if (kind === "workspace") next.workspaceId = randomUUID();
      if (kind === "generation") next.generation--;
      if (kind === "engine") next.engineInstanceId = f.scope.engineInstanceId;
      if (kind === "writer") next.writerEpoch = f.scope.writerEpoch;
      expect(() => controls(f.file, next, f.predecessor)).toThrow("credential_control_authority_rejected");
      expect(inventory(f.file)).toEqual(f.before);
    });

  it("fences old handles and late ACK completion after the same-file publication", async () => {
    const f = await fixture();
    let resolve!: () => void;
    const wait = new Promise<void>(done => { resolve = done; }), entered = vi.fn();
    const old = controls(f.file, f.scope, null, async () => { entered(); await wait; });
    const late = old.handle({ ...f.request, mutationId: f.pending.mutationId, controlRequestId: randomUUID(),
      operation: "publish-desired", desiredCacheRevision: 2 });
    const failure = expect(late).rejects.toThrow("credential_control_authority_rejected");
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const next = controls(f.file, successor(f.scope), f.predecessor);
    const published = inventory(f.file);
    expect(() => old.pendingAcknowledgement()).toThrow("credential_control_authority_rejected");
    expect(() => old.confirmAcknowledgement(f.pending)).toThrow("credential_control_authority_rejected");
    resolve(); await failure;
    expect(inventory(f.file)).toEqual(published);
    expect(next.pendingAcknowledgement()).toBeNull();
  });

  it("refuses A to B to A even with a freshly verified B checkpoint", async () => {
    const f = await fixture(), scopeB = successor(f.scope), b = controls(f.file, scopeB, f.predecessor);
    b.close();
    const rootB = path.join(f.directory, "checkpoint-b");
    await seal(f.file, scopeB, rootB);
    const restored = await restoreCloudLocalCommandCheckpointLedger({ root: rootB, file: f.file, scope: scopeB, expectedWriterEpoch: scopeB.writerEpoch });
    cleanup.push(restored.cleanup);
    expect(() => controls(f.file, f.scope, restored.predecessor)).toThrow("credential_control_authority_rejected");
    expect(inventory(f.file)).toEqual(f.before);
  });

  it.each(["retired", "foreign"])("refuses a contradictory %s current-scope record", async kind => {
    const f = await fixture(), db = openSqlite(f.file);
    try {
      if (kind === "retired") db.prepare("UPDATE local_credential_control_scopes SET retired=1 WHERE writer_epoch=?").run(f.scope.writerEpoch);
      else db.prepare("UPDATE local_credential_control_scopes SET scope=? WHERE writer_epoch=?")
        .run(JSON.stringify({ ...f.scope, workspaceId: randomUUID() }), f.scope.writerEpoch);
    } finally { db.close(); }
    expect(() => controls(f.file, successor(f.scope), f.predecessor)).toThrow("credential_control_authority_rejected");
    expect(inventory(f.file)).toEqual(f.before);
  });

  it.each(["mixed-columns", "missing-history", "missing-current"])("refuses a partial %s migration", async kind => {
    const f = await fixture(), db = openSqlite(f.file);
    try {
      if (kind === "mixed-columns") db.exec(`DROP INDEX local_credential_start_fences_writer;
        ALTER TABLE local_credential_start_fences DROP COLUMN writer_epoch`);
      else if (kind === "missing-history") db.exec("DROP TABLE local_credential_control_scopes");
      else db.prepare("DELETE FROM local_credential_control_scopes WHERE writer_epoch=?").run(f.scope.writerEpoch);
    } finally { db.close(); }
    expect(() => controls(f.file, successor(f.scope), f.predecessor)).toThrow("credential_control_authority_rejected");
    expect(inventory(f.file)).toEqual(f.before);
  });

  it("rolls back a partial legacy handoff without losing rows or publishing the successor", async () => {
    const f = await fixture(true), db = openSqlite(f.file);
    try { db.exec(`CREATE TRIGGER reject_scope_publication AFTER UPDATE ON local_credential_control_metadata
      WHEN NEW.key='scope' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END`); }
    finally { db.close(); }
    expect(() => controls(f.file, successor(f.scope), f.predecessor)).toThrow("credential_control_storage_unavailable");
    expect(inventory(f.file)).toEqual(f.before);
    const check = openSqlite(f.file, { readonly: true });
    try {
      expect(check.prepare("SELECT name FROM pragma_table_info('local_credential_control_operations') WHERE name='writer_epoch'").get()).toBeUndefined();
      expect(check.prepare("SELECT value FROM local_credential_control_metadata WHERE key='scope'").get())
        .toEqual({ value: expect.any(String) });
      expect(JSON.parse((check.prepare("SELECT value FROM local_credential_control_metadata WHERE key='scope'").get() as { value: string }).value)).toEqual(f.scope);
    } finally { check.close(); }
    expect(controls(f.file, f.scope).pendingAcknowledgement()).not.toBeNull();
  });

  it("bounds the total retained epochs without pruning tombstones to admit another one", async () => {
    const f = await fixture(), db = openSqlite(f.file);
    try {
      db.transaction(() => {
        const insert = db.prepare("INSERT INTO local_credential_control_scopes(writer_epoch,scope,revision,retired) VALUES(?,?,?,1)");
        for (let index = 1; index < 4096; index++) {
          const old = successor(f.scope); insert.run(old.writerEpoch, JSON.stringify(old), "0");
        }
      })();
    } finally { db.close(); }
    expect(() => controls(f.file, successor(f.scope), f.predecessor)).toThrow("credential_control_limit");
    expect(inventory(f.file)).toEqual(f.before);
  });

  it.each(["operations", "mutations", "ack-bytes"])("counts retained predecessors against the total %s budget", async budget => {
    const f = await fixture(), next = successor(f.scope);
    if (budget === "ack-bytes") {
      const db = openSqlite(f.file);
      try { db.prepare("UPDATE local_credential_control_operations SET ack_bytes=? WHERE request_id=?")
        .run(32 * 1024 * 1024, f.request.controlRequestId); } finally { db.close(); }
    }
    const before = inventory(f.file);
    const current = controls(f.file, next, f.predecessor, undefined,
      budget === "operations" ? { maxOperations: 3 } : budget === "mutations" ? { maxMutations: 2 } : {});
    await expect(current.handle({ ...f.request, ...next, controlRequestId: randomUUID(), mutationId: randomUUID() }))
      .rejects.toThrow("credential_control_limit");
    expect(inventory(f.file)).toEqual(before);
  });
});
