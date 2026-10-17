import { open, rename, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  CapabilityVerifier,
  capabilityEpochEntries,
  type CapabilityProof,
  type CapabilityRoute,
  type CapabilitySessionClosure,
  type CapabilityVerifyContext,
  type CapabilityVerifyResult,
  type CapabilityVerifySuccess,
} from "./cloud-capability-verifier";
import type {
  EngineUplinkAuthDelta,
  EngineUplinkAuthSink,
  EngineUplinkAuthSync,
  EngineUplinkCapability,
  EngineUplinkJwk,
  EngineUplinkRevocation,
} from "./cloud-engine-uplink";

/**
 * The engine's durable S1 verifier state and client-token verification
 * (cloud mode only; constructed only when the control plane advertised an
 * uplink, which requires the organization's `capabilities` flag). Binds the
 * shared verifier to the uplink's `EngineUplinkAuthSink` calling guarantee:
 * - every `applyKeys`/`applySync`/`applyDelta` resolves only once its state
 *   is durable, and resolves or rejects within ENGINE_AUTH_SINK_BOUND_MS so a
 *   hung write can never wedge the uplink's client-scoped auth chain;
 * - epochs and revocations merge in memory first (maximum merge, never
 *   lowered), so a slow write can only delay `auth.applied`, never an
 *   epoch's effect on open sessions;
 * - the cursor offered in `sys.hello` advances only after a durable write;
 * - `applyKeys` replaces the key set.
 */

/** Equal to the control plane's UPLINK_AUTH_APPLIED_TIMEOUT_MS (S2), which
 * the server's auth.applied wait is tied to; a test pins the two together. */
export const ENGINE_AUTH_SINK_BOUND_MS = 10_000;
/** S1 "Outage rule": the JWKS probe while the uplink is down. */
export const ENGINE_JWKS_PROBE_INTERVAL_MS = 10_000;
export const ENGINE_JWKS_PROBE_TIMEOUT_MS = 3_000;

export class EngineAuthSinkTimeoutError extends Error {
  constructor() {
    super("capability auth state did not become durable in time");
    this.name = "EngineAuthSinkTimeoutError";
  }
}

export type EngineCapabilityIdentity = Readonly<{
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
}>;

export type PersistedCapabilityAuth = {
  version: 1;
  workspaceId: string;
  cursor?: string;
  known: Array<[string, number]>;
  revoked: Array<["sid" | "did", string, number]>;
};

export interface EngineCapabilityAuthStore {
  read(): Promise<PersistedCapabilityAuth | null>;
  write(state: PersistedCapabilityAuth): Promise<void>;
}

/** Atomic, fsynced JSON file in the engine runtime directory. */
export function fileCapabilityAuthStore(file: string): EngineCapabilityAuthStore {
  return {
    async read() {
      try {
        const value = JSON.parse(await readFile(file, "utf8")) as PersistedCapabilityAuth;
        return value?.version === 1 && Array.isArray(value.known) && Array.isArray(value.revoked) ? value : null;
      } catch {
        return null;
      }
    },
    async write(state) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      const handle = await open(temporary, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(state), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      const directory = await open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    },
  };
}

export type EngineCapabilityAuthOptions = {
  identity: EngineCapabilityIdentity;
  issuer: string;
  store: EngineCapabilityAuthStore;
  now?: () => number;
  boundMs?: number;
  /** Fetches the public JWKS (`Cache-Control: no-cache`), within the probe
   * timeout; used for the step-3 refresh and the outage probe. */
  fetchKeys?: (signal: AbortSignal) => Promise<readonly unknown[]>;
  /** Client sessions a raise, revocation or deadline closed. */
  onSessionsClosed?: (closures: readonly CapabilitySessionClosure[]) => void;
};

export type EngineClientAuth = Readonly<{ capability: string; proof: CapabilityProof }>;

export class EngineCapabilityAuth implements EngineUplinkAuthSink {
  readonly verifier: CapabilityVerifier;
  private cursor: string | undefined;
  private synced = false;
  private capability: EngineUplinkCapability | null = null;
  private writes: Promise<void> = Promise.resolve();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly boundMs: number;

  constructor(private readonly options: EngineCapabilityAuthOptions) {
    this.now = options.now ?? Date.now;
    this.boundMs = options.boundMs ?? ENGINE_AUTH_SINK_BOUND_MS;
    this.verifier = new CapabilityVerifier({
      issuer: options.issuer,
      now: this.now,
      ...(options.fetchKeys ? { fetchKeys: () => this.fetchKeysBounded() } : {}),
      ...(options.onSessionsClosed ? { onSessionsClosed: options.onSessionsClosed } : {}),
    });
  }

  /** Loads the last durable state (maximum merge). Admission still waits for
   * this connection's first `auth.sync` (S2). */
  async restore(): Promise<void> {
    const state = await this.options.store.read();
    if (!state || state.workspaceId !== this.options.identity.workspaceId) return;
    this.verifier.mergeKnown(state.known.filter(([subject, epoch]) => typeof subject === "string" && Number.isSafeInteger(epoch)));
    for (const [kind, id, until] of state.revoked)
      if ((kind === "sid" || kind === "did") && typeof id === "string" && until > this.now()) this.verifier.revoke(kind, id, until);
    if (typeof state.cursor === "string") this.cursor = state.cursor;
  }

  authCursor(): string | undefined { return this.cursor; }
  ready(): boolean { return this.synced; }
  engineCapability(): EngineUplinkCapability | null { return this.capability; }

  applyKeys(keys: readonly EngineUplinkJwk[]): Promise<void> {
    return this.bounded(async () => { this.verifier.applyKeys(keys); });
  }

