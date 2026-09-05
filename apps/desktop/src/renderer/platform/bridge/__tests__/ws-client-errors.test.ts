import { describe, expect, it, vi } from "vitest";

import {
  RuntimeClient,
  cloudRuntimeWebSocketProtocols,
  describeConnectionRejection,
  isRejectionRetryableAfterEngineRestart,
  parseInboundBridgeWebSocketFrame,
  parseRuntimeConnectionTarget,
} from "../ws-client";
import { setAuthAccessToken } from "../../../features/auth/auth-token";

const RUNTIME_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ENGINE_INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const CLOUD_TOKEN = `zws_${"a".repeat(43)}`;

function cloudTarget(now: number) {
  return {
    kind: "cloud" as const,
    channel: "electron-ssh-tunnel" as const,
    runtimeId: RUNTIME_ID,
    organizationId: ORGANIZATION_ID,
    workspaceId: WORKSPACE_ID,
    generation: 7,
    authorityEpoch: 11,
    engineInstanceId: ENGINE_INSTANCE_ID,
    connectionSequence: 1,
    url: "ws://127.0.0.1:54173/ws",
    cloudToken: CLOUD_TOKEN,
    expiresAt: now + 60_000,
  };
}

describe("qualified cloud runtime connection target", () => {
  it("uses an exact Electron loopback tunnel and a subprotocol bearer", () => {
    const now = 1_800_000_000_000;
    const target = parseRuntimeConnectionTarget(cloudTarget(now), now);
    if (target.kind !== "cloud") throw new Error("expected cloud target");
    expect(target).toEqual(cloudTarget(now));
    const protocols = cloudRuntimeWebSocketProtocols(target.cloudToken);
    expect(protocols[0]).toBe("zeros-v1");
    expect(protocols.join(",")).not.toContain(target.cloudToken);
    expect(new URL(target.url).search).toBe("");
  });

  it.each([
    {
      ...cloudTarget(1_800_000_000_000),
      url: "ws://engine.example/ws",
    },
    {
      ...cloudTarget(1_800_000_000_000),
      url: "ws://127.0.0.1:54173/ws?token=leak",
    },
    {
      ...cloudTarget(1_800_000_000_000),
      url: "ws://127.0.0.1:54173/not-ws",
    },
    {
      ...cloudTarget(1_800_000_000_000),
      cloudToken: "short",
    },
    {
      ...cloudTarget(1_800_000_000_000),
      expiresAt: 1_799_999_999_999,
    },
  ])("rejects an unsafe or expired target %#", (target) => {
    expect(() =>
      parseRuntimeConnectionTarget(target, 1_800_000_000_000),
    ).toThrow(/cloud runtime connection/i);
  });

  it("expires an installed descriptor exactly once instead of reconnecting with stale authority", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const client = new RuntimeClient(cloudTarget(1_800_000_000_000));
      const expired: number[] = [];
      client.onConnectionTargetExpired(() => {
        throw new Error("broken observer");
      });
      client.onConnectionTargetExpired((event) =>
        expired.push(event.expiresAt),
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(expired).toEqual([1_800_000_060_000]);
      expect(client.status).toBe("disconnected");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(expired).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledOnce();
      client.dispose();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("refreshes a consumed descriptor with an exact monotonic session sequence", async () => {
    const now = Date.now();
    const first = cloudTarget(now);
    const refresh = vi.fn(async () => ({
      ...first,
      connectionSequence: 2,
      cloudToken: `zws_${"b".repeat(43)}`,
      expiresAt: now + 120_000,
    }));
    const client = new RuntimeClient(first, {
      refreshCloudConnectionTarget: refresh,
    });
    const internals = client as unknown as {
      cloudTargetNeedsRefresh: boolean;
      connectionTarget: unknown;
      refreshCurrentCloudTarget(): Promise<boolean>;
    };
    internals.cloudTargetNeedsRefresh = true;

    await expect(internals.refreshCurrentCloudTarget()).resolves.toBe(true);
    expect(internals.connectionTarget).toMatchObject({
      runtimeId: RUNTIME_ID,
      connectionSequence: 2,
      cloudToken: `zws_${"b".repeat(43)}`,
    });
    expect(refresh).toHaveBeenCalledWith(first);
    client.dispose();
  });

  it("rejects a refresh that changes the runtime identity or skips sequence", async () => {
    const now = Date.now();
    const first = cloudTarget(now);
    const client = new RuntimeClient(first, {
      refreshCloudConnectionTarget: vi.fn(async () => ({
        ...first,
        runtimeId: "99999999-9999-4999-8999-999999999999",
        connectionSequence: 3,
        expiresAt: now + 120_000,
      })),
    });
    const internals = client as unknown as {
      refreshCurrentCloudTarget(): Promise<boolean>;
    };

    await expect(internals.refreshCurrentCloudTarget()).resolves.toBe(false);
    client.dispose();
  });

  it("never sends the reusable WorkOS bearer into an admitted cloud engine", () => {
    setAuthAccessToken("workos-access-token-must-stay-on-mac");
    try {
      const client = new RuntimeClient(cloudTarget(Date.now()));
      const send = vi.fn();
      const internals = client as unknown as {
        send: (message: Record<string, unknown>) => void;
        onTransportOpen(): void;
      };
      internals.send = send;
      internals.onTransportOpen();

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "CONNECTED" }),
      );
      expect(send.mock.calls[0]![0]).not.toHaveProperty("authToken");
      expect(JSON.stringify(send.mock.calls[0]![0])).not.toContain(
        "workos-access-token-must-stay-on-mac",
      );
      client.dispose();
    } finally {
      setAuthAccessToken(null);
    }
  });
});

