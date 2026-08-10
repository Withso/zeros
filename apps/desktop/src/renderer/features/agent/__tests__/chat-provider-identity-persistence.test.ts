import { describe, expect, it } from "vitest";

import { providerIdentityClearForTransition } from "../chat-provider-identity-persistence";

const binding = {
  version: 1 as const,
  providerId: "codex",
  kind: "native" as const,
  resumeId: "thread-1",
};

describe("providerIdentityClearForTransition", () => {
  it("emits a guarded clear for an intentional same-agent reset", () => {
    expect(
      providerIdentityClearForTransition(
        { id: "chat-1", agentId: "codex", providerBinding: binding },
        { id: "chat-1", agentId: "codex", providerBinding: null },
      ),
    ).toEqual({
      chatId: "chat-1",
      agentId: "codex",
      resumeId: "thread-1",
    });
  });

  it("does not turn incomplete snapshots or agent changes into clears", () => {
    expect(
      providerIdentityClearForTransition(undefined, {
        id: "chat-1",
        agentId: "codex",
        providerBinding: null,
      }),
    ).toBeNull();
    expect(
      providerIdentityClearForTransition(
        { id: "chat-1", agentId: "codex", providerBinding: binding },
        { id: "chat-1", agentId: "claude", providerBinding: null },
      ),
    ).toBeNull();
    expect(
      providerIdentityClearForTransition(
        { id: "chat-1", agentId: "codex", providerBinding: binding },
        { id: "chat-1", agentId: "codex", providerBinding: binding },
      ),
    ).toBeNull();
  });
});
