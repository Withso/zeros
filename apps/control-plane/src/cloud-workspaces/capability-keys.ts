import { createCipheriv, createDecipheriv, createPrivateKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import type pg from "pg";

import { withSystemStatement } from "../db.js";
import { postgresNotificationSubscription, type PostgresNotificationSubscription } from "../postgres-notifications.js";
import { sql } from "../sql-fragment.js";
import type { CapabilityKeyring } from "./capability-keyring.js";
import { CAPABILITY_KEY_ID_PATTERN, type CapabilityDeviceKey } from "./capability-contract.js";

export const CAPABILITY_KEYS_CHANNEL = "zeros_capability_keys";
/** AAD binds the sealed private key to its kid and purpose; the envelope is
 * the generalised form of the settings-secret AES-256-GCM envelope with the
 * binding passed in, sealed under the dedicated capability keyring. */
export const CAPABILITY_SEAL_PURPOSE = "zeros-cap-signing-v1";

function keyringKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("capability keyring keys must be canonical base64url for 32 bytes");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    key.fill(0);
    throw new Error("capability keyring keys must be canonical base64url for 32 bytes");
  }
  return key;
}

export type SealedCapabilityKey = { keyVersion: number; nonce: Buffer; ciphertext: Buffer; authTag: Buffer };

