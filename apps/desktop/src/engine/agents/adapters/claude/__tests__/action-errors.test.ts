import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { ClaudeStreamTranslator } from "../translator";

const assistant = (id: string, text: string, error?: string) => ({
  type: "assistant", uuid: id, error,
  message: { id, stop_reason: "end_turn", content: [{ type: "text", text }] },
});
const stream = (event: object, parent_tool_use_id?: string) => ({ type: "stream_event", event, parent_tool_use_id });

describe("Claude user-action error identities", () => {
  it.each(["verification_required", "cloud_credential_error"])("cannot restore a recovered %s by replaying its native frame", (code) => {
    let messages: AgentMessage[] = [];
    const translator = new ClaudeStreamTranslator({ sessionId: "s", streamPartials: true, emit: (n) => { messages = applyUpdate(messages, n); } });
    const error = assistant("error-id", "Provider explanation", code);
    translator.feed(error);
    expect(translator.pendingUserActionFailure?.code).toBe(code);
    translator.feed(assistant("recovered-id", "Recovered output"));
    const confirmed = messages;
    translator.feed(error);
    expect(translator.pendingUserActionFailure).toBeNull();
    expect(messages).toBe(confirmed);
    translator.feed({ type: "result", subtype: "error_during_execution", errors: ["A different error."] });
    expect(translator.terminalFailure).toEqual({ code: undefined, message: "A different error." });
  });

  it.each(["verification_required", "cloud_credential_error"])("does not demote completed output or add model work for %s", (code) => {
    let messages: AgentMessage[] = [];
    const translator = new ClaudeStreamTranslator({ sessionId: "s", emit: (n) => { messages = applyUpdate(messages, n); } });
    translator.feed(assistant("report", "First report"));
    const confirmed = messages;
    translator.feed(assistant("error", "Provider explanation", code));
    expect(messages).toBe(confirmed);
    expect(translator.pendingUserActionFailure?.code).toBe(code);
    translator.feed({ type: "system", subtype: "model_refusal_fallback", scope: "local", retracted_message_uuids: ["error"] });
    expect(translator.pendingUserActionFailure).toBeNull();
  });

  it("requires new parent content before clearing a pending setup failure", () => {
    const translator = new ClaudeStreamTranslator({ sessionId: "s", streamPartials: true, emit: () => {} });
    translator.feed(assistant("error", "Verify your account", "verification_required"));
    translator.feed(stream({ type: "message_start", message: { id: "retry" } }));
    translator.feed(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    translator.feed(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child content" } }, "child"));
    expect(translator.pendingUserActionFailure?.code).toBe("verification_required");
    translator.feed(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Parent recovered" } }));
    expect(translator.pendingUserActionFailure).toBeNull();
  });
});
