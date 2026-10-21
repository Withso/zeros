import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { ClaudeDriver } from "../driver";
import { ClaudeStreamTranslator } from "../translator";
import { SessionStore } from "../../../sessions/session-store";
import { streams } from "./fixtures/streams";
import { input, text } from "./fake-query";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<object>(), randomUUID: () => `00000000-0000-4000-8000-${String(++ids.next).padStart(12, "0")}` }));
const localPath = fileURLToPath(new URL("../../../../../desktop/src/engine/agents/adapters/claude/translator.ts", import.meta.url));
const { ClaudeStreamTranslator: LocalTranslator } = await import(localPath);

for (const fixture of streams) it(`native SDK → driver → persisted rows: ${fixture.name}`, async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const expected: SessionNotification[] = [];
  ids.next = 0;
  const local: ClaudeStreamTranslator = new LocalTranslator({ sessionId: input.sessionId, streamPartials: true, emit: (event: SessionNotification) => expected.push(event) });
  local.beginProcess(); ids.next++; // The driver's outbound user UUID precedes beginTurn.
  local.beginTurn();
  let terminal: { error: string | null; stopReason: string; usage: unknown } | undefined;
  for (const frame of fixture.frames) {
    local.feed(frame);
    if (!terminal && frame.type === "result" && frame.user_message_uuid === "@input") terminal = { error: local.terminalError, stopReason: local.stopReason, usage: local.turnUsage };
  }
  const directory = await mkdtemp(join(tmpdir(), "zeros-claude-parity-"));
  const actual: SessionNotification[] = []; ids.next = 0;
  const driver = new ClaudeDriver({ executable: fileURLToPath(new URL("./fixtures/cli.mjs", import.meta.url)), environment: { PATH: process.env.PATH, HOME: directory } });
  driver.onEvent(event => actual.push(event));
  try {
    await driver.open({ ...input, cwd: directory });
    const response = await driver.prompt(text(`fixture:${JSON.stringify(fixture.frames)}`)).catch((error: unknown) => error);
    await expect.poll(() => actual).toEqual(JSON.parse(JSON.stringify(expected)));
    if (terminal!.error) expect(response).toBeInstanceOf(Error);
    else expect(response).toMatchObject({ stopReason: terminal!.stopReason, ...(terminal!.usage ? { usage: terminal!.usage } : {}) });
    let random = 0; vi.spyOn(Math, "random").mockImplementation(() => ++random / 1000);
    const folded = expected.reduce<AgentMessage[]>((messages, event) => applyUpdate(messages, event), []); random = 0;
    const store = await SessionStore.open(join(directory, "state"), "fixture");
    await store.upsert({ id: "chat", folder: "fixture", agentId: "claude" });
    for (const event of actual) await store.fold("chat", event);
    await store.flush();
    const reopened = await SessionStore.open(join(directory, "state"), "fixture");
    expect(reopened.window("chat").messages).toEqual(folded.map(message => ({ msgId: message.id, kind: message.kind, payload: JSON.stringify(message), createdAt: message.createdAt })));
  } finally { await driver.dispose(); await rm(directory, { recursive: true, force: true }); }
});
