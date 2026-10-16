import { randomBytes } from "node:crypto";
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
    let current = rows;
    const load = vi.fn(async () => current);
    let handlers!: { onNotification: () => void; onReady: () => void; onUnavailable: () => void };
    const logger = { warn: vi.fn(), info: vi.fn() };
    const store = new CapabilitySigningKeyStore({
      keyring, load, logger, refreshMs: 3_600_000,
      subscribe: next => { handlers = next; return { start: async () => {}, healthy: () => true, stop: async () => {} }; },
    });
    return { store, load, logger, get handlers() { return handlers; }, set rows(next: Row[]) { current = next; } };
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
});
