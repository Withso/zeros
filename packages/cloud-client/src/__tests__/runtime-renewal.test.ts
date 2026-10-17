import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerCapabilityRenewed, ServerCapabilityRevoked } from "../generated/device-stream";
import type { Capabilities } from "../generated/rest";
import { CloudRestError } from "../rest-client";
import {
  RuntimeRenewal,
  type RuntimeRenewalEvent,
  type RuntimeRenewalOptions,
} from "../runtime-renewal";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_SESSION_ID = "0f8c6d2e-3b1a-4c5d-8e9f-0a1b2c3d4e5f";
const OTHER_CLIENT_SESSION_ID = "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a";
const T0 = 1_760_000_000_000;
/** T0 in seconds, the unit of the iat and exp claims. */
const S0 = T0 / 1000;

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** A compact JWS whose payload is `claims`; the signature segment is a placeholder. */
function token(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  return `${header}.${base64url(JSON.stringify(claims))}.${"s".repeat(86)}`;
}

/** Capabilities whose engine token has `iat` (omitted when undefined) and `exp`, both in seconds. */
function caps(iatSeconds: number | undefined, expSeconds: number): Capabilities {
  const engineClaims: Record<string, unknown> = { aud: "zeros:engine", wsp: WORKSPACE_ID, jti: `engine-${expSeconds}` };
  if (iatSeconds !== undefined) engineClaims.iat = iatSeconds;
  engineClaims.exp = expSeconds;
  const expiresAt = new Date(expSeconds * 1000).toISOString();
  return {
    engine: { token: token(engineClaims), expiresAt },
    realtime: {
      token: token({ aud: "zeros:realtime", wsp: WORKSPACE_ID, jti: `realtime-${expSeconds}`, exp: expSeconds }),
      expiresAt,
    },
  };
}

/** Capabilities whose engine token does not decode. */
function unusable(): Capabilities {
  const usable = caps(S0, S0 + 300);
  return { ...usable, engine: { token: "not-a-token", expiresAt: usable.engine.expiresAt } };
}

function renewedFrame(
  capabilities: Capabilities,
  ids: { workspaceId?: string; clientSessionId?: string } = {},
): ServerCapabilityRenewed {
  return {
    t: "capability.renewed",
    d: {
      workspaceId: ids.workspaceId ?? WORKSPACE_ID,
      clientSessionId: ids.clientSessionId ?? CLIENT_SESSION_ID,
      capabilities,
    },
  };
}

function revokedFrame(d: ServerCapabilityRevoked["d"]): ServerCapabilityRevoked {
  return { t: "capability.revoked", c: "1", d };
}

