import { describe, expect, it } from "vitest";
import type { QuestionRequest } from "../../apps/desktop/src/engine/agents/types";
import type { CodexUserInputRequest } from "../../apps/desktop/src/engine/agents/adapters/codex/app-server";
import { mapCodexQuestionAnswer, mapCodexQuestionToCanonical } from "../../apps/desktop/src/engine/agents/adapters/codex/app-server-adapter";
import { CodexAppServerTranslator } from "../../apps/desktop/src/engine/agents/adapters/codex/app-server-translator";
import { mcpElicitationAuditInput } from "../../apps/desktop/src/engine/agents/adapters/shared/mcp-elicitation";
import { nativeQualificationQuestion } from "../cloud-workspace-validation/lib/native-qualification-input";
import { NativeToolEvidence } from "../cloud-workspace-validation/lib/native-tool-evidence";

function fixture(params: Record<string, unknown> = {}) {
  const tools = new NativeToolEvidence();
  const translator = new CodexAppServerTranslator({ sessionId: "owned-session", emit: event => tools.observe(event.update) });
  const item = { id: "owned-probe", type: "mcpToolCall", server: "zeros-qualification", tool: "probe", arguments: {}, status: "inProgress" };
  translator.handle("item/started", { item });
  const native: CodexUserInputRequest = { questionId: "owned-question", rpcRequestId: "owned-rpc", method: "mcpServer/elicitation/request",
    params: { threadId: "owned-thread", turnId: "owned-turn", serverName: "zeros-qualification", mode: "form",
      message: "Allow the qualification probe?", requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", tool_title: "probe", persist: ["session", "always"] }, ...params } };
  const question = mapCodexQuestionToCanonical("owned-session", native);
  question.toolCallId = translator.emitBlockingQuestionToolCall(question.toolCallId, "MCP input requested", mcpElicitationAuditInput(native.params));
  const context = { provider: "codex", phase: "native-mcp-prompt" as const, sessionId: "owned-session", tools };
  return { tools, translator, item, native, question, context };
}

describe("unattended native MCP qualification confirmation", () => {
  it.each(["form", "openai/form", "openaiForm"])("answers the owned %s probe once through the maintained mapper", mode => {
    const f = fixture({ mode });
    const response = nativeQualificationQuestion(f.question, f.context);
    expect(mapCodexQuestionAnswer(f.native, f.question, response)).toEqual({ response: { action: "accept", content: null, _meta: null } });
    expect(response).toEqual({ outcome: { outcome: "answered", answers: [{ questionId: "__zeros_confirm__", selectedOptionIds: ["accept"] }] } });
    expect(nativeQualificationQuestion(f.question, f.context)).toEqual({ outcome: { outcome: "dismissed" } });
    // Consent does not qualify execution. The original completion gate remains.
    expect(() => f.tools.assertMcp("zeros-qualification", "probe")).toThrow();
    f.translator.handle("item/completed", { item: { ...f.item, status: "completed" } });
    expect(() => f.tools.assertMcp("zeros-qualification", "probe")).not.toThrow();
    expect(nativeQualificationQuestion(f.question, f.context)).toEqual({ outcome: { outcome: "dismissed" } });
  });

  it.each([
    { serverName: "another-server" },
    { serverName: "zeros-qualification-extra" },
    { mode: "url", url: "https://example.test/authorize", elicitationId: "browser" },
    { mode: "form", requestedSchema: { type: "object", properties: { secret: { type: "string" } }, required: ["secret"] } },
    { _meta: null },
    { _meta: { codex_approval_kind: "tool_suggestion", tool_title: "probe" } },
    { _meta: { codex_approval_kind: "mcp_tool_call", tool_title: "Access browser origin" } },
  ])("dismisses unrelated forms, browser flows and installation requests: %j", params => {
    const f = fixture(params);
    expect(nativeQualificationQuestion(f.question, f.context)).toEqual({ outcome: { outcome: "dismissed" } });
  });

  it.each([
    { provider: "claude" }, { provider: "cursor" }, { phase: "native-mcp-rotation" as const },
    { phase: "native-mcp-removal" as const }, { phase: "native-review" as const },
    { sessionId: undefined }, { sessionId: "another-session" }, { tools: new NativeToolEvidence() },
  ])("requires the exact initial Codex probe context: %j", context => {
    const f = fixture();
    expect(nativeQualificationQuestion(f.question, { ...f.context, ...context })).toEqual({ outcome: { outcome: "dismissed" } });
  });

  it.each([
    { source: "inferred_from_text" }, { blocking: false }, { allowDecline: false },
    { nativeRequestId: "another-rpc" }, { toolCallId: "unobserved-row" },
  ])("requires the actual pending native request: %j", replacements => {
    const f = fixture();
    expect(nativeQualificationQuestion({ ...f.question, ...replacements }, f.context)).toEqual({ outcome: { outcome: "dismissed" } });
  });

  it.each(["accept_session", "accept_always", "open"])("never substitutes %s for one-call approval", option => {
    const f = fixture();
    const question = { ...f.question, questions: [{ ...f.question.questions[0], options: [{ id: option, label: option }] }] };
    expect(nativeQualificationQuestion(question, f.context)).toEqual({ outcome: { outcome: "dismissed" } });
  });

  it("rejects extra questions and external actions even with the same confirmation ID", () => {
    const f = fixture();
    expect(nativeQualificationQuestion({ ...f.question, questions: [...f.question.questions, f.question.questions[0]] }, f.context))
      .toEqual({ outcome: { outcome: "dismissed" } });
    const question: QuestionRequest = structuredClone(f.question);
    question.questions[0].options[0].externalAction = { kind: "open-url", url: "https://example.test/authorize" };
    expect(nativeQualificationQuestion(question, f.context)).toEqual({ outcome: { outcome: "dismissed" } });
  });

  it("rejects an ambiguous probe or an already settled native question", () => {
    const ambiguous = fixture();
    ambiguous.translator.handle("item/started", { item: { ...ambiguous.item, id: "second-probe" } });
    expect(nativeQualificationQuestion(ambiguous.question, ambiguous.context)).toEqual({ outcome: { outcome: "dismissed" } });
    const settled = fixture();
    settled.tools.observe({ sessionUpdate: "tool_call_update", toolCallId: settled.question.toolCallId, status: "completed" });
    expect(nativeQualificationQuestion(settled.question, settled.context)).toEqual({ outcome: { outcome: "dismissed" } });
  });

  it.each([
    { server: "other-server" }, { tool: "other-tool" }, { arguments: { unexpected: true } },
    { arguments: [] }, { arguments: null }, { status: "failed" }, { status: "completed" },
  ])("does not approve without the live argument-free probe: %j", replacement => {
    const f = fixture();
    f.translator.handle("item/started", { item: { ...f.item, ...replacement } });
    if (["failed", "completed"].includes(String(replacement.status)))
      f.translator.handle("item/completed", { item: { ...f.item, ...replacement } });
    expect(nativeQualificationQuestion(f.question, f.context)).toEqual({ outcome: { outcome: "dismissed" } });
  });
});
