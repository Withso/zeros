import { describe, expect, it, vi } from "vitest";
import { loadCapabilityKeyring } from "./capability-keyring.js";
import {
  CapabilitySigningKeyStore,
  generateCapabilityKeypair,
  openCapabilityPrivateKey,
  sealCapabilityPrivateKey,
} from "./capability-keys.js";

const key = (n: number) => Buffer.alloc(32, n).toString("base64url");
const keyring = { keys: { 1: key(1), 2: key(2) }, currentKeyVersion: 2 } as const;

describe("capability keyring", () => {
  it("loads a valid dedicated keyring", () => {
    expect(loadCapabilityKeyring({
      CLOUD_CAPABILITY_KEYS_JSON: JSON.stringify({ 1: key(1), 2: key(2) }),
      CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "2",
    })).toEqual(keyring);
    expect(loadCapabilityKeyring({})).toBeUndefined();
  });

  it.each([
    ["missing current version", { CLOUD_CAPABILITY_KEYS_JSON: JSON.stringify({ 1: key(1) }) }],
    ["missing keys", { CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "1" }],
    ["absent current key", { CLOUD_CAPABILITY_KEYS_JSON: JSON.stringify({ 1: key(1) }), CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "2" }],
    ["not json", { CLOUD_CAPABILITY_KEYS_JSON: "[1]", CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "1" }],
    ["bad key bytes", { CLOUD_CAPABILITY_KEYS_JSON: JSON.stringify({ 1: "not-a-key" }), CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "1" }],
    ["bad version", { CLOUD_CAPABILITY_KEYS_JSON: JSON.stringify({ 0: key(1) }), CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "0" }],
  ])("refuses %s", (_label, env) => {
    expect(() => loadCapabilityKeyring(env)).toThrow(/capability keyring/i);
  });
});

