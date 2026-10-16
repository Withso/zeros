import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentControlConfirmationBroker,
  type AgentControlConfirmationInput,
} from "../agent-control/confirmations";

function input(
  overrides: Partial<AgentControlConfirmationInput> = {},
): AgentControlConfirmationInput {
  return {
    kind: "app",
    workspaceId: "ws_1",
    conversationId: "conv_a",
    agent: "codex",
    subject: "Safari",
    subjectId: "com.apple.Safari",
    ...overrides,
  } as AgentControlConfirmationInput;
}

describe("Zeros app and simulator approvals", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the request in main and resolves only the user's answer", async () => {
    const onRequest = vi.fn();
    const onSettled = vi.fn();
    const broker = new AgentControlConfirmationBroker({ onRequest, onSettled });
    const pending = broker.confirm(input({ subject: "  Safari \n Web  " }));

    const request = onRequest.mock.calls[0]![0];
    expect(request).toMatchObject({
      kind: "app",
      agent: "codex",
      subject: "Safari Web",
      subjectId: "com.apple.Safari",
    });
    expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(broker.respond(request.id, "maybe" as never)).toBe(false);
    expect(broker.respond(request.id, "allow")).toBe(true);
    await expect(pending).resolves.toBe("allow");
    expect(onSettled).toHaveBeenCalledWith(request.id);
    expect(broker.respond(request.id, "deny")).toBe(false);
  });

  it("denies without a trusted surface, with a full queue or an invalid subject", async () => {
    await expect(new AgentControlConfirmationBroker().confirm(input())).resolves.toBe(
      "deny",
    );
    const onRequest = vi.fn();
    const broker = new AgentControlConfirmationBroker({ onRequest, maxPending: 1 });
    const first = broker.confirm(input());
    await expect(broker.confirm(input({ subject: "Notes" }))).resolves.toBe("deny");
    await expect(
      new AgentControlConfirmationBroker({ onRequest }).confirm(
        input({ subjectId: "com.apple Safari" }),
      ),
    ).resolves.toBe("deny");
    await expect(
      new AgentControlConfirmationBroker({ onRequest }).confirm(input({ subject: "  " })),
    ).resolves.toBe("deny");
    broker.denyPending();
    await expect(first).resolves.toBe("deny");
  });

  it("denies when the turn stops, the request times out or delivery throws", async () => {
    vi.useFakeTimers();
    const onRequest = vi.fn();
    const broker = new AgentControlConfirmationBroker({ onRequest, timeoutMs: 1_000 });

    const controller = new AbortController();
    const aborted = broker.confirm(input(), controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBe("deny");

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(broker.confirm(input(), preAborted.signal)).resolves.toBe("deny");

    const timed = broker.confirm(input());
    vi.advanceTimersByTime(1_000);
    await expect(timed).resolves.toBe("deny");
    expect(broker.pendingRequests()).toEqual([]);

    const throwing = new AgentControlConfirmationBroker({
      onRequest: () => {
        throw new Error("renderer closed");
      },
    });
    await expect(throwing.confirm(input())).resolves.toBe("deny");
    expect(throwing.pendingRequests()).toEqual([]);
  });

  it("denies one chat's requests without touching another chat", async () => {
    const onRequest = vi.fn();
    const broker = new AgentControlConfirmationBroker({ onRequest });
    const a = broker.confirm(input());
    const b = broker.confirm(input({ conversationId: "conv_b" } as never));

    expect(broker.denyOwner("ws_1", "conv_a")).toBe(1);
    await expect(a).resolves.toBe("deny");
    const snapshot = broker.pendingRequests();
    expect(snapshot.map((request) => request.conversationId)).toEqual(["conv_b"]);
    snapshot.pop();
    expect(broker.pendingRequests()).toHaveLength(1);
    expect(broker.denyPending()).toBe(1);
    await expect(b).resolves.toBe("deny");
  });

  it("keeps the decision when the settlement notification throws", async () => {
    const onRequest = vi.fn();
    const broker = new AgentControlConfirmationBroker({
      onRequest,
      onSettled: () => {
        throw new Error("tombstone channel closed");
      },
    });
    const pending = broker.confirm(input());
    broker.respond(onRequest.mock.calls[0]![0].id, "allow");
    await expect(pending).resolves.toBe("allow");
  });

  it("rejects unusable limits", () => {
    expect(() => new AgentControlConfirmationBroker({ timeoutMs: 0 })).toThrow();
    expect(() => new AgentControlConfirmationBroker({ maxPending: 1.5 })).toThrow();
  });
});
