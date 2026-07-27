// ──────────────────────────────────────────────────────────
// EncryptedChannel — mutually-authenticated E2EE for the bridge
// ──────────────────────────────────────────────────────────
//
// Stronger than a one-way NaCl box (Paseo) — modelled on Remodex +
// StealthRelay and hardened with replay protection + a forward-secrecy
// ratchet:
//
//   • Identity (long-term Ed25519) on BOTH ends → mutual auth, which is
//     what makes per-device revocation possible.
//   • Ephemeral X25519 per session → per-session forward secrecy.
//   • The host signs the handshake transcript; the client verifies it
//     against the key PINNED in the pairing offer → anti-MITM (a
//     malicious relay can't forge the signature).
//   • The client signs too; the host verifies against its device
//     registry → blocks unknown/revoked devices.
//   • HKDF-SHA256 → two DIRECTIONAL ChaCha20-Poly1305 keys.
//   • Monotonic per-direction counter in the AEAD nonce + AAD →
//     in-session replay protection (the gap Paseo documents).
//   • Symmetric ratchet every N records → bounds the blast radius of a
//     late key compromise over a long agent run.
//
// The channel is transport-agnostic: the handshake is driven over a
// minimal `HandshakeIO`; the established channel is a pure transformer
// (`encrypt`/`decrypt`). A relay data socket, a browser WebSocket, and
// a React Native socket all adapt to the same interface.
// ──────────────────────────────────────────────────────────

import {
  type KeyPairBytes,
  generateEphemeralKeyPair,
  deriveSharedSecret,
  sign,
  verify,
  sha256Hash,
  hkdfSha256,
  randomBytes,
  aeadSeal,
  aeadOpen,
  utf8Encode,
  utf8Decode,
  toBase64,
  fromBase64,
  concatBytes,
} from "./primitives";
import { PROTOCOL_VERSION, isCompatible } from "../version";

const HS_LABEL = "zeros-bridge-v2";
const DIR_C2D = 0x01; // client → daemon
const DIR_D2C = 0x02; // daemon → client
const DEFAULT_RATCHET_INTERVAL = 1 << 16; // 65536 records per direction
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const NONCE_LEN = 12; // ChaCha20-Poly1305 nonce
const AEAD_TAG_LEN = 16;

export type ChannelState = "handshaking" | "established" | "closed";

export type HandshakeErrorCode =
  | "version"
  | "bad-signature"
  | "untrusted-device"
  | "timeout"
  | "protocol";

export class HandshakeError extends Error {
  constructor(
    public readonly code: HandshakeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HandshakeError";
  }
}

/** Minimal duplex the handshake drives. The caller adapts its socket:
 *  `send` writes a text frame; `recv` resolves with the next inbound frame. */
export interface HandshakeIO {
  send(frame: string): void;
  recv(): Promise<string>;
}

export interface ServerHandshakeOptions {
  /** The host's long-term Ed25519 identity. */
  identityKeyPair: KeyPairBytes;
  /** Device-registry gate. Return false to reject the connecting client. The
   *  second arg is the pairing nonce the client echoed from the offer (H13) —
   *  the gate uses it to TOFU-accept an unknown device only when it proves
   *  possession of the current offer, not merely knowledge of serverId.
   *  Omit to accept any client (trust-on-first-use is the caller's job). */
  isTrusted?: (clientIdPublicKeyB64: string, pairingNonce?: string) => boolean;
  ratchetInterval?: number;
  handshakeTimeoutMs?: number;
}

/** An identity that can sign WITHOUT exposing its private key bytes — the shape
 *  a non-extractable WebCrypto key takes (H1: the browser device key lives as a
 *  non-extractable CryptoKey, so we only ever get its public bytes + an async
 *  sign(), never the secret). The byte-key path (Node / engine / tests) is
 *  trivially adapted to this too. */
