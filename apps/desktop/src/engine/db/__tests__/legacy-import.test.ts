import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeZerosDb, setZerosDbPathForTesting } from "../index";
import { listChats, upsertChat, type ChatRow } from "../chats";
import { windowChatMessages } from "../messages";
import { migrateLegacyAgentHistory } from "../legacy-import";

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-legacy-"));
  return path.join(dir, name);
}

/** Build a fixture matching the legacy electron/db.ts schema (chats + agent_messages). */
function makeLegacyDb(): string {
  const file = tmpFile("zeros-agent-history.db");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE chats (id TEXT PRIMARY KEY, folder TEXT, agent_id TEXT, agent_name TEXT,
      model TEXT, effort TEXT, permission_mode TEXT, title TEXT, created_at INTEGER,
      updated_at INTEGER, session_id TEXT, pinned INTEGER, archived INTEGER,
      source_chat_id TEXT, kind TEXT);
    CREATE TABLE agent_messages (chat_id TEXT, ord INTEGER, msg_id TEXT, kind TEXT,
      payload TEXT, created_at INTEGER, PRIMARY KEY (chat_id, ord));
  `);
  db.prepare(
    "INSERT INTO chats (id, folder, title, created_at, updated_at, pinned, archived) VALUES (?,?,?,?,?,?,?)",
  ).run("legacy1", "/p", "Legacy One", 1, 2, 0, 0);
  const ins = db.prepare(
    "INSERT INTO agent_messages (chat_id, ord, msg_id, kind, payload, created_at) VALUES (?,?,?,?,?,?)",
  );
  ins.run(
    "legacy1",
    1,
    "m1",
    "text",
    JSON.stringify({
      id: "m1",
      kind: "text",
      role: "user",
      text: "hi from legacy",
    }),
    1,
  );
  ins.run(
    "legacy1",
    2,
    "m2",
    "text",
    JSON.stringify({ id: "m2", kind: "text", role: "agent", text: "reply" }),
    2,
  );
  db.close();
  return file;
}

function chat(id: string, over: Partial<ChatRow> = {}): ChatRow {
  return {
    id,
    folder: "/p",
    agentId: null,
    agentName: null,
    model: null,
    effort: "",
    permissionMode: "",
    lastModeId: null,
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    nativeSessionId: null,
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: "chat",
    ...over,
  };
}

describe("legacy agent-history migration", () => {
  afterEach(() => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
    delete process.env.ZEROS_LEGACY_AGENT_DB;
  });

  it("imports legacy chats + messages into the engine DB, idempotently", () => {
    const legacy = makeLegacyDb();
    setZerosDbPathForTesting(tmpFile("zeros.db"));
    process.env.ZEROS_LEGACY_AGENT_DB = legacy;

    migrateLegacyAgentHistory();
    expect(listChats().map((c) => c.id)).toEqual(["legacy1"]);
    expect(windowChatMessages("legacy1", 100).map((m) => m.msgId)).toEqual([
      "m1",
      "m2",
    ]);

    // Second run is a no-op (flag set) — counts unchanged.
    migrateLegacyAgentHistory();
    expect(listChats().length).toBe(1);
    expect(windowChatMessages("legacy1", 100).length).toBe(2);
  });

  it("INSERT-if-absent: never clobbers a chat the engine already has", () => {
    const legacy = makeLegacyDb();
    setZerosDbPathForTesting(tmpFile("zeros.db"));
    process.env.ZEROS_LEGACY_AGENT_DB = legacy;
    upsertChat(chat("legacy1", { title: "Newer Engine Title", updatedAt: 99 }));

    migrateLegacyAgentHistory();
    expect(listChats().find((c) => c.id === "legacy1")!.title).toBe(
      "Newer Engine Title",
    );
  });

  it("no-ops when ZEROS_LEGACY_AGENT_DB is unset", () => {
    setZerosDbPathForTesting(tmpFile("zeros.db"));
    migrateLegacyAgentHistory();
    expect(listChats()).toEqual([]);
  });

  it("no-op (and marks done) when the legacy file has no chats table", () => {
    const empty = tmpFile("zeros-agent-history.db");
    new Database(empty).close(); // exists but empty
    setZerosDbPathForTesting(tmpFile("zeros.db"));
    process.env.ZEROS_LEGACY_AGENT_DB = empty;
    expect(() => migrateLegacyAgentHistory()).not.toThrow();
    expect(listChats()).toEqual([]);
  });
});