  applySync(sync: EngineUplinkAuthSync): Promise<void> {
    this.merge(sync.epochs, sync.revocations);
    return this.bounded(async () => {
      await this.persist(sync.authCursor);
      this.cursor = sync.authCursor;
      this.synced = true;
      // S1 recovery: the sync is applied before anything else; then every
      // open session is re-checked and grace-extended ones get 60 s to renew.
      this.verifier.outage.uplinkRestored(this.now());
      this.verifier.recheck();
    });
  }

  applyDelta(delta: EngineUplinkAuthDelta): Promise<void> {
    this.merge(delta.epochs, delta.revocations);
    return this.bounded(async () => {
      await this.persist(delta.authCursor);
      this.cursor = delta.authCursor;
    });
  }

  holdCapability(capability: EngineUplinkCapability): void { this.capability = capability; }

  /** Uplink established flips drive the outage rule and its JWKS probe. */
  uplinkEstablished(established: boolean): void {
    if (established) { this.stopProbe(); return; }
    this.verifier.outage.uplinkDown(this.now());
    if (this.probeTimer || !this.options.fetchKeys) return;
    this.probeTimer = setInterval(() => { void this.probeOnce(); }, ENGINE_JWKS_PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
  }

  /** One S1 outage probe; a fetched set also replaces the key set, so a
   * push-down engine still learns an emergency key revocation. */
  async probeOnce(): Promise<void> {
    try {
      const keys = await this.fetchKeysBounded();
      this.verifier.applyKeys(keys);
      this.verifier.outage.probe(true, this.now());
    } catch {
      this.verifier.outage.probe(false, this.now());
      this.verifier.recheck();
    }
  }

  /** Verifies a client capability on the direct route or the relay route
   * (`relay.open`) against this engine's own placement (S1 steps 1-12). */
  async verifyClient(auth: EngineClientAuth, route: CapabilityRoute): Promise<CapabilityVerifyResult> {
    if (!this.synced) return { ok: false, code: "capability_issuer_unavailable", step: 0 };
    return this.verifier.verify(auth.capability, { aud: "zeros:engine", knd: "client" }, this.context(route, auth.proof));
  }

  /** Admits a verified client as an open session the verifier re-checks. */
  admit(sessionId: string, verified: CapabilityVerifySuccess, route: CapabilityRoute): void {
    this.verifier.openSession(sessionId, verified, this.context(route));
    this.ensureRecheckTimer();
  }

  /** In-band `auth.renew` (S3 Part 3): steps 1-12, then the session's token
   * is swapped without reconnecting. Returns the new expiry. */
  async renewClient(sessionId: string, auth: EngineClientAuth, route: CapabilityRoute): Promise<CapabilityVerifyResult> {
    const result = await this.verifyClient(auth, route);
    if (!result.ok) return result;
    if (!this.verifier.renewSession(sessionId, result)) return { ok: false, code: "capability_revoked", step: 11 };
    return result;
  }

  closeClient(sessionId: string): void {
    this.verifier.closeSession(sessionId);
    if (!this.verifier.openSessionIds().length && this.recheckTimer) { clearInterval(this.recheckTimer); this.recheckTimer = null; }
  }

  stop(): void {
    this.stopProbe();
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
  }

  private context(route: CapabilityRoute, proof?: CapabilityProof): CapabilityVerifyContext {
    const { workspaceId, organizationId, generation, engineInstanceId } = this.options.identity;
    return { workspaceId, organizationId, generation, engineInstanceId, route, ...(proof ? { proof } : {}) };
  }

  private merge(epochs: EngineUplinkAuthSync["epochs"] | EngineUplinkAuthDelta["epochs"], revocations: readonly EngineUplinkRevocation[]): void {
    this.verifier.mergeKnown(capabilityEpochEntries(this.options.identity, epochs));
    for (const revocation of revocations)
      this.verifier.revoke(revocation.kind === "session" ? "sid" : "did", revocation.id, revocation.until);
  }

  private persist(cursor: string): Promise<void> {
    const state = this.snapshot(cursor);
    // One write at a time, in order, so a slow older write can never land
    // after a newer one.
    const write = this.writes.then(() => this.options.store.write(state));
    this.writes = write.catch(() => undefined);
    return write;
  }

  private snapshot(cursor: string): PersistedCapabilityAuth {
    return { version: 1, workspaceId: this.options.identity.workspaceId, cursor, ...this.verifier.exportState() };
  }

  private bounded(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new EngineAuthSinkTimeoutError()), this.boundMs);
      timer.unref?.();
      task().then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  private async fetchKeysBounded(): Promise<readonly unknown[]> {
    const fetchKeys = this.options.fetchKeys;
    if (!fetchKeys) throw new Error("no key source");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENGINE_JWKS_PROBE_TIMEOUT_MS);
    timer.unref?.();
    try { return await fetchKeys(controller.signal); } finally { clearTimeout(timer); }
  }

  private ensureRecheckTimer(): void {
    if (this.recheckTimer) return;
    this.recheckTimer = setInterval(() => this.verifier.recheck(), 1_000);
    this.recheckTimer.unref?.();
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }
}

/** Fetches the public S1 JWKS from the control plane origin. */
export function jwksFetcher(origin: string, fetchImpl: typeof fetch = fetch): (signal: AbortSignal) => Promise<readonly unknown[]> {
  const url = new URL("/.well-known/zeros-capabilities/jwks.json", origin).href;
  return async signal => {
    const response = await fetchImpl(url, { headers: { "cache-control": "no-cache" }, signal, redirect: "error" });
    if (!response.ok) throw new Error(`jwks ${response.status}`);
    const body = await response.json() as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error("jwks shape");
    return body.keys;
  };
}
