import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { SessionStore } from "../session-store";
import { HistoryMirror } from "../history-mirror";
import { FakeRelay, WORKSPACE_KEY } from "../../__tests__/worker-fixtures";

it("an old failed send cannot disable history on a newer connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-history-"));
  const store = await SessionStore.open(directory, WORKSPACE_KEY);
  await store.upsert({ id: "chat", folder: WORKSPACE_KEY, title: "Before" });
  const relay = new FakeRelay(); relay.connected = true;
  let release!: (value: boolean) => void;
  let first = true;
  const original = relay.send.bind(relay);
  relay.send = async (frame: CloudV2WorkerFrame) => {
    if (first) { first = false; return new Promise<boolean>((resolve) => { release = resolve; }); }
    return original(frame);
  };
  const mirror = new HistoryMirror(store, relay);
  try {
    mirror.connect();
    await expect.poll(() => release).toBeDefined();
    mirror.disconnect(); mirror.connect();
    await store.upsert({ id: "chat", folder: WORKSPACE_KEY, title: "After" });
    release(false);
    await mirror.flush();
    expect(relay.frames.some((frame) => frame.t === "history" && frame.chats?.some((chat) => chat.title === "After"))).toBe(true);
  } finally { await mirror.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); }
});
