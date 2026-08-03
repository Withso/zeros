import { beforeEach, describe, expect, it } from "vitest";

import type { RequestPermissionRequest } from "../../bridge/agent-events";
import { BLANK, useSessionsStore } from "../sessions-store";

const request = (
  sessionId: string,
  nativeRequestId: string,
  title: string,
): RequestPermissionRequest => ({
  sessionId,
  nativeRequestId,
  title,
  toolCall: {
    toolCallId: nativeRequestId,
    title: "Bash",
    kind: "execute",
    status: "pending",
    rawInput: { command: "pnpm test" },
  },
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ],
});

describe("sessions-store permission queue", () => {
  beforeEach(() => useSessionsStore.getState().clearAll());

  it("serializes concurrent helper gates without changing the one-card UI", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
    });
    store.applyBridgePermissionRequest(
      "claude",
      "permission-1",
      request("session-a", "native-1", "Allow network access"),
    );
    store.applyBridgePermissionRequest(
      "claude",
      "permission-2",
      request("session-a", "native-2", "Allow shell access"),
    );

    let slot = useSessionsStore.getState().sessions["chat-a"];
    expect(slot.pendingPermission?.permissionId).toBe("permission-1");
    expect(slot.pendingPermissions.map((item) => item.permissionId)).toEqual([
      "permission-1",
      "permission-2",
    ]);

    store.settlePendingPermission("chat-a", "permission-1");
    slot = useSessionsStore.getState().sessions["chat-a"];
    expect(slot.pendingPermission?.permissionId).toBe("permission-2");
    expect(slot.pendingPermissions).toHaveLength(1);
  });

  it("dedupes a replayed native request instead of showing it twice", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
    });
    store.applyBridgePermissionRequest(
      "claude",
      "permission-old",
      request("session-a", "native-1", "Allow network access"),
    );
    store.applyBridgePermissionRequest(
      "claude",
      "permission-replay",
      request("session-a", "native-1", "Allow network access"),
    );
    expect(
      useSessionsStore.getState().sessions["chat-a"].pendingPermissions,
    ).toHaveLength(1);
    expect(
      useSessionsStore.getState().sessions["chat-a"].pendingPermission
        ?.permissionId,
    ).toBe("permission-replay");
  });
});
