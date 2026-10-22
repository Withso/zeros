import { afterEach, expect, it, vi } from "vitest";
import { access } from "node:fs/promises";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { ClaudeDriver } from "../driver";
import { harness, input, nativeId, result, text, tick } from "./fake-query";

const drivers: ClaudeDriver[] = [];
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); vi.useRealTimers(); });
function setup() {
  const h = harness();
  const driver = new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: { PATH: "/usr/bin", HOME: "/fixture/home", ZEROS_WORKER_TOKEN: "fixture-worker", CURSOR_API_KEY: "fixture-cursor",
    CLAUDE_CODE_OAUTH_TOKEN: "fixture-ambient-oauth", ANTHROPIC_API_KEY: "fixture-ambient-api-key", ANTHROPIC_AUTH_TOKEN: "fixture-ambient-auth",
    ANTHROPIC_BASE_URL: "https://example.invalid", ZEROS_CLOUD_PROXY_TOKEN: "fixture-ambient-proxy" }, gitEnvironment: { GIT_ASKPASS: "/fixture/askpass" } });
  drivers.push(driver); return { driver, ...h };
}

it("passes the pinned Haiku model and low effort to the native query", async () => {
  const { driver, queries } = setup();
  await driver.open({ ...input, model: "claude-haiku-5-5", effort: "low" });
  const turn = driver.prompt(text("ok")), query = queries[0], sent = await query.read();
  query.push(result(sent.uuid)); await turn;
  expect(query.args.options).toMatchObject({ model: "claude-haiku-5-5", settings: { effortLevel: "low" } });
  expect(query.args.options).not.toHaveProperty("effort");
});

it.each([
  { effort: "medium", settings: { effortLevel: "medium", ultracode: false } },
  { effort: " high ", settings: { effortLevel: "high", ultracode: false } },
  { effort: "xhigh", settings: { effortLevel: "xhigh", ultracode: false } },
  { effort: "ultracode", settings: { effortLevel: "xhigh", ultracode: true } },
  { effort: "max", settings: { ultracode: false }, topLevel: "max" },
  ...[undefined, "", "unknown", "LOW", "minimal", "ultra"].map(effort => ({ effort, settings: { ultracode: false } })),
])("maps Claude effort $effort exactly as Local does", async ({ effort, settings, ...expected }) => {
  const { driver, queries } = setup();
  await driver.open({ ...input, effort });
  const turn = driver.prompt(text("ok")), query = queries[0], sent = await query.read();
  query.push(result(sent.uuid)); await turn;
  expect(query.args.options.settings).toEqual(settings);
  if ("topLevel" in expected) expect(query.args.options.effort).toBe(expected.topLevel);
  else expect(query.args.options).not.toHaveProperty("effort");
});

it.each(["low", "max", "ultracode"])("clears %s on a model change for the live query and later resume", async effort => {
  const { driver, queries } = setup();
  await driver.open({ ...input, effort });
  const first = driver.prompt(text("one")), query = queries[0], sent = await query.read();
  query.push(result(sent.uuid)); await first;
  await driver.setModel(input.model);
  expect(query.flagSettings).toEqual([]);
  await driver.setModel("claude-haiku-5-5");
  expect(query.flagSettings).toEqual([{ effortLevel: null, ultracode: false }]);
  const next = driver.prompt(text("two")), second = await query.read();
  query.push(result(second.uuid)); await next;
  expect(queries).toHaveLength(1);
  query.end(); await tick();
  const resumed = driver.prompt(text("three")), replacement = queries[1], third = await replacement.read();
  replacement.push(result(third.uuid)); await resumed;
  expect(replacement.args.options).toMatchObject({ model: "claude-haiku-5-5", resume: nativeId, settings: { ultracode: false } });
  expect(replacement.args.options).not.toHaveProperty("effort");
  expect(replacement.args.options.settings).not.toHaveProperty("effortLevel");
});

it("clears effort when the model changes before the first query", async () => {
  const { driver, queries } = setup();
  await driver.open({ ...input, effort: "low" });
  await driver.setModel("claude-haiku-5-5");
  const turn = driver.prompt(text("ok")), query = queries[0], sent = await query.read();
  query.push(result(sent.uuid)); await turn;
  expect(query.args.options).not.toHaveProperty("effort");
  expect(query.args.options.settings).not.toHaveProperty("effortLevel");
});

it("keeps one persistent query across prompts and changes the model through native control", async () => {
  const { driver, queries } = setup(); await driver.open(input);
  const first = driver.prompt(text("one")), query = queries[0], sent = await query.read();
  query.push(result(sent.uuid)); await expect(first).resolves.toMatchObject({ stopReason: "end_turn", effectiveModel: input.model });
  expect(query.closed).toBe(false);
  await driver.setModel("claude-opus-4-8"); expect(query.models).toEqual(["claude-opus-4-8"]);
  const next = driver.prompt(text("two")); const second = await query.read(); query.push(result(second.uuid));
  await expect(next).resolves.toMatchObject({ effectiveModel: "claude-opus-4-8" }); expect(queries).toHaveLength(1);
  expect(query.args.options).toMatchObject({ resume: nativeId, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, includePartialMessages: true, systemPrompt: { type: "preset", preset: "claude_code" } });
  expect(query.args.options).not.toHaveProperty("sessionId"); expect(query.args.options).not.toHaveProperty("canUseTool");
});

