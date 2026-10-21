import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { CodexEventMapper } from "../event-mapper";
import { CodexDriver } from "../driver";
import { streams } from "./fixtures/streams";

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
      } finally { await driver.dispose(); }
    });
  }
});
