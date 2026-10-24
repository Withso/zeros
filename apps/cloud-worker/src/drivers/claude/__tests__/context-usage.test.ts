import { afterEach, expect, it, vi } from "vitest";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { ClaudeDriver } from "../driver";
import { FakeQuery, input, nativeId, result, text, tick } from "./fake-query";

const drivers: ClaudeDriver[] = [];
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); vi.useRealTimers(); });
const snapshot = (used: number) => ({ totalTokens: used, maxTokens: 100, categories: [{ id: "messages", name: "Messages", tokens: used, kind: "used" }] });
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(read?: (queryNumber: number, options: { detail: "summary" }) => Promise<unknown>) {
  const queries: FakeQuery[] = [], events: SessionNotification[] = [];
  const driver = new ClaudeDriver({ executable: "/fixture/claude", environment: {}, query: args => {
    const query = new FakeQuery(args), number = queries.push(query);
    if (read) Object.assign(query, { getContextUsage: (options: { detail: "summary" }) => read(number, options) });
    return query;
  } });
  drivers.push(driver); driver.onEvent(event => events.push(event)); await driver.open(input);
  let sequence = 0;
  const complete = async () => {
    const turn = driver.prompt(text("Continue")), query = queries.at(-1)!;
    const message = await query.read();
    query.push({ type: "system", subtype: "init", session_id: nativeId });
    query.push(result(message.uuid, { uuid: `result-${++sequence}` }));
    await turn; await tick();
  };
  const readings = () => events.flatMap(event => event.update.sessionUpdate === "usage_update" && event.update.used !== undefined ? [event.update] : []);
  return { driver, queries, complete, readings };
}

it("maps summary IDs and MCP server shares for the cloud gauge", async () => {
  const read = vi.fn(async () => ({ totalTokens: 20, maxTokens: 100, categories: [
    { id: "mcp_tools", name: "Connected tools", tokens: 8, kind: "used" },
    { id: "mcp_instructions", name: "Guidance", tokens: 5, kind: "used" },
    { id: "mcp_tools_deferred", name: "Available tools", tokens: 40, kind: "deferred" },
    { id: "skills", name: "Skills", tokens: 2, kind: "used" },
    { id: "future_category", name: "Messages", tokens: 5, kind: "used" },
  ], mcpTools: [
    { name: "mcp__Team_Docs__read", serverName: "Team_Docs", tokens: 8, isLoaded: true },
    { name: "mcp__unused__read", serverName: "unused", tokens: 40, isLoaded: false },
  ], mcpInstructions: [{ serverName: "Team Docs", tokens: 5 }] }));
  const t = await setup(read); await t.complete();
  expect(read).toHaveBeenCalledWith(1, { detail: "summary" });
  expect(t.readings()).toEqual([{ sessionUpdate: "usage_update", size: 100, used: 20, categories: [
    { id: "mcp_tools", name: "Connected tools", tokens: 8, kind: "used", mcpServers: [{ serverName: "Team_Docs", tokens: 8 }] },
    { id: "mcp_instructions", name: "Guidance", tokens: 5, kind: "used", mcpServers: [{ serverName: "Team Docs", tokens: 5 }] },
    { id: "mcp_tools_deferred", name: "Available tools", tokens: 40, kind: "deferred" },
    { id: "skills", name: "Skills", tokens: 2, kind: "used" },
    { name: "Messages", tokens: 5, kind: "used" },
  ] }]);
});

it("refreshes settled foreground and turnless runs, but not child, replayed or background acknowledgement results", async () => {
  const read = vi.fn(async () => snapshot(20)), t = await setup(read);
  await t.complete(); const query = t.queries[0];
  query.push(result(undefined, { uuid: "result-1" }));
  query.push(result(undefined, { uuid: "child", parent_tool_use_id: "child" }));
  query.push(result(undefined, { uuid: "ack", num_turns: 0, result_index: 1, queued_turn_count: 1 }));
  await tick(); expect(read).toHaveBeenCalledTimes(1);
  query.push(result(undefined, { uuid: "compact", origin: { kind: "task_notification" } }));
  await tick(); expect(read).toHaveBeenCalledTimes(2);
});

it("never waits for context to settle a turn and coalesces newer readings without resetting on init", async () => {
  const old = deferred(), read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot(10));
  const t = await setup(read);
  await t.complete(); await t.complete();
  expect(read).toHaveBeenCalledTimes(1); expect(t.readings()).toEqual([]);
  old.resolve(snapshot(90)); await tick();
  expect(read).toHaveBeenCalledTimes(2);
  expect(t.readings().map(value => value.used)).toEqual([10]);
});

it("expires a stuck reading without accumulating requests or keeping a timer alive", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = deferred(), read = vi.fn(() => pending.promise), t = await setup(read);
  await t.complete(); await vi.advanceTimersByTimeAsync(5_000);
  pending.resolve(snapshot(90)); await tick();
  expect(t.readings()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  const stuck = deferred(); read.mockImplementation(() => stuck.promise);
  for (let turn = 0; turn < 10; turn++) await t.complete();
  expect(read).toHaveBeenCalledTimes(2);
  await t.driver.dispose(); expect(vi.getTimerCount()).toBe(0);
  stuck.resolve(snapshot(80)); await tick(); expect(t.readings()).toEqual([]);
});

it.each(["dispose", "EOF", "stop"])("ignores a response after %s retires the process", async action => {
  const pending = deferred(), t = await setup(() => pending.promise);
  await t.complete();
  if (action === "dispose") await t.driver.dispose();
  else if (action === "EOF") { t.queries[0].end(); await tick(); }
  else await t.driver.interrupt();
  pending.resolve(snapshot(90)); await tick(); expect(t.readings()).toEqual([]);
});

it("ignores the old query after replacement resumes the same native session", async () => {
  const old = deferred(), t = await setup(number => number === 1 ? old.promise : Promise.resolve(snapshot(10)));
  await t.complete(); await t.driver.interrupt(); await t.complete();
  old.resolve(snapshot(90)); await tick();
  expect(t.readings().map(value => value.used)).toEqual([10]);
});

it("keeps the confirmed reading on unsupported, failed and invalid responses, and clears absent categories", async () => {
  const unsupported = await setup(); await unsupported.complete(); expect(unsupported.readings()).toEqual([]);
  const read = vi.fn().mockResolvedValueOnce(snapshot(30)).mockRejectedValueOnce(new Error("Unsupported"))
    .mockResolvedValueOnce({ totalTokens: -1, maxTokens: 100 }).mockResolvedValueOnce({ totalTokens: 0, maxTokens: 100 });
  const t = await setup(read);
  for (let turn = 0; turn < 4; turn++) await t.complete();
  expect(t.readings()).toEqual([
    { sessionUpdate: "usage_update", size: 100, used: 30, categories: snapshot(30).categories },
    { sessionUpdate: "usage_update", size: 100, used: 0, categories: [] },
  ]);
});
