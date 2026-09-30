import { describe, expect, it } from "vitest";
import { cloudSessionMetadata } from "../cloud-session-metadata";
import { BLANK } from "../sessions-store";
import { cloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
import type { AgentSessionCreatedMessage } from "../../../platform/bridge/messages";

const executionId = cloudScopedId(
  {
    organizationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
  },
  "conversation:chat",
);
const message = {
  type: "AGENT_SESSION_CREATED",
  agentId: "codex",
  session: {
    executionId,
    sessionId: executionId,
    modes: {
      currentModeId: "ask",
      availableModes: [{ id: "ask", name: "Ask" }],
    },
  },
  initialize: { protocolVersion: 1, agentCapabilities: { steering: true } },
} as AgentSessionCreatedMessage;
describe("cloud attachment metadata", () => {
  it("updates the same session without replacing a running turn or transcript", () => {
    const slot = {
      ...BLANK,
      executionId,
      sessionId: executionId,
      agentId: "codex",
      status: "streaming" as const,
      activeTurnStartedAt: 10,
    };
    const patch = cloudSessionMetadata(slot, message);
    expect(patch).toMatchObject({
      initialize: message.initialize,
      currentModeId: "ask",
      availableModes: message.session.modes!.availableModes,
    });
    expect({ ...slot, ...patch }).toMatchObject({
      status: "streaming",
      activeTurnStartedAt: 10,
      executionId,
    });
    expect(patch).not.toHaveProperty("messages");
  });
  it("ignores stale routes, other providers, local handshakes and unbound chats", () => {
    const slot = {
      ...BLANK,
      executionId,
      sessionId: executionId,
      agentId: "codex",
    };
    expect(cloudSessionMetadata(undefined, message)).toBeNull();
    expect(
      cloudSessionMetadata({ ...slot, executionId: "replacement" }, message),
    ).toBeNull();
    expect(
      cloudSessionMetadata({ ...slot, agentId: "claude" }, message),
    ).toBeNull();
    const local = {
      ...message,
      session: { ...message.session, executionId: "local", sessionId: "local" },
    };
    expect(
      cloudSessionMetadata({ ...slot, executionId: "local" }, local),
    ).toBeNull();
  });
});
