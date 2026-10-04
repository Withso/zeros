import { describe, expect, it } from "vitest";
import { CloudCustomizationRedactor } from "../cloud-customization-redaction";

describe("execution MCP secret redaction", () => {
  it("adds scoped product headers to the same transcript and history filter", () => {
    const redactor = new CloudCustomizationRedactor(["existing-user-secret"]);
    redactor.addSecrets(["Bearer synthetic-computer-capability"]);
    expect(redactor.value("existing-user-secret Bearer synthetic-computer-capability")).toBe("[redacted] [redacted]");
    expect(redactor.stream("reply", "synthetic-computer-")).toBe("");
    expect(redactor.stream("reply", "capability")).toBe("[redacted]");
  });
  it("removes configured values from tool results, nested receipts and stderr", () => {
    const redactor = new CloudCustomizationRedactor(["synthetic-private-value"]);
    expect(JSON.stringify(redactor.value({ rawOutput: { content: [{ text: "failed: synthetic-private-value" }] } }))).not.toContain("synthetic-private-value");
    expect(redactor.stream("stderr", "synthetic-private-value\n")).toBe("[redacted]\n");
  });
  it("holds only a potential secret prefix and removes secrets split across chunks", () => {
    const redactor = new CloudCustomizationRedactor(["synthetic-private-value"]);
    const values = ["Ordinary text. syn", "thetic-", "private", "-value. Done."].map(value => redactor.stream("reply", value));
    expect(values[0]).toBe("Ordinary text. ");
    expect(values.join("")).toBe("Ordinary text. [redacted]. Done.");
    expect(redactor.stream("another", "value is unrelated")).toBe("value is unrelated");
  });
  it("redacts an ambiguous partial match when the turn finishes", () => {
    const redactor = new CloudCustomizationRedactor(["synthetic-private-value"]);
    const streamed = redactor.stream("reply", "Description: syn");
    expect(streamed + redactor.finish("reply")).toBe("Description: [redacted]");
    expect(redactor.finish("reply")).toBe("");
    expect(redactor.stream("reply", "synthetic-private-value") + redactor.finish("reply")).toBe("[redacted]");
  });
  it("flushes a partial suffix to the same message and subagent as an append", () => {
    const redactor = new CloudCustomizationRedactor(["synthetic-private-value"]);
    redactor.notification({ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", messageId: "message", parentToolId: "task", textMode: "replace", content: { type: "text", text: "Normal syn" } } });
    expect(redactor.finishSession("another-session")).toEqual([]);
    expect(redactor.finishSession("session")).toEqual([{ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", messageId: "message", parentToolId: "task", content: { type: "text", text: "[redacted]" } } }]);
    expect(redactor.finishSession("session")).toEqual([]);
  });
});

it("keeps identity and permission metadata intact for short values while removing their displayed occurrences", () => {
  const redactor = new CloudCustomizationRedactor(["1", "completed", "allow_once"]);
  const event = redactor.notification({ sessionId: "s1", executionId: "e1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", parentToolId: "p1", phase: "commentary", content: { type: "text", text: "value 1 completed" } } });
  expect(event).toMatchObject({ sessionId: "s1", executionId: "e1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", parentToolId: "p1", phase: "commentary", content: { type: "text", text: "value [redacted] [redacted]" } } });
  const permission = redactor.permission({ sessionId: "s1", nativeRequestId: "n1", toolCall: { toolCallId: "t1", title: "value 1", status: "completed" }, options: [{ optionId: "o1", kind: "allow_once", name: "Allow 1" }] });
  expect(permission).toMatchObject({ sessionId: "s1", nativeRequestId: "n1", toolCall: { toolCallId: "t1", status: "completed", title: "value [redacted]" }, options: [{ optionId: "o1", kind: "allow_once", name: "Allow [redacted]" }] });
  expect(redactor.question({ sessionId: "s1", questionId: "q1", nativeRequestId: "n1", source: "native_rpc", blocking: true, questions: [{ id: "f1", prompt: "value 1", options: [{ id: "o1", label: "value 1" }], allowOther: true }] })).toMatchObject({ sessionId: "s1", questionId: "q1", questions: [{ id: "f1", prompt: "value [redacted]", options: [{ id: "o1", label: "value [redacted]" }] }] });
});

it("never releases a nearly complete secret when a stream or tool ends prematurely", () => {
  const literal = "synthetic-opaque-very-private";
  const redactor = new CloudCustomizationRedactor([literal]);
  expect(redactor.stream("text", literal.slice(0, -1)) + redactor.finish("text")).not.toContain(literal.slice(0, -1));
  const event = redactor.notification({ sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", rawOutput: literal.slice(0, -1) } });
  expect(JSON.stringify(event)).not.toContain(literal.slice(0, -1));
});

it("redacts overlapping complete values before withholding a snapshot suffix", () => {
  const redactor = new CloudCustomizationRedactor(["abcabc"]);
  const event = redactor.notification({ sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress", rawOutput: "abcabc" } });
  expect(event.update).toHaveProperty("rawOutput", "[redacted]");
});
