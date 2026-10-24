import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { CONVERSATION_REPLAY_CAPABILITY, synthesizeReplayPrompt } from "@zeros/protocol/conversation-replay";
import { sameProviderBinding } from "@zeros/protocol/identities";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";

// Exercise the real dispatch callback at the transport boundary, including the
// capability fallback, rather than duplicating its ownership predicate here.
const ast = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let source = "";
(function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "runPrompt") source = node.initializer!.getText(ast);
  ts.forEachChild(node, visit);
})(ast);
const code = ts.transpileModule(`globalThis.runPrompt = ${source}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

afterEach(() => vi.useRealTimers());

it.each([
  { cwd: "/personal/repo", capable: true, replay: false },
  { cwd: "/organization/repo", capable: true, replay: false },
  { cwd: "/personal/repo", capable: false, replay: true },
  { cwd: "/organization/repo", capable: undefined, replay: true },
  { cwd: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", capable: true, replay: true },
])("routes retained history for $cwd with engine capability $capable", async ({ cwd, capable, replay }) => {
  vi.useFakeTimers();
  const userMessage = { id: "next", kind: "text", role: "user", text: "Next task", createdAt: 2 };
  const current = { cwd, agentId: "codex", sessionId: "execution", providerBinding: null, needsConversationReplay: true,
    messages: [{ ...userMessage, id: "previous", text: "Retained instructions", createdAt: 1 }, userMessage] };
  const store = { sessions: { chat: current }, patchSession: vi.fn() };
  const request = vi.fn(async (_message: unknown) => ({ type: "AGENT_PROMPT_COMPLETE", stopReason: "end_turn" }));
  const bridge = { request, ...(capable === undefined ? {} : { supportsEngineCapability: vi.fn(() => capable) }) };
  const context: Record<string, unknown> = {
    current, userMessage, bridge, chatId: "chat", promptId: "prompt", bubble: undefined, pendingAuth: [], requestExecutionId: null,
    getStore: () => store, synthesizeReplayPrompt, sameProviderBinding, isCloudWorkspace, CONVERSATION_REPLAY_CAPABILITY,
    promptAbortRef: { current: new Map() }, promptActivityRef: { current: new Map() }, AbortController, DOMException,
    ownsPromptTurn: () => true, stoppedByUser: () => false, awaitComposerMode: () => null,
    requestLocalPrompt: async (_bridge: unknown, message: unknown) => request(message),
    setTimeout, clearTimeout, PROMPT_INACTIVITY_TIMEOUT_MS: 1000, PROMPT_ABSOLUTE_TIMEOUT_MS: 2000,
  };
  vm.runInNewContext(code, context);
  const runPrompt = context.runPrompt as (execution: string, prompt: unknown[]) => Promise<unknown>;
  await runPrompt("execution", [{ type: "text", text: "Next task" }]);
  const sent = request.mock.calls[0][0] as { prompt: unknown[] };
  expect(sent.prompt).toHaveLength(replay ? 2 : 1);
  expect(JSON.stringify(sent.prompt).includes("Retained instructions")).toBe(replay);
  expect(sent.prompt.at(-1)).toEqual({ type: "text", text: "Next task" });
  expect(vi.getTimerCount()).toBe(0);
});