export interface IdentitySigner {
  /** Long-term Ed25519 public key (raw 32 bytes). */
  publicKey: Uint8Array;
  /** Sign `message` (may be async — WebCrypto subtle.sign is a Promise). */
  sign(message: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

export interface ClientHandshakeOptions {
  /** This device's long-term Ed25519 identity as raw bytes (Node / tests /
   *  engine). Provide EITHER this OR `identitySigner`. */
  identityKeyPair?: KeyPairBytes;
  /** This device's identity as a non-extractable signer (the browser path —
   *  the private key never enters JS). Provide EITHER this OR `identityKeyPair`. */
  identitySigner?: IdentitySigner;
  /** Host identity public key from the pairing offer — PINNED (anti-MITM). */
  expectedServerIdPublicKeyB64: string;
  /** H13: the offer's pairing nonce, echoed to the daemon so an unknown device
   *  can only TOFU-pair when it holds the current offer. Absent on a trusted
   *  reconnect (the device registry already knows it). */
  pairingNonce?: string;
  ratchetInterval?: number;
  handshakeTimeoutMs?: number;
}

// ── Handshake frame shapes (the only plaintext the relay ever sees) ──

interface HelloFrame {
  t: "hello";
  v: number;
  ce: string; // client ephemeral X25519 public key
  cn: string; // client nonce
  ci: string; // client identity Ed25519 public key
  pn?: string; // H13: pairing nonce echoed from the offer (TOFU gate; optional)
}
interface AuthFrame {
  t: "auth";
  se: string; // server ephemeral X25519 public key
  sn: string; // server nonce
  sig: string; // server Ed25519 signature over the transcript
  v?: number; // M3: the agreed protocol version, echoed so both sides bind it
}
interface ConfirmFrame {
  t: "confirm";
  sig: string; // client Ed25519 signature over the transcript
}
interface ReadyFrame {
  t: "ready";
}

// ── Internal helpers ────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HandshakeError("timeout", `handshake timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function writeU64BE(arr: Uint8Array, offset: number, num: number): void {
  let n = num;
  for (let i = 7; i >= 0; i--) {
    arr[offset + i] = n & 0xff;
    n = Math.floor(n / 256);
  }
}

function readU64BE(arr: Uint8Array, offset: number): number {
  let n = 0;
  for (let i = 0; i < 8; i++) n = n * 256 + arr[offset + i];
  return n;
}

function computeTranscript(
  v: number,
  clientEphPub: Uint8Array,
  clientNonce: Uint8Array,
  clientIdPub: Uint8Array,
  serverEphPub: Uint8Array,
  serverNonce: Uint8Array,
): Uint8Array {
  return sha256Hash(
    concatBytes(
      utf8Encode(HS_LABEL),
      Uint8Array.of(v & 0xff),
      clientEphPub,
      clientNonce,
      clientIdPub,
      serverEphPub,
      serverNonce,
    ),
  );
}

function deriveDirKeys(
  shared: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
): { kC2D: Uint8Array; kD2C: Uint8Array } {
  const salt = concatBytes(clientNonce, serverNonce);
  return {
    kC2D: hkdfSha256(shared, salt, utf8Encode(HS_LABEL + "|c2d"), 32),
    kD2C: hkdfSha256(shared, salt, utf8Encode(HS_LABEL + "|d2c"), 32),
  };
}

// ── The channel ─────────────────────────────────────────────

interface ChannelInit {
  role: "server" | "client";
  kC2D: Uint8Array;
  kD2C: Uint8Array;
  peerIdPublicKeyB64: string;
  ratchetInterval: number;
}

export class EncryptedChannel {
  state: ChannelState = "established";
  readonly peerIdPublicKeyB64: string;

  private sendKey: Uint8Array;
  private recvKey: Uint8Array;
  private readonly sendDir: number;
  private readonly recvDir: number;
  private readonly ratchetInterval: number;

  private sendCounter = 0;
  private recvLastSeen = -1;
  private sendEpoch = 0;
  private recvEpoch = 0;

  private constructor(init: ChannelInit) {
    this.peerIdPublicKeyB64 = init.peerIdPublicKeyB64;
    this.ratchetInterval = init.ratchetInterval;
    if (init.role === "server") {
      this.sendKey = init.kD2C;
      this.recvKey = init.kC2D;
      this.sendDir = DIR_D2C;
      this.recvDir = DIR_C2D;
    } else {
      this.sendKey = init.kC2D;
      this.recvKey = init.kD2C;
      this.sendDir = DIR_C2D;
      this.recvDir = DIR_D2C;
    }
  }

  /** @internal — constructed by the handshake functions only. */
  static _create(init: ChannelInit): EncryptedChannel {
    return new EncryptedChannel(init);
  }

  /** Encrypt an application message → a base64url text frame. */
  encrypt(plaintext: string | Uint8Array): string {
    if (this.state !== "established") throw new Error("channel not established");
    const pt = typeof plaintext === "string" ? utf8Encode(plaintext) : plaintext;
    const counter = this.sendCounter++;
    this.maybeRatchetSend(counter);
    const nonce = new Uint8Array(NONCE_LEN);
    writeU64BE(nonce, 0, counter);
    nonce.set(randomBytes(4), 8);
    const aad = new Uint8Array(9);
    aad[0] = this.sendDir;
    writeU64BE(aad, 1, counter);
    const ct = aeadSeal(this.sendKey, nonce, pt, aad);
    return toBase64(concatBytes(nonce, ct));
  }

