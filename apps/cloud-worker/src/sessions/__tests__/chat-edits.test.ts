import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { CloudV2HistoryFrameSchema, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { SessionStore } from "../session-store";
import { HistoryMirror } from "../history-mirror";
import type { Transport } from "../../transport";

const workspace = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function store() {
  const directory = await mkdtemp(join(tmpdir(), "chat-edits-")); directories.push(directory);
  const opened = await SessionStore.open(directory, workspace);
  await opened.upsert({ id: "chat", folder: "/fixture", title: "Original", createdAt: 1, updatedAt: 5 });
  return { directory, store: opened };
}

it("applies a title and archive edit once per version, to an existing chat only, and keeps the applied version across reopen", async () => {
  const { directory, store: first } = await store();
  expect(await first.applyChatEdit({ chatId: "missing", version: "1", title: "Nope" })).toBe("unknown");
  expect(await first.applyChatEdit({ chatId: "chat", version: "2", title: "  Renamed  " })).toBe("applied");
  expect(first.metadata("chat")!.chat).toMatchObject({ title: "Renamed", archived: false, updatedAt: 5 });
  expect(await first.applyChatEdit({ chatId: "chat", version: "3", archived: true })).toBe("applied");
  expect(first.metadata("chat")!.chat).toMatchObject({ title: "Renamed", archived: true });
  expect(await first.applyChatEdit({ chatId: "chat", version: "3", title: "Replay must not apply" })).toBe("already");
  expect(await first.applyChatEdit({ chatId: "chat", version: "2", archived: false })).toBe("already");
  expect(first.metadata("chat")!.chat).toMatchObject({ title: "Renamed", archived: true });
  await first.flush();
  const reopened = await SessionStore.open(directory, workspace);
  expect(await reopened.applyChatEdit({ chatId: "chat", version: "3", archived: false })).toBe("already");
  expect(reopened.metadata("chat")!.chat).toMatchObject({ title: "Renamed", archived: true });
  expect(await reopened.applyChatEdit({ chatId: "chat", version: "10", archived: false })).toBe("applied");
  await reopened.delete("chat");
  expect(await reopened.applyChatEdit({ chatId: "chat", version: "11", title: "Deleted" })).toBe("unknown");
});

it("carries an acknowledgement in the same history frame as the edited chat row, also when acknowledging again", async () => {
  const { store: chats } = await store();
  const frames: CloudV2WorkerFrame[] = [];
  const transport = { send: async (frame: CloudV2WorkerFrame) => { frames.push(structuredClone(frame)); return true; } } as unknown as Transport;
  const mirror = new HistoryMirror(chats, transport, () => true);
  mirror.connect(); await mirror.flush(); frames.length = 0;
  await chats.applyChatEdit({ chatId: "chat", version: "4", title: "Edited" });
  mirror.acknowledgeChatEdit("chat", "4");
  await mirror.flush();
  // The store's own change may mirror the row first; the ack never travels without it.
  const acked = frames.filter(frame => frame.t === "history" && frame.chatEditAcks);
  expect(acked).toEqual([{ t: "history", chats: [expect.objectContaining({ id: "chat", title: "Edited" })], chatEditAcks: [{ chatId: "chat", version: "4" }] }]);
  expect(frames.at(-1)).toBe(acked[0]);
  for (const frame of frames) expect(CloudV2HistoryFrameSchema.safeParse(frame).success).toBe(true);
  frames.length = 0;
  mirror.acknowledgeChatEdit("chat", "4");
  mirror.acknowledgeChatEdit("missing", "1");
  await mirror.flush();
  expect(frames).toEqual([{ t: "history", chats: [expect.objectContaining({ id: "chat", title: "Edited" })], chatEditAcks: [{ chatId: "chat", version: "4" }] }]);
  frames.length = 0;
  mirror.disconnect();
  mirror.acknowledgeChatEdit("chat", "4");
  await mirror.flush();
  expect(frames).toEqual([]);
});
