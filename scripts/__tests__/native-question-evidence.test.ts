import { describe, expect, it } from "vitest";
import { NativeQuestionEvidence } from "../cloud-workspace-validation/lib/native-question-evidence";
import { buildMcpElicitationQuestion } from "../../apps/desktop/src/engine/agents/adapters/shared/mcp-elicitation";

const emptySummary = () => ({ version: 1, requests: 0, overflowed: false,
  sources: { native_dialog: 0, native_rpc: 0, inferred_from_text: 0, unknown: 0 },
  blocking: { yes: 0, no: 0, unknown: 0 }, elicitation: { mcp: 0, notIndicated: 0, unknown: 0 } });

describe("bounded canonical qualification questions", () => {
  it("starts with measured zeros and separates native blocking, native async and inferred requests", () => {
    const evidence = new NativeQuestionEvidence();
    expect(evidence.summary()).toEqual(emptySummary());
    for (const request of [
      { source: "native_dialog", blocking: true },
      { source: "native_dialog", blocking: false },
      { source: "native_rpc", blocking: true },
      { source: "inferred_from_text", blocking: false },
    ]) evidence.observe({ ...request, sessionId: "private-session", questionId: "private-question", nativeRequestId: "private-native",
      toolCallId: "private-tool", questions: [{ prompt: "synthetic private question", options: [{ label: "private label" }] }] });
    expect(evidence.summary()).toEqual({ ...emptySummary(), requests: 4,
      sources: { native_dialog: 2, native_rpc: 1, inferred_from_text: 1, unknown: 0 },
      blocking: { yes: 2, no: 2, unknown: 0 }, elicitation: { mcp: 0, notIndicated: 4, unknown: 0 } });
    expect(JSON.stringify(evidence.summary())).not.toContain("private");
  });
  it.each([
    { mode: "form" as const, message: "synthetic private form", requestedSchema: { type: "object", properties: {} } },
    { mode: "url" as const, message: "synthetic private url", url: "https://example.invalid/private", elicitationId: "private-elicitation" },
  ])("classifies the maintained MCP decline marker without keeping form or URL content", request => {
    const evidence = new NativeQuestionEvidence();
    evidence.observe(buildMcpElicitationQuestion({ request, sessionId: "private-session", questionId: "private-question",
      nativeRequestId: "private-native", toolCallId: "private-tool" }));
    expect(evidence.summary()).toEqual({ ...emptySummary(), requests: 1,
      sources: { ...emptySummary().sources, native_rpc: 1 }, blocking: { yes: 1, no: 0, unknown: 0 },
      elicitation: { mcp: 1, notIndicated: 0, unknown: 0 } });
    expect(JSON.stringify(evidence.summary())).not.toContain("private");
  });
  it("does not infer elicitation or valid metadata from private or malformed fields", () => {
    const evidence = new NativeQuestionEvidence();
    for (const request of [
      { source: "private-source", blocking: "true", allowDecline: "true" },
      { source: "native_dialog", blocking: true, allowDecline: true },
      { source: "native_rpc", blocking: false, allowDecline: true },
      { source: "inferred_from_text", blocking: false, allowDecline: false },
    ]) evidence.observe({ ...request, questions: [{ prompt: "MCP elicitation request_user_input private".repeat(4096) }],
      private: { source: "native_rpc", blocking: true, allowDecline: true } });
    evidence.observe(null);
    expect(evidence.summary()).toEqual({ ...emptySummary(), requests: 5,
      sources: { native_dialog: 1, native_rpc: 1, inferred_from_text: 1, unknown: 2 },
      blocking: { yes: 1, no: 2, unknown: 2 }, elicitation: { mcp: 0, notIndicated: 2, unknown: 3 } });
    const snapshot = evidence.summary(); snapshot.sources.native_rpc = 100;
    expect(evidence.summary().sources.native_rpc).toBe(1);
    expect(JSON.stringify(evidence.summary())).not.toContain("private");
  });
  it("saturates only diagnostic counters with an explicit overflow marker", () => {
    const evidence = new NativeQuestionEvidence();
    for (let index = 0; index < 2050; index++) evidence.observe({ source: "native_rpc", blocking: true, allowDecline: true });
    expect(evidence.summary()).toEqual({ ...emptySummary(), requests: 2048, overflowed: true,
      sources: { ...emptySummary().sources, native_rpc: 2048 }, blocking: { yes: 2048, no: 0, unknown: 0 },
      elicitation: { mcp: 2048, notIndicated: 0, unknown: 0 } });
  });
});
