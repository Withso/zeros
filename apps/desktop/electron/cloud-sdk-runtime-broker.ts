import { randomBytes, randomUUID } from "node:crypto";
import { CloudRestClient, CloudRestError, probeFromConnectFailure, readRuntimeBinding,
  type CapabilityProofFields, type DeviceProofHeaders, type DeviceProofRequest, type DeviceSessionGrant } from "@zeros/cloud-client";
import type { Capabilities, DeviceSessionResponse, RestOperationId } from "@zeros/cloud-client/generated/rest";
import { CapabilityClaimsSchema, CapabilityHeaderSchema, CAPABILITY_POP_TIMESTAMP_LEEWAY_MS } from "@zeros/protocol/cloud-capabilities";
import { CloudAcceptedWorkClientProofSchema, cloudAcceptedWorkCommandBinding,
  type CloudAcceptedWorkProofBinding } from "@zeros/protocol/cloud-accepted-work-client";
import { isCloudDirectProviderUrl } from "@zeros/protocol/cloud-runtime-connection";
import { CloudSdkCapabilitiesSchema, CloudSdkConnectResponseSchema, CloudSdkDeviceSessionSchema, CloudSdkProofRequestSchema,
  CloudSdkRuntimeIdentitySchema, CloudSdkRuntimeTargetSchema, CloudSdkTargetSchema,
  type CloudSdkRuntimeIdentity, type CloudSdkRuntimeTarget, type CloudSdkTarget } from "../shared/cloud-sdk-contract";
import { CloudWorkspaceAccessClientError } from "./cloud-workspace-access-client";
import { CLOUD_SDK_COMMAND_MAX_BYTES, CloudSdkCommandEnvelopeRequestSchema, CloudSdkConnectionControlSchema,
  CloudSdkUnsignedCommandSchema } from "../shared/cloud-sdk-command-contract";

type Device = { deviceId: string; keyVersion: number };
type Decision = { legacy: boolean; stop: AbortController };
type StoredCapability = { aud: string; wsp: string; jti: string; exp: number; sub: string; role?: string; scp: string[] };
type Handshake = { nonce: string; route: "direct" | "relay"; timestampMs: number; capabilities: Capabilities };
type ActiveConnection = { attemptId: string; handshakeNonce: string; route: "direct" | "relay"; unbindRenderer?: () => void };
type Entry = { target: CloudSdkRuntimeTarget; device: Device; capabilities: Capabilities; proofs: StoredCapability[]; stop: AbortController;
  handshakes?: Map<"direct" | "relay", Handshake>; activated?: boolean; connection?: ActiveConnection;
  command?: { requestId: string; cancelled: boolean };
  previous?: StoredCapability[]; renew?: Promise<Capabilities>; refresh?: { source: CloudSdkRuntimeIdentity; promise: Promise<CloudSdkRuntimeTarget> };
  receipt?: { source: CloudSdkRuntimeIdentity; target: CloudSdkRuntimeTarget } };
type Session = { id: string; device: Device; streamOrigin: string; issuedAt: number;
  ticket?: { url: string; value: string; expiresAt: number } };

export interface CloudSdkRuntimeBrokerOptions {
  baseUrl: string;
  appVersion: string;
  platform: "macos" | "windows" | "linux";
  enabled(): boolean;
  getAccountSessionKey(): string | null;
  getAccessToken(): Promise<string | null>;
  ensureDevice(): Promise<unknown>;
  readDevice(): Device | null;
  signRequest(token: string, request: DeviceProofRequest): Promise<DeviceProofHeaders>;
  signProof(token: string, device: Device, fields: CapabilityProofFields): Promise<string>;
  signAcceptedWorkProof?(token: string, device: Device, fields: CloudAcceptedWorkProofBinding): Promise<string>;
  fetch: typeof fetch;
  onRetired(runtimeIds: string[]): void;
  now?: () => number;
  newRuntimeId?: () => string;
  newClientSessionId?: () => string;
  allowInsecureLoopback?: boolean;
}

const MAX_ENTRIES = 64;
const REQUEST_TIMEOUT_MS = 15_000;
const error = (code = "cloud_workspace_access_superseded", status = 409) => new CloudWorkspaceAccessClientError(status, code,
  code === "bad_response" ? "The cloud control plane returned invalid runtime access" : "The cloud runtime authority has ended");