/** A promise the test settles by hand. */
interface Settle<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function settle<T>(): Settle<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** A connection whose renew calls wait for the test, and whose close the test can fire. */
function fakeConnection() {
  const renewals: Settle<number>[] = [];
  const closeListeners = new Set<(code: number, reason: string) => void>();
  const fireClose = (code: number, reason: string): void => {
    connection.closed = true;
    for (const listener of [...closeListeners]) listener(code, reason);
  };
  const connection = {
    closed: false,
    renewals,
    renew: vi.fn((_capabilities: Capabilities) => {
      const renewal = settle<number>();
      renewals.push(renewal);
      return renewal.promise;
    }),
    close: vi.fn((code = 1000, reason = "client_closed") => {
      fireClose(code, reason);
    }),
    onClose(listener: (code: number, reason: string) => void): () => void {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    fireClose,
  };
  return connection;
}

type FakeConnection = ReturnType<typeof fakeConnection>;

/** A renewal of `initial` over a fake connection. REST fetches stay pending unless a test answers them. */
function harness(initial: Capabilities, connection: FakeConnection = fakeConnection()) {
  const events: RuntimeRenewalEvent[] = [];
  const fetchCapabilities = vi.fn(() => new Promise<Capabilities>(() => undefined));
  const options: RuntimeRenewalOptions = {
    workspaceId: WORKSPACE_ID,
    clientSessionId: CLIENT_SESSION_ID,
    connection,
    capabilities: initial,
    fetchCapabilities,
    onEvent: (event) => {
      events.push(event);
    },
    now: () => Date.now(),
    random: () => 1,
  };
  const renewal = new RuntimeRenewal(options);
  return { connection, fetchCapabilities, events, renewal };
}

/** Advances fake time and lets promise continuations run. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("RuntimeRenewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the REST fallback at 80% of the token lifetime", async () => {
    const { fetchCapabilities } = harness(caps(S0, S0 + 300));
    await advance(239_999);
    expect(fetchCapabilities).not.toHaveBeenCalled();
    await advance(1);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
  });

  it("runs the REST fallback 60 s before exp when the token has no iat", async () => {
    const { fetchCapabilities } = harness(caps(undefined, S0 + 300));
    await advance(239_999);
    expect(fetchCapabilities).not.toHaveBeenCalled();
    await advance(1);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
  });

  it("renews in band from a matching push and reschedules the fallback from its iat", async () => {
    const { connection, fetchCapabilities, events, renewal } = harness(caps(S0, S0 + 300));
    await advance(180_000);
    const pushed = caps(S0 + 180, S0 + 480);
    renewal.handleFrame(renewedFrame(pushed));
    expect(connection.renew).toHaveBeenCalledTimes(1);
    expect(connection.renew).toHaveBeenCalledWith(pushed);
    connection.renewals[0].resolve(1_760_000_480_000);
    await advance(0);
    expect(events).toEqual([
      { type: "renewed", source: "push", capabilities: pushed, expiresAtMs: 1_760_000_480_000 },
    ]);
    expect(renewal.capabilities).toBe(pushed);
    await advance(60_000);
    expect(fetchCapabilities).not.toHaveBeenCalled();
    await advance(180_000);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
  });

  it("ignores pushes for another workspace or session, an equal exp, or an undecodable token", async () => {
    const { connection, renewal } = harness(caps(S0, S0 + 300));
    renewal.handleFrame(renewedFrame(caps(S0 + 180, S0 + 480), { workspaceId: OTHER_WORKSPACE_ID }));
    renewal.handleFrame(renewedFrame(caps(S0 + 180, S0 + 480), { clientSessionId: OTHER_CLIENT_SESSION_ID }));
    renewal.handleFrame(renewedFrame(caps(S0 + 200, S0 + 300)));
    renewal.handleFrame(renewedFrame(unusable()));
    await advance(0);
    expect(connection.renew).not.toHaveBeenCalled();
  });

  it("keeps one renewal in flight and sends only the newest waiting offer", async () => {
    const { connection, renewal } = harness(caps(S0, S0 + 300));
    const first = caps(S0, S0 + 400);
    const newest = caps(S0, S0 + 600);
    renewal.handleFrame(renewedFrame(first));
    renewal.handleFrame(renewedFrame(caps(S0, S0 + 500)));
    renewal.handleFrame(renewedFrame(newest));
    expect(connection.renew).toHaveBeenCalledTimes(1);
    connection.renewals[0].resolve(1_760_000_400_000);
    await advance(0);
    expect(connection.renew).toHaveBeenCalledTimes(2);
    expect(connection.renew).toHaveBeenLastCalledWith(newest);
    expect(connection.renew.mock.calls.map(([capabilities]) => capabilities)).toEqual([first, newest]);
  });

  it("applies a REST fallback answer that is newer than the applied token", async () => {
    const { connection, fetchCapabilities, events } = harness(caps(S0, S0 + 300));
    const answer = caps(S0 + 240, S0 + 540);
    fetchCapabilities.mockResolvedValueOnce(answer);
    await advance(240_000);
    expect(connection.renew).toHaveBeenCalledWith(answer);
    connection.renewals[0].resolve(1_760_000_540_000);
    await advance(0);
    expect(events).toEqual([
      { type: "renewed", source: "rest", capabilities: answer, expiresAtMs: 1_760_000_540_000 },
    ]);
  });

  it("retries retryable REST failures with backoff and honours retryAfterMs", async () => {
    const { connection, fetchCapabilities, events, renewal } = harness(caps(S0, S0 + 300));
    const answer = caps(S0 + 247, S0 + 547);
    fetchCapabilities
      .mockRejectedValueOnce(new CloudRestError({ status: 503, code: "unavailable" }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new CloudRestError({ status: 429, code: "rate_limited", retryAfterMs: 7_000 }))
      .mockResolvedValueOnce(answer);
    await advance(240_000);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
    await advance(249);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchCapabilities).toHaveBeenCalledTimes(2);
    await advance(499);
    expect(fetchCapabilities).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchCapabilities).toHaveBeenCalledTimes(3);
    await advance(6_999);
    expect(fetchCapabilities).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fetchCapabilities).toHaveBeenCalledTimes(4);
    connection.renewals[0].resolve(1_760_000_547_000);
    await advance(0);
    expect(renewal.capabilities).toBe(answer);
    expect(events).toEqual([
      { type: "renewed", source: "rest", capabilities: answer, expiresAtMs: 1_760_000_547_000 },
    ]);
  });

  it("caps REST retries at 5 s once the token is past exp", async () => {
    const { fetchCapabilities } = harness(caps(S0, S0 + 300));
    const calls: number[] = [];
    fetchCapabilities.mockImplementation(() => {
      calls.push(Date.now());
      return Promise.reject(new CloudRestError({ status: 503, code: "unavailable" }));
    });
    await advance(330_000);
    const delays = calls.slice(1).map((at, index) => at - calls[index]);
    expect(delays.slice(0, 8)).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(delays.slice(8, 10)).toEqual([5_000, 5_000]);
    expect(delays.slice(8).every((delay) => delay <= 5_000)).toBe(true);
  });

  it("emits refused and stops on a terminal REST error, leaving the connection open", async () => {
    const { connection, fetchCapabilities, events, renewal } = harness(caps(S0, S0 + 300));
    fetchCapabilities.mockRejectedValueOnce(new CloudRestError({ status: 403, code: "capability_revoked" }));
    await advance(240_000);
    expect(events).toEqual([{ type: "refused", status: 403, code: "capability_revoked" }]);
    expect(renewal.stopped).toBe(true);
    expect(connection.close).not.toHaveBeenCalled();
    await advance(600_000);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
  });

  it("falls back to REST after an in-band renew failure and renews in band from its answer", async () => {
    const { connection, fetchCapabilities, events, renewal } = harness(caps(S0, S0 + 300));
    const answer = caps(S0 + 180, S0 + 480);
    fetchCapabilities.mockResolvedValueOnce(answer);
    renewal.handleFrame(renewedFrame(caps(S0 + 180, S0 + 400)));
    connection.renewals[0].reject(new Error("renew_timeout"));
    await advance(249);
    expect(fetchCapabilities).not.toHaveBeenCalled();
    await advance(1);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
    expect(connection.renew).toHaveBeenLastCalledWith(answer);
    connection.renewals[1].resolve(1_760_000_480_000);
    await advance(0);
    expect(events).toEqual([
      { type: "renewed", source: "rest", capabilities: answer, expiresAtMs: 1_760_000_480_000 },
    ]);
  });

  it("stops without an event when an in-band renew fails on a closed connection", async () => {
    const { connection, fetchCapabilities, events, renewal } = harness(caps(S0, S0 + 300));
    renewal.handleFrame(renewedFrame(caps(S0 + 180, S0 + 400)));
    connection.fireClose(1006, "abnormal");
    connection.renewals[0].reject(new Error("runtime connection closed"));
    await advance(0);
    expect(renewal.stopped).toBe(true);
    expect(events).toEqual([]);
    await advance(600_000);
    expect(fetchCapabilities).not.toHaveBeenCalled();
  });

  it("closes and emits revoked for this workspace or an unscoped revocation, and ignores another workspace", () => {
    const scoped = harness(caps(S0, S0 + 300));
    scoped.renewal.handleFrame(
      revokedFrame({ workspaceId: WORKSPACE_ID, reason: "workspace_deleted", scope: "workspace" }),
    );
    expect(scoped.connection.close).toHaveBeenCalledWith(1000, "capability_revoked");
    expect(scoped.events).toEqual([{ type: "revoked", reason: "workspace_deleted", scope: "workspace" }]);
    expect(scoped.renewal.stopped).toBe(true);

    const unscoped = harness(caps(S0, S0 + 300));
    unscoped.renewal.handleFrame(revokedFrame({ reason: "session_revoked", scope: "account" }));
    expect(unscoped.connection.close).toHaveBeenCalledWith(1000, "capability_revoked");
    expect(unscoped.events).toEqual([{ type: "revoked", reason: "session_revoked", scope: "account" }]);
    expect(unscoped.renewal.stopped).toBe(true);

    const other = harness(caps(S0, S0 + 300));
    other.renewal.handleFrame(
      revokedFrame({ workspaceId: OTHER_WORKSPACE_ID, reason: "workspace_deleted", scope: "workspace" }),
    );
    expect(other.connection.close).not.toHaveBeenCalled();
    expect(other.events).toEqual([]);
    expect(other.renewal.stopped).toBe(false);
  });

  it("treats a REST answer with an equal exp as a failure and retries 250 ms later", async () => {
    const { connection, fetchCapabilities } = harness(caps(S0, S0 + 300));
    fetchCapabilities.mockResolvedValueOnce(caps(S0 + 200, S0 + 300));
    await advance(240_000);
    expect(connection.renew).not.toHaveBeenCalled();
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
    await advance(249);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchCapabilities).toHaveBeenCalledTimes(2);
    expect(connection.renew).not.toHaveBeenCalled();
  });

  it("ignores a REST answer when a push was applied while the fetch was in flight", async () => {
    const { connection, fetchCapabilities, renewal } = harness(caps(S0, S0 + 300));
    const answer = settle<Capabilities>();
    fetchCapabilities.mockReturnValueOnce(answer.promise);
    await advance(240_000);
    renewal.handleFrame(renewedFrame(caps(S0 + 241, S0 + 400)));
    expect(connection.renew).toHaveBeenCalledTimes(1);
    connection.renewals[0].resolve(1_760_000_400_000);
    await advance(0);
    answer.resolve(caps(S0 + 240, S0 + 540));
    await advance(0);
    expect(connection.renew).toHaveBeenCalledTimes(1);
  });

  it("stop() ends timers, pushes and late fetch results", async () => {
    const { connection, fetchCapabilities, events, renewal } = harness(caps(S0, S0 + 300));
    const answer = settle<Capabilities>();
    fetchCapabilities.mockReturnValueOnce(answer.promise);
    await advance(240_000);
    renewal.stop();
    await advance(600_000);
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
    renewal.handleFrame(renewedFrame(caps(S0 + 180, S0 + 480)));
    expect(connection.renew).not.toHaveBeenCalled();
    answer.resolve(caps(S0 + 240, S0 + 540));
    await advance(0);
    expect(connection.renew).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("stops renewal when the connection closes", async () => {
    const { connection, fetchCapabilities, renewal } = harness(caps(S0, S0 + 300));
    connection.fireClose(1006, "abnormal");
    expect(renewal.stopped).toBe(true);
    await advance(600_000);
    expect(fetchCapabilities).not.toHaveBeenCalled();
  });

  it("is stopped at once when constructed on a closed connection", async () => {
    const connection = fakeConnection();
    connection.closed = true;
    const { renewal, fetchCapabilities } = harness(caps(S0, S0 + 300), connection);
    expect(renewal.stopped).toBe(true);
    await advance(600_000);
    expect(fetchCapabilities).not.toHaveBeenCalled();
  });
});
