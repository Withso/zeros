import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCapabilityConformance, conformanceOutcome } from "../../../../control-plane/src/cloud-workspaces/capability-conformance-test-utils";
import {
  TEST_CAPABILITY_HEADER,
  TEST_CAPABILITY_IDS,
  TEST_CAPABILITY_NOW_S,
  signTestCapability,
  signTestProof,
  testClientClaims,
} from "../../../../control-plane/src/cloud-workspaces/capability-verifier-test-utils";
import { UPLINK_AUTH_APPLIED_TIMEOUT_MS } from "../../../../control-plane/src/realtime/uplink-protocol";
import {
  ENGINE_AUTH_SINK_BOUND_MS,
  ENGINE_CAPABILITY_FALLBACK_AFTER_DOWN_MS,
  ENGINE_CAPABILITY_FALLBACK_INTERVAL_MS,
  RUNTIME_AUTH_FRAME_MAX_BYTES,
  capabilityCloseCode,
  EngineAuthSinkTimeoutError,
  EngineCapabilityAuth,
  fileCapabilityAuthStore,
  type EngineCapabilityAuthStore,
  type PersistedCapabilityAuth,
} from "../cloud-capability-auth";
import type { EngineUplinkAuthSync } from "../cloud-engine-uplink";

const fixture = buildCapabilityConformance();
const ids = {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  organizationId: "22222222-2222-4222-8222-222222222222",
  generation: 7,
  engineInstanceId: "44444444-4444-4444-8444-444444444444",
};
const USER = "11111111-1111-4111-8111-111111111111";

function memoryStore(): EngineCapabilityAuthStore & { writes: PersistedCapabilityAuth[] } {
  const writes: PersistedCapabilityAuth[] = [];
  return { writes, read: async () => writes.at(-1) ?? null, write: async state => { writes.push(state); } };
}

const sync = (cursor: string, epochs: Partial<EngineUplinkAuthSync["epochs"]> = {}, revocations: EngineUplinkAuthSync["revocations"] = []) =>
  ({ syncId: "55555555-5555-4555-8555-555555555555", epochs: { wa: 1, wr: 1, ...epochs }, revocations, authCursor: cursor, complete: true }) as EngineUplinkAuthSync;

afterEach(() => { vi.useRealTimers(); });

describe("engine capability verifier: S1 conformance vectors", () => {
  for (const vector of fixture.vectors.filter(v => v.pin.aud === "zeros:engine")) {
    it(vector.name, async () => {
      const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store: memoryStore(), now: () => vector.nowMs });
      await auth.applyKeys(fixture.keys as never);
      await auth.applySync(sync("c-1"));
      if (vector.known) auth.verifier.mergeKnown(vector.known);
      for (const [kind, id] of vector.revoked ?? []) auth.verifier.revoke(kind, id);
      const request = { capability: vector.token, proof: vector.context.proof! };
      const route = vector.context.route!;
      let result = await auth.verifyClient(request, route);
      if (vector.repeat) result = await auth.verifyClient(request, route);
      // Step 13 is per message on an admitted session.
      if (result.ok && vector.context.scope !== undefined) {
        auth.admit("session", result, route);
        if (!auth.verifier.allows("session", vector.context.scope)) result = { ok: false, code: "capability_scope_denied", step: 13 };
      }
      expect(conformanceOutcome(result)).toEqual(vector.expect);
    });
  }
});

