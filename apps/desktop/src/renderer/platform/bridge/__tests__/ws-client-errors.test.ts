import { describe, expect, it, vi } from "vitest";

import {
  RuntimeClient,
  describeConnectionRejection,
  isRejectionRetryableAfterEngineRestart,
} from "../ws-client";

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
