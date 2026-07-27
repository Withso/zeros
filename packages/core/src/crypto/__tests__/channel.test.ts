import { describe, it, expect } from "vitest";
import {
  serverHandshake,
  clientHandshake,
  generateIdentityKeyPair,
  sign,
  toBase64,
  fromBase64,
  HandshakeError,
  type HandshakeIO,
  type EncryptedChannel,
} from "../index";

// In-memory duplex so two channels can handshake against each other.
class FrameQueue {
  private items: string[] = [];
  private waiters: ((s: string) => void)[] = [];
  push(s: string): void {
    const w = this.waiters.shift();
    if (w) w(s);
    else this.items.push(s);
  }
  pull(): Promise<string> {
    const i = this.items.shift();
    if (i !== undefined) return Promise.resolve(i);
    return new Promise((res) => this.waiters.push(res));
  }
}

function makePipe(): [HandshakeIO, HandshakeIO] {
  const c2s = new FrameQueue();
  const s2c = new FrameQueue();
  const clientIO: HandshakeIO = { send: (f) => c2s.push(f), recv: () => s2c.pull() };
  const serverIO: HandshakeIO = { send: (f) => s2c.push(f), recv: () => c2s.pull() };
  return [clientIO, serverIO];
}

describe("EncryptedChannel", () => {
  const server = generateIdentityKeyPair();
  const client = generateIdentityKeyPair();
  const serverIdB64 = toBase64(server.publicKey);
  const clientIdB64 = toBase64(client.publicKey);

  async function establish(opts?: {
    isTrusted?: (id: string) => boolean;
    expectedServerIdB64?: string;
    ratchetInterval?: number;
  }): Promise<{ c: EncryptedChannel; s: EncryptedChannel }> {
    const [clientIO, serverIO] = makePipe();
    const [c, s] = await Promise.all([
      clientHandshake(clientIO, {
        identityKeyPair: client,
        expectedServerIdPublicKeyB64: opts?.expectedServerIdB64 ?? serverIdB64,
        ratchetInterval: opts?.ratchetInterval,
      }),
      serverHandshake(serverIO, {
        identityKeyPair: server,
        isTrusted: opts?.isTrusted,
        ratchetInterval: opts?.ratchetInterval,
      }),
    ]);
    return { c, s };
  }

  it("completes a mutual-auth handshake and pins both identities", async () => {
    const { c, s } = await establish();
    expect(c.state).toBe("established");
    expect(s.state).toBe("established");
    expect(c.peerIdPublicKeyB64).toBe(serverIdB64);
    expect(s.peerIdPublicKeyB64).toBe(clientIdB64);
  });

  // H1: the client may sign with a non-extractable key — i.e. via an ASYNC
  // signer that exposes only the public key + sign(), never the secret bytes.
  it("completes with an async identitySigner (non-extractable-key path)", async () => {
    const [clientIO, serverIO] = makePipe();
    let seenClientId: string | undefined;
    const asyncSigner = {
      publicKey: client.publicKey,
      // async to mirror WebCrypto subtle.sign returning a Promise
      sign: async (m: Uint8Array) => sign(m, client.secretKey),
    };
    const [c, s] = await Promise.all([
      clientHandshake(clientIO, {
        identitySigner: asyncSigner,
        expectedServerIdPublicKeyB64: serverIdB64,
      }),
      serverHandshake(serverIO, {
        identityKeyPair: server,
        isTrusted: (id) => {
          seenClientId = id;
          return true;
        },
      }),
    ]);
    // The server still sees the SAME client identity (registry/revocation intact).
    expect(seenClientId).toBe(clientIdB64);
    // And the established channel works end to end.
    const frame = c.encrypt("hello via signer");
    expect(s.decryptText(frame)).toBe("hello via signer");
  });

  it("rejects a client handshake given neither identityKeyPair nor identitySigner", async () => {
    const [clientIO] = makePipe();
    await expect(
      clientHandshake(clientIO, {
        expectedServerIdPublicKeyB64: serverIdB64,
      }),
    ).rejects.toBeInstanceOf(HandshakeError);
  });

  it("encrypts and decrypts in both directions", async () => {
    const { c, s } = await establish();
    const f1 = c.encrypt("hello from client");
    expect(s.decryptText(f1)).toBe("hello from client");
    const f2 = s.encrypt("hello from server");
    expect(c.decryptText(f2)).toBe("hello from server");
    // ciphertext is opaque (no plaintext leak)
    expect(f1).not.toContain("hello");
  });

  it("rejects replayed frames (monotonic counter)", async () => {
    const { c, s } = await establish();
    const f = c.encrypt("once");
    expect(s.decryptText(f)).toBe("once");
    expect(() => s.decrypt(f)).toThrow(/replay/);
  });

  it("rejects tampered frames (AEAD auth)", async () => {
    const { c, s } = await establish();
    const f = c.encrypt("secret");
    const buf = fromBase64(f);
    buf[buf.length - 1] ^= 0xff; // flip the last tag byte — deterministic AEAD failure
    expect(() => s.decrypt(toBase64(buf))).toThrow();
  });

  it("rejects a MITM: host identity not matching the pinned offer key", async () => {
    const wrong = generateIdentityKeyPair();
    const [clientIO, serverIO] = makePipe();
    const results = await Promise.allSettled([
      clientHandshake(clientIO, {
        identityKeyPair: client,
        expectedServerIdPublicKeyB64: toBase64(wrong.publicKey),
        handshakeTimeoutMs: 500,
      }),
      serverHandshake(serverIO, { identityKeyPair: server, handshakeTimeoutMs: 500 }),
    ]);
    const clientResult = results[0];
    expect(clientResult.status).toBe("rejected");
    if (clientResult.status === "rejected") {
      expect(clientResult.reason).toBeInstanceOf(HandshakeError);
      expect((clientResult.reason as HandshakeError).code).toBe("bad-signature");
    }
  });

  it("rejects an untrusted / revoked device", async () => {
    const [clientIO, serverIO] = makePipe();
    const results = await Promise.allSettled([
      clientHandshake(clientIO, {
        identityKeyPair: client,
        expectedServerIdPublicKeyB64: serverIdB64,
        handshakeTimeoutMs: 500,
      }),
      serverHandshake(serverIO, {
        identityKeyPair: server,
        isTrusted: () => false,
        handshakeTimeoutMs: 500,
      }),
    ]);
    const serverResult = results[1];
    expect(serverResult.status).toBe("rejected");
    if (serverResult.status === "rejected") {
      expect((serverResult.reason as HandshakeError).code).toBe("untrusted-device");
    }
  });

  it("survives ratchet boundaries in both directions", async () => {
    const { c, s } = await establish({ ratchetInterval: 4 });
    for (let i = 0; i < 12; i++) {
      expect(s.decryptText(c.encrypt(`c-${i}`))).toBe(`c-${i}`);
    }
    for (let i = 0; i < 12; i++) {
      expect(c.decryptText(s.encrypt(`s-${i}`))).toBe(`s-${i}`);
    }
  });

  it("rejects a forged out-of-range counter in O(1) (no unbounded ratchet DoS)", async () => {
    const { c, s } = await establish();
    // Forge a frame whose counter is enormous (~2^48): byte 1 of the 8-byte
    // big-endian counter set to 1. Pre-fix this drove ~2^32 HKDF iterations.
    const buf = new Uint8Array(12 + 16);
    buf[1] = 0x01;
    const start = Date.now();
    expect(() => s.decrypt(toBase64(buf))).toThrow(/out of range/);
    expect(Date.now() - start).toBeLessThan(500); // did NOT hang in an HKDF loop
    void c;
  });

  it("a rejected (forged) frame does not corrupt channel state", async () => {
    const { c, s } = await establish();
    expect(s.decryptText(c.encrypt("one"))).toBe("one");
    // counter=50 (in-range epoch 0) with garbage ciphertext → AEAD auth fails.
    const forged = new Uint8Array(12 + 16);
    forged[7] = 50;
    expect(() => s.decrypt(toBase64(forged))).toThrow();
    // recvKey/recvEpoch/recvLastSeen must be untouched → next legit frame works.
    expect(s.decryptText(c.encrypt("two"))).toBe("two");
  });
});
