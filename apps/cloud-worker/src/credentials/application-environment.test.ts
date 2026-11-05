import { describe, expect, it } from "vitest";
import { ApplicationEnvironment } from "./application-environment";

describe("application secret diagnostics", () => {
  const canary = 'synthetic-app-"value"\nsecond', fileSecret = "synthetic-file-only";
  const environment = () => new ApplicationEnvironment({ variables: { APP_SECRET: canary }, files: [{ path: ".env.local", content: `FILE_SECRET=${fileSecret}\n` }] });
  it("removes literal, JSON-escaped, URI and encoded values without logging replacements twice", () => {
    const app = environment();
    for (const value of [canary, JSON.stringify(canary).slice(1, -1), encodeURIComponent(canary), Buffer.from(canary).toString("base64"), fileSecret]) {
      expect(app.text(`before ${value} after`) === "before [redacted] after").toBe(true);
    }
    expect(new ApplicationEnvironment({ variables: { VALUE: "redacted" }, files: [] }).text("redacted redacted")).toBe("[redacted] [redacted]");
  });
  it("preserves protocol and history identities when a short app value occurs in their spelling", () => {
    const app = new ApplicationEnvironment({ variables: { VALUE: "text" }, files: [] });
    expect(app.value({ type: "text", sessionUpdate: "agent_message_chunk", sessionId: "text-id", content: { type: "text", text: "text" } }))
      .toEqual({ type: "text", sessionUpdate: "agent_message_chunk", sessionId: "text-id", content: { type: "text", text: "[redacted]" } });
    const data = JSON.stringify({ type: "text", text: "text" });
    expect(app.value({ msgId: "text", data })).toEqual({ msgId: "text", data: JSON.stringify({ type: "text", text: "[redacted]" }) });
  });
  it("redacts values split across every stream boundary and UTF-8 fragments", () => {
    const secret = "synthetic-☃-secret";
    for (let index = 1; index < Buffer.byteLength(secret); index++) {
      const app = new ApplicationEnvironment({ variables: { VALUE: secret }, files: [] }), chunks: string[] = [];
      const stream = app.stream(value => chunks.push(value)), bytes = Buffer.from(`before ${secret} after`);
      stream.push(bytes.subarray(0, 7 + index)); stream.push(bytes.subarray(7 + index)); stream.end();
      expect(chunks.join("") === "before [redacted] after").toBe(true);
    }
  });
  it("preserves error classification when an app value matches a protocol enum", () => {
    const app = new ApplicationEnvironment({ variables: { VALUE: "error" }, files: [] });
    expect(app.value({ sessionId: "execution", update: { sessionUpdate: "error_notice", severity: "error",
      code: "provider_error", failureKind: "authentication", message: "error", recoverable: false } })).toEqual({
      sessionId: "execution", update: { sessionUpdate: "error_notice", severity: "error", code: "provider_error",
        failureKind: "authentication", message: "[redacted]", recoverable: false },
    });
  });
  it("raw tool data cannot inherit protocol identity exclusions", () => {
    const app = environment();
    expect(app.value({ sessionId: "execution", update: { sessionUpdate: "tool_call", toolCallId: "tool",
      rawOutput: { id: canary, type: canary, data: JSON.stringify({ sessionId: fileSecret }) } } })).toEqual({
      sessionId: "execution", update: { sessionUpdate: "tool_call", toolCallId: "tool",
        rawOutput: { id: "[redacted]", type: "[redacted]", data: JSON.stringify({ sessionId: "[redacted]" }) } },
    });
  });
  it("preserves fallback and mode facts but scrubs an ordinary rationale with the same text", () => {
    const app = new ApplicationEnvironment({ variables: { VALUE: "overloaded", MODE: "plan", MODEL: "fixture-model" }, files: [] });
    const fallback = { provider: "claude", fromModel: "fixture-model", toModel: "fixture-model-next", scope: "session", reason: "overloaded" };
    expect(app.value({ sessionUpdate: "model_fallback", ...fallback })).toEqual({ sessionUpdate: "model_fallback", ...fallback });
    expect(app.value({ data: JSON.stringify({ modelFallback: fallback }) })).toEqual({ data: JSON.stringify({ modelFallback: fallback }) });
    expect(app.value({ sessionUpdate: "mode_switch", from: "plan", to: "bypass", reason: "plan overloaded" }))
      .toEqual({ sessionUpdate: "mode_switch", from: "plan", to: "bypass", reason: "[redacted] [redacted]" });
  });
  it("scrubs arbitrary diagnostic JSON regardless of its property names", () => {
    const app = environment();
    const output = app.diagnostic(JSON.stringify({ id: canary, type: fileSecret, nested: { [fileSecret]: canary } }));
    expect(output.includes(fileSecret) || output.includes(JSON.stringify(canary).slice(1, -1))).toBe(false);
  });
});
