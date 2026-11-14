import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudV2HistoryDigestsReply, CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { SessionStore } from "../session-store";
import { HistoryMirror } from "../history-mirror";
import { FakeRelay, WORKSPACE_KEY } from "../../__tests__/worker-fixtures";

// A boot restored from a checkpoint owes the control plane one full replacement. The worker clears its restore
// marker only once that replacement was delivered on the current connection (a no-setup workspace has no other
// point that clears it); a lost connection keeps the obligation for the next one.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

class Relay extends FakeRelay {
  failAfter = Infinity;
  async historyDigests(): Promise<CloudV2HistoryDigestsReply> { return { chats: [] }; }
  override async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    if (frame.t === "history" && this.failAfter-- <= 0) { this.connected = false; return false; }
    return super.send(frame);
  }
}

async function setup(restored: boolean, chats = 3) {
  const directory = await mkdtemp(join(tmpdir(), "worker-restored-obligation-"));
  const store = await SessionStore.open(directory, WORKSPACE_KEY);
  for (let c = 0; c < chats; c++) await store.upsert({ id: `chat-${c}`, folder: WORKSPACE_KEY, title: `Chat ${c}` });
  const relay = new Relay(); relay.connected = true;
  const delivered = vi.fn();
  const mirror = new HistoryMirror(store, relay, () => true, value => value, { enabled: () => true, restored: () => restored, delivered });
  cleanups.push(async () => { await mirror.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  const replaced = () => relay.frames.filter(frame => frame.t === "history" && frame.messages?.replace).length;
  return { relay, mirror, delivered, replaced };
}

describe("a restored boot's replacement obligation", () => {
  it("is reported delivered once, after every replacement frame of the connection was sent", async () => {
    const f = await setup(true);
    f.mirror.connect(); await f.mirror.flush();
    expect(f.replaced()).toBe(3);
    expect(f.delivered).toHaveBeenCalledOnce();
    f.mirror.disconnect(); f.mirror.connect(); await f.mirror.flush();
    expect(f.delivered).toHaveBeenCalledOnce();
  });

  it("survives a connection lost mid-replacement: the next connection replaces everything again, then reports", async () => {
    const f = await setup(true);
    f.relay.failAfter = 2;
    f.mirror.connect(); await f.mirror.flush();
    expect(f.delivered).not.toHaveBeenCalled();
    f.relay.frames.length = 0; f.relay.failAfter = Infinity; f.relay.connected = true;
    f.mirror.connect(); await f.mirror.flush();
    expect(f.replaced()).toBe(3);
    expect(f.delivered).toHaveBeenCalledOnce();
  });

  it("an empty restored workspace is delivered at once; an ordinary boot never reports", async () => {
    const empty = await setup(true, 0);
    empty.mirror.connect(); await empty.mirror.flush();
    expect(empty.delivered).toHaveBeenCalledOnce();
    const ordinary = await setup(false);
    ordinary.mirror.connect(); await ordinary.mirror.flush();
    expect(ordinary.delivered).not.toHaveBeenCalled();
  });
});
