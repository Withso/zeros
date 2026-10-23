import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { Agents } from "../agents";
import { SessionStore } from "../sessions/session-store";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import { FakeDriver, browserFrame, config } from "./worker-fixtures";

async function setup(agentId: "claude" | "codex" | "cursor") {
  const fixture = await repositoryFixture();
  const store = await SessionStore.open(fixture.state, fixture.scope.key);
  const driver = new FakeDriver();
  const frames: BridgeMessage[] = [];
  const client = { id: "fixture", send: async (frame: BridgeMessage) => { frames.push(frame); } };
  const agents = new Agents(store, fixture.scope, { [agentId]: () => driver }, {
    ...config, workspace: fixture.scope.workspace,
    agents: { ...config.agents, claude: { apiKey: "fixture-key" }, cursor: { apiKey: "fixture-key" } },
  }, client.send, () => {});
  await agents.handle(client, browserFrame("AGENT_NEW_SESSION", { agentId, chatId: "chat", cwd: fixture.root, workspaceId: fixture.scope.workspace.id }) as BridgeMessage);
  const created = frames.find(frame => frame.type === "AGENT_SESSION_CREATED") as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
  expect(created).toBeDefined();
  const sessionId = created.session.sessionId;
  const prompt = browserFrame("AGENT_PROMPT", { agentId, sessionId, userMessageId: "opening", prompt: [{ type: "text", text: "Change files" }] });
  const send = () => agents.handle(client, prompt as BridgeMessage);
  const completed = () => frames.some(frame => frame.type === "AGENT_PROMPT_COMPLETE" && frame.requestId === prompt.id);
  const close = async () => { await agents.closeChat("chat", true); await store.flush(); };
  return { ...fixture, store, driver, agents, client, frames, sessionId, send, completed, close };
}

it.each(["claude", "codex", "cursor"] as const)("records %s before native dispatch and publishes the summary before completion", async agentId => {
  const { root, scope, store, driver, send, completed, frames, close } = await setup(agentId);
  try {
    await send(); await expect.poll(() => driver.prompts.length).toBe(1);
    expect(store.turnRecord("chat", "opening")?.preSnapshot).toMatch(/^[a-f0-9]{40,64}$/);
    await writeFile(join(root, "readme.txt"), "native edit\n");
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", kind: "edit", status: "completed", rawInput: { path: "readme.txt" } });
    driver.complete(); await expect.poll(completed).toBe(true);
    expect(store.turnRecord("chat", "opening")?.files).toMatchObject([{ path: "readme.txt", additions: 1, deletions: 1 }]);
    const summary = frames.findIndex(frame => frame.type === "AGENT_SESSION_UPDATE" && frame.notification.update.sessionUpdate === "user_message_recorded" && !!frame.notification.update.message.turnSummary?.files.length);
    expect(summary).toBeGreaterThan(-1);
    expect(summary).toBeLessThan(frames.findIndex(frame => frame.type === "AGENT_PROMPT_COMPLETE"));
    expect(frames.slice(summary + 1)).toContainEqual(expect.objectContaining({
      type: "DB_CHANGED", kinds: ["workspaces"], workspaceIds: [scope.workspace.id],
    }));
  } finally { await close(); }
});

it("captures background edits that settle while the first post-snapshot is being finalized", async () => {
  const { root, store, driver, agents, send, completed, close } = await setup("claude");
  const snapshots = agents.turns as unknown as { snapshot(chatId: string, turnId: string, phase: "pre" | "post"): Promise<string | null> };
  const capture = snapshots.snapshot.bind(snapshots);
  let release!: () => void, captured!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  let firstPost = true;
  vi.spyOn(snapshots, "snapshot").mockImplementation(async (...args) => {
    const tree = await capture(...args);
    if (args[2] === "post" && firstPost) { firstPost = false; captured(); await held; }
    return tree;
  });
  const finish = vi.spyOn(agents.turns, "finish");
  try {
    await send(); await expect.poll(() => driver.prompts.length).toBe(1);
    driver.emit({ sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: { state: "running", startedAt: 1 } });
    driver.complete(); await ready;
    await writeFile(join(root, "background.txt"), "late background edit\n");
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "late-edit", title: "Edit", kind: "edit", status: "completed", rawInput: { path: "background.txt" } });
    driver.emit({ sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: null });
    // The background completion must request its own serialized refresh while
    // the first capture remains held; it cannot be skipped because active exists.
    await expect.poll(() => finish.mock.calls.length).toBe(2);
    release();
    await expect.poll(completed).toBe(true);
    await expect.poll(() => store.turnRecord("chat", "opening")?.files.map(file => file.path)).toEqual(["background.txt"]);
    expect(store.turnRecord("chat", "opening")?.status).toBe("completed");
  } finally { release(); await close(); }
});

it("refreshes the same turn after background edits without attributing the next turn", async () => {
  const { root, store, driver, send, completed, close } = await setup("claude");
  try {
    await send(); await expect.poll(() => driver.prompts.length).toBe(1);
    driver.emit({ sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: { state: "running", startedAt: 1 } });
    driver.complete(); await expect.poll(completed).toBe(true);
    await writeFile(join(root, "background.txt"), "background edit\n");
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "child-edit", title: "Edit", parentToolId: "child", kind: "edit", status: "completed", rawInput: { path: "background.txt" } });
    driver.emit({ sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: null });
    await expect.poll(() => store.turnRecord("chat", "opening")?.files.map(file => file.path)).toEqual(["background.txt"]);
    const recorded = store.turnRecord("chat", "opening")!;
    await writeFile(join(root, "background.txt"), "later unrelated edit\n");
    driver.emit({ sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: null });
    // An event after the duplicate proves the event queue drained.
    driver.emit({ sessionUpdate: "agent_message_chunk", messageId: "after-idle", content: { type: "text", text: "Done" } });
    await expect.poll(() => store.history("chat").some(row => JSON.parse(row.payload).messageId === "after-idle")).toBe(true);
    expect(store.turnRecord("chat", "opening")).toEqual(recorded);
  } finally { await close(); }
});