describe("engine durable auth sink", () => {
  it("bounds every sink call at the control plane's auth.applied timeout", () => {
    expect(ENGINE_AUTH_SINK_BOUND_MS).toBe(UPLINK_AUTH_APPLIED_TIMEOUT_MS);
  });

  it("admits no client before the first auth.sync is durable", async () => {
    let release!: () => void;
    const store: EngineCapabilityAuthStore = { read: async () => null, write: () => new Promise<void>(resolve => { release = resolve; }) };
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store });
    const vector = fixture.vectors.find(v => v.pin.aud === "zeros:engine" && v.expect.ok)!;
    const applied = auth.applySync(sync("c-1"));
    await Promise.resolve();
    expect(auth.ready()).toBe(false);
    expect(auth.authCursor()).toBeUndefined();
    expect(await auth.verifyClient({ capability: vector.token, proof: vector.context.proof! }, "direct"))
      .toMatchObject({ ok: false, code: "capability_issuer_unavailable" });
    release();
    await applied;
    expect(auth.ready()).toBe(true);
    expect(auth.authCursor()).toBe("c-1");
  });

  it("rejects a hung write within the bound, keeps the durable cursor and still applies the epochs in memory", async () => {
    vi.useFakeTimers();
    const store: EngineCapabilityAuthStore = { read: async () => null, write: () => new Promise<void>(() => {}) };
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store });
    const applied = auth.applySync(sync("c-1", { members: { [USER]: 9 } }));
    const outcome = applied.then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(ENGINE_AUTH_SINK_BOUND_MS - 1);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(EngineAuthSinkTimeoutError);
    expect(auth.authCursor()).toBeUndefined();
    expect(auth.ready()).toBe(false);
    expect(auth.verifier.knownEpoch(`me:${ids.organizationId}:${USER}`)).toBe(9);
    // Later calls queue behind the hung write and are bounded too, so the
    // uplink's chain always moves on (auth_apply_failed and a redial).
    const delta = auth.applyDelta({ epochs: { wa: 2 }, revocations: [], authCursor: "c-2" }).then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(ENGINE_AUTH_SINK_BOUND_MS);
    expect(await delta).toBeInstanceOf(EngineAuthSinkTimeoutError);
    expect(auth.verifier.knownEpoch(`wa:${ids.workspaceId}`)).toBe(2);
  });

  it("merges as a maximum, replaces the key set and restores the durable state", async () => {
    const store = memoryStore();
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store });
    await auth.applySync(sync("c-1", { wa: 5, members: { [USER]: 4 } }));
    await auth.applyDelta({ epochs: { wa: 3, members: { [USER]: 6 } }, revocations: [{ kind: "session", id: "s1", until: Date.now() + 60_000 }], authCursor: "c-2" });
    expect(auth.verifier.knownEpoch(`wa:${ids.workspaceId}`)).toBe(5);
    expect(auth.verifier.knownEpoch(`me:${ids.organizationId}:${USER}`)).toBe(6);
    await auth.applyKeys(fixture.keys as never);
    await auth.applyKeys([]);
    expect(auth.verifier.keyIds()).toEqual([]);
    await expect(auth.applyKeys([{ kty: "OKP", crv: "Ed25519", x: "k".repeat(43), kid: "k1", use: "sig", alg: "EdDSA" }])).rejects.toThrow();
    const restored = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store });
    await restored.restore();
    expect(restored.authCursor()).toBe("c-2");
    expect(restored.verifier.knownEpoch(`me:${ids.organizationId}:${USER}`)).toBe(6);
    expect(restored.verifier.isRevoked("sid", "s1")).toBe(true);
    expect(restored.ready()).toBe(false);
    const other = new EngineCapabilityAuth({ identity: { ...ids, workspaceId: "77777777-7777-4777-8777-777777777777" }, issuer: fixture.issuer, store });
    await other.restore();
    expect(other.authCursor()).toBeUndefined();
  });

  it("writes the state atomically to a private file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zeros-cap-auth-"));
    try {
      const file = join(directory, "runtime", "cloud-capability-auth.json");
      const store = fileCapabilityAuthStore(file);
      await store.write({ version: 1, workspaceId: ids.workspaceId, cursor: "c-9", known: [["wa:x", 3]], revoked: [] });
      expect(await store.read()).toEqual({ version: 1, workspaceId: ids.workspaceId, cursor: "c-9", known: [["wa:x", 3]], revoked: [] });
      expect(statSync(file).mode & 0o077).toBe(0);
      expect(readdirSync(join(directory, "runtime"))).toEqual(["cloud-capability-auth.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes an admitted session when a pushed epoch revokes it", async () => {
    const vector = fixture.vectors.find(v => v.name === "zeros:engine valid")!;
    const closed: string[] = [];
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store: memoryStore(), now: () => vector.nowMs,
      onSessionsClosed: closures => closed.push(...closures.map(c => `${c.sessionId}:${c.code}`)) });
    await auth.applyKeys(fixture.keys as never);
    await auth.applySync(sync("c-1"));
    const result = await auth.verifyClient({ capability: vector.token, proof: vector.context.proof! }, "direct");
    if (!result.ok) throw new Error(result.code);
    auth.admit("client-1", result, "direct");
    await auth.applyDelta({ epochs: { members: { [USER]: 99 } }, revocations: [], authCursor: "c-2" });
    expect(closed).toEqual(["client-1:capability_revoked"]);
    auth.stop();
  });
});