  /** Decrypt a frame. Throws on replay, tampering, or a malformed frame. */
  decrypt(frame: string): Uint8Array {
    if (this.state !== "established") throw new Error("channel not established");
    const buf = fromBase64(frame);
    if (buf.length < NONCE_LEN + AEAD_TAG_LEN) throw new Error("frame too short");
    const nonce = buf.slice(0, NONCE_LEN);
    const ct = buf.slice(NONCE_LEN);
    const counter = readU64BE(nonce, 0);
    if (counter <= this.recvLastSeen) {
      throw new Error(`replay detected: counter ${counter} <= last seen ${this.recvLastSeen}`);
    }
    // Authenticate the frame BEFORE mutating any channel state, and BOUND the
    // ratchet advance: a forged counter (the nonce is attacker-controlled) must
    // never drive an unbounded HKDF loop (CPU DoS), nor advance recvKey/recvEpoch
    // ahead of a failed verify. Over a single ordered stream the epoch advances
    // by at most 1 per accepted frame (encrypt bumps the counter by 1; the replay
    // check rejects non-increasing counters), so a +1 bound never rejects a
    // legitimate frame while a huge forged counter is rejected in O(1).
    const epoch = Math.floor(counter / this.ratchetInterval);
    if (epoch > this.recvEpoch + 1) {
      throw new Error(`frame counter out of range (epoch ${epoch} > ${this.recvEpoch + 1})`);
    }
    let key = this.recvKey;
    let ep = this.recvEpoch;
    while (ep < epoch) {
      key = hkdfSha256(key, new Uint8Array(0), utf8Encode("ratchet"), 32);
      ep++;
    }
    const aad = new Uint8Array(9);
    aad[0] = this.recvDir;
    writeU64BE(aad, 1, counter);
    const pt = aeadOpen(key, nonce, ct, aad); // throws on auth failure BEFORE any commit
    this.recvKey = key;
    this.recvEpoch = ep;
    this.recvLastSeen = counter;
    return pt;
  }

  decryptText(frame: string): string {
    return utf8Decode(this.decrypt(frame));
  }

  close(): void {
    this.state = "closed";
  }

