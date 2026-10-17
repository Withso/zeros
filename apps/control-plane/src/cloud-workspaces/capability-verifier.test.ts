import { describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_KEY_REFRESH_INTERVAL_MS,
  CAPABILITY_OUTAGE_DETECT_MS,
  CAPABILITY_OUTAGE_GRACE_MS,
  CAPABILITY_RECOVERY_RENEWAL_MS,
  CAPABILITY_REVOCATION_RETENTION_MS,
  CapabilityKeySetError,
  CapabilityOutageMonitor,
  CapabilityVerifier,
  capabilityEpochEntries,
  capabilityEpochSubject,
  capabilityProofMessage,
  type CapabilityVerifyContext,
} from "./capability-verifier.js";
import {
  TEST_CAPABILITY_HEADER,
  TEST_CAPABILITY_IDS as ids,
  TEST_CAPABILITY_ISSUER,
  TEST_CAPABILITY_NOW_S,
  signTestCapability,
  signTestProof,
  testClientClaims,
  testEngineClaims,
  testSigningJwk,
} from "./capability-verifier-test-utils.js";

const CLIENT = { aud: "zeros:engine", knd: "client" } as const;
const ENGINE = { aud: "zeros:api", knd: "engine" } as const;

function setup(options: { fetchKeys?: () => Promise<readonly unknown[]> } = {}) {
  let clock = TEST_CAPABILITY_NOW_S * 1000;
  const closed: string[] = [];
  const verifier = new CapabilityVerifier({ issuer: TEST_CAPABILITY_ISSUER, now: () => clock,
    onSessionsClosed: closures => closed.push(...closures.map(c => `${c.sessionId}:${c.code}`)), ...options });
  verifier.applyKeys([testSigningJwk("cap-2026-10-a")]);
  return { verifier, closed, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

const base: CapabilityVerifyContext = { workspaceId: ids.workspace, organizationId: ids.org, generation: 7, engineInstanceId: ids.engine };
let nonceCounter = 0;
function proofContext(now: number, overrides: { jti?: string; route?: "direct" | "relay"; nonce?: string; signRoute?: "direct" | "relay"; signAud?: string; device?: string; ts?: number } = {}): CapabilityVerifyContext {
  const nonce = overrides.nonce ?? `N${String(nonceCounter++).padStart(21, "0")}`;
  const timestampMs = overrides.ts ?? now;
  const signature = signTestProof(overrides.device ?? "device-a", { aud: overrides.signAud ?? "zeros:engine", wsp: ids.workspace,
    jti: overrides.jti ?? "AAAAAAAAAAAAAAAAAAAAAA", timestampMs, nonce, route: overrides.signRoute ?? overrides.route ?? "direct" });
  return { ...base, route: overrides.route ?? "direct", proof: { timestampMs, nonce, signature } };
}
const client = (overrides: Record<string, unknown> = {}) => signTestCapability(TEST_CAPABILITY_HEADER, testClientClaims(overrides));
const engine = (overrides: Record<string, unknown> = {}) => signTestCapability(TEST_CAPABILITY_HEADER, testEngineClaims(overrides));

describe("capability verifier", () => {
  it("accepts a valid client token with a proof and a valid engine token", async () => {
    const { verifier, now } = setup();
    expect(await verifier.verify(client(), CLIENT, proofContext(now()))).toMatchObject({ ok: true, claims: { sub: `user:${ids.user}` } });
    expect(await verifier.verify(engine(), ENGINE, base)).toMatchObject({ ok: true, claims: { knd: "engine" } });
  });

  it("pins the header members exactly and rejects an array audience before the signature", async () => {
    const { verifier } = setup();
    for (const header of [{ ...TEST_CAPABILITY_HEADER, crit: ["b64"] }, { ...TEST_CAPABILITY_HEADER, b64: false },
      { ...TEST_CAPABILITY_HEADER, typ: "application/zeros-cap+jwt" }, { ...TEST_CAPABILITY_HEADER, alg: "Ed25519" }])
      expect(await verifier.verify(signTestCapability(header, testEngineClaims(), "cap-2026-10-a"), ENGINE, base))
        .toEqual({ ok: false, code: "capability_malformed", step: 2 });
    expect(await verifier.verify(engine({ aud: ["zeros:api"] }), ENGINE, base)).toEqual({ ok: false, code: "capability_malformed", step: 2 });
  });

  it("replaces the key set, holds at most three keys and keeps the set on an invalid one", () => {
    const { verifier } = setup();
    verifier.applyKeys([testSigningJwk("cap-2026-10-b"), testSigningJwk("cap-2026-11-a")]);
    expect(verifier.keyIds()).toEqual(["cap-2026-10-b", "cap-2026-11-a"]);
    expect(() => verifier.applyKeys(["a", "b", "c", "d"].map(s => testSigningJwk(`cap-2026-10-${s}`)))).toThrow(CapabilityKeySetError);
    expect(() => verifier.applyKeys([{ ...testSigningJwk("cap-2026-10-c"), crv: "X25519" }])).toThrow(CapabilityKeySetError);
    expect(verifier.keyIds()).toEqual(["cap-2026-10-b", "cap-2026-11-a"]);
  });

  it("refreshes keys once per minute on an unknown kid", async () => {
    let published = [testSigningJwk("cap-2026-10-a")];
    const fetchKeys = vi.fn(async () => published);
    const { verifier, advance } = setup({ fetchKeys });
    verifier.applyKeys([]);
    const unknown = signTestCapability({ ...TEST_CAPABILITY_HEADER, kid: "cap-2026-10-z" }, testEngineClaims());
    expect(await verifier.verify(unknown, ENGINE, base)).toEqual({ ok: false, code: "capability_key_unknown", step: 3 });
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    expect(await verifier.verify(unknown, ENGINE, base)).toMatchObject({ code: "capability_key_unknown" });
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    published = [testSigningJwk("cap-2026-10-a"), testSigningJwk("cap-2026-10-n")];
    const fresh = signTestCapability({ ...TEST_CAPABILITY_HEADER, kid: "cap-2026-10-n" }, testEngineClaims());
    expect(await verifier.verify(fresh, ENGINE, base)).toMatchObject({ code: "capability_key_unknown" });
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    advance(CAPABILITY_KEY_REFRESH_INTERVAL_MS);
    expect(await verifier.verify(signTestCapability({ ...TEST_CAPABILITY_HEADER, kid: "cap-2026-10-n" }, testEngineClaims()), ENGINE, base))
      .toMatchObject({ ok: true });
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it("merges known epochs as a maximum and re-checks every open session on a raise", async () => {
    const { verifier, now, closed } = setup();
    const first = await verifier.verify(client(), CLIENT, proofContext(now()));
    if (!first.ok) throw new Error(first.code);
    verifier.openSession("s1", first, base);
    expect(verifier.mergeKnown(capabilityEpochEntries({ workspaceId: ids.workspace, organizationId: ids.org }, { wa: 12, members: { [ids.user]: 4 } }))).toEqual([]);
    expect(verifier.knownEpoch(`me:${ids.org}:${ids.user}`)).toBe(5);
    expect(verifier.mergeKnown([[`me:${ids.org}:${ids.user}`, 3]])).toEqual([]);
    expect(verifier.knownEpoch(`me:${ids.org}:${ids.user}`)).toBe(5);
    expect(verifier.mergeKnown([[`me:${ids.org}:${ids.user}`, 6]])).toEqual([{ sessionId: "s1", code: "capability_revoked" }]);
    expect(closed).toEqual(["s1:capability_revoked"]);
    expect(await verifier.verify(client({ jti: "CCCCCCCCCCCCCCCCCCCCCC" }), CLIENT, proofContext(now(), { jti: "CCCCCCCCCCCCCCCCCCCCCC" })))
      .toEqual({ ok: false, code: "capability_revoked", step: 10 });
  });

  it("raises known epochs from a newer verified token and closes older sessions", async () => {
    const { verifier, now, closed } = setup();
    const older = await verifier.verify(client(), CLIENT, proofContext(now()));
    if (!older.ok) throw new Error(older.code);
    verifier.openSession("old", older, base);
    const newer = await verifier.verify(client({ jti: "DDDDDDDDDDDDDDDDDDDDDD", ep: { wa: 12, wr: 4, me: 5, ac: 1, dk: 2 } }), CLIENT,
      proofContext(now(), { jti: "DDDDDDDDDDDDDDDDDDDDDD" }));
    expect(newer.ok).toBe(true);
    expect(closed).toEqual(["old:capability_revoked"]);
  });

  it("keeps revocations until their own until and defaults to the retention window", async () => {
    const { verifier, advance } = setup();
    verifier.revoke("sid", ids.session, TEST_CAPABILITY_NOW_S * 1000 + 1_000);
    verifier.revoke("did", "77777777-7777-4777-8777-777777777777");
    expect(verifier.isRevoked("sid", ids.session)).toBe(true);
    advance(1_000);
    expect(verifier.isRevoked("sid", ids.session)).toBe(false);
    advance(CAPABILITY_REVOCATION_RETENTION_MS - 1_001);
    expect(verifier.isRevoked("did", "77777777-7777-4777-8777-777777777777")).toBe(true);
    advance(1);
    expect(verifier.isRevoked("did", "77777777-7777-4777-8777-777777777777")).toBe(false);
  });

  it("verifies proofs over the exact message it rebuilds, once per nonce, within 30 s", async () => {
    const { verifier, now } = setup();
    expect(capabilityProofMessage({ aud: "zeros:engine", wsp: ids.workspace, jti: "J", timestampMs: 12, nonce: "n", route: "relay" }).toString("utf8"))
      .toBe(`zeros-cap-pop-v1\nzeros:engine\n${ids.workspace}\nJ\n12\nn\nrelay`);
    const replayed = proofContext(now(), { nonce: "R".repeat(22) });
    expect((await verifier.verify(client(), CLIENT, replayed)).ok).toBe(true);
    expect(await verifier.verify(client(), CLIENT, replayed)).toEqual({ ok: false, code: "capability_proof_invalid", step: 12 });
    // A relay proof cannot open a direct session: the verifier signs its own route.
    expect(await verifier.verify(client(), CLIENT, proofContext(now(), { route: "direct", signRoute: "relay" })))
      .toMatchObject({ code: "capability_proof_invalid" });
    expect(await verifier.verify(client(), CLIENT, proofContext(now(), { signAud: "zeros:realtime" }))).toMatchObject({ code: "capability_proof_invalid" });
    expect(await verifier.verify(client(), CLIENT, proofContext(now(), { device: "device-b" }))).toMatchObject({ code: "capability_proof_invalid" });
    expect(await verifier.verify(client(), CLIENT, proofContext(now(), { ts: now() - 30_001 }))).toMatchObject({ code: "capability_proof_invalid" });
    expect((await verifier.verify(client(), CLIENT, proofContext(now(), { ts: now() + 30_000 }))).ok).toBe(true);
    expect(await verifier.verify(client(), CLIENT, base)).toMatchObject({ code: "capability_proof_invalid" });
  });

  it("closes a session at exp with no leeway when the CP is reachable", async () => {
    const { verifier, now, advance, closed } = setup();
    const result = await verifier.verify(client(), CLIENT, proofContext(now()));
    if (!result.ok) throw new Error(result.code);
    verifier.openSession("s", result, base);
    advance(289_999);
    expect(verifier.recheck()).toEqual([]);
    advance(1);
    expect(verifier.recheck()).toEqual([{ sessionId: "s", code: "capability_expired" }]);
    expect(closed).toEqual(["s:capability_expired"]);
  });

  it("closes an open session when its signing key leaves the set", async () => {
    const onSessionsClosed = vi.fn();
    const clock = TEST_CAPABILITY_NOW_S * 1000;
    const verifier = new CapabilityVerifier({ issuer: TEST_CAPABILITY_ISSUER, now: () => clock, onSessionsClosed });
    verifier.applyKeys([testSigningJwk("cap-2026-10-a"), testSigningJwk("cap-2026-10-b")]);
    const result = await verifier.verify(client(), CLIENT, proofContext(clock));
    if (!result.ok) throw new Error(result.code);
    verifier.openSession("s1", result, base);
    const closures = verifier.applyKeys([testSigningJwk("cap-2026-10-b")]);
    expect(closures).toEqual([{ sessionId: "s1", code: "capability_key_unknown" }]);
    expect(onSessionsClosed.mock.calls[0]?.[0]).toBe(closures);
    expect(verifier.openSessionIds()).toEqual([]);
  });

  it("keeps a session that renewed under a key that stays", async () => {
    const { verifier, now } = setup();
    verifier.applyKeys([testSigningJwk("cap-2026-10-a"), testSigningJwk("cap-2026-10-b")]);
    const first = await verifier.verify(client(), CLIENT, proofContext(now()));
    if (!first.ok) throw new Error(first.code);
    verifier.openSession("s1", first, base);
    const renewed = await verifier.verify(signTestCapability({ ...TEST_CAPABILITY_HEADER, kid: "cap-2026-10-b" },
      testClientClaims({ jti: "EEEEEEEEEEEEEEEEEEEEEE" })), CLIENT, proofContext(now(), { jti: "EEEEEEEEEEEEEEEEEEEEEE" }));
    if (!renewed.ok) throw new Error(renewed.code);
    expect(verifier.renewSession("s1", renewed)).toBe(true);
    expect(verifier.applyKeys([testSigningJwk("cap-2026-10-b")])).toEqual([]);
    expect(verifier.openSessionIds()).toEqual(["s1"]);
  });

  it("records a first-seen subject without re-checking open sessions", async () => {
    const { verifier, now, advance } = setup();
    const result = await verifier.verify(client(), CLIENT, proofContext(now()));
    if (!result.ok) throw new Error(result.code);
    verifier.openSession("s1", result, base);
    advance(300_000);
    expect(verifier.mergeKnown([["ac:99999999-9999-4999-8999-999999999999", 5]])).toEqual([]);
    expect(verifier.openSessionIds()).toEqual(["s1"]);
    expect(verifier.mergeKnown([[capabilityEpochSubject("wa", result.claims)!, 13]])).toEqual([{ sessionId: "s1", code: "capability_expired" }]);
  });

  it("closes a session when one of its own subjects is raised over the known epoch", async () => {
    const { verifier, now } = setup();
    const result = await verifier.verify(client({ ep: { wa: 1, wr: 3, me: 5, ac: 1, dk: 2 } }), CLIENT, proofContext(now()));
    if (!result.ok) throw new Error(result.code);
    verifier.openSession("s1", result, base);
    expect(verifier.mergeKnown([[capabilityEpochSubject("wa", result.claims)!, result.claims.ep.wa + 1]]))
      .toEqual([{ sessionId: "s1", code: "capability_revoked" }]);
    expect(verifier.openSessionIds()).toEqual([]);
  });

  it("an expired revocation stops rejecting at its until", async () => {
    const { verifier, now, advance } = setup();
    verifier.revoke("sid", ids.session, now() + 1_000);
    expect(await verifier.verify(client(), CLIENT, proofContext(now()))).toEqual({ ok: false, code: "capability_revoked", step: 11 });
    advance(1_000);
    expect(await verifier.verify(client(), CLIENT, proofContext(now()))).toMatchObject({ ok: true });
  });
});

describe("capability outage monitor", () => {
  const T = 1_000_000;
  it("starts an outage only when the uplink and the probe have both failed for 30 s", () => {
    const monitor = new CapabilityOutageMonitor(() => T);
    monitor.uplinkDown(T);
    expect(monitor.outageStartedAt(T + 60_000)).toBeNull();
    monitor.probe(false, T + 10_000);
    expect(monitor.outageStartedAt(T + 10_000 + CAPABILITY_OUTAGE_DETECT_MS - 1)).toBeNull();
    expect(monitor.outageStartedAt(T + 10_000 + CAPABILITY_OUTAGE_DETECT_MS)).toBe(T + 40_000);
  });

  it("extends only sessions authenticated before the outage, bounded at 30 min, and requires renewal within 60 s of recovery", () => {
    const monitor = new CapabilityOutageMonitor(() => T);
    monitor.uplinkDown(T);
    monitor.probe(false, T);
    const started = monitor.outageStartedAt(T + 30_000)!;
    const before = { authenticatedAtMs: started - 1, expMs: started + 100_000 };
    const after = { authenticatedAtMs: started + 1, expMs: started + 100_000 };
    expect(monitor.sessionDeadline(before, started + 1)).toBe(started + CAPABILITY_OUTAGE_GRACE_MS);
    expect(monitor.sessionDeadline({ ...before, expMs: started - 5_000 }, started + 1)).toBe(started - 5_000 + CAPABILITY_OUTAGE_GRACE_MS);
    expect(monitor.sessionDeadline(after, started + 1)).toBe(after.expMs);
    const recoveredAt = started + 600_000;
    monitor.uplinkRestored(recoveredAt);
    expect(monitor.outageStartedAt(recoveredAt)).toBeNull();
    expect(monitor.sessionDeadline(before, recoveredAt)).toBe(recoveredAt + CAPABILITY_RECOVERY_RENEWAL_MS);
    // A session still inside its own exp at recovery keeps normal rules.
    expect(monitor.sessionDeadline({ authenticatedAtMs: started - 1, expMs: recoveredAt + 5_000 }, recoveredAt)).toBe(recoveredAt + 5_000);
  });

  it("ends the outage when the JWKS probe answers again", () => {
    const monitor = new CapabilityOutageMonitor(() => T);
    monitor.uplinkDown(T);
    monitor.probe(false, T);
    expect(monitor.outageStartedAt(T + 30_000)).toBe(T + 30_000);
    monitor.probe(true, T + 40_000);
    expect(monitor.outageStartedAt(T + 40_000)).toBeNull();
  });
});
