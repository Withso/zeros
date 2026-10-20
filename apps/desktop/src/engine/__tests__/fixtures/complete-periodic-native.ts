import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSqlite } from "../../db/sqlite";
import { runMigrations } from "../../db/migrations";
import { CloudLocalCommandQueue } from "../../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../../cloud-local-command-queue-events";
import { CloudLocalCommandActionStore } from "../../cloud-local-command-queue-actions";
import { CloudLocalCommandWriterLifecycle } from "../../cloud-local-command-queue-lifecycle";
import { CloudCredentialStartFences } from "../../cloud-local-command-queue-start-fences";
import { CloudActorAuthorityRegistry } from "../../agents/cloud-agent-lease";

/** Real current schemas. This is an idle local fixture, never native freeze
 * qualification. WAL byte copies below happen with no concurrently running IO. */
export function periodicNativeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "complete-native-"));
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 3,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const source = { organizationId: scope.organizationId, workspaceId: scope.workspaceId, generation: scope.generation,
    engineInstanceId: scope.engineInstanceId, writerEpoch: scope.writerEpoch,
    scopeRevision: 1, scopeSha256: "a".repeat(64), changeSequence: 1, reconcileSequence: 0 };
  const normalFile = path.join(directory, "normal.sqlite"), file = path.join(directory, "ledger.sqlite");
  const normal = openSqlite(normalFile);
  normal.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0");
  runMigrations(normal);
  const actorSessionId = randomUUID();
  const actor = { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1,
    role: "owner" as const, fingerprint: "b".repeat(64) };
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true });
  actors.confirm({ scope, actor, actorSessionId, authorityEpoch: 1, confirmedUntilMs: Date.now() + 9_000,
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" } });
  const queue = new CloudLocalCommandQueue({ file, scope, actors, engineLive: () => true, ready: () => true,
    history: () => ({ recordSequence: 1, eventSequence: events.head }) });
  const events = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true });
  const actionOptions = { file, queue, engineLive: () => true,
    authorize: (session: string, capability: "read" | "run") => actors.authorizeCurrent(session, capability) };
  const actions = new CloudLocalCommandActionStore(actionOptions);
  const lifecycle = new CloudLocalCommandWriterLifecycle({ file, queue, normalDb: () => normal,
    assertQuiescent: () => {}, heads: () => ({ recordSequence: 1, eventSequence: events.head }) });
  const fences = new CloudCredentialStartFences({ file, scope, engineLive: () => true,
    activity: () => ({ complete: true, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] }),
    retire: async () => {}, markDesired: () => {}, readyRevision: () => 1, synchronize: async () => {} });
  const ledger = openSqlite(file); ledger.exec("PRAGMA wal_autocheckpoint=0");
  const input = (prompt: string, conversationId = "chat") => {
    const snapshot = queue.handle({ kind: "snapshot", conversationId }, { writerEpoch: scope.writerEpoch, actorSessionId }) as { revision: number };
    const commandId = randomUUID(), userMessageId = randomUUID();
    queue.handle({ kind: "mutate", mutation: { conversationId, operationId: randomUUID(), expectedRevision: snapshot.revision,
      action: { kind: "enqueue", commandId, payload: { agentId: "claude", model: "fixture", modeRevision: 0,
        userMessageId, prompt: [{ type: "text", text: prompt }] } } }, admissionError: null },
    { writerEpoch: scope.writerEpoch, actorSessionId });
    return { commandId, userMessageId };
  };
  const stage = () => {
    const stagedDirectory = fs.mkdtempSync(path.join(directory, "staged-"));
    const files: { name: "ledger.sqlite" | "ledger.sqlite-wal" | "normal.sqlite" | "normal.sqlite-wal"; bytes: number; sha256: string }[] = [];
    for (const name of ["ledger.sqlite", "ledger.sqlite-wal", "normal.sqlite", "normal.sqlite-wal"] as const) {
      const original = path.join(directory, name);
      if (!fs.existsSync(original)) continue;
      const bytes = fs.readFileSync(original);
      fs.writeFileSync(path.join(stagedDirectory, name), bytes, { mode: 0o600, flag: "wx" });
      files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    return { stagedDirectory, files, source, cutAtMs: Date.now(), inventorySha256: "c".repeat(64) };
  };
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    fences.close(); lifecycle.close(); actions.close(); events.close(); queue.close(); ledger.close(); normal.close(); actors.dispose();
  };
  return { directory, source, scope, actorSessionId, actor, normal, ledger, queue, events, actions, lifecycle,
    actionOptions, input, stage, close, dispose: () => { close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