  private maybeRatchetSend(counter: number): void {
    const epoch = Math.floor(counter / this.ratchetInterval);
    while (this.sendEpoch < epoch) {
      this.sendKey = hkdfSha256(this.sendKey, new Uint8Array(0), utf8Encode("ratchet"), 32);
      this.sendEpoch++;
    }
  }

}

// ── Handshake drivers ───────────────────────────────────────

/** Daemon side. Awaits `hello`, proves identity, verifies the client,
 *  and returns an established channel. */
export async function serverHandshake(
  io: HandshakeIO,
  opts: ServerHandshakeOptions,
): Promise<EncryptedChannel> {
  const timeout = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const ratchetInterval = opts.ratchetInterval ?? DEFAULT_RATCHET_INTERVAL;

  const hello = JSON.parse(await withTimeout(io.recv(), timeout)) as HelloFrame;
  if (hello.t !== "hello") throw new HandshakeError("protocol", `expected hello, got ${hello.t}`);
  if (!isCompatible(hello.v)) {
    throw new HandshakeError("version", `unsupported protocol version ${hello.v}`);
  }
  const clientEphPub = fromBase64(hello.ce);
  const clientNonce = fromBase64(hello.cn);
  const clientIdPub = fromBase64(hello.ci);

  const serverEph = generateEphemeralKeyPair();
  const serverNonce = randomBytes(32);
  // M3: bind the AGREED protocol version (the one the client offered + we
  // accepted), not our local constant — and echo it in `auth` so the client
  // binds the same byte. At today's single version this is identical to before.
  const agreedVersion = hello.v;
  const transcript = computeTranscript(
    agreedVersion,
    clientEphPub,
    clientNonce,
    clientIdPub,
    serverEph.publicKey,
    serverNonce,
  );
  const sigD = sign(transcript, opts.identityKeyPair.secretKey);
  const authFrame: AuthFrame = {
    t: "auth",
    se: toBase64(serverEph.publicKey),
    sn: toBase64(serverNonce),
    sig: toBase64(sigD),
    v: agreedVersion,
  };
  io.send(JSON.stringify(authFrame));

  const confirm = JSON.parse(await withTimeout(io.recv(), timeout)) as ConfirmFrame;
  if (confirm.t !== "confirm") {
    throw new HandshakeError("protocol", `expected confirm, got ${confirm.t}`);
  }
  if (!verify(fromBase64(confirm.sig), transcript, clientIdPub)) {
    throw new HandshakeError("bad-signature", "client signature verification failed");
  }
  const clientIdB64 = toBase64(clientIdPub);
  // H13: hand the gate the echoed pairing nonce so it can require an UNKNOWN
  // device to prove it holds the current offer (not just serverId) before TOFU.
  if (opts.isTrusted && !opts.isTrusted(clientIdB64, hello.pn)) {
    throw new HandshakeError("untrusted-device", "connecting device is not trusted");
  }

  const shared = deriveSharedSecret(serverEph.secretKey, clientEphPub);
  const { kC2D, kD2C } = deriveDirKeys(shared, clientNonce, serverNonce);
  const readyFrame: ReadyFrame = { t: "ready" };
  io.send(JSON.stringify(readyFrame));

  return EncryptedChannel._create({
    role: "server",
    kC2D,
    kD2C,
    peerIdPublicKeyB64: clientIdB64,
    ratchetInterval,
  });
}

/** Client side. Sends `hello`, verifies the host against the pinned offer
 *  key, proves its own identity, and returns an established channel. */
export async function clientHandshake(
  io: HandshakeIO,
  opts: ClientHandshakeOptions,
): Promise<EncryptedChannel> {
  const timeout = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const ratchetInterval = opts.ratchetInterval ?? DEFAULT_RATCHET_INTERVAL;

  // Accept either a raw byte key (Node/tests) or a non-extractable signer (web).
  const identitySign: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array =
    opts.identitySigner
      ? (m) => opts.identitySigner!.sign(m)
      : opts.identityKeyPair
        ? (m) => sign(m, opts.identityKeyPair!.secretKey)
        : (() => {
            throw new HandshakeError(
              "protocol",
              "clientHandshake requires identityKeyPair or identitySigner",
            );
          })();
  const clientIdPub = opts.identitySigner?.publicKey ?? opts.identityKeyPair?.publicKey;
  if (!clientIdPub) {
    throw new HandshakeError("protocol", "clientHandshake requires an identity public key");
  }

  const clientEph = generateEphemeralKeyPair();
  const clientNonce = randomBytes(32);
  const helloFrame: HelloFrame = {
    t: "hello",
    v: PROTOCOL_VERSION,
    ce: toBase64(clientEph.publicKey),
    cn: toBase64(clientNonce),
    ci: toBase64(clientIdPub),
    // H13: echo the offer's pairing nonce (omitted on a trusted reconnect).
    ...(opts.pairingNonce ? { pn: opts.pairingNonce } : {}),
  };
  io.send(JSON.stringify(helloFrame));

  const auth = JSON.parse(await withTimeout(io.recv(), timeout)) as AuthFrame;
  if (auth.t !== "auth") throw new HandshakeError("protocol", `expected auth, got ${auth.t}`);
  const serverEphPub = fromBase64(auth.se);
  const serverNonce = fromBase64(auth.sn);
  const expectedServerIdPub = fromBase64(opts.expectedServerIdPublicKeyB64);
  // M3: bind the version the server AGREED to. A new server echoes `auth.v`; an
  // old one omits it (fall back to our constant — identical at today's version).
  // If the server agreed to a DIFFERENT version than we offered, that's a
  // downgrade/mismatch — refuse rather than bind a value the peer didn't.
  if (auth.v !== undefined && auth.v !== PROTOCOL_VERSION) {
    throw new HandshakeError("version", `server agreed to protocol ${auth.v}, expected ${PROTOCOL_VERSION}`);
  }
  const agreedVersion = auth.v ?? PROTOCOL_VERSION;
  const transcript = computeTranscript(
    agreedVersion,
    clientEph.publicKey,
    clientNonce,
    clientIdPub,
    serverEphPub,
    serverNonce,
  );
  if (!verify(fromBase64(auth.sig), transcript, expectedServerIdPub)) {
    throw new HandshakeError(
      "bad-signature",
      "host identity does not match the pairing offer (possible MITM)",
    );
  }

  const sigC = await identitySign(transcript);
  const confirmFrame: ConfirmFrame = { t: "confirm", sig: toBase64(sigC) };
  io.send(JSON.stringify(confirmFrame));

  const ready = JSON.parse(await withTimeout(io.recv(), timeout)) as ReadyFrame;
  if (ready.t !== "ready") throw new HandshakeError("protocol", `expected ready, got ${ready.t}`);

  const shared = deriveSharedSecret(clientEph.secretKey, serverEphPub);
  const { kC2D, kD2C } = deriveDirKeys(shared, clientNonce, serverNonce);

  return EncryptedChannel._create({
    role: "client",
    kC2D,
    kD2C,
    peerIdPublicKeyB64: opts.expectedServerIdPublicKeyB64,
    ratchetInterval,
  });
}
