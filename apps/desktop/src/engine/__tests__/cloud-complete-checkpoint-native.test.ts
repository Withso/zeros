import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { periodicNativeFixture } from "./fixtures/complete-periodic-native";
import { openSqlite } from "../db/sqlite";
import { createMessage } from "@zeros/protocol/messages";
import { CloudBootCommandClaimSchema } from "@zeros/protocol/cloud-commands";
import { CloudActionReceiptSchema } from "@zeros/protocol/cloud-actions";
import { CloudLocalCommandActionStore } from "../cloud-local-command-queue-actions";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });
const modulePath = path.resolve(import.meta.dirname, "../cloud-complete-checkpoint-native.ts");
async function implementation() {
  expect(fs.existsSync(modulePath), "a periodic native exporter must exist without a final seal").toBe(true);
  return import("../cloud-complete-checkpoint-native");
}
function fixture() { const f = periodicNativeFixture(); cleanup.push(f.dispose); return f; }
const limits = { maxRows: 10_000, maxBytes: 16 * 1024 * 1024, maxRowBytes: 1024 * 1024 };
describe("dormant periodic native export", () => {
  it("recovers the staged NORMAL/FULL WAL pair including unfinished input without a final seal", async () => {
    const m = await implementation(), f = fixture();
    const accepted = f.input("private unfinished input");
    f.normal.prepare("INSERT INTO chats(id,title,folder) VALUES(?,?,?)").run("chat", "Private title", "/fixture");
    f.normal.prepare("INSERT INTO turns(chat_id,turn_id,ord,started_at,status,summary) VALUES(?,?,1,1,'running',?)")
      .run("chat", accepted.userMessageId, "incomplete user turn");
    f.normal.exec("UPDATE sync_meta SET next_rev=2 WHERE id=0");
    const staged = f.stage();
    f.input("later input");
    f.close(); fs.unlinkSync(path.join(f.directory, "normal.sqlite")); fs.unlinkSync(path.join(f.directory, "ledger.sqlite"));
    const result = m.exportPeriodicNative({ ...staged, targetDirectory: path.join(f.directory, "export"), limits, guard: () => {} });
    expect(result.kind).toBe("complete-periodic-native");
    expect(result.cutAtMs).toBe(staged.cutAtMs);
    expect(result.heads.recordSequence).toBe(1);
    const records = m.readPeriodicNative({ directory: path.join(f.directory, "export"), expected: result, guard: () => {} });
    const command = records.find(row => row.database === "ledger" && row.table === "local_commands")!;
    expect(JSON.stringify(command)).toContain("private unfinished input");
    expect(JSON.stringify(records)).not.toContain("later input");
    expect(command.values).toMatchObject({ state: "queued", actor: f.actor });
    expect(command.values).not.toHaveProperty("claim_id");
    expect(command.values).not.toHaveProperty("credential_run_info");
    expect(JSON.stringify(records)).not.toContain(f.actorSessionId);
    expect(records.some(row => row.table === "turns" && row.values.status === "running")).toBe(true);
    const restored = path.join(f.directory, "inert.sqlite");
    m.restorePeriodicNativeOracle({ directory: path.join(f.directory, "export"), expected: result, destination: restored, guard: () => {} });
    const db = openSqlite(restored, { readonly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all())
        .toEqual([{ name: "periodic_data" }, { name: "periodic_origin" }]);
      expect(db.prepare("SELECT count(*) AS n FROM periodic_data").get()).toEqual({ n: records.length });
    } finally { db.close(); }
  });
  it.each(["unknown_table", "extra_column", "unknown_record", "wrong_writer", "future_head", "active_seal"] as const)(
    "refuses %s without publishing a partial export", async fault => {
      const m = await implementation(), f = fixture(); f.input("retained");
      if (fault === "unknown_table") f.normal.exec("CREATE TABLE unknown_data(value TEXT); INSERT INTO unknown_data VALUES('private')");
      if (fault === "extra_column") f.ledger.exec("ALTER TABLE local_commands ADD COLUMN unknown_data TEXT");
      if (fault === "unknown_record") f.ledger.exec("INSERT INTO local_command_metadata VALUES('unknown_kind','private')");
      if (fault === "wrong_writer") f.source.writerEpoch = randomUUID();
      if (fault === "future_head") f.ledger.prepare("UPDATE local_commands SET history=?").run(JSON.stringify({ recordSequence: 999, eventSequence: 0 }));
      if (fault === "active_seal") f.ledger.prepare("INSERT INTO local_command_metadata VALUES('sealedWriter',?)").run(f.scope.writerEpoch);
      const targetDirectory = path.join(f.directory, "export");
      expect(() => m.exportPeriodicNative({ ...f.stage(), targetDirectory, limits, guard: () => {} })).toThrow("complete native export refused");
      expect(fs.existsSync(path.join(targetDirectory, "manifest.json"))).toBe(false);
    });
  it("refuses an unlisted WAL or corrupt immutable pair instead of reading mutable originals", async () => {
    const m = await implementation(), f = fixture(); f.input("kept"); const staged = f.stage();
    staged.files = staged.files.filter(file => file.name !== "ledger.sqlite-wal");
    expect(() => m.exportPeriodicNative({ ...staged, targetDirectory: path.join(f.directory, "export"), limits, guard: () => {} })).toThrow("complete native export refused");
  });
  it("keeps incomplete NORMAL transactions out and committed FULL pending input in the cut", async () => {
    const m = await implementation(), f = fixture(); f.input("FULL committed");
    f.normal.exec("BEGIN IMMEDIATE");
    f.normal.prepare("INSERT INTO chats(id,title) VALUES('uncommitted',?)").run("not committed");
    const staged = f.stage(); f.normal.exec("ROLLBACK");
    const result = m.exportPeriodicNative({ ...staged, targetDirectory: path.join(f.directory, "export"), limits, guard: () => {} });
    const records = m.readPeriodicNative({ directory: path.join(f.directory, "export"), expected: result, guard: () => {} });
    expect(JSON.stringify(records)).toContain("FULL committed");
    expect(JSON.stringify(records)).not.toContain("not committed");
  });
  it("does not accept corrupted exported bytes, wrong source or extra entries on restore", async () => {
    const m = await implementation(), f = fixture(); f.input("private");
    const directory = path.join(f.directory, "export");
    const result = m.exportPeriodicNative({ ...f.stage(), targetDirectory: directory, limits, guard: () => {} });
    expect(() => m.readPeriodicNative({ directory, expected: { ...result, source: { ...result.source, workspaceId: randomUUID() } }, guard: () => {} })).toThrow();
    fs.appendFileSync(path.join(directory, "records.jsonl"), "extra\n");
    expect(() => m.readPeriodicNative({ directory, expected: result, guard: () => {} })).toThrow();
    expect(result.recordsSha256).not.toBe(createHash("sha256").update(fs.readFileSync(path.join(directory, "records.jsonl"))).digest("hex"));
  });
  it("honors an original guard after output fsync and never replaces an existing export", async () => {
    const m = await implementation(), f = fixture(); f.input("kept");
    const staged = f.stage(), targetDirectory = path.join(f.directory, "export");
    expect(() => m.exportPeriodicNative({ ...staged, targetDirectory, limits, guard: () => {
      if (fs.existsSync(path.join(targetDirectory, "manifest.json"))) throw new Error("closed deadline");
    } })).toThrow("complete native export refused");
    expect(fs.existsSync(path.join(targetDirectory, "manifest.json"))).toBe(false);
    expect(() => m.exportPeriodicNative({ ...staged, targetDirectory, limits, guard: () => {} })).toThrow();
  });
  it("refuses explicit work limits instead of dropping rows or privately authored secrets", async () => {
    const m = await implementation(), f = fixture(); f.input("secret authored by the user");
    expect(() => m.exportPeriodicNative({ ...f.stage(), targetDirectory: path.join(f.directory, "export"), limits: { ...limits, maxRows: 1 }, guard: () => {} })).toThrow();
  });
  it.each(["unknown_event", "unknown_managed_record"] as const)("refuses %s rather than discarding mixed user data", async fault => {
    const m = await implementation(), f = fixture(); f.input("kept");
    if (fault === "unknown_event") f.ledger.prepare("INSERT INTO local_command_events VALUES(?,1,?,20)")
      .run(f.scope.engineInstanceId, JSON.stringify({ type: "UNKNOWN_USER_DATA", content: "unique private bytes" }));
    if (fault === "unknown_managed_record") f.ledger.exec("INSERT INTO local_credential_control_metadata VALUES('unknown_user_data','unique private bytes')");
    expect(() => m.exportPeriodicNative({ ...f.stage(), targetDirectory: path.join(f.directory, "export"), limits, guard: () => {} }))
      .toThrow("complete native export refused");
  });
  it("refuses an in-flight action whose durable receipt lacks its user payload", async () => {
    const m = await implementation(), f = fixture(); f.input("kept");
    await f.actions.request({ kind: "begin", admissible: true, action: { kind: "question", operationId: randomUUID(),
      conversationId: "chat", executionId: "execution", requestId: "question", payload: { response: { outcome: { outcome: "declined" } } } } }, f.actorSessionId);
    expect(() => m.exportPeriodicNative({ ...f.stage(), targetDirectory: path.join(f.directory, "export"), limits, guard: () => {} }))
      .toThrow("complete native export refused");
  });
  it.each(["extra_authority", "missing_column", "invalid_cell", "missing_coverage", "duplicate_coverage", "wrong_coverage", "missing_input", "duplicate_json_key"] as const)(
    "refuses a rehashed %s export on the source-independent reader", async fault => {
      const m = await implementation(), f = fixture(); f.input("preserved payload");
      const directory = path.join(f.directory, "export");
      const result = m.exportPeriodicNative({ ...f.stage(), targetDirectory: directory, limits, guard: () => {} });
      const entries = m.readPeriodicNative({ directory, expected: result, guard: () => {} });
      const command = entries.find(row => row.table === "local_commands")!;
      if (fault === "extra_authority") command.values.claim_id = randomUUID();
      if (fault === "missing_column") delete command.values.payload;
      if (fault === "invalid_cell") command.values.created_at = { futureCell: "unmapped" };
      if (fault === "missing_coverage") result.coverage = result.coverage.filter(row => row.table !== "local_commands");
      if (fault === "duplicate_coverage") result.coverage.push(result.coverage[0]!);
      if (fault === "wrong_coverage") result.coverage.find(row => row.table === "local_commands")!.rows += 1;
      if (fault === "missing_input") result.files = result.files.filter(file => file.name !== "ledger.sqlite");
      let records = entries.map(row => JSON.stringify(row)).join("\n") + "\n";
      if (fault === "duplicate_json_key") records = records.replace('"database":"normal"', '"database":"ledger","database":"normal"');
      fs.writeFileSync(path.join(directory, "records.jsonl"), records);
      result.recordsBytes = Buffer.byteLength(records);
      result.recordsSha256 = createHash("sha256").update(records).digest("hex");
      const { manifestSha256: _oldDigest, ...document } = result;
      const bytes = JSON.stringify(document);
      fs.writeFileSync(path.join(directory, "manifest.json"), bytes);
      result.manifestSha256 = createHash("sha256").update(bytes).digest("hex");
      f.close();
      expect(() => m.readPeriodicNative({ directory, expected: result, guard: () => {} }))
        .toThrow("complete native export refused");
    });
  it("keeps a genuinely dispatched turn and its private replay/control prefix inert", async () => {
    const m = await implementation(), f = fixture(); f.input("active private input");
    const claim = CloudBootCommandClaimSchema.parse(f.queue.handle({ kind: "claim", conversationId: "chat", executionId: "native-fixture" },
      { writerEpoch: f.scope.writerEpoch }));
    const permissionId = randomUUID(); f.events.bindControlOwner(permissionId, "permission", claim);
    const frames = [createMessage({ type: "AGENT_SESSION_UPDATE", source: "engine", agentId: "claude", chatId: "chat",
      notification: { sessionId: claim.executionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "private unfinished delta" } } } }),
    createMessage({ type: "AGENT_PERMISSION_REQUEST", source: "engine", agentId: "claude", chatId: "chat", permissionId,
      request: { sessionId: claim.executionId, toolCall: { toolCallId: "tool", title: "Read private work", kind: "read" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } })];
    for (const frame of frames) f.events.append({ ...frame, cloudStream: { streamId: f.scope.engineInstanceId, sequence: f.events.head + 1 } });
    const directory = path.join(f.directory, "export");
    const result = m.exportPeriodicNative({ ...f.stage(), targetDirectory: directory, limits, guard: () => {} });
    const rows = m.readPeriodicNative({ directory, expected: result, guard: () => {} });
    expect(result.heads.eventSequence).toBe(2);
    expect(rows.find(row => row.table === "local_commands")!.values.state).toBe("dispatching");
    expect(JSON.stringify(rows)).toContain("private unfinished delta");
    expect(rows.filter(row => row.table === "local_command_compact_controls")).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(claim.executionId);
    expect(JSON.stringify(rows)).not.toContain(claim.claimId);
    expect(JSON.stringify(rows)).not.toContain(f.actorSessionId);
    expect(f.queue.accepting).toBe(true);
  });
  it("preserves an original uncommitted accepted-work reservation without its capability", async () => {
    const m = await implementation(), f = fixture();
    const commandId = randomUUID();
    f.queue.acceptedWork.reserve({ actorSessionId: f.actorSessionId, cwd: "/fixture", executionId: "reservation-execution",
      capabilityId: "fixture-platform-authority", kid: "cap-fixture", capabilityExpiresAtMs: Date.now() + 5000,
      mutation: { conversationId: "reserved", operationId: randomUUID(), expectedRevision: 0, action: { kind: "enqueue", commandId,
        payload: { agentId: "claude", model: "fixture", modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text", text: "reserved private input" }] } } } });
    const directory = path.join(f.directory, "export");
    const result = m.exportPeriodicNative({ ...f.stage(), targetDirectory: directory, limits, guard: () => {} });
    const rows = m.readPeriodicNative({ directory, expected: result, guard: () => {} });
    const row = rows.find(row => row.table === "local_accepted_work")!;
    expect(row.values.state).toBe("reserved");
    expect(JSON.stringify(row)).toContain("reserved private input");
    expect(JSON.stringify(row)).not.toContain("fixture-platform-authority");
    expect(JSON.stringify(row)).not.toContain("reservation-execution");
    expect(JSON.stringify(row)).not.toContain(f.actorSessionId);
  });
  it("refuses a reopened uncertain action instead of claiming its absent payload was captured", async () => {
    const m = await implementation(), f = fixture(); f.input("kept");
    await f.actions.request({ kind: "begin", admissible: true, action: { kind: "question", operationId: randomUUID(),
      conversationId: "chat", executionId: "execution", requestId: "question", payload: { response: { outcome: { outcome: "declined" } } } } }, f.actorSessionId);
    f.actions.close(); const reopened = new CloudLocalCommandActionStore(f.actionOptions); cleanup.push(() => reopened.close());
    expect(f.ledger.prepare("SELECT state FROM local_command_actions").get()).toEqual({ state: "uncertain" });
    expect(() => m.exportPeriodicNative({ ...f.stage(), targetDirectory: path.join(f.directory, "export"), limits, guard: () => {} }))
      .toThrow("complete native export refused");
  });
  it("preserves an exactly settled action as attribution without live claim authority", async () => {
    const m = await implementation(), f = fixture(); f.input("kept");
    const receipt = CloudActionReceiptSchema.parse(await f.actions.request({ kind: "begin", admissible: true,
      action: { kind: "question", operationId: randomUUID(), conversationId: "chat", executionId: "execution", requestId: "question",
        payload: { response: { outcome: { outcome: "declined" } } } } }, f.actorSessionId));
    await f.actions.request({ kind: "settle", operationId: receipt.operationId, claimId: receipt.claimId, outcome: "delivered", turnId: null });
    const directory = path.join(f.directory, "export");
    const result = m.exportPeriodicNative({ ...f.stage(), targetDirectory: directory, limits, guard: () => {} });
    const rows = m.readPeriodicNative({ directory, expected: result, guard: () => {} });
    expect(rows.find(row => row.table === "local_command_actions")!.values).toMatchObject({ state: "settled", outcome: "delivered", actor: f.actor });
    expect(JSON.stringify(rows)).not.toContain(receipt.claimId);
  });
  it("attempts every original descriptor close after an earlier close reports uncertainty", async () => {
    const m = await implementation(), f = fixture(); f.input("retained");
    const staged = f.stage(), close = fs.closeSync;
    const before = new Set(fs.readdirSync("/proc/self/fd"));
    let injected = false;
    vi.spyOn(fs, "closeSync").mockImplementation(fd => {
      let file = ""; try { file = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* Already closed. */ }
      close(fd);
      if (!injected && file.startsWith(staged.stagedDirectory + "/")) {
        injected = true; throw new Error("uncertain close fixture");
      }
    });
    let failure: unknown;
    try { m.exportPeriodicNative({ ...staged, targetDirectory: path.join(f.directory, "export"), limits, guard: () => {} }); }
    catch (error) { failure = error; }
    finally { vi.restoreAllMocks(); }
    expect(injected).toBe(true);
    const leaked = fs.readdirSync("/proc/self/fd").filter(fd => !before.has(fd) && (() => {
      try { return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(f.directory + "/"); } catch { return false; }
    })());
    try { expect(failure).toEqual(new Error("complete native export refused")); expect(leaked).toEqual([]); }
    finally { for (const fd of leaked) close(Number(fd)); }
  });
});
