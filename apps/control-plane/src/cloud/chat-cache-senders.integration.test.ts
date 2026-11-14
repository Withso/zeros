import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { teamSharingFixture, type TeamSharingFixture } from "./team-sharing/test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("sender attribution in passive cloud cache reads", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => pool.end());
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;
  const row = (id: string, role = "user", text = id, extra: object = {}) => ({ msgId: id, kind: "text", createdAt: 1,
    payload: JSON.stringify({ id, role, text, senderUserId: f.viewer.id, ...extra }) });
  async function receipt(id = randomUUID()) {
    const response = await f.call(`${path()}/prompts`, "POST", { chatId: "chat", userMessageId: id,
      agentId: "codex", startedAt: 1, prompt: [{ type: "text", text: "Synthetic prompt" }] }, f.creator, false);
    expect(response.status).toBe(201);
    return id;
  }
  const mirror = (rows: ReturnType<typeof row>[]) => f.store.writeHistory(f.workspace.id, { chats: [{ id: "chat" }], messages: { chatId: "chat", rows } });
  async function read(op: string, params: object, sharing = true) {
    const response = await f.call(`${path()}/history`, "POST", { op, params }, sharing ? f.viewer : f.creator, sharing);
    expect(response.status).toBe(200);
    return (await response.json()).result;
  }

  it("returns only user-row senders and the separate turn opening, including known unknowns", async () => {
    const opening = await receipt(), assistant = await receipt(), steer = await receipt();
    await mirror([row(opening), row(assistant, "assistant"), row(steer, "user", steer, { steeredTurnId: opening }), row("unknown")]);
    const params = { chatId: "chat", fromIndex: 1, toIndex: 4 };
    const range = await read("messages.range", params);
    expect(range.rows.map((value: { msgId: string }) => value.msgId)).toEqual([assistant, steer, "unknown"]);
    expect(range.turnOpening).toEqual(row(opening));
    expect(range.senders).toEqual({ [opening]: { userId: f.creator.id }, [steer]: { userId: f.creator.id }, unknown: null });
    expect(await read("messages.range", params, false)).not.toHaveProperty("senders");
  });

  it("includes senders for delta user rows only and omits them on resync", async () => {
    const first = await receipt(), second = await receipt();
    await mirror([row(first)]);
    const base = await read("messages.range", { chatId: "chat", fromIndex: 0, toIndex: 1 });
    await mirror([row(second), row("unknown"), row("assistant", "assistant")]);
    const params = { chatId: "chat", revision: base.revision };
    const delta = await read("messages.since", params);
    expect(delta).toMatchObject({ resync: false, senders: { [second]: { userId: f.creator.id }, unknown: null } });
    expect(delta.senders).not.toHaveProperty(first);
    expect(await read("messages.since", params, false)).not.toHaveProperty("senders");
    const resync = await read("messages.since", { chatId: "chat", revision: delta.revision + 1 });
    expect(resync.resync).toBe(true);
    expect(resync).not.toHaveProperty("senders");
  });

  it.each(["range", "since"] as const)("refuses the entire %s reply after viewer membership is removed", async kind => {
    const id = await receipt();
    await mirror([row(id)]);
    const base = await f.store.messageRange(f.workspace.id, "chat", 0, 1);
    await mirror([row(id, "user", "Edited")]);
    const remove = () => pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    if (kind === "range") {
      const original = f.store.messageRange.bind(f.store);
      vi.spyOn(f.store, "messageRange").mockImplementationOnce(async (...args) => {
        const result = await original(...args); expect(result).toHaveProperty("senders"); await remove(); return result;
      });
    } else {
      const original = f.store.messageSince.bind(f.store);
      vi.spyOn(f.store, "messageSince").mockImplementationOnce(async (...args) => {
        const result = await original(...args); expect(result).toHaveProperty("senders"); await remove(); return result;
      });
    }
    const params = kind === "range" ? { chatId: "chat", fromIndex: 0, toIndex: 1 } : { chatId: "chat", revision: base.revision };
    const response = await f.call(`${path()}/history`, "POST", { op: `messages.${kind}`, params });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "Cloud workspace not found" } });
  });
});
