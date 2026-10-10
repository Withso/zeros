import { describe, expect, it, vi } from "vitest";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import { ZerosEngine } from "../zeros-engine";

const methods = ZerosEngine.prototype as unknown as {
  routeSessionScoped(this: unknown, executionId: string, message: BridgeMessage): void;
};
describe("cloud stream conversation ownership", () => {
  it.each(["AGENT_PERMISSION_REQUEST", "AGENT_PERMISSION_SETTLED", "AGENT_QUESTION_REQUEST", "AGENT_QUESTION_SETTLED"])(
    "identifies %s before a cold attachment knows its native execution", type => {
      const router = { routeToSession: vi.fn(), broadcastLocal: vi.fn() };
      const engine = { cloudWorker: {}, sessionChat: new Map([["native", "chat"]]), router };
      const message = type === "AGENT_PERMISSION_REQUEST" ? createMessage({ type, source: "engine", agentId: "claude", permissionId: "permission",
        request: { sessionId: "native", toolCall: { toolCallId: "tool", title: "Read", kind: "read" }, options: [] } }) :
        type === "AGENT_PERMISSION_SETTLED" ? createMessage({ type, source: "engine", agentId: "claude", permissionId: "permission", sessionId: "native" }) :
        type === "AGENT_QUESTION_REQUEST" ? createMessage({ type, source: "engine", agentId: "claude", questionId: "question",
          request: { sessionId: "native", questionId: "question", nativeRequestId: "native-question", source: "native_rpc", blocking: true, questions: [] } }) :
        createMessage({ type: "AGENT_QUESTION_SETTLED", source: "engine", agentId: "claude", questionId: "question", outcome: { outcome: "dismissed" } });
      methods.routeSessionScoped.call(engine, "native", message);
      expect(router.routeToSession).toHaveBeenCalledWith("native", { ...message, chatId: "chat" });
    },
  );
  it.each([false, true])("preserves Local routing and envelopes (restricted=%s)", restricted => {
    const router = { routeToSession: vi.fn(), broadcastLocal: vi.fn() };
    const engine = { cloudWorker: null, sessionChat: new Map([["native", "chat"]]), router, sessionRestrictedFromRemote: () => restricted };
    const message = createMessage({ type: "AGENT_PERMISSION_SETTLED", source: "engine", agentId: "claude", sessionId: "native", permissionId: "permission" });
    methods.routeSessionScoped.call(engine, "native", message);
    expect(restricted ? router.broadcastLocal : router.routeToSession).toHaveBeenCalledWith(...(restricted ? [message] : ["native", message]));
    expect(message).not.toHaveProperty("chatId");
  });
});