it("reserves a new UUID and only resumes after that native process has started", async () => {
  const { driver, queries } = setup(); const opened = await driver.open({ ...input, nativeSessionId: undefined });
  const first = driver.prompt(text("first")); const query = queries[0]; await query.read();
  expect(query.args.options.sessionId).toBe(opened.nativeSessionId); expect(query.args.options).not.toHaveProperty("resume");
  query.push({ type: "system", subtype: "init", session_id: opened.nativeSessionId });
  query.push(result(undefined, { session_id: opened.nativeSessionId })); await first;
  query.end(); await tick(); const next = driver.prompt(text("resume"));
  const resumed = queries[1]; await resumed.read(); expect(resumed.args.options.resume).toBe(opened.nativeSessionId);
  resumed.push(result(undefined, { session_id: opened.nativeSessionId })); await next;
});

it("resolves the pinned SDK's platform executable without a PATH fallback", async () => {
  const h = harness(), driver = new ClaudeDriver({ query: h.query, environment: {} }); drivers.push(driver);
  await driver.open(input); const prompt = driver.prompt(text("hello")), query = h.queries[0], sent = await query.read();
  const executable = query.args.options.pathToClaudeCodeExecutable!;
  expect(executable).toMatch(/claude-agent-sdk-linux-(x64|arm64).*\/claude$/); await access(executable);
  query.push(result(sent.uuid)); await prompt;
});

it("accounts cumulative usage by turn and ignores a replayed result during the next turn", async () => {
  const { driver, queries } = setup(); await driver.open(input); const first = driver.prompt(text("one")), query = queries[0], one = await query.read();
  const usage = (cost: number, tokens: number) => ({ total_cost_usd: cost, modelUsage: { "claude-sonnet-4-6": { inputTokens: tokens, outputTokens: tokens / 2, costUSD: cost } } });
  const previous = result(one.uuid, { uuid: "first-result", ...usage(0.1, 100) }); query.push(previous);
  await expect(first).resolves.toMatchObject({ usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.1 } });
  let finished = false; const next = driver.prompt(text("two")).then(value => { finished = true; return value; }), two = await query.read();
  query.push(previous); await tick(); expect(finished).toBe(false);
  query.push(result(two.uuid, { uuid: "second-result", ...usage(0.15, 140) }));
  const response = await next; expect(response.usage).toMatchObject({ inputTokens: 40, outputTokens: 20 }); expect(response.usage?.totalCostUsd).toBeCloseTo(0.05);
});

const logins = [
  { login: { oauthToken: "offline-oauth-placeholder" }, name: "CLAUDE_CODE_OAUTH_TOKEN" },
  { login: { apiKey: "offline-api-key-placeholder" }, name: "ANTHROPIC_API_KEY" },
];

it.each(logins)("allows only $name and cancels unsupported native questions immediately", async ({ login, name }) => {
  const { driver, queries } = setup(); await driver.open({ ...input, oauthToken: undefined, ...login }); const prompt = driver.prompt(text("hello"));
  const query = queries[0], sent = await query.read(), options = query.args.options;
  expect(Object.keys(options.env!).sort()).toEqual([name, "GIT_ASKPASS", "HOME", "PATH"].sort());
  expect(options.env![name] === (login.oauthToken ?? login.apiKey)).toBe(true);
  expect(await options.onUserDialog!({ dialogKind: "unknown", payload: {} } as never, {} as never)).toEqual({ behavior: "cancelled" });
  expect(await options.onElicitation!({} as never, {} as never)).toEqual({ action: "cancel" });
  query.push(result(sent.uuid)); await prompt;
});

it("does not finish the active prompt on a child, autonomous, or old correlated result", async () => {
  const { driver, queries } = setup(); const events: SessionNotification[] = []; driver.onEvent(event => events.push(event));
  await driver.open(input); let finished = false; const prompt = driver.prompt(text("hello")).then(value => { finished = true; return value; });
  const query = queries[0], sent = await query.read();
  for (const extra of [{ parent_tool_use_id: "child" }, { agent_id: "child" }, { origin: { kind: "task_notification" } }, { user_message_uuid: "older-turn" }, { num_turns: 0, result_index: 1, queued_turn_count: 1 }]) {
    query.push(result(undefined, extra)); await tick(); expect(finished).toBe(false);
  }
  query.push(result(sent.uuid, { origin: { kind: "task_notification" } })); await prompt;
  expect(finished).toBe(true); expect(events.length).toBeGreaterThan(0);
});

