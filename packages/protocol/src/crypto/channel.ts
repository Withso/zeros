// ──────────────────────────────────────────────────────────
// EncryptedChannel — mutually-authenticated E2EE for the bridge
// ──────────────────────────────────────────────────────────
//
// Mutually authenticated channel hardened with replay protection and a
// forward-secrecy ratchet:
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
//     in-session replay protection.
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

// Handshake format is versioned separately from application messages. Legacy
// peers cannot enroll: both ends must explicitly negotiate this protected proof.
const HANDSHAKE_VERSION = 3;
const HS_LABEL = "zeros-bridge-handshake-v3";
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
   *  second arg is the decrypted offer nonce, authenticated to this client's
   *  identity and handshake. Enrollment MUST atomically check expiry and consume
   *  the offer. Share one gate per offer (or use a durable registry transaction).
   *  Omit to accept any client (trust-on-first-use is the caller's job). */
  isTrusted?: (clientIdPublicKeyB64: string, pairingNonce?: string) => boolean;
  ratchetInterval?: number;
  handshakeTimeoutMs?: number;
}

/** An identity that can sign WITHOUT exposing its private key bytes — the shape
 *  a non-extractable WebCrypto key takes (the browser device key lives as a
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
  /** The offer's pairing nonce, encrypted to the authenticated host so a device
   *  can only TOFU-pair when it holds the current offer. Absent on a trusted
   *  reconnect (the device registry already knows it). */
  pairingNonce?: string;
  ratchetInterval?: number;
  handshakeTimeoutMs?: number;
}

// ── Handshake frame shapes (the only plaintext the relay ever sees) ──

interface HelloFrame {
  t: "hello";
  h: number;
  v: number;
  ce: string; // client ephemeral X25519 public key
  cn: string; // client nonce
  ci: string; // client identity Ed25519 public key
}
interface AuthFrame {
  t: "auth";
  h: number;
  se: string; // server ephemeral X25519 public key
  sn: string; // server nonce
  sig: string; // server Ed25519 signature over the transcript
  v?: number; // Agreed protocol version, echoed so both sides bind it
}
interface ConfirmFrame {
  t: "confirm";
  sig: string; // client Ed25519 signature over the transcript
  proof?: string; // AEAD-sealed offer nonce, bound to this transcript
}
interface ReadyFrame {
  t: "ready";
  proof: string;
}

// ── Internal helpers ────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new HandshakeError("timeout", `handshake timed out after ${ms}ms`),
        ),
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
  serverIdPub: Uint8Array,
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
      serverIdPub,
    ),
  );
}

function proofKey(shared: Uint8Array, transcript: Uint8Array, purpose: string): Uint8Array {
  return hkdfSha256(shared, transcript, utf8Encode(`${HS_LABEL}|${purpose}`), 32);
}

function sealProof(key: Uint8Array, text: string, transcript: Uint8Array): string {
  const nonce = randomBytes(NONCE_LEN);
  return toBase64(concatBytes(nonce, aeadSeal(key, nonce, utf8Encode(text), transcript)));
}

function openProof(key: Uint8Array, proof: string, transcript: Uint8Array): string {
  if (typeof proof !== "string" || proof.length > 1024) throw new HandshakeError("protocol", "invalid proof");
  try {
    const bytes = fromBase64(proof);
    return utf8Decode(aeadOpen(key, bytes.slice(0, NONCE_LEN), bytes.slice(NONCE_LEN), transcript));
  } catch { throw new HandshakeError("bad-signature", "handshake proof authentication failed"); }
}

