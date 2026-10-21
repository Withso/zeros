import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorDriver } from "../driver";
import { CursorSdkTranslator } from "../translator";
import { CursorSubagentTranscriptReader } from "../subagent-transcript-reader";
import { agentTranscriptsRoot } from "../subagent-transcript";
import { SessionStore } from "../../../sessions/session-store";
import { streams } from "./fixtures/streams";
import { fixtureHost, prompt } from "./fixture-host";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<object>(), randomUUID: () => `00000000-0000-4000-8000-${String(++ids.next).padStart(12, "0")}` }));
const localRoot = new URL("../../../../../desktop/src/engine/agents/adapters/cursor-sdk/", import.meta.url);
const { CursorSdkTranslator: LocalTranslator } = await import(fileURLToPath(new URL("translator.ts", localRoot)));
const { CursorSubagentTranscriptReader: LocalReader } = await import(fileURLToPath(new URL("subagent-transcript-reader.ts", localRoot)));
let host: Awaited<ReturnType<typeof fixtureHost>>;
beforeAll(async () => { host = await fixtureHost(); });
afterAll(async () => { await host?.dispose(); });

for (const fixture of streams) it(`native host → driver → persisted rows: ${fixture.name}`, async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const directory = await mkdtemp(join(tmpdir(), "zeros-cursor-parity-"));
  const owner = { cwd: directory, home: directory, parentAgentId: "native-agent" };
  if (fixture.checkpoint) {
    const parent = join(agentTranscriptsRoot(directory, owner), "native-agent", "subagents"); await mkdir(parent, { recursive: true });
    await writeFile(join(parent, "child-file.jsonl"), [
      { role: "assistant", message: { id: "one", content: [{ type: "text", text: "Inspecting" }, { type: "tool_use", id: "read", name: "Read", input: { path: "README.md" } }] } },
      { role: "assistant", message: { id: "two", content: [{ type: "text", text: "Checkpoint report" }] } },
    ].map(row => JSON.stringify(row)).join("\n"));
  }
  const expected: SessionNotification[] = [], actual: SessionNotification[] = [];
  const reader: CursorSubagentTranscriptReader = new LocalReader(owner);
  ids.next = 1; // Driver's logical turn UUID precedes the translator's UUID.
  const local: CursorSdkTranslator = new LocalTranslator({ sessionId: "execution", emit: (event: SessionNotification) => expected.push(event),
    readSubagentTranscript: (child: Parameters<CursorSubagentTranscriptReader["read"]>[0], final: boolean) => reader.read(child, final) });
  for (const frame of fixture.before ?? []) {
    if (frame.kind === "delta") local.feedDelta(frame.value); else local.feedStep(frame.value);
  }
  local.bindRunIdentity("native-agent", "run-1");
  for (const frame of fixture.frames) {
    if (frame.kind === "delta") local.feedDelta(frame.value);
    else if (frame.kind === "step") local.feedStep(frame.value);
    else local.feed(frame.value);
  }
  await local.flushSubagents(); reader.dispose();
  if (fixture.result.status !== "error") local.recoverFinalAnswer(fixture.result.result);
  ids.next = 0;
  const driver = new CursorDriver({ hostPath: host.path, environment: { PATH: process.env.PATH, HOME: directory } });
  driver.onEvent(event => actual.push(event));
  try {
    await driver.open({ sessionId: "execution", cwd: directory, apiKey: "fixture-cursor" });
    const response = await driver.prompt(prompt(fixture)).catch((error: unknown) => error);
    expect(actual).toEqual(JSON.parse(JSON.stringify(expected)));
    if (fixture.result.status === "error") expect(response).toBeInstanceOf(Error);
    else expect(response).toMatchObject({ stopReason: local.stopReason });
    let random = 0; vi.spyOn(Math, "random").mockImplementation(() => ++random / 1000);
    const folded = expected.reduce<AgentMessage[]>((messages, event) => applyUpdate(messages, event), []); random = 0;
    const store = await SessionStore.open(join(directory, "state"), "fixture");
    await store.upsert({ id: "chat", folder: "fixture", agentId: "cursor" });
    for (const event of actual) await store.fold("chat", event);
    await store.flush();
    const reopened = await SessionStore.open(join(directory, "state"), "fixture");
    expect(reopened.window("chat").messages).toEqual(folded.map(row => ({ msgId: row.id, kind: row.kind, payload: JSON.stringify(row), createdAt: row.createdAt })));
  } finally { await driver.dispose(); await rm(directory, { recursive: true, force: true }); }
});
