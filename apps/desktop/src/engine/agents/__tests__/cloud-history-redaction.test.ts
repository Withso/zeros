import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudCompactControlEventSchema } from "@zeros/protocol/cloud-local-mirror";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { CloudCustomizationRedactor } from "../cloud-customization-redaction";
import { pinCloudHistoryContentRedactor } from "../cloud-history-redaction";

const literal = "e-synthetic-private-value", prefix = literal.slice(0, -1), hidden = "[redacted]";
const filter = (secrets = [literal]) => pinCloudHistoryContentRedactor(new CloudCustomizationRedactor(secrets));
function message(payload: AgentMessage | Record<string, unknown>) {
  return { version: 1, chatId: "conversation-e", msgId: payload.id, ord: 1, kind: payload.kind,
    createdAt: 1, payload: JSON.stringify(payload) };
}
const restored = (result: unknown) => JSON.parse((result as { payload: string }).payload) as Record<string, unknown>;

describe("original execution's content-only canonical history filter", () => {
  it("preserves chat and resume identity while filtering descriptive metadata", () => {
    const chat = { id: "conversation-e", folder: "source", agentId: "claude", agentName: literal, model: "fixture-model",
      lastModeId: "code", prePlanModeId: "plan", composerMode: "code", permissionMode: "default", effort: "high",
      kind: "code", title: literal, sourceChatId: "source-e", sessionId: "session-e", createdAt: 1, updatedAt: 2,
      providerBinding: { version: 1, providerId: "claude", kind: "native", resumeId: "resume-e", scopeId: "scope-e", legacySessionId: "legacy-e" },
      providerMetadata: { version: 1, git: { sha: "a".repeat(40), branch: literal, originUrl: prefix } },
      futureContent: { id: literal } };
    const original = JSON.stringify(chat);
    const result = filter([literal, "claude", "code", "native", "fixture-model"])({ version: 1, chat }, "chat");
    expect(result).toEqual({ version: 1, chat: { ...chat, agentName: hidden, title: hidden,
      providerMetadata: { version: 1, git: { sha: "a".repeat(40), branch: hidden, originUrl: hidden } },
      futureContent: { id: hidden } } });
    expect(JSON.stringify(chat)).toBe(original);
  });

  it("preserves turn proof, snapshots and usage identities but filters summaries and file paths", () => {
    const files = [{ path: literal, oldPath: prefix, status: "renamed", additions: 1, deletions: 2 }];
    const usage = { accountingVersion: 1, costKind: "reported", inputTokens: 3,
      perModel: [{ model: "fixture-model", inputTokens: 3 }], _sources: [{ id: "source-e", usage: { inputTokens: 3 } }] };
    const row = { chat_id: "conversation-e", turn_id: "turn-e", agent_id: "claude", workspace_id: null, folder: "source",
      ord: 1, started_at: 1, ended_at: 2, status: "completed", stop_reason: "end_turn", summary: literal,
      pre_snapshot: "a".repeat(40), post_snapshot: "b".repeat(40), files: JSON.stringify(files), usage: JSON.stringify(usage) };
    const redact = filter([literal, "claude", "completed", "end_turn", "renamed", "reported", "fixture-model"]);
    const result = redact({ version: 1, row }, "turn") as { row: typeof row };
    expect(result.row).toMatchObject({ ...row, summary: hidden, files: expect.any(String), usage: expect.any(String) });
    expect(JSON.parse(result.row.files)).toEqual([{ ...files[0], path: hidden, oldPath: hidden }]);
    expect(JSON.parse(result.row.usage)).toEqual(usage);
  });

  it("filters decoded text and attachments without corrupting nested message discriminants", () => {
    const payload: AgentMessage = { id: "message-e", kind: "text", role: "agent", text: literal, createdAt: 1,
      messageId: "native-e", parentToolId: "parent-e", phase: "commentary", retryText: prefix,
      authRecovery: { text: literal }, recoveryFailure: { kind: "protocol_error", message: literal },
      attachments: [{ kind: "text", name: literal, mimeType: "text/plain", diskPath: prefix, attachmentId: "attachment-e" }],
      segments: [{ type: "text", text: literal }, { type: "mention", kind: "file", label: literal, path: prefix }],
      localFrom: { chatId: "other-e", title: literal, agentId: "claude", link: "zeros://chat/other-e" },
      modelFallback: { provider: "claude", fromModel: "old-e", toModel: "new-e", scope: "session", reason: "refusal" } };
    const document = message(payload), original = structuredClone(document);
    const result = filter([literal, "text", "agent", "claude", "protocol_error", "commentary"])(document, "message");
    expect(result).toMatchObject({ ...document, payload: expect.any(String) });
    expect(restored(result)).toEqual({ ...payload, text: hidden, retryText: hidden, authRecovery: { text: hidden },
      recoveryFailure: { kind: "protocol_error", message: hidden },
      attachments: [{ ...payload.attachments![0], name: hidden, diskPath: hidden }],
      segments: [{ type: "text", text: hidden }, { type: "mention", kind: "file", label: hidden, path: hidden }],
      localFrom: { ...payload.localFrom, title: hidden } });
    expect(document).toEqual(original);
  });

  it("preserves tool routing, nested kinds and status without exempting ids in arbitrary raw content", () => {
    const payload: AgentMessage = { id: "message-e", kind: "tool", toolCallId: "tool-e", nativeToolCallId: "native-e",
      parentToolId: "parent-e", toolKind: "execute", status: "completed", title: literal, createdAt: 1, updatedAt: 2,
      content: [{ type: "content", content: { type: "text", text: prefix } },
        { type: "diff", path: literal, oldText: prefix, newText: literal }, { type: "terminal", terminalId: "terminal-e" }],
      locations: [{ path: literal, line: 1 }],
      resourceLinks: [{ type: "resource_link", name: literal, uri: prefix, mimeType: "text/plain" }],
      rawInput: { id: literal, kind: literal, nested: { agentId: literal } }, rawOutput: { type: "text", value: prefix } };
    const result = restored(filter([literal, "tool", "text", "completed", "execute"])(message(payload), "message"));
    expect(result).toMatchObject({ id: "message-e", toolCallId: "tool-e", nativeToolCallId: "native-e", parentToolId: "parent-e",
      toolKind: "execute", status: "completed", title: hidden,
      content: [{ type: "content", content: { type: "text", text: hidden } },
        { type: "diff", path: hidden, oldText: hidden, newText: hidden }, { type: "terminal", terminalId: "terminal-e" }],
      locations: [{ path: hidden, line: 1 }], resourceLinks: [{ type: "resource_link", name: hidden, uri: hidden, mimeType: "text/plain" }],
      rawInput: { id: hidden, kind: hidden, nested: { agentId: hidden } }, rawOutput: { type: hidden, value: hidden } });
  });

  const variants: Array<{ payload: AgentMessage; expected: Partial<AgentMessage> }> = [
    { payload: { id: "thinking-e", kind: "thinking", messageId: "native-e", text: prefix, createdAt: 1 }, expected: { text: hidden } },
    { payload: { id: "question-e", kind: "question", questionId: "question-e", nativeRequestId: "native-e",
      toolCallId: "tool-e", source: "native_tool", blocking: true, createdAt: 1,
      questions: [{ id: "field-e", inputType: "choice", prompt: literal, options: [{ id: "option-e", label: literal }],
        answer: { selectedOptionIds: ["option-e"], freeText: prefix } }] },
      expected: { questions: [{ id: "field-e", inputType: "choice", prompt: hidden, options: [{ id: "option-e", label: hidden }],
        answer: { selectedOptionIds: ["option-e"], freeText: hidden } }] } },
    { payload: { id: "mode-e", kind: "mode_switch", axis: "phase", from: "code", to: "plan", source: "agent", reason: literal, createdAt: 1 },
      expected: { reason: hidden } },
    { payload: { id: "subagent-e", kind: "subagent", subagentId: "child-e", parentToolId: "parent-e", marker: "end",
      description: literal, summary: prefix, createdAt: 1 }, expected: { description: hidden, summary: hidden } },
    { payload: { id: "notice-e", kind: "error_notice", severity: "error", message: prefix, recoverable: false,
      code: "protocol_error", turnFailure: { turnId: "turn-e", kind: "protocol_error" }, createdAt: 1 }, expected: { message: hidden } },
  ];
  it.each(variants)("keeps $payload.kind state and redacts its visible content", ({ payload, expected }) => {
    const result = filter([literal, "code", "agent", "native_tool", "protocol_error", payload.kind])(message(payload), "message");
    expect(restored(result)).toEqual({ ...payload, ...expected });
  });

  const controlBase = { version: 1, executionId: "execution-e", commandId: randomUUID(), turnId: "turn-e", eventSequence: 4 };
  const frameBase = { id: "frame-e", timestamp: 1, source: "engine", agentId: "claude", chatId: "conversation-e",
    cloudStream: { streamId: randomUUID(), sequence: 4 } };
  it("keeps a strict permission request and settlement while filtering request content", () => {
    const request = { ...controlBase, frame: { ...frameBase, type: "AGENT_PERMISSION_REQUEST", permissionId: "permission-e",
      request: { sessionId: "session-e", executionId: "execution-e", nativeRequestId: "native-e", title: literal,
        toolCall: { toolCallId: "tool-e", title: prefix, kind: "execute", status: "completed", rawOutput: { id: literal } },
        options: [{ optionId: "option-e", name: literal, kind: "allow_once" }] } } };
    const redact = filter([literal, "engine", "claude", "allow_once", "completed", "execute"]);
    const result = redact(request, "control");
    expect(CloudCompactControlEventSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({ ...request, frame: { ...request.frame, request: { ...request.frame.request, title: hidden,
      toolCall: { ...request.frame.request.toolCall, title: hidden, rawOutput: { id: hidden } },
      options: [{ optionId: "option-e", name: hidden, kind: "allow_once" }] } } });
    const settlement = { ...controlBase, frame: { ...frameBase, type: "AGENT_PERMISSION_SETTLED", permissionId: "permission-e",
      sessionId: "session-e", executionId: "execution-e" } };
    expect(redact(settlement, "control")).toEqual(settlement);
  });
  it("keeps question and option identities across request and answered settlement", () => {
    const question = { id: "field-e", prompt: literal, header: prefix, allowOther: true,
      options: [{ id: "option-e", label: literal, externalAction: { kind: "open-url", url: literal } }],
      defaultOptionIds: ["option-e"], defaultFreeText: prefix };
    const request = { ...controlBase, frame: { ...frameBase, type: "AGENT_QUESTION_REQUEST", questionId: "question-e",
      request: { sessionId: "session-e", executionId: "execution-e", nativeRequestId: "native-e", questionId: "question-e",
        source: "native_rpc", blocking: true, questions: [question] } } };
    const redact = filter([literal, "engine", "claude", "native_rpc", "open-url", "answered"]);
    const result = redact(request, "control");
    expect(CloudCompactControlEventSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ ...controlBase, frame: { ...frameBase, request: { ...request.frame.request, questions: [{
      ...question, prompt: hidden, header: hidden, defaultFreeText: hidden,
      options: [{ id: "option-e", label: hidden, externalAction: { kind: "open-url", url: hidden } }],
    }] } } });
    const settled = { ...controlBase, frame: { ...frameBase, type: "AGENT_QUESTION_SETTLED", questionId: "question-e",
      outcome: { outcome: "answered", answers: [{ questionId: "field-e", selectedOptionIds: ["option-e"], freeText: prefix }] } } };
    const terminal = redact(settled, "control");
    expect(CloudCompactControlEventSchema.safeParse(terminal).success).toBe(true);
    expect(terminal).toEqual({ ...settled, frame: { ...settled.frame, outcome: { outcome: "answered",
      answers: [{ questionId: "field-e", selectedOptionIds: ["option-e"], freeText: hidden }] } } });
  });

  it("redacts literals in decoded JSON without rewriting escapes or own prototype-like data keys", () => {
    const secret = 'synthetic-"quoted"\nprivate';
    const payload = JSON.parse('{"id":"message-e","kind":"text","text":"","__proto__":{"id":""}}') as Record<string, unknown>;
    payload.text = secret; (payload.__proto__ as Record<string, unknown>).id = secret;
    const result = restored(filter([secret])(message(payload), "message"));
    expect(result).toEqual(JSON.parse('{"id":"message-e","kind":"text","text":"[redacted]","__proto__":{"id":"[redacted]"}}'));
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
  });

  it.each([
    { version: 2, chat: {} }, { version: 1, chat: null }, { version: 1, chat: { id: { text: literal } } },
  ])("refuses malformed structural records without exporting their contents", document => {
    expect(() => filter()(document, "chat")).toThrow("Cloud history redaction refused");
  });
  it.each([
    "{", "null", "[]", '{"kind":"unknown","text":"private"}', '{"kind":"text","attachments":{}}',
    '{"kind":"tool","content":[{"type":"unknown"}]}',
  ])("refuses malformed or unsupported payload %s", payload => {
    expect(() => filter()({ version: 1, payload }, "message")).toThrow();
  });
  it("bounds parsed JSON depth before recursive filtering", () => {
    const payload = '{"kind":"text","extra":' + '['.repeat(34) + '0' + ']'.repeat(34) + '}';
    expect(() => filter()({ version: 1, payload }, "message")).toThrow("Invalid canonical history document");
  });
});