describe("RuntimeClient correlated domain errors", () => {
  it("resolves WORKSPACE_ERROR intact for workspaceOp to classify", async () => {
    const client = new RuntimeClient();
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<unknown>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const internals = client as unknown as {
      pendingRequests: Map<
        string,
        {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
          timer: null;
        }
      >;
      handleIncoming: (message: unknown) => void;
    };
    internals.pendingRequests.set("request-1", {
      resolve,
      reject,
      timer: null,
    });

    const message = {
      type: "WORKSPACE_ERROR",
      requestId: "request-1",
      op: "git.changeTarget",
      code: "GIT_COMMAND_FAILED",
      message: "rebase failed",
      remediation: "Resolve the current operation first.",
    };
    internals.handleIncoming(message);

    await expect(response).resolves.toBe(message);
    expect(internals.pendingRequests.has("request-1")).toBe(false);
  });
});

describe("untrusted WebSocket frame validation", () => {
  it("accepts a compatible engine envelope while dropping malformed or wrong-direction frames", () => {
    const compatible = JSON.stringify({
      id: "engine-ready-1",
      source: "engine",
      timestamp: Date.now(),
      type: "ENGINE_READY",
      futureEngineField: { tolerated: true },
    });
    expect(parseInboundBridgeWebSocketFrame(compatible)).toMatchObject({
      source: "engine",
      type: "ENGINE_READY",
    });
    expect(parseInboundBridgeWebSocketFrame("{not json")).toBeNull();
    expect(
      parseInboundBridgeWebSocketFrame(
        JSON.stringify({
          id: "browser-spoof",
          source: "browser",
          timestamp: Date.now(),
          type: "ENGINE_READY",
        }),
      ),
    ).toBeNull();
    // A newer engine's unrecognised type is deliberately ignored, matching
    // the old dispatch behavior rather than disconnecting mixed versions.
    expect(
      parseInboundBridgeWebSocketFrame(
        JSON.stringify({
          id: "future-engine-message",
          source: "engine",
          timestamp: Date.now(),
          type: "FUTURE_ENGINE_MESSAGE",
        }),
      ),
    ).toBeNull();
  });
});

// ── CONNECTION_REJECTED recovery ─────────────────────────────
//
// The engine's terminal rejection latch used to have NO consumer: ws-client
// suspended its reconnect ladder and the app silently wedged "disconnected"
// until relaunch. These tests pin the pure recovery policy (which reasons an
// engine respawn may retry, what copy the toast shows) and the latch plumbing
// BridgeProvider relies on.

