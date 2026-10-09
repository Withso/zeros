import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudCompactControlFrameSchema } from "../cloud-events";
import type { BridgeMessage } from "../messages";

const executionId = randomUUID();
const base = { id: randomUUID(), timestamp: 123, source: "engine" as const, chatId: "chat",
  cloudStream: { streamId: randomUUID(), sequence: 17 } };
const permission: BridgeMessage = { ...base, type: "AGENT_PERMISSION_REQUEST", agentId: "claude", permissionId: randomUUID(),
  request: { sessionId: executionId, executionId, toolCall: { toolCallId: "native-tool", title: "Synthetic tool", kind: "execute",
    rawInput: { command: "synthetic fixture" } }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    requiresExplicitApproval: true, allowLocalPolicies: false } };
const question: BridgeMessage = { ...base, type: "AGENT_QUESTION_REQUEST", agentId: "codex", questionId: "native-question",
  request: { sessionId: executionId, executionId, questionId: "native-question", nativeRequestId: "rpc-17", source: "native_rpc",
    blocking: true, allowDecline: true, questions: [{ id: "q0", prompt: "Synthetic question", options: [], allowOther: true,
      allowEmptyFreeText: true, preserveFreeText: true, secret: true }] } };

describe("compact cloud interaction frames", () => {
  it.each(["rawInput", "rawOutput", "content"] as const)("preserves inert nested __proto__ JSON bytes in %s", field => {
    const data: unknown = JSON.parse('{"__proto__":{"synthetic":"inert"},"nested":{"__proto__":null},"value":1}');
    const frame = { ...permission, request: { ...permission.request,
      toolCall: { ...permission.request.toolCall, [field]: field === "content" ? [data] : data } } };
    const parsed = CloudCompactControlFrameSchema.parse(frame);
    if (parsed.type !== "AGENT_PERMISSION_REQUEST") throw new Error("Unexpected compact frame");
    expect(JSON.stringify(parsed.request.toolCall[field])).toBe(JSON.stringify(frame.request.toolCall[field]));
    expect(parsed).toEqual(frame);
    expect(Object.prototype).not.toHaveProperty("synthetic");
  });
  it.each([
    permission,
    { ...base, type: "AGENT_PERMISSION_SETTLED", agentId: "claude", permissionId: "permission", sessionId: executionId, executionId },
    question,
    { ...base, type: "AGENT_QUESTION_SETTLED", agentId: "codex", questionId: "native-question", outcome: { outcome: "answered",
      answers: [{ questionId: "q0", selectedOptionIds: [], freeText: "synthetic response" }] } },
  ])("preserves the exact live $type shape and native resolver identity", frame => {
    expect(CloudCompactControlFrameSchema.parse(frame)).toEqual(frame);
  });

  it.each(["AGENT_SESSION_UPDATE", "AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED", "DB_CHANGED", "PTY_DATA"])("excludes %s from the compact control channel", type => {
    expect(CloudCompactControlFrameSchema.safeParse({ ...permission, type }).success).toBe(false);
  });

  it("retains the native project permission option without granting persistence authority", () => {
    const frame: BridgeMessage = { ...permission, request: { ...permission.request,
      options: [{ optionId: "project", name: "Allow for this project", kind: "allow_always_project" }] } };
    expect(CloudCompactControlFrameSchema.parse(frame)).toEqual(frame);
  });

  it("rejects undeclared fields, foreign source, missing resolver and invalid native outcome", () => {
    for (const frame of [{ ...permission, endpoint: "https://invalid.example" }, { ...permission, source: "renderer" },
      { ...permission, permissionId: "" }, { ...question, request: { ...question.request, extra: true } },
      { ...base, type: "AGENT_QUESTION_SETTLED", agentId: "codex", questionId: "q", outcome: { outcome: "cancelled" } }])
      expect(CloudCompactControlFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("refuses oversized control bodies instead of silently stripping prompt or tool state", () => {
    const large = { ...permission, request: { ...permission.request, toolCall: { ...permission.request.toolCall,
      rawInput: { text: "x".repeat(256 * 1024) } } } };
    expect(CloudCompactControlFrameSchema.safeParse(large).success).toBe(false);
  });
});