describe("engine token REST fallback (S1 Lifetimes and Issuance)", () => {
  const token = (label: string, expiresAtMs: number) => ({ token: label, expiresAtMs });

  it("asks api only after the uplink has been down 30 s and the held token reached 80% of its lifetime", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const request = vi.fn(async () => token("fallback", Date.now() + 300_000));
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store: memoryStore(), requestEngineCapability: request });
    auth.uplinkEstablished(true);
    auth.holdCapability(token("pushed", start + 300_000));
    auth.uplinkEstablished(false);
    await vi.advanceTimersByTimeAsync(ENGINE_CAPABILITY_FALLBACK_AFTER_DOWN_MS);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(240_000 - ENGINE_CAPABILITY_FALLBACK_AFTER_DOWN_MS - 1);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(auth.engineCapability()?.token).toBe("fallback");
    // The fallback token renews at its own 80% mark.
    await vi.advanceTimersByTimeAsync(240_000 - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    auth.stop();
  });

  it("never asks while the uplink is up: the uplink pushes the renewal at 60%", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => token("fallback", Date.now() + 300_000));
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store: memoryStore(), requestEngineCapability: request });
    auth.uplinkEstablished(true);
    auth.holdCapability(token("pushed", Date.now() + 300_000));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).not.toHaveBeenCalled();
    auth.stop();
  });

  it("starts 30 s after boot without any token and asks at most once a minute", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (): Promise<{ token: string; expiresAtMs: number }> => { throw new Error("api unavailable"); });
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store: memoryStore(), requestEngineCapability: request });
    await vi.advanceTimersByTimeAsync(ENGINE_CAPABILITY_FALLBACK_AFTER_DOWN_MS - 1);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ENGINE_CAPABILITY_FALLBACK_INTERVAL_MS - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    auth.uplinkEstablished(true);
    await vi.advanceTimersByTimeAsync(10 * ENGINE_CAPABILITY_FALLBACK_INTERVAL_MS);
    expect(request).toHaveBeenCalledTimes(2);
    auth.stop();
  });

  it("keeps the later-expiring token when a push lands during a fallback request", async () => {
    vi.useFakeTimers();
    let answer!: (value: { token: string; expiresAtMs: number }) => void;
    const request = vi.fn(() => new Promise<{ token: string; expiresAtMs: number }>(resolve => { answer = resolve; }));
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store: memoryStore(), requestEngineCapability: request });
    await vi.advanceTimersByTimeAsync(ENGINE_CAPABILITY_FALLBACK_AFTER_DOWN_MS);
    expect(request).toHaveBeenCalledTimes(1);
    auth.holdCapability(token("pushed", Date.now() + 300_000));
    answer(token("fallback", Date.now() + 200_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(auth.engineCapability()?.token).toBe("pushed");
    auth.stop();
  });
});