describe("isRejectionRetryableAfterEngineRestart", () => {
  it.each([
    // Version skew against a STALE engine process — the respawned binary may
    // match the client again.
    "protocol-too-old",
    "protocol-too-new",
    // The engine had no (or not-yet-seeded) owner binding; a respawn re-seeds
    // from the local CONNECTED token.
    "auth-required",
    "desktop-unbound",
  ])("retries %s after a watchdog engine respawn", (reason) => {
    expect(isRejectionRetryableAfterEngineRestart(reason)).toBe(true);
  });

  it.each(["auth-invalid", "auth-wrong-account", "unknown", undefined, null])(
    "does NOT auto-retry %s (client credential is the problem, or unknown)",
    (reason) => {
      expect(isRejectionRetryableAfterEngineRestart(reason)).toBe(false);
    },
  );
});

describe("describeConnectionRejection", () => {
  it("maps each known reason to actionable copy", () => {
    expect(
      describeConnectionRejection({ reason: "protocol-too-old", message: "" })
        .headline,
    ).toMatch(/needs an update/i);
    expect(
      describeConnectionRejection({ reason: "protocol-too-new", message: "" })
        .headline,
    ).toMatch(/engine is out of date/i);
    for (const reason of ["auth-invalid", "auth-required"]) {
      expect(
        describeConnectionRejection({ reason, message: "" }).headline,
      ).toMatch(/sign in again/i);
    }
    expect(
      describeConnectionRejection({ reason: "auth-wrong-account", message: "" })
        .headline,
    ).toMatch(/different account/i);
    expect(
      describeConnectionRejection({ reason: "desktop-unbound", message: "" })
        .headline,
    ).toMatch(/sign in to zeros on your mac/i);
  });

  it("falls back to the engine's own message for an unknown reason", () => {
    const copy = describeConnectionRejection({
      reason: "some-future-reason",
      message: "engine said so",
    });
    expect(copy.headline).toMatch(/refused the connection/i);
    expect(copy.description).toBe("engine said so");
  });
});

describe("RuntimeClient rejection latch", () => {
  /** Feed a CONNECTION_REJECTED frame through the private inbound path. */
  function rejectClient(client: RuntimeClient, reason: string): void {
    (
      client as unknown as { handleIncoming: (message: unknown) => void }
    ).handleIncoming({
      type: "CONNECTION_REJECTED",
      reason,
      message: "nope",
    });
  }

  it("records the rejection and fans out to listeners (incl. late subscribers)", () => {
    const client = new RuntimeClient();
    const seen: string[] = [];
    client.onConnectionRejected((r) => seen.push(r.reason));

    rejectClient(client, "auth-required");
    expect(client.lastRejection).toEqual({
      reason: "auth-required",
      message: "nope",
    });
    expect(client.status).toBe("disconnected");
    expect(seen).toEqual(["auth-required"]);

    // A subscriber that mounts AFTER the rejection must still hear about it —
    // BridgeProvider's effect can run after a fast startup rejection.
    const late: string[] = [];
    client.onConnectionRejected((r) => late.push(r.reason));
    expect(late).toEqual(["auth-required"]);
  });

  it("clearRejection({ reconnect: false }) clears the latch without dialing", () => {
    const client = new RuntimeClient();
    const connect = vi.fn(async () => {});
    (client as unknown as { connect: () => Promise<void> }).connect = connect;

    rejectClient(client, "desktop-unbound");
    client.clearRejection({ reconnect: false });

    expect(client.lastRejection).toBeNull();
    // The engine-restarted path drives its own forceReconnect (which must
    // re-resolve the port first); a second concurrent connect() would race it.
    expect(connect).not.toHaveBeenCalled();
  });

  it("clearRejection() reconnects by default and is a no-op when not rejected", () => {
    const client = new RuntimeClient();
    const connect = vi.fn(async () => {});
    (client as unknown as { connect: () => Promise<void> }).connect = connect;

    // Not rejected → nothing happens (a stray call must not spawn sockets).
    client.clearRejection();
    expect(connect).not.toHaveBeenCalled();

    rejectClient(client, "auth-invalid");
    client.clearRejection();
    expect(client.lastRejection).toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