export function sealCapabilityPrivateKey(privateSeed: Buffer, kid: string, keyring: CapabilityKeyring): SealedCapabilityKey {
  if (privateSeed.length !== 32 || !CAPABILITY_KEY_ID_PATTERN.test(kid)) throw new Error("capability key input is invalid");
  const key = keyringKey(keyring.keys[keyring.currentKeyVersion]!);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`${CAPABILITY_SEAL_PURPOSE}\n${kid}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(privateSeed), cipher.final()]);
    return { keyVersion: keyring.currentKeyVersion, nonce, ciphertext, authTag: cipher.getAuthTag() };
  } finally {
    key.fill(0);
  }
}

export function openCapabilityPrivateKey(sealed: SealedCapabilityKey, kid: string, keyring: CapabilityKeyring): Buffer {
  const encoded = keyring.keys[sealed.keyVersion];
  if (!encoded || sealed.nonce.length !== 12 || sealed.authTag.length !== 16 ||
      sealed.ciphertext.length !== 32 || !CAPABILITY_KEY_ID_PATTERN.test(kid)) {
    throw new Error("capability signing key envelope is invalid");
  }
  const key = keyringKey(encoded);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
    decipher.setAAD(Buffer.from(`${CAPABILITY_SEAL_PURPOSE}\n${kid}`, "utf8"));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } finally {
    key.fill(0);
  }
}

export type CapabilityKeypair = { kid: string; publicJwk: CapabilityDeviceKey; privateSeed: Buffer };

export function generateCapabilityKeypair(kid: string): CapabilityKeypair {
  if (!CAPABILITY_KEY_ID_PATTERN.test(kid)) throw new Error("capability key id must match cap-<yyyy>-<mm>-<suffix>");
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string; d?: string };
  const privateJwk = pair.privateKey.export({ format: "jwk" }) as { d?: string };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || !privateJwk.d) throw new Error("capability key generation failed");
  const privateSeed = Buffer.from(privateJwk.d, "base64url");
  return { kid, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x }, privateSeed };
}

/** Rebuild the private key from the opened seed and the row's public half.
 * A sign/verify probe proves the pair matches before the key may sign. */
export function capabilityPrivateKeyObject(privateSeed: Buffer, publicJwk: CapabilityDeviceKey): KeyObject {
  if (privateSeed.length !== 32 || publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519" ||
      !/^[A-Za-z0-9_-]{43}$/.test(publicJwk.x)) {
    throw new Error("capability signing key envelope is invalid");
  }
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicJwk.x, d: privateSeed.toString("base64url") },
    format: "jwk",
  });
  const probe = randomBytes(16);
  if (!verify(null, probe, key, sign(null, probe, key))) throw new Error("capability signing key does not match its published public key");
  return key;
}

export type CapabilityPublicKeyEntry = CapabilityDeviceKey & { kid: string; use: "sig"; alg: "EdDSA" };

type Row = {
  kid: string;
  public_jwk: CapabilityDeviceKey;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  state: "next" | "current" | "retiring" | "retired" | "revoked";
};

type Handlers = { onNotification: () => void; onReady: () => void; onUnavailable: () => void };
type Subscribe = (handlers: Handlers) => PostgresNotificationSubscription;
type Load = () => Promise<readonly Row[]>;

export type CapabilitySigningKeyStoreOptions = {
  pool?: pg.Pool;
  listenerPool?: pg.Pool;
  keyring: CapabilityKeyring;
  load?: Load;
  subscribe?: Subscribe;
  refreshMs?: number;
  /** Backoff for retrying a failed reload, each capped below refreshMs.
   * Defaults to 1, 2, 4, 8, 15 and 30 s, like the rollout-flag snapshot. */
  retryDelaysMs?: readonly number[];
  logger?: Pick<Console, "warn" | "info">;
};

export type CapabilitySigningKeyStoreStats = {
  /** Load attempts that failed (database error or timeout). */
  reloadFailures: number;
  /** Successful loads that found no current key that could be opened. */
  noCurrentKey: number;
};

/** In-process view of the capability signing keys. Only `current` signs; the
 * private seed is opened from its envelope on each load and never leaves the
 * store. Reloads on the keys NOTIFY, on every LISTEN (re)connect and on a
 * slow safety refresh. */
export class CapabilitySigningKeyStore {
  private current: { kid: string; key: KeyObject } | null = null;
  private published: readonly CapabilityPublicKeyEntry[] = [];
  private readonly keyListeners = new Set<(keys: readonly CapabilityPublicKeyEntry[]) => void>();
  private reloading: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private listening = false;
  private loadCurrent = false;
  private readonly lossListeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryAttempt = 0;
  /** A key change was announced (NOTIFY or LISTEN reconnect) and no load
   * has succeeded since. */
  private hinted = false;
  private readonly counters: CapabilitySigningKeyStoreStats = { reloadFailures: 0, noCurrentKey: 0 };
  private readonly retryDelaysMs: readonly number[];
  private subscription: PostgresNotificationSubscription | undefined;
  private readonly keyring: CapabilityKeyring;
  private readonly refreshMs: number;
  private readonly logger: Pick<Console, "warn" | "info">;
  private readonly loadRows: Load;
  private readonly subscribe: Subscribe;

  constructor(options: CapabilitySigningKeyStoreOptions) {
    this.keyring = options.keyring;
    this.refreshMs = options.refreshMs ?? 60_000;
    this.retryDelaysMs = (options.retryDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 15_000, 30_000])
      .map(delay => Math.max(1, Math.min(delay, Math.floor(this.refreshMs / 2))));
    this.logger = options.logger ?? console;
    const pool = options.pool;
    this.loadRows = options.load ?? (async () => {
      if (!pool) throw new Error("capability_key_pool_missing");
      return (await withSystemStatement<Row>(pool, sql`SELECT kid,public_jwk,key_version,nonce,ciphertext,auth_tag,state
        FROM cloud_capability_signing_keys WHERE state IN ('next','current','retiring') ORDER BY created_at`)).rows;
    });
    const listenerPool = options.listenerPool;
    this.subscribe = options.subscribe ?? (handlers => {
      if (!listenerPool) throw new Error("capability_key_listener_pool_missing");
      return postgresNotificationSubscription(listenerPool, {
        channels: [CAPABILITY_KEYS_CHANNEL],
        onNotification: () => handlers.onNotification(),
        onReady: handlers.onReady,
        onUnavailable: handlers.onUnavailable,
      });
    });
  }

  /** Resolves after the first load attempt; never rejects. A failed load is
   * retried with backoff. A failed safety refresh keeps the previous signer,
   * but a failed load after a key-change hint drops it (issuance fails
   * closed) until a load succeeds: the hint may be a revocation, and
   * issuance needs the database anyway. */
  start(): Promise<void> {
    if (this.subscription || this.stopped) return this.reloading ?? Promise.resolve();
    this.subscription = this.subscribe({
      onNotification: () => { this.hinted = true; void this.reload(); },
      onReady: () => { this.listening = true; this.hinted = true; void this.reload(); },
      onUnavailable: () => { this.listening = false; this.lost(); },
    });
    void this.subscription.start().catch(() => {});
    this.timer = setInterval(() => { void this.reload(); }, this.refreshMs);
    this.timer.unref();
    return this.reload();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lost();
    this.lossListeners.clear();
    this.keyListeners.clear();
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = undefined;
    await this.subscription?.stop();
    await this.reloading;
  }

  /** The key the issuer signs with, or null when no current key can be
   * opened. Issuance fails closed on null. */
  signer(): { kid: string; key: KeyObject } | null {
    return this.current;
  }

  /** next, current and retiring keys for the JWKS endpoint and S2 auth.keys. */
  publicKeySet(): readonly CapabilityPublicKeyEntry[] {
    return this.published;
  }

  /** Successful changes to the public set, including removal of every key.
   * Consumers read the initial set separately and unsubscribe on shutdown. */
  onKeysChanged(listener: (keys: readonly CapabilityPublicKeyEntry[]) => void): () => void {
    if (this.stopped) return () => {};
    this.keyListeners.add(listener);
    return () => { this.keyListeners.delete(listener); };
  }

  stats(): CapabilitySigningKeyStoreStats {
    return { ...this.counters };
  }

  authorityCurrent(): boolean { return !this.stopped && this.listening && this.loadCurrent && !this.hinted; }
  onHealthLost(listener: () => void): () => void {
    this.lossListeners.add(listener);
    return () => { this.lossListeners.delete(listener); };
  }
  private lost(): void {
    this.loadCurrent = false;
    for (const listener of [...this.lossListeners]) listener();
  }
  /** reload() can retain old keys on failure. Continuation needs positive
   * source evidence, including a pass started after the challenge batch. */
  async observeAuthority(): Promise<boolean> {
    const failures = this.counters.reloadFailures;
    await this.reload();
    return this.authorityCurrent() && failures === this.counters.reloadFailures;
  }

  reload(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reloading) { this.again = true; return this.reloading; }
    this.reloading = this.run().finally(() => { this.reloading = undefined; });
    return this.reloading;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelaysMs[Math.min(this.retryAttempt, this.retryDelaysMs.length - 1)]!;
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reload();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async run(): Promise<void> {
    do {
      this.again = false;
      const hinted = this.hinted;
      let rows: readonly Row[];
      try {
        rows = await this.loadRows();
      } catch {
        this.counters.reloadFailures += 1;
        this.lost();
        if (hinted && this.current) {
          this.current = null;
          this.logger.warn("[capability-keys] reload after a key change failed; not signing until a reload succeeds");
        } else {
          this.logger.warn("[capability-keys] reload failed; retrying with backoff");
        }
        this.scheduleRetry();
        continue;
      }
      if (this.stopped) return;
      this.retryAttempt = 0;
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      // A hint that arrived during this read is served by the next pass.
      if (!this.again) this.hinted = false;
      const published: CapabilityPublicKeyEntry[] = [];
      let current: { kid: string; key: KeyObject } | null = null;
      for (const row of rows) {
        if (!CAPABILITY_KEY_ID_PATTERN.test(row.kid) || !["next", "current", "retiring"].includes(row.state)) continue;
        published.push({ ...row.public_jwk, kid: row.kid, use: "sig", alg: "EdDSA" });
        if (row.state === "current") {
          try {
            const seed = openCapabilityPrivateKey(
              { keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
              row.kid, this.keyring,
            );
            try {
              current = { kid: row.kid, key: capabilityPrivateKeyObject(seed, row.public_jwk) };
            } finally {
              seed.fill(0);
            }
          } catch (error) {
            current = null;
            this.logger.warn(`[capability-keys] current key cannot be opened: ${error instanceof Error ? error.message : "failed"}`);
          }
        }
      }
      if (!current) this.counters.noCurrentKey += 1;
      const changed = published.length !== this.published.length || published.some(key =>
        !this.published.some(previous => previous.kid === key.kid && previous.kty === key.kty &&
          previous.crv === key.crv && previous.x === key.x));
      this.published = published;
      this.current = current;
      this.loadCurrent = true;
      if (changed) for (const listener of this.keyListeners) {
        try { listener(published); }
        catch { this.logger.warn("[capability-keys] key-set consumer callback failed"); }
      }
    } while (this.again && !this.stopped);
  }
}