async function receiveFrame<T>(io: HandshakeIO, timeout: number): Promise<T> {
  const frame = await withTimeout(io.recv(), timeout);
  if (typeof frame !== "string" || frame.length > 4096) throw new HandshakeError("protocol", "invalid handshake frame");
  try {
    const value = JSON.parse(frame);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch { throw new HandshakeError("protocol", "invalid handshake frame"); }
}

function keyBytes(value: string): Uint8Array {
  if (typeof value !== "string" || value.length > 48) throw new HandshakeError("protocol", "invalid handshake key");
  const bytes = fromBase64(value);
  if (bytes.length !== 32) throw new HandshakeError("protocol", "invalid handshake key");
  return bytes;
}

/** In-process single-use admission. All connections for an offer must share
 * this gate; multi-process hosts instead consume in their durable registry. */
export function createPairingTrustGate(options: {
  nonce: string;
  expiresAt: number;
  isTrusted: (id: string) => boolean;
  enroll: (id: string) => boolean;
  now?: () => number;
}): (id: string, nonce?: string) => boolean {
  let consumed = false;
  const now = options.now ?? Date.now;
  return (id, nonce) => {
    if (options.isTrusted(id)) return true;
    if (consumed || !Number.isFinite(options.expiresAt) || now() >= options.expiresAt || !nonce || nonce !== options.nonce) return false;
    consumed = true;
    return options.enroll(id);
  };
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
    if (this.state !== "established")
      throw new Error("channel not established");
    const pt =
      typeof plaintext === "string" ? utf8Encode(plaintext) : plaintext;
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
    if (this.state !== "established")
      throw new Error("channel not established");
    const buf = fromBase64(frame);
    if (buf.length < NONCE_LEN + AEAD_TAG_LEN)
      throw new Error("frame too short");
    const nonce = buf.slice(0, NONCE_LEN);
    const ct = buf.slice(NONCE_LEN);
    const counter = readU64BE(nonce, 0);
    if (counter <= this.recvLastSeen) {
      throw new Error(
        `replay detected: counter ${counter} <= last seen ${this.recvLastSeen}`,
      );
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
      throw new Error(
        `frame counter out of range (epoch ${epoch} > ${this.recvEpoch + 1})`,
      );
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
      this.sendKey = hkdfSha256(
        this.sendKey,
        new Uint8Array(0),
        utf8Encode("ratchet"),
        32,
      );
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

  const hello = await receiveFrame<HelloFrame>(io, timeout);
  if (hello.t !== "hello")
    throw new HandshakeError("protocol", `expected hello, got ${hello.t}`);
  if (hello.h !== HANDSHAKE_VERSION || !isCompatible(hello.v) || "pn" in hello) {
    throw new HandshakeError(
      "version",
      `unsupported protocol version ${hello.v}`,
    );
  }
  const clientEphPub = keyBytes(hello.ce);
  const clientNonce = keyBytes(hello.cn);
  const clientIdPub = keyBytes(hello.ci);

  const serverEph = generateEphemeralKeyPair();
  const serverNonce = randomBytes(32);
  // Bind the agreed protocol version (the one the client offered and we
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
    opts.identityKeyPair.publicKey,
  );
  const sigD = sign(transcript, opts.identityKeyPair.secretKey);
  const authFrame: AuthFrame = {
    t: "auth",
    h: HANDSHAKE_VERSION,
    se: toBase64(serverEph.publicKey),
    sn: toBase64(serverNonce),
    sig: toBase64(sigD),
    v: agreedVersion,
  };
  io.send(JSON.stringify(authFrame));

  const confirm = await receiveFrame<ConfirmFrame>(io, timeout);
  if (confirm.t !== "confirm") {
    throw new HandshakeError("protocol", `expected confirm, got ${confirm.t}`);
  }
  const confirmation = sha256Hash(concatBytes(transcript, utf8Encode(confirm.proof ?? "")));
  if (!verify(fromBase64(confirm.sig), confirmation, clientIdPub)) {
    throw new HandshakeError(
      "bad-signature",
      "client signature verification failed",
    );
  }
  const clientIdB64 = toBase64(clientIdPub);
  const shared = deriveSharedSecret(serverEph.secretKey, clientEphPub);
  const nonce = confirm.proof === undefined ? undefined : openProof(proofKey(shared, transcript, "pairing"), confirm.proof, transcript);
  if (opts.isTrusted && !opts.isTrusted(clientIdB64, nonce)) {
    throw new HandshakeError(
      "untrusted-device",
      "connecting device is not trusted",
    );
  }

  const { kC2D, kD2C } = deriveDirKeys(shared, clientNonce, serverNonce);
  const readyFrame: ReadyFrame = { t: "ready", proof: sealProof(proofKey(shared, transcript, "ready"), "ready", confirmation) };
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
  if (opts.pairingNonce !== undefined && (typeof opts.pairingNonce !== "string" || !opts.pairingNonce || opts.pairingNonce.length > 256))
    throw new HandshakeError("protocol", "invalid pairing nonce");

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
  const clientIdPub =
    opts.identitySigner?.publicKey ?? opts.identityKeyPair?.publicKey;
  if (!clientIdPub) {
    throw new HandshakeError(
      "protocol",
      "clientHandshake requires an identity public key",
    );
  }

  const clientEph = generateEphemeralKeyPair();
  const clientNonce = randomBytes(32);
  const helloFrame: HelloFrame = {
    t: "hello",
    h: HANDSHAKE_VERSION,
    v: PROTOCOL_VERSION,
    ce: toBase64(clientEph.publicKey),
    cn: toBase64(clientNonce),
    ci: toBase64(clientIdPub),
  };
  io.send(JSON.stringify(helloFrame));

  const auth = await receiveFrame<AuthFrame>(io, timeout);
  if (auth.t !== "auth")
    throw new HandshakeError("protocol", `expected auth, got ${auth.t}`);
  const serverEphPub = keyBytes(auth.se);
  const serverNonce = keyBytes(auth.sn);
  const expectedServerIdPub = keyBytes(opts.expectedServerIdPublicKeyB64);
  // Both versions must be explicit. Never downgrade to plaintext enrollment.
  if (auth.h !== HANDSHAKE_VERSION || auth.v !== PROTOCOL_VERSION) {
    throw new HandshakeError(
      "version",
      `server agreed to protocol ${auth.v}, expected ${PROTOCOL_VERSION}`,
    );
  }
  const agreedVersion = auth.v;
  const transcript = computeTranscript(
    agreedVersion,
    clientEph.publicKey,
    clientNonce,
    clientIdPub,
    serverEphPub,
    serverNonce,
    expectedServerIdPub,
  );
  if (!verify(fromBase64(auth.sig), transcript, expectedServerIdPub)) {
    throw new HandshakeError(
      "bad-signature",
      "host identity does not match the pairing offer (possible MITM)",
    );
  }

  const shared = deriveSharedSecret(clientEph.secretKey, serverEphPub);
  const proof = opts.pairingNonce === undefined ? undefined : sealProof(proofKey(shared, transcript, "pairing"), opts.pairingNonce, transcript);
  const confirmation = sha256Hash(concatBytes(transcript, utf8Encode(proof ?? "")));
  const sigC = await identitySign(confirmation);
  const confirmFrame: ConfirmFrame = { t: "confirm", sig: toBase64(sigC), ...(proof ? { proof } : {}) };
  io.send(JSON.stringify(confirmFrame));

  const ready = await receiveFrame<ReadyFrame>(io, timeout);
  if (ready.t !== "ready")
    throw new HandshakeError("protocol", `expected ready, got ${ready.t}`);

  if (openProof(proofKey(shared, transcript, "ready"), ready.proof, confirmation) !== "ready")
    throw new HandshakeError("bad-signature", "invalid ready proof");
  const { kC2D, kD2C } = deriveDirKeys(shared, clientNonce, serverNonce);

  return EncryptedChannel._create({
    role: "client",
    kC2D,
    kD2C,
    peerIdPublicKeyB64: opts.expectedServerIdPublicKeyB64,
    ratchetInterval,
  });
}