const keyOf = (target: CloudSdkTarget) => `${target.organizationId}/${target.workspaceId}`;
const identityOf = (target: CloudSdkRuntimeIdentity): CloudSdkRuntimeIdentity => {
  const { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence } = target;
  return { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence };
};
const sameDevice = (a: Device, b: Device | null) => a.deviceId === b?.deviceId && a.keyVersion === b.keyVersion;
const sameIdentity = (a: CloudSdkRuntimeIdentity, b: CloudSdkRuntimeIdentity) =>
  Object.keys(CloudSdkRuntimeIdentitySchema.shape).every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);

/** Syntax and credential placement only. The configured CP is the authority
 * for its realtime origin; direct endpoints retain the existing provider check. */
function socketUrl(raw: string, path: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw error("bad_response", 201); }
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || url.pathname !== path || url.toString() !== raw)
    throw error("bad_response", 201);
  return url;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const field of Object.values(value)) freeze(field); Object.freeze(value); }
  return value;
}

/** Native authority for one source-account incarnation. Only tokens returned
 * by its own authenticated CP calls may be used by the narrow signing IPC.
 * Claims are consistency checks, not a replacement for the engine's S1 verifier. */
export class CloudSdkRuntimeBroker {
  private readonly account: string | null;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly decisions = new Map<string, Decision>();
  private readonly opens = new Map<string, { decision: Decision; promise: Promise<CloudSdkRuntimeTarget | null> }>();
  private readonly requests = new Set<AbortController>();
  private session: Session | null = null;
  private sessionFlight: Promise<Session> | null = null;
  private streamSessionFlight: Promise<DeviceSessionGrant> | null = null;
  private streamSessionId: string | null = null;
  private readonly runtimeListeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly options: CloudSdkRuntimeBrokerOptions) {
    this.account = options.getAccountSessionKey(); this.now = options.now ?? Date.now;
    const base = new URL(options.baseUrl);
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
        (base.protocol !== "https:" && !(options.allowInsecureLoopback && base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))))
      throw error("invalid_input", 422);
  }

  get size(): number { return this.entries.size; }
  owns(runtimeId: string): boolean { return this.entries.has(runtimeId); }
  runtimeTargets(): readonly CloudSdkRuntimeTarget[] { return [...this.entries.values()].map(entry => entry.target); }
  subscribeRuntimeTargets(listener: () => void): () => void {
    this.runtimeListeners.add(listener); return () => { this.runtimeListeners.delete(listener); };
  }
  private runtimeChanged(): void {
    for (const listener of this.runtimeListeners) { try { listener(); } catch { /* consumers cannot extend authority */ } }
  }
  assertActive(): void {
    this.assertCurrent();
    if (this.session && !sameDevice(this.session.device, this.options.readDevice())) { this.dispose(); throw error(); }
  }

  /** Main's one stream consumes each ticket once. A null held ID after an
   * earlier hello means the SDK discarded a disabled/superseded session. */
  openStreamSession(heldId: string | null): Promise<DeviceSessionGrant> {
    this.assertActive();
    if (this.streamSessionFlight) return this.streamSessionFlight;
    const previous = this.streamSessionId;
    if (heldId === null && previous !== null && this.session?.id === previous) this.session = null;
    const flight = (async () => {
      let session = await this.ensureSession(); this.assertActive();
      if (!session.ticket || session.ticket.expiresAt <= this.now() + 1_000) session = await this.ensureSession(true);
      this.assertActive();
      const ticket = session.ticket;
      if (this.session !== session || !ticket || ticket.expiresAt <= this.now()) throw error();
      session.ticket = undefined;
      this.streamSessionId = session.id;
      return { deviceSessionId: session.id, url: ticket.url, ticket: ticket.value };
    })();
    this.streamSessionFlight = flight;
    void flight.finally(() => { if (this.streamSessionFlight === flight) this.streamSessionFlight = null; }).catch(() => {});
    return flight;
  }

  private assertCurrent(initial = false): void {
    if (this.disposed || !this.options.enabled() || !this.account || this.options.getAccountSessionKey() !== this.account) {
      this.dispose(); throw error(initial ? "signed_out" : undefined, initial ? 401 : 409);
    }
  }
  private current(input: CloudSdkRuntimeIdentity): Entry {
    this.assertCurrent();
    const parsed = CloudSdkRuntimeIdentitySchema.safeParse(identityOf(input)), entry = this.entries.get(input.runtimeId);
    if (!parsed.success || !entry || !sameIdentity(entry.target, parsed.data) || !sameDevice(entry.device, this.options.readDevice())) throw error();
    return entry;
  }
  private assertEntry(entry: Entry): void { if (this.current(entry.target) !== entry) throw error(); }
  assertRuntime(input: CloudSdkRuntimeIdentity): void { this.current(input); }

  private decision(target: CloudSdkTarget): Decision {
    const key = keyOf(target), existing = this.decisions.get(key);
    if (existing) return existing;
    if (this.decisions.size >= MAX_ENTRIES) {
      const oldest = this.decisions.keys().next().value!; this.decisions.get(oldest)!.stop.abort(); this.decisions.delete(oldest);
    }
    const entry = { legacy: false, stop: new AbortController() }; this.decisions.set(key, entry); return entry;
  }
  /** A catalog hint fences pending admissions; it does not retire healthy peers. */
  invalidate(target?: CloudSdkTarget): void {
    for (const [key, decision] of this.decisions) if (!target || key === keyOf(target)) { decision.stop.abort(); this.decisions.delete(key); }
  }
  markLegacy(input: CloudSdkRuntimeIdentity): void {
    const entry = this.current(input); this.decision(entry.target).legacy = true; this.close(input.runtimeId);
  }

  async open(raw: CloudSdkTarget): Promise<CloudSdkRuntimeTarget | null> {
    this.assertCurrent(true);
    const target = CloudSdkTargetSchema.parse(raw), key = keyOf(target), decision = this.decision(target), pending = this.opens.get(key);
    if (pending?.decision === decision) return pending.promise;
    if (this.entries.size + this.opens.size >= MAX_ENTRIES) throw error("cloud_access_local_limit", 429);
    if (decision.legacy) return null;
    const promise = this.admit(target, decision);
    this.opens.set(key, { decision, promise });
    try { return await promise; } finally { if (this.opens.get(key)?.promise === promise) this.opens.delete(key); }
  }

  private async admit(target: CloudSdkTarget, decision: Decision, previous?: Entry): Promise<CloudSdkRuntimeTarget | null> {
    const assert = () => {
      this.assertCurrent();
      if (this.decisions.get(keyOf(target)) !== decision) throw error();
      if (previous) this.assertEntry(previous);
    };
    try {
      let session = await this.ensureSession(); assert();
      const clientSessionId = previous?.target.clientSessionId ?? (this.options.newClientSessionId ?? randomUUID)();
      const signal = previous ? AbortSignal.any([decision.stop.signal, previous.stop.signal]) : decision.stop.signal;
      const connectRequest = () => this.request("connectCloudWorkspaceRuntime", {
        pathParams: { organization: target.organizationId, workspace: target.workspaceId },
        body: { deviceSessionId: session.id, clientSessionId, routes: ["direct", "relay"] },
      }, session.device, signal);
      let response: unknown;
      try { response = await connectRequest(); }
      catch (cause) {
        assert();
        if (!(cause instanceof CloudRestError) || cause.status !== 409 || cause.code !== "device_session_expired") throw cause;
        if (this.session === session) this.session = null;
        session = await this.ensureSession(); assert();
        response = await connectRequest(); // One fresh session, never an unbounded repair loop.
      }
      assert();
      if (this.session?.id !== session.id) throw error();
      const parsed = CloudSdkConnectResponseSchema.safeParse(response);
      if (!parsed.success) throw error("bad_response", 201);
      const connect = parsed.data;
      let binding: ReturnType<typeof readRuntimeBinding>;
      try { binding = readRuntimeBinding(connect, target); } catch { throw error("bad_response", 201); }
      if (!binding) { decision.legacy = true; return null; }
      for (const route of connect.routes) {
        if (route.kind === "direct" ? !isCloudDirectProviderUrl(route.url)
          : socketUrl(route.url, "/v1/relay").origin !== session.streamOrigin) throw error("bad_response", 201);
      }
      if (previous && (previous.target.authorityEpoch !== binding.authorityEpoch ||
          Object.entries(previous.target.bootScope).some(([key, value]) => binding!.bootScope[key as keyof typeof binding.bootScope] !== value))) throw error();
      const proofs = this.validateCapabilities(connect.capabilities, { ...target, ...binding.bootScope, authorityEpoch: binding.authorityEpoch }, session.device);
      assert();
      const runtime = freeze(CloudSdkRuntimeTargetSchema.parse({ kind: "cloud", channel: "sdk-websocket", ...target,
        runtimeId: previous?.target.runtimeId ?? (this.options.newRuntimeId ?? randomUUID)(),
        connectionSequence: previous ? previous.target.connectionSequence + 1 : 1,
        generation: connect.generation, engineInstanceId: connect.engineInstanceId, authorityEpoch: binding.authorityEpoch, bootScope: binding.bootScope,
        deviceSessionId: session.id, clientSessionId, connect,
        expiresAt: Math.min(...proofs.map(proof => proof.exp * 1000)),
      }));
      if (!previous && this.entries.has(runtime.runtimeId)) throw error();
      this.entries.set(runtime.runtimeId, { target: runtime, device: session.device, capabilities: runtime.connect.capabilities, proofs, stop: new AbortController() });
      if (previous) { this.retireConnection(previous); previous.stop.abort(); }
      this.runtimeChanged();
      return runtime;
    } catch (cause) {
      assert();
      if (probeFromConnectFailure(cause) === "legacy") { decision.legacy = true; return null; }
      throw cause;
    }
  }

  async refresh(input: CloudSdkRuntimeIdentity): Promise<CloudSdkRuntimeTarget> {
    this.assertCurrent();
    const existing = this.entries.get(input.runtimeId), receipt = existing?.receipt;
    if (receipt && sameIdentity(receipt.source, input)) {
      this.assertEntry(existing!);
      if (receipt.target !== existing!.target || receipt.target.expiresAt - this.now() < 5_000) throw error();
      return receipt.target;
    }
    const entry = this.current(input);
    if (entry.refresh) return entry.refresh.promise;
    const source = CloudSdkRuntimeIdentitySchema.parse(identityOf(input));
    const promise = this.admit(entry.target, this.decision(entry.target), entry).then(target => {
      if (!target) throw error("cloud_workspace_sdk_legacy_required");
      const current = this.current(target); current.receipt = { source, target }; return target;
    });
    entry.refresh = { source, promise };
    try { return await promise; } finally { if (entry.refresh?.promise === promise) entry.refresh = undefined; }
  }

  async signCapabilityProof(raw: unknown): Promise<string> {
    const parsed = CloudSdkProofRequestSchema.safeParse(raw);
    if (!parsed.success) throw error("invalid_input", 422);
    const { runtime, fields } = parsed.data, entry = this.current(runtime);
    const assert = () => {
      this.assertEntry(entry);
      if (Math.abs(fields.timestampMs - this.now()) > CAPABILITY_POP_TIMESTAMP_LEEWAY_MS ||
          !entry.target.connect.routes.some(route => route.kind === fields.route) ||
          ![...entry.proofs, ...(entry.previous ?? [])].some(proof => proof.aud === fields.aud && proof.wsp === fields.wsp &&
            proof.jti === fields.jti && proof.exp * 1000 > this.now())) throw error("invalid_input", 422);
    };
    assert(); const token = await this.accessToken(); assert();
    const signature = await this.options.signProof(token, entry.device, fields); assert();
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) throw error("bad_response", 201);
    // At most one candidate per offered route. Activation names this native
    // receipt; the command IPC never accepts a route or signing fields.
    if (entry.target.connect.runtimeBinding.acceptedWorkVersion === 1 && !entry.activated &&
        fields.aud === "zeros:engine" && fields.jti === entry.proofs[0]!.jti) {
      (entry.handshakes ??= new Map()).set(fields.route, { nonce: fields.nonce, route: fields.route,
        timestampMs: fields.timestampMs, capabilities: entry.capabilities });
    }
    return signature;
  }

  controlConnection(raw: unknown, lifetime?: (onGone: () => void) => () => void): { attemptId: string } | boolean {
    const parsed = CloudSdkConnectionControlSchema.safeParse(raw);
    if (!parsed.success) throw error("invalid_input", 422);
    const input = parsed.data, entry = this.current(input.runtime);
    if (input.action === "activate") {
      if (entry.target.connect.runtimeBinding.acceptedWorkVersion !== 1 || !this.options.signAcceptedWorkProof) throw error("invalid_input", 422);
      if (entry.connection?.handshakeNonce === input.handshakeNonce) return { attemptId: entry.connection.attemptId };
      const receipt = [...(entry.handshakes?.values() ?? [])].find(item => item.nonce === input.handshakeNonce);
      if (entry.activated || !receipt || receipt.capabilities !== entry.capabilities ||
          Math.abs(receipt.timestampMs - this.now()) > CAPABILITY_POP_TIMESTAMP_LEEWAY_MS || entry.proofs[0]!.exp * 1000 <= this.now()) throw error();
      entry.activated = true; entry.handshakes = undefined;
      entry.connection = { attemptId: randomUUID(), handshakeNonce: receipt.nonce, route: receipt.route };
      const connection = entry.connection;
      connection.unbindRenderer = lifetime?.(() => { if (entry.connection === connection) this.retireConnection(entry); });
      return { attemptId: entry.connection.attemptId };
    }
    if (entry.connection?.attemptId !== input.attemptId) return false;
    if (input.action === "retire") {
      this.retireConnection(entry);
      return true;
    }
    if (entry.command?.requestId !== input.requestId) return false;
    entry.command.cancelled = true;
    return true;
  }

  private retireConnection(entry: Entry): void {
    const connection = entry.connection; entry.connection = undefined;
    connection?.unbindRenderer?.();
    if (entry.command) entry.command.cancelled = true;
  }

  /** One signing flight per admitted runtime, with no native queue. The
   * renderer serializes a bounded command queue and forwards this entire frame
   * once. The frame is transient wire data, never a durable command record. */
  async prepareCommandEnvelope(raw: unknown): Promise<string> {
    const parsed = CloudSdkCommandEnvelopeRequestSchema.safeParse(raw);
    if (!parsed.success || Buffer.byteLength(parsed.data.command, "utf8") > CLOUD_SDK_COMMAND_MAX_BYTES) throw error("invalid_input", 422);
    const input = parsed.data, entry = this.current(input.runtime), connection = entry.connection;
    if (entry.target.connect.runtimeBinding.acceptedWorkVersion !== 1 || !connection ||
        connection.attemptId !== input.attemptId || !this.options.signAcceptedWorkProof) throw error();
    let command: ReturnType<typeof CloudSdkUnsignedCommandSchema.parse>;
    let binding: ReturnType<typeof cloudAcceptedWorkCommandBinding>;
    try {
      command = CloudSdkUnsignedCommandSchema.parse(JSON.parse(input.command));
      binding = cloudAcceptedWorkCommandBinding(command.params.request.mutation);
    } catch { throw error("invalid_input", 422); }
    if (command.params.bootId !== entry.target.bootScope.bootId || command.params.writerEpoch !== entry.target.bootScope.writerEpoch) throw error();
    if (entry.command) throw error("rate_limited", 429);
    const capabilities = entry.capabilities, capability = entry.proofs[0]!;
    const flight = { requestId: command.id, cancelled: false }; entry.command = flight;
    let timestampMs: number | undefined;
    const assert = () => {
      this.assertEntry(entry);
      if (entry.command !== flight || flight.cancelled || entry.connection !== connection || entry.capabilities !== capabilities ||
          entry.target.connect.runtimeBinding.acceptedWorkVersion !== 1 || capability.exp * 1000 <= this.now() ||
          timestampMs !== undefined && Math.abs(timestampMs - this.now()) > CAPABILITY_POP_TIMESTAMP_LEEWAY_MS) throw error();
      if (capability.aud !== "zeros:engine" || capability.sub !== `user:${entry.target.bootScope.fundingOwnerUserId}` ||
          capability.role !== "owner" || !capability.scp.includes("ws:prompt")) throw error("forbidden", 403);
    };
    try {
      assert(); const token = await this.accessToken(); assert();
      timestampMs = this.now();
      const fields = { aud: "zeros:engine" as const, wsp: capability.wsp, jti: capability.jti,
        timestampMs, nonce: randomBytes(16).toString("base64url"), route: connection.route };
      const signature = await this.options.signProof(token, entry.device, fields); assert();
      if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) throw error("bad_response", 201);
      const commandSignature = await this.options.signAcceptedWorkProof(token, entry.device,
        { ...fields, scope: entry.target.bootScope, ...binding }); assert();
      const proof = CloudAcceptedWorkClientProofSchema.safeParse({ version: 1, capability: capabilities.engine.token,
        proof: { timestampMs, nonce: fields.nonce, signature }, commandSignature });
      if (!proof.success) throw error("bad_response", 201);
      return JSON.stringify({ ...command, params: { ...command.params, acceptedWorkProof: proof.data } });
    } finally { if (entry.command === flight) entry.command = undefined; }
  }

  async renewCapabilities(input: CloudSdkRuntimeIdentity): Promise<Capabilities> {
    const entry = this.current(input);
    if (entry.renew) return entry.renew;
    const promise = (async () => {
      const response = await this.request("renewCloudWorkspaceCapabilities", {
        pathParams: { organization: entry.target.organizationId, workspace: entry.target.workspaceId },
        body: { deviceSessionId: entry.target.deviceSessionId, clientSessionId: entry.target.clientSessionId },
      }, entry.device, entry.stop.signal);
      this.assertEntry(entry);
      const raw = response && typeof response === "object" ? (response as { capabilities?: unknown }).capabilities : undefined;
      return this.acceptCapabilities(entry, raw);
    })();
    entry.renew = promise;
    try { return await promise; } finally { if (entry.renew === promise) entry.renew = undefined; }
  }

  /** Main's authenticated device-stream owner is the only pushed-token caller.
   * There is intentionally no renderer IPC that registers arbitrary tokens. */
  acceptPushedCapabilities(input: CloudSdkRuntimeIdentity, clientSessionId: string, capabilities: unknown): Capabilities {
    const entry = this.current(input);
    if (entry.target.clientSessionId !== clientSessionId) throw error();
    return this.acceptCapabilities(entry, capabilities);
  }
  private acceptCapabilities(entry: Entry, raw: unknown): Capabilities {
    const parsed = CloudSdkCapabilitiesSchema.safeParse(raw);
    if (!parsed.success) throw error("bad_response", 201);
    const capabilities = parsed.data, proofs = this.validateCapabilities(capabilities, entry.target, entry.device);
    if (proofs[0]!.exp < entry.proofs[0]!.exp) return entry.capabilities;
    entry.previous = entry.proofs; entry.proofs = proofs; entry.capabilities = freeze(capabilities);
    return entry.capabilities;
  }

  private validateCapabilities(capabilities: Capabilities, target: CloudSdkTarget & { generation: number; engineInstanceId: string; authorityEpoch: number }, device: Device): StoredCapability[] {
    return (["engine", "realtime"] as const).map(kind => {
      const grant = capabilities[kind];
      try {
        if (grant.token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(grant.token)) throw error();
        const [header, payload] = grant.token.split(".");
        CapabilityHeaderSchema.parse(JSON.parse(Buffer.from(header!, "base64url").toString("utf8")));
        const claims = CapabilityClaimsSchema.parse(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")));
        if (claims.knd !== "client" || claims.aud !== `zeros:${kind}` || claims.org !== target.organizationId || claims.wsp !== target.workspaceId ||
            claims.gen !== target.generation || claims.ein !== target.engineInstanceId || claims.ep.wa !== target.authorityEpoch ||
            claims.did !== device.deviceId || claims.ep.dk !== device.keyVersion || Date.parse(grant.expiresAt) !== claims.exp * 1000 ||
            claims.exp * 1000 - this.now() < 5_000 || claims.iat * 1000 > this.now() + 30_000) throw error();
        return { aud: claims.aud, wsp: claims.wsp, jti: claims.jti, exp: claims.exp, sub: claims.sub, role: claims.role, scp: claims.scp };
      } catch { throw error("bad_response", 201); }
    });
  }

  private async ensureSession(freshTicket = false): Promise<Session> {
    this.assertCurrent();
    if (!freshTicket && this.session && sameDevice(this.session.device, this.options.readDevice()) && this.now() - this.session.issuedAt < 23 * 60 * 60_000) return this.session;
    if (this.sessionFlight) return this.sessionFlight;
    const promise = (async () => {
      await this.options.ensureDevice(); this.assertCurrent();
      const device = this.options.readDevice(); if (!device) throw error("device_proof_required", 403);
      const response = await this.request("createDeviceSession", {
        body: { deviceId: device.deviceId, ...(this.session && sameDevice(this.session.device, device) ? { deviceSessionId: this.session.id } : {}),
          client: { platform: this.options.platform, appVersion: this.options.appVersion, contract: { min: 1, max: 1 } } },
      }, device);
      const parsed = CloudSdkDeviceSessionSchema.safeParse(response);
      if (!parsed.success) throw error("bad_response", 201);
      const grant: DeviceSessionResponse = parsed.data, url = socketUrl(grant.stream.url, "/v1/device-stream");
      if (Date.parse(grant.stream.ticketExpiresAt) <= this.now() || Date.parse(grant.stream.ticketExpiresAt) - this.now() > 90_000) throw error("bad_response", 201);
      this.assertCurrent();
      const session: Session = { id: grant.deviceSessionId, device: { ...device }, streamOrigin: url.origin, issuedAt: this.now(),
        ticket: { url: grant.stream.url, value: grant.stream.ticket, expiresAt: Date.parse(grant.stream.ticketExpiresAt) } };
      this.session = session;
      for (const entry of [...this.entries.values()]) if (entry.target.deviceSessionId !== session.id) this.close(entry.target.runtimeId);
      return session;
    })();
    this.sessionFlight = promise;
    try { return await promise; } finally { if (this.sessionFlight === promise) this.sessionFlight = null; }
  }

  private async accessToken(): Promise<string> {
    this.assertCurrent(); const token = await this.options.getAccessToken(); this.assertCurrent();
    if (!token) throw error("signed_out", 401); return token;
  }
  private async request(operation: RestOperationId, input: { pathParams?: Record<string, string>; body: unknown }, device: Device, lifetime?: AbortSignal): Promise<unknown> {
    const token = await this.accessToken(), controller = new AbortController(); this.requests.add(controller);
    const assert = () => { this.assertCurrent(); if (!sameDevice(device, this.options.readDevice())) throw error(); };
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      assert();
      const rest = new CloudRestClient({ baseUrl: this.options.baseUrl, getAccessToken: () => token,
        getDeviceProof: async request => { assert(); const proof = await this.options.signRequest(token, request); assert();
          if (proof.deviceId !== device.deviceId || Number(proof.keyVersion) !== device.keyVersion) throw error(); return proof; },
        fetchImpl: async (url, options) => { assert(); return this.options.fetch(url, { ...options, redirect: "error" }); },
      });
      const result = await rest.invoke(operation, { ...input, deviceProof: true,
        signal: lifetime ? AbortSignal.any([controller.signal, lifetime]) : controller.signal });
      assert(); return result.body;
    } catch (cause) {
      assert();
      if (cause instanceof CloudRestError) throw cause;
      throw cause instanceof CloudWorkspaceAccessClientError ? cause : error("request_failed", 503);
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }

  close(runtimeId: string): boolean {
    const entry = this.entries.get(runtimeId);
    if (!entry) return false;
    this.entries.delete(runtimeId); this.retireConnection(entry); entry.stop.abort();
    try { this.options.onRetired([runtimeId]); } catch { /* retirement is already authoritative */ }
    this.runtimeChanged();
    return true;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const entry of this.entries.values()) { this.retireConnection(entry); entry.stop.abort(); }
    for (const decision of this.decisions.values()) decision.stop.abort();
    for (const controller of this.requests) controller.abort(); this.requests.clear();
    const ids = [...this.entries.keys()]; this.entries.clear(); this.opens.clear(); this.decisions.clear(); this.session = null; this.sessionFlight = null;
    this.streamSessionFlight = null; this.streamSessionId = null;
    if (ids.length) { try { this.options.onRetired(ids); } catch { /* all local authority is already gone */ } }
    this.runtimeChanged(); this.runtimeListeners.clear();
  }
}
