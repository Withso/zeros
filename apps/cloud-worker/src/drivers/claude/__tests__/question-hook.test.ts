import { afterEach, expect, it, vi } from "vitest";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { QuestionResponse } from "@zeros/protocol/agent-events";
import { ClaudeDriver } from "../driver";
import { CLOUD_INPUT_TIMEOUT_MS } from "../../shared/native-input";
import { harness, input, result, text, tick } from "./fake-query";

const payload = { questions: [{ question: "Which route?", header: "Route", multiSelect: false,
  options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] }], metadata: { source: "fixture" } };
const answered: QuestionResponse = { outcome: { outcome: "answered", answers: [{ questionId: "q0", selectedOptionIds: ["o1"] }] } };
const dismissed: QuestionResponse = { outcome: { outcome: "dismissed" } };
const hookInput = (tool = "AskUserQuestion") => ({ hook_event_name: "PreToolUse", session_id: input.nativeSessionId,
  transcript_path: "/fixture/transcript", cwd: input.cwd, tool_name: tool, tool_input: payload, tool_use_id: "native-ask" } as const);
const drivers: ClaudeDriver[] = [];
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); vi.useRealTimers(); });

async function setup(onQuestion?: () => Promise<QuestionResponse>, modeId = "bypass") {
  const h = harness(), driver = new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: {} });
  drivers.push(driver);
  const onPermission = vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } }));
  await driver.open({ ...input, onQuestion, onPermission, modeId });
  const turn = driver.prompt(text("ask")), query = h.queries[0], sent = await query.read();
  return { driver, query, onPermission, turn, finish: async () => { query.push(result(sent.uuid)); await turn; } };
}

function questionHook(t: Awaited<ReturnType<typeof setup>>): HookCallback {
  const matcher = t.query.args.options.hooks?.PreToolUse?.[0];
  expect(matcher).toMatchObject({ matcher: "^AskUserQuestion$" });
  expect(matcher!.timeout).toBeGreaterThan(CLOUD_INPUT_TIMEOUT_MS / 1_000);
  return matcher!.hooks[0];
}

it("opens Full access questions through the permission channel and returns the human's labels to the native tool", async () => {
  let answer!: (value: QuestionResponse) => void;
  const onQuestion = vi.fn(() => new Promise<QuestionResponse>(resolve => { answer = resolve; }));
  const t = await setup(onQuestion);
  expect(t.query.args.options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, permissionPromptToolName: "stdio" });
  expect(t.query.args.options.canUseTool).toBeUndefined();
  const hook = questionHook(t), pending = hook(hookInput(), "native-ask", { signal: new AbortController().signal });
  await tick();
  expect(onQuestion).toHaveBeenCalledOnce();
  answer(answered);
  expect(await pending).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { ...payload, answers: { "Which route?": "B" } } } });
  expect(t.onPermission).not.toHaveBeenCalled();
  await t.finish();
});

it("never prompts or returns a hook decision for any other Full access tool", async () => {
  const onQuestion = vi.fn(async () => answered), t = await setup(onQuestion), hook = questionHook(t);
  const matcher = new RegExp(t.query.args.options.hooks!.PreToolUse![0].matcher!);
  for (const tool of ["Read", "Write", "Edit", "Bash", "ExitPlanMode", "mcp__fixture__AskUserQuestion", "AskUserQuestionExtra", "askuserquestion"]) {
    expect(matcher.test(tool)).toBe(false);
    expect(await hook(hookInput(tool), "other-tool", { signal: new AbortController().signal })).toEqual({});
  }
  expect(onQuestion).not.toHaveBeenCalled(); expect(t.onPermission).not.toHaveBeenCalled();
  expect(t.query.args.options.canUseTool).toBeUndefined();
  await t.finish();
});

it.each(["bypass", "plan"])("leaves an unsupported peer's %s question channels unchanged", async mode => {
  const t = await setup(undefined, mode);
  expect(t.query.args.options.permissionPromptToolName).toBeUndefined();
  expect(t.query.args.options.hooks?.PreToolUse).toBeUndefined();
  await t.finish();
});

it("keeps supported Plan questions on the existing canUseTool path", async () => {
  const t = await setup(async () => answered, "plan");
  expect(t.query.args.options.hooks?.PreToolUse).toBeUndefined();
  expect(t.query.args.options.permissionPromptToolName).toBeUndefined();
  await expect(t.query.args.options.canUseTool!("AskUserQuestion", payload, { signal: new AbortController().signal, toolUseID: "native-ask", requestId: "permission-native" }))
    .resolves.toMatchObject({ behavior: "deny", message: expect.stringContaining("B") });
  await t.finish();
});

it.each(["dismissed", "failure", "invalid"])("denies a Full access question on %s", async kind => {
  const t = await setup(async () => {
    if (kind === "failure") throw new Error("fixture delivery failed");
    return kind === "invalid" ? { outcome: { outcome: "answered", answers: [] } } : dismissed;
  });
  await expect(questionHook(t)(hookInput(), "native-ask", { signal: new AbortController().signal }))
    .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  await t.finish();
});

it.each(["interrupt", "dispose", "native-abort"])("denies an answer racing %s and refuses callbacks from the retired execution", async stop => {
  let answer!: (value: QuestionResponse) => void;
  const onQuestion = vi.fn(() => new Promise<QuestionResponse>(resolve => { answer = resolve; })), t = await setup(onQuestion);
  const hook = questionHook(t), abort = new AbortController();
  const pending = hook(hookInput(), "native-ask", { signal: abort.signal });
  await tick(); answer(answered);
  if (stop === "native-abort") abort.abort();
  else await t.driver[stop as "interrupt" | "dispose"]();
  expect(await pending).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(await hook(hookInput(), "late-ask", { signal: abort.signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(onQuestion).toHaveBeenCalledOnce();
  if (stop === "native-abort") await t.finish();
  else await expect(t.turn).resolves.toMatchObject({ stopReason: "cancelled" });
});

it("bounds a held native callback after the canonical cloud input deadline", async () => {
  vi.useFakeTimers();
  const t = await setup(() => new Promise<QuestionResponse>(() => {}));
  let settled = false;
  const pending = questionHook(t)(hookInput(), "native-ask", { signal: new AbortController().signal })
    .then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(CLOUD_INPUT_TIMEOUT_MS);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  await t.finish();
});

it("cannot publish a question queued immediately before native retirement", async () => {
  const onQuestion = vi.fn(async () => answered), t = await setup(onQuestion);
  const pending = questionHook(t)(hookInput(), "native-ask", { signal: new AbortController().signal });
  await t.driver.interrupt();
  await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(onQuestion).not.toHaveBeenCalled();
});

it("does not publish from a hook belonging to a replaced native query", async () => {
  const onQuestion = vi.fn(async () => answered), t = await setup(onQuestion), hook = questionHook(t);
  await t.finish(); await t.driver.updateConfig({ effort: "max", fast: false });
  const next = t.driver.prompt(text("new execution"));
  await expect(hook(hookInput(), "stale-ask", { signal: new AbortController().signal }))
    .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(onQuestion).not.toHaveBeenCalled();
  await t.driver.interrupt(); await next;
});