describe("in-band client auth.renew (S3 Part 3)", () => {
  const valid = () => fixture.vectors.find(v => v.name === "zeros:engine valid")!;
  const RENEWED_EXP_S = TEST_CAPABILITY_NOW_S + 300;

  function renewal(device = "device-a", jti = "CCCCCCCCCCCCCCCCCCCCCC", timestampMs = TEST_CAPABILITY_NOW_S * 1000) {
    const capability = signTestCapability(TEST_CAPABILITY_HEADER, testClientClaims({ jti, iat: TEST_CAPABILITY_NOW_S, nbf: TEST_CAPABILITY_NOW_S, exp: RENEWED_EXP_S }));
    const nonce = "R".repeat(22);
    const signature = signTestProof(device, { aud: "zeros:engine", wsp: TEST_CAPABILITY_IDS.workspace, jti, timestampMs, nonce, route: "direct" });
    return { t: "auth.renew", d: { capability, proof: { timestampMs, nonce, signature } } };
  }

  async function admitted(clock: { now: number }, closed: string[] = []) {
    const vector = valid();
    clock.now = vector.nowMs;
    const auth = new EngineCapabilityAuth({ identity: ids, issuer: fixture.issuer, store: memoryStore(), now: () => clock.now,
      onSessionsClosed: closures => closed.push(...closures.map(c => `${c.sessionId}:${c.code}`)) });
    await auth.applyKeys(fixture.keys as never);
    await auth.applySync(sync("c-1"));
    const result = await auth.verifyClient({ capability: vector.token, proof: vector.context.proof! }, "direct");
    if (!result.ok) throw new Error(result.code);
    auth.admit("client-1", result, "direct");
    return auth;
  }

  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  it("swaps the session's token without reconnecting and replies auth.renewed with the new expiry", async () => {
    const clock = { now: 0 };
    const closed: string[] = [];
    const auth = await admitted(clock, closed);
    const frame = renewal();
    expect(await auth.handleInBandAuth("client-1", frame, bytes(frame), "direct"))
      .toEqual({ kind: "reply", frame: JSON.stringify({ t: "auth.renewed", d: { expiresAtMs: RENEWED_EXP_S * 1000 } }) });
    expect(auth.verifier.sessionClaims("client-1")?.jti).toBe("CCCCCCCCCCCCCCCCCCCCCC");
    // Past the first token's exp the renewed session stays open; past the
    // renewed exp it closes with capability_expired.
    clock.now = (TEST_CAPABILITY_NOW_S + 295) * 1000;
    auth.verifier.recheck();
    expect(closed).toEqual([]);
    clock.now = RENEWED_EXP_S * 1000;
    auth.verifier.recheck();
    expect(closed).toEqual(["client-1:capability_expired"]);
    auth.stop();
  });

  it("closes a session that never renews with capability_expired at exp", async () => {
    const clock = { now: 0 };
    const closed: string[] = [];
    const auth = await admitted(clock, closed);
    clock.now = (TEST_CAPABILITY_NOW_S + 290) * 1000;
    auth.verifier.recheck();
    expect(closed).toEqual(["client-1:capability_expired"]);
    auth.stop();
  });

  it("closes with the S1 socket code when a renewal fails verification", async () => {
    const clock = { now: 0 };
    const auth = await admitted(clock);
    const frame = renewal("device-b");
    expect(await auth.handleInBandAuth("client-1", frame, bytes(frame), "direct"))
      .toEqual({ kind: "close", code: 4401, reason: "capability_proof_invalid" });
    expect(auth.verifier.openSessionIds()).toEqual([]);
    auth.stop();
  });

  it("passes engine messages through and closes 4400 on any other handshake frame", async () => {
    const clock = { now: 0 };
    const auth = await admitted(clock);
    const engine = { type: "ping", t: "auth.renew" };
    expect(await auth.handleInBandAuth("client-1", engine, bytes(engine), "direct")).toEqual({ kind: "engine" });
    expect(await auth.handleInBandAuth("client-1", [1], 3, "direct")).toEqual({ kind: "engine" });
    for (const frame of [{ t: "auth", d: {} }, { t: "auth.renew", d: { capability: 1 } }, { t: "auth.renew", d: { ...renewal().d, extra: true } }]) {
      expect(await auth.handleInBandAuth("client-1", frame, bytes(frame), "direct")).toEqual({ kind: "close", code: 4400, reason: "frame_invalid" });
    }
    const frame = renewal();
    expect(await auth.handleInBandAuth("client-1", frame, RUNTIME_AUTH_FRAME_MAX_BYTES + 1, "direct"))
      .toEqual({ kind: "close", code: 4400, reason: "frame_invalid" });
    auth.stop();
  });

  it("maps every S1 error code to its socket close", () => {
    expect(capabilityCloseCode("capability_workspace_mismatch")).toBe(4403);
    expect(capabilityCloseCode("capability_revoked")).toBe(4403);
    expect(capabilityCloseCode("capability_generation_mismatch")).toBe(4409);
    expect(capabilityCloseCode("capability_contract_unsupported")).toBe(4426);
    expect(capabilityCloseCode("capability_expired")).toBe(4401);
    expect(capabilityCloseCode("capability_scope_denied")).toBeNull();
    expect(capabilityCloseCode("capability_issuer_unavailable")).toBeNull();
  });
});
describe("engine capability verifier Local boundary", () => {
  const ENGINE = join(process.cwd(), "apps", "desktop");
  function sources(directory: string, found: string[] = []): string[] {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) sources(path, found);
      else if (/\.(?:ts|tsx|mts|js|mjs|cjs)$/.test(entry)) found.push(path);
    }
    return found;
  }

  it("is imported only by cloud-only modules and constructed only for an advertised uplink", () => {
    const files = ["src", "electron"].flatMap(root => sources(join(ENGINE, root)));
    const importers = files.filter(file => /from "\.\/cloud-capability-(?:auth|verifier)"|control-plane\/src\/cloud-workspaces\/capability-verifier/.test(readFileSync(file, "utf8")))
      .map(file => relative(ENGINE, file)).sort();
    expect(importers).toEqual(["src/engine/cloud-capability-auth.ts", "src/engine/cloud-capability-verifier.ts", "src/engine/zeros-engine.ts"]);
    const engine = readFileSync(join(ENGINE, "src", "engine", "zeros-engine.ts"), "utf8");
    const constructions = [...engine.matchAll(/new EngineCapabilityAuth\(/g)].map(match => match.index!);
    expect(constructions).toHaveLength(1);
    const start = engine.indexOf("private startCloudEngineUplink(): void {");
    const body = engine.slice(start, engine.indexOf("\n  }\n", start));
    expect(body.indexOf("if (!advertised) return;")).toBeGreaterThan(0);
    expect(constructions[0]! - start).toBeGreaterThan(body.indexOf("if (!advertised) return;"));
    expect(constructions[0]!).toBeLessThan(start + body.length);
  });
});
