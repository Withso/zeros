import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CodexEventMapper } from "../event-mapper";
import { CodexDriver } from "../driver";
import { streams } from "./fixtures/streams";
import { SessionStore } from "../../../sessions/session-store";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...await original<object>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.next).padStart(12, "0")}`,
}));

// Only this test imports the Local mapper. The path is intentionally resolved
// at test runtime so package typechecking does not pull in the Local engine.
const localMapperPath = fileURLToPath(new URL("../../../../../desktop/src/engine/agents/adapters/codex/app-server-translator.ts", import.meta.url));
const { CodexAppServerTranslator } = await import(localMapperPath);

describe("Codex native → canonical event parity", () => {
  it("persists a recovered VM image and edit sources through the real driver and history reload", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "zeros-worker-image-parity-")));
    const savedPath = join(directory, "sunset-poster.png");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4P9MFAAR3Ad0FpxN3AAAAAElFTkSuQmCC", "base64");
    const inputImages = [{ path: join(directory, "beach.jpg"), sha256: "a".repeat(64) }];
    await writeFile(savedPath, bytes);
    const frames = [
      { method: "item/completed", params: { item: { type: "imageGeneration", id: "generated-image", status: "completed", revisedPrompt: null, failure: null, fileId: "opaque-file", savedPath, inputImages } } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    ];
    ids.next = 0;
    const expected: SessionNotification[] = [];
    const local = new CodexAppServerTranslator({ sessionId: "execution", emit: (event: SessionNotification) => expected.push(event) });
    local.startTurn();
    for (const frame of frames) local.handle(frame.method, frame.params);
    await local.flushImageReads();
    ids.next = 0;
    const actual: SessionNotification[] = [];
    const driver = new CodexDriver({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))], environment: {} });
    driver.onEvent((event) => actual.push(event));
    try {
      await driver.open({ sessionId: "execution", cwd: directory, proxy: { baseUrl: "http://127.0.0.1:1/v1", token: "offline-placeholder" } });
      await expect(driver.prompt([{ type: "text", text: `fixture:${JSON.stringify(frames)}` }])).resolves.toMatchObject({ stopReason: "end_turn" });
      await expect.poll(() => actual).toEqual(JSON.parse(JSON.stringify(expected)));
      const store = await SessionStore.open(join(directory, "history"), "image-workspace");
      await store.upsert({ id: "chat", folder: "image-workspace", agentId: "codex" });
      for (const event of actual) await store.fold("chat", event);
      await store.flush();
      const reloaded = await SessionStore.open(join(directory, "history"), "image-workspace");
      const messages = reloaded.window("chat").messages.map((message) => JSON.parse(message.payload));
      expect(messages).toEqual([expect.objectContaining({ status: "completed", rawOutput: expect.objectContaining({ savedPath, inputImages }),
        content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: bytes.toString("base64") } }],
      })]);
    } finally { await driver.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  for (const fixture of streams) {
    it(fixture.name, () => {
      const run = (Mapper: typeof CodexEventMapper): { events: SessionNotification[]; result: unknown } => {
        ids.next = 0;
        const events: SessionNotification[] = [];
        const mapper = new Mapper({ sessionId: "execution", emit: (event) => events.push(event) });
        mapper.startTurn();
        mapper.handle("thread/started", { thread: { id: "native-chat" } });
        mapper.handle("turn/started", { turn: { id: "native-turn" } });
        for (const frame of fixture.frames) mapper.handle(frame.method, frame.params);
        return { events, result: { stopReason: mapper.stopReason, usage: mapper.turnUsage, error: mapper.terminalError } };
      };
      const local = run(CodexAppServerTranslator);
      expect(local.events.length).toBeGreaterThan(0);
      expect(run(CodexEventMapper)).toEqual(local);
    });

    it(`driver stream: ${fixture.name}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "zeros-worker-parity-"));
      ids.next = 0;
      const expected: SessionNotification[] = [];
      const local = new CodexAppServerTranslator({ sessionId: "execution", emit: (event: SessionNotification) => expected.push(event) });
      local.startTurn();
      local.handle("thread/started", { thread: { id: "native-chat" } });
      local.handle("turn/started", { turn: { id: "native-turn" } });
      for (const frame of fixture.frames) local.handle(frame.method, frame.params);
      ids.next = 0;
      const actual: SessionNotification[] = [];
      const driver = new CodexDriver({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))], environment: {} });
      driver.onEvent((event) => actual.push(event));
      try {
        await driver.open({ sessionId: "execution", cwd: process.cwd(), proxy: { baseUrl: "http://127.0.0.1:1/v1", token: "offline-placeholder" } });
        const result = await driver.prompt([{ type: "text", text: `fixture:${JSON.stringify(fixture.frames)}` }]).catch((error: unknown) => error);
        // Wire serialization omits undefined fields on both sides.
        await expect.poll(() => actual).toEqual(JSON.parse(JSON.stringify(expected)));
        if (local.terminalError) expect(result).toBeInstanceOf(Error);
        else expect(result).toMatchObject({ stopReason: local.stopReason });
        // Check the durable consumer too: authoritative replacements and late
        // terminal repairs must survive the same shared fold and disk reload.
        vi.spyOn(Date, "now").mockReturnValue(1000);
        let random = 0;
        vi.spyOn(Math, "random").mockImplementation(() => ++random / 1000);
        const wanted = expected.reduce<AgentMessage[]>((messages, event) => applyUpdate(messages, event), []);
        random = 0;
        const store = await SessionStore.open(directory, "parity-workspace");
        await store.upsert({ id: "chat", folder: "parity-workspace", agentId: "codex" });
        for (const event of actual) await store.fold("chat", event);
        await store.flush();
        const reloaded = await SessionStore.open(directory, "parity-workspace");
        expect(reloaded.window("chat").messages).toEqual(wanted.map((message) => ({
          msgId: message.id, kind: message.kind, payload: JSON.stringify(message), createdAt: message.createdAt,
        })));
      } finally { await driver.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
  }
});