describe("capability key envelopes", () => {
  it("round-trips a sealed Ed25519 seed", () => {
    const pair = generateCapabilityKeypair("cap-2026-10-a");
    expect(pair.publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519", x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const sealed = sealCapabilityPrivateKey(pair.privateSeed, pair.kid, keyring);
    expect(sealed.keyVersion).toBe(2);
    const opened = openCapabilityPrivateKey(sealed, pair.kid, keyring);
    expect(opened.equals(pair.privateSeed)).toBe(true);
  });

  it.each([
    ["another kid", "cap-2026-10-b", 2, 0],
    ["another keyring version", "cap-2026-10-a", 1, 0],
    ["a truncated ciphertext", "cap-2026-10-a", 2, 8],
  ])("refuses to open with %s", (_label, kid, version, cut) => {
    const pair = generateCapabilityKeypair("cap-2026-10-a");
    const sealed = sealCapabilityPrivateKey(pair.privateSeed, pair.kid, keyring);
    const tampered = { ...sealed, keyVersion: version, ciphertext: sealed.ciphertext.subarray(0, sealed.ciphertext.length - cut) };
    expect(() => openCapabilityPrivateKey(tampered, kid, keyring)).toThrow();
  });

  it("rejects an unknown key id and key sizes", () => {
    expect(() => generateCapabilityKeypair("bad-kid")).toThrow(/key id/);
    expect(() => sealCapabilityPrivateKey(Buffer.alloc(31), "cap-2026-10-a", keyring)).toThrow(/invalid/);
  });
});

describe("capability signing key store", () => {
  type Row = { kid: string; public_jwk: { kty: "OKP"; crv: "Ed25519"; x: string }; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer; state: string };
  const kidFor = (suffix: string) => `cap-2026-10-${suffix}`;
  function row(suffix: string, state: string): Row {
    const pair = generateCapabilityKeypair(kidFor(suffix));
    const sealed = sealCapabilityPrivateKey(pair.privateSeed, pair.kid, keyring);
    pair.privateSeed.fill(0);
    return { kid: pair.kid, public_jwk: pair.publicJwk, key_version: sealed.keyVersion, nonce: sealed.nonce, ciphertext: sealed.ciphertext, auth_tag: sealed.authTag, state };
  }

  function harness(rows: Row[]) {
    let current = rows, failing = false;
    const load = vi.fn(async () => {
      if (failing) throw new Error("connection terminated");
      return current;
    });
    let handlers!: { onNotification: () => void; onReady: () => void; onUnavailable: () => void };
    const logger = { warn: vi.fn(), info: vi.fn() };
    const store = new CapabilitySigningKeyStore({
      keyring, load, logger, refreshMs: 3_600_000, retryDelaysMs: [5],
      subscribe: next => { handlers = next; return { start: async () => {}, healthy: () => true, stop: async () => {} }; },
    });
    return { store, load, logger, get handlers() { return handlers; }, set rows(next: Row[]) { current = next; },
      set failing(next: boolean) { failing = next; } };
  }

  it("publishes next, current and retiring, and signs only with current", async () => {
    const h = harness([row("a", "current"), row("b", "next"), row("c", "retiring"), row("d", "retired"), row("e", "revoked")]);
    await h.store.start();
    expect(h.store.publicKeySet().map(entry => entry.kid)).toEqual([kidFor("a"), kidFor("b"), kidFor("c")]);
    expect(h.store.publicKeySet().every(entry => entry.use === "sig" && entry.alg === "EdDSA")).toBe(true);
    expect(h.store.signer()?.kid).toBe(kidFor("a"));
    await h.store.stop();
  });

  it("fails closed when the current envelope cannot be opened", async () => {
    const broken = row("a", "current");
    broken.ciphertext = Buffer.alloc(32, 9);
    const h = harness([broken, row("b", "next")]);
    await h.store.start();
    expect(h.store.signer()).toBeNull();
    expect(h.store.publicKeySet().map(entry => entry.kid)).toEqual([kidFor("a"), kidFor("b")]);
    expect(h.logger.warn).toHaveBeenCalledOnce();
    await h.store.stop();
  });

  it("reloads on notification and rotates the signer", async () => {
    const h = harness([row("a", "current")]);
    await h.store.start();
    expect(h.store.signer()?.kid).toBe(kidFor("a"));
    h.rows = [row("b", "current"), row("a", "retiring")];
    h.handlers.onNotification();
    await vi.waitFor(() => expect(h.store.signer()?.kid).toBe(kidFor("b")));
    await h.store.stop();
  });

  it("publishes changed key sets, including empty, after committing the new signer", async () => {
    const a = row("a", "current"), b = row("b", "next");
    const h = harness([a]);
    await h.store.start();
    const observed = vi.fn(keys => ({ keys, signer: h.store.signer()?.kid }));
    const unsubscribe = h.store.onKeysChanged(observed);
    h.rows = [a, b];
    await h.store.reload();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.results[0]!.value).toEqual({ keys: h.store.publicKeySet(), signer: a.kid });

    // Reordered rows, a new signer and identical safety reads do not change
    // the public set. No extra frame is needed until a public key changes.
    h.rows = [{ ...b, state: "current" }, { ...a, state: "retiring" }];
    await h.store.reload();
    await h.store.reload();
    expect(observed).toHaveBeenCalledOnce();
    h.rows = [];
    h.handlers.onNotification();
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(2));
    expect(observed.mock.results[1]!.value).toEqual({ keys: [], signer: undefined });

    unsubscribe();
    h.rows = [a];
    await h.store.reload();
    expect(observed).toHaveBeenCalledTimes(2);
    await h.store.stop();
  });

  it("isolates failed key-set observers from the reload and other observers", async () => {
    const h = harness([row("a", "current")]);
    await h.store.start();
    h.store.onKeysChanged(() => { throw new Error("observer failed"); });
    const observed = vi.fn();
    h.store.onKeysChanged(observed);
    h.rows = [row("b", "current")];
    await h.store.reload();
    expect(h.store.signer()?.kid).toBe(kidFor("b"));
    expect(observed).toHaveBeenCalledWith(h.store.publicKeySet());
    expect(h.store.stats().reloadFailures).toBe(0);
    await h.store.stop();
  });

  it("stops signing when the reload after a key change fails, and retries until it loads", async () => {
    const h = harness([row("a", "current")]);
    await h.store.start();
    expect(h.store.signer()?.kid).toBe(kidFor("a"));
    const observed = vi.fn();
    h.store.onKeysChanged(observed);
    // The hint may be a revocation of "a": keep no stale signer.
    h.failing = true;
    h.rows = [row("b", "current")];
    h.handlers.onNotification();
    await vi.waitFor(() => expect(h.store.signer()).toBeNull());
    await vi.waitFor(() => expect(h.load.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(observed).not.toHaveBeenCalled();
    expect(h.store.publicKeySet().map(key => key.kid)).toEqual([kidFor("a")]);
    h.failing = false;
    await vi.waitFor(() => expect(h.store.signer()?.kid).toBe(kidFor("b")));
    expect(observed).toHaveBeenCalledExactlyOnceWith(h.store.publicKeySet());
    const stats = h.store.stats();
    expect(stats.reloadFailures).toBeGreaterThanOrEqual(2);
    expect(stats.noCurrentKey).toBe(0);
    await h.store.stop();
  });

  it("keeps the signer through a failed safety refresh and counts a missing key separately", async () => {
    const h = harness([row("a", "current")]);
    await h.store.start();
    h.failing = true;
    await h.store.reload();
    expect(h.store.signer()?.kid).toBe(kidFor("a"));
    expect(h.store.stats()).toEqual({ reloadFailures: 1, noCurrentKey: 0 });
    h.failing = false;
    h.rows = [row("b", "next")];
    await vi.waitFor(() => expect(h.store.signer()).toBeNull());
    expect(h.store.stats().noCurrentKey).toBe(1);
    await h.store.stop();
  });
});
