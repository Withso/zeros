import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { teamSharingFixture, type TeamSharingFixture } from "./team-sharing/test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const digest = "a".repeat(64);
const row = (id: string, text = id) => ({ msgId: id, kind: "text", createdAt: 1,
  payload: JSON.stringify({ id, role: "user", text }) });

suite("chat cache revisions alongside worker history digests", () => {
  let pool: pg.Pool, f: TeamSharingFixture, token: string, boot: string, sequence: number;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    f = await teamSharingFixture(pool);
    await f.store.transition(f.workspace.id, ["stopped"], "starting");
    token = await f.store.rotateWorkerToken(f.workspace.id);
    boot = randomUUID(); sequence = 0;
    expect(await f.store.acceptWorkerHello(token, boot)).not.toBeNull();
    expect(await f.store.chatEdits.advertise(token, boot, true)).toBe(true);
  });
  const write = (input: Parameters<TeamSharingFixture["store"]["writeWorkerHistory"]>[3]) =>
    f.store.writeWorkerHistory(token, boot, ++sequence, input, true);
  const stamp = async () => {
    await write({ chats: [{ id: "chat", title: "Original title" }] });
    await write({ messages: { chatId: "chat", replace: true, historyState: { revision: 0 }, rows: [row("m0"), row("m1")] } });
    await write({ messages: { chatId: "chat", rows: [], digest } });
  };
  const metadata = async () => (await pool.query(`SELECT history_digest,history_replacement_boot_id,
    history_replacement_sequence::text,history_replacement_started FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id='chat'`,
  [f.workspace.id])).rows[0];
  const range = () => f.store.messageRange(f.workspace.id, "chat", 0, 500);
  const read = async (op: string, params: object = {}) => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/history`, "POST", { op, params });
    expect(response.status).toBe(200);
    return (await response.json()).result;
  };

  it("keeps replacement markers and digests across passive reads, and stamps without advancing the cache revision", async () => {
    await write({ chats: [{ id: "chat" }] });
    await write({ messages: { chatId: "chat", replace: true, historyState: { revision: 0 }, rows: [row("m0")] } });
    const before = await range(), pending = await metadata();
    expect(pending).toMatchObject({ history_digest: null, history_replacement_boot_id: boot,
      history_replacement_sequence: "2", history_replacement_started: true });
    f.fetcher.mockClear();
    f.unavailable.add(f.viewer.id); f.unavailable.add(f.creator.id);
    expect(await read("messages.range", { chatId: "chat", fromIndex: 0, toIndex: 500 })).toEqual(before);
    expect(await read("messages.since", { chatId: "chat", revision: before.revision }))
      .toMatchObject({ resync: false, revision: before.revision, rows: [] });
    expect((await read("chats.list")).chats).toEqual([{ id: "chat", historyState: { revision: 0 },
      historyCache: { revision: before.revision, messageCount: 1 } }]);
    expect(await metadata()).toEqual(pending);
    await write({ messages: { chatId: "chat", rows: [], digest } });
    expect(await metadata()).toEqual({ history_digest: digest, history_replacement_boot_id: null,
      history_replacement_sequence: null, history_replacement_started: null });
    expect(await range()).toEqual(before);
    await read("messages.range", { chatId: "chat", fromIndex: 0, toIndex: 500 });
    await read("messages.since", { chatId: "chat", revision: before.revision });
    await read("chats.list");
    expect(await f.store.workerHistoryDigests(token, boot)).toEqual({ chats: [{ chatId: "chat", digest }] });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("clears the worker digest and advances the cache once for a same-count N-1 message edit", async () => {
    await stamp();
    const before = await range();
    await pool.query("UPDATE cloud_v2_messages SET payload=$2 WHERE workspace_id=$1 AND chat_id='chat' AND msg_id='m0'",
      [f.workspace.id, row("m0", "Updated").payload]);
    expect((await metadata()).history_digest).toBeNull();
    expect(await f.store.messageSince(f.workspace.id, "chat", before.revision)).toMatchObject({
      resync: false, revision: before.revision + 1, messageCount: 2, rows: [{ index: 0, ...row("m0", "Updated") }],
    });
  });

  it("keeps the transcript cache valid after a title edit while invalidating the worker digest", async () => {
    await stamp();
    const before = await range();
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/chats/chat/edit`, "POST", { title: "Edited title" }, f.admin);
    expect(response.status).toBe(200);
    expect((await metadata()).history_digest).toBeNull();
    expect(await range()).toEqual(before);
    expect((await read("chats.list")).chats[0]).toMatchObject({ title: "Edited title",
      historyCache: { revision: before.revision, messageCount: 2 } });
  });
});