it("waits for authoritative steering receipts, including after the foreground result", async () => {
  const { driver, queries } = setup(); await driver.open(input); const prompt = driver.prompt(text("hello"));
  const query = queries[0], sent = await query.read(); let settled = false;
  const steer = driver.steer(text("follow up")).then(value => { settled = true; return value; }); const follow = await query.read();
  query.push({ type: "user", uuid: follow.uuid, message: follow.message }); await tick(); expect(settled).toBe(false);
  query.push({ type: "command_lifecycle", state: "started", command_uuid: follow.uuid, parent_tool_use_id: "child" }); await tick(); expect(settled).toBe(false);
  query.push(result(sent.uuid, { queued_turn_count: 1 })); await prompt; expect(settled).toBe(false);
  query.push({ type: "command_lifecycle", state: "started", command_uuid: follow.uuid }); await expect(steer).resolves.toBe("delivered");
});

it("bounds missing steering receipts after a result with no queued work", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { driver, queries } = setup(); await driver.open(input); const prompt = driver.prompt(text("hello"));
  const query = queries[0], sent = await query.read(); const steer = driver.steer(text("follow up")); await query.read();
  query.push(result(sent.uuid)); await prompt; await vi.advanceTimersByTimeAsync(5_000);
  await expect(steer).resolves.toBe("interrupted");
});

it("Stop discards unpulled input, settles uncertain receipts, and fences late native output", async () => {
  const { driver, queries } = setup(); const events: SessionNotification[] = []; driver.onEvent(event => events.push(event)); await driver.open(input);
  const prompt = driver.prompt(text("hello")), query = queries[0]; await query.read();
  const pulled = driver.steer(text("pulled")); await query.read(); const buffered = driver.steer(text("buffered"));
  await driver.interrupt(); await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
  await expect(pulled).resolves.toBe("interrupted"); await expect(buffered).resolves.toBe("queued"); expect(query.closed).toBe(true);
  const before = events.length;
  query.push({ type: "assistant", message: { id: "late", role: "assistant", content: [{ type: "text", text: "late" }] } }); await tick(); expect(events).toHaveLength(before);
  const next = driver.prompt(text("new explicit send")), resumed = queries[1]; const sent = await resumed.read();
  expect(resumed.args.options.resume).toBe(nativeId); resumed.push(result(sent.uuid)); await next;
});

it("fails a lost stream and rejects a different native session without replaying input", async () => {
  const { driver, queries } = setup(); await driver.open(input); const prompt = driver.prompt(text("hello")); const failed = expect(prompt).rejects.toThrow(/ended|closed/i);
  await queries[0].read(); queries[0].end(); await failed; expect(queries).toHaveLength(1);
  const next = driver.prompt(text("again")); const mismatch = expect(next).rejects.toThrow(/session/i); await queries[1].read();
  queries[1].push({ type: "system", subtype: "init", session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }); await mismatch;
});

it.each(logins)("ends a 401 turn cleanly and redacts $name from events and errors", async ({ login }) => {
  const { driver, queries } = setup(); const events: SessionNotification[] = []; driver.onEvent(event => events.push(event));
  await driver.open({ ...input, oauthToken: undefined, ...login });
  const failure = driver.prompt(text("hello")).catch((error: unknown) => error), query = queries[0], sent = await query.read();
  const secret = login.oauthToken ?? login.apiKey;
  query.push(result(sent.uuid, { subtype: "error_during_execution", is_error: true, errors: [`401 unauthorized ${secret}`] }));
  const error = await failure;
  expect(error instanceof Error && /401|authentication/i.test(error.message)).toBe(true);
  expect(error instanceof Error && error.message.includes(secret)).toBe(false);
  expect(JSON.stringify(events).includes(secret)).toBe(false); expect(queries).toHaveLength(1);
});

it("reports background failure and recovery after a completed prompt, and marks lost background work", async () => {
  const { driver, queries } = setup(), events: SessionNotification[] = []; driver.onEvent(event => events.push(event)); await driver.open(input);
  const prompt = driver.prompt(text("hello")), query = queries[0], sent = await query.read(); query.push(result(sent.uuid)); await prompt;
  query.push(result(undefined, { subtype: "error_during_execution", is_error: true, errors: ["401 authentication expired"], origin: { kind: "task_notification" } })); await tick();
  expect(events.some(event => event.update.sessionUpdate === "error_notice" && event.update.code === "claude-background-failed")).toBe(true);
  query.push(result(undefined, { origin: { kind: "task_notification" } })); await tick();
  expect(events.some(event => event.update.sessionUpdate === "error_notice" && event.update.code === "claude-background-recovered")).toBe(true);
  query.push({ type: "system", subtype: "task_started", task_id: "unfinished", description: "Background task", is_backgrounded: true }); await tick(); query.end(); await tick();
  expect(events.some(event => event.update.sessionUpdate === "error_notice" && event.update.code === "claude-background-transport-closed")).toBe(true);
});
