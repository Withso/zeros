import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";

import type Database from "better-sqlite3";

import {
  cloudDesktopDeviceLabel,
  cloudDesktopPlatform,
  cloudDeviceEnrollmentIdempotencyKey,
  cloudDevicePublicKeyFingerprint,
} from "./cloud-device-enrollment";
import {
  CloudReplicaApplyError,
  inspectCloudReplicaEntry,
  normalizeCloudReplicaPath,
} from "./cloud-replica-apply";
import {
  CloudReplicaClientError,
  HttpCloudReplicaApi,
  HttpCloudReplicaEnrollmentClient,
  type CloudWorkspaceDesktopApi,
  type CloudReplicaProofSigner,
  type CloudReplicaRemoteState,
} from "./cloud-replica-client";
import { CloudReplicaSyncBroker } from "./cloud-replica-broker";
import {
  cloudReplicaHostControlLine,
  type CloudReplicaDeviceRegistered,
  type CloudReplicaHostSession,
  type CloudReplicaProofRequest,
  type CloudReplicaProofResponse,
} from "./cloud-replica-host-control";
import {
  DEFAULT_CLOUD_REPLICA_IGNORE_POLICY,
  DatabaseCloudReplicaState,
  cloudReplicaIgnorePolicySha256,
  parseCloudReplicaIgnorePolicy,
  type CloudReplicaIgnorePolicy,
  type CloudReplicaLocalState,
} from "./cloud-replica-state";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const PROOF_TIMEOUT_MS = 10_000;
const SYNC_INTERVAL_MS = 15_000;
const MAX_REPLICAS_PER_TICK = 4;
const MAX_PENDING_PROOFS = 32;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Select a deterministic round-robin batch. Replica state is ordered for
 * database efficiency, but a fixed `.slice(0, 4)` would permanently starve
 * every later replica whenever the first four are continuously due. */
export function selectFairCloudReplicaBatch<T extends { replicaId: string }>(
  replicas: readonly T[],
  cursor: string | null,
  maximum: number = MAX_REPLICAS_PER_TICK,
): { replicas: T[]; cursor: string | null } {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Cloud replica scheduler batch size is invalid");
  }
  const ordered = [...replicas].sort((left, right) =>
    left.replicaId.localeCompare(right.replicaId),
  );
  if (ordered.length === 0) return { replicas: [], cursor: null };
  let start = 0;
  if (cursor !== null) {
    const next = ordered.findIndex((replica) => replica.replicaId > cursor);
    start = next === -1 ? 0 : next;
  }
  const selected = Array.from(
    { length: Math.min(maximum, ordered.length) },
    (_, offset) => ordered[(start + offset) % ordered.length]!,
  );
  return { replicas: selected, cursor: selected.at(-1)!.replicaId };
}

export function cloudReplicaDetachmentCode(error: unknown): string | null {
  if (!(error instanceof CloudReplicaClientError)) return null;
  if (error.code === "workspace_replica_not_found") return "workspace_deleted";
  if (
    [
      "cloud_workspace_scope_not_found",
      "cloud_workspace_owner_required",
      "forbidden",
    ].includes(error.code)
  ) {
    return "workspace_access_revoked";
  }
  if (
    [
      "cloud_workspaces_not_allowed",
      "cloud_account_entitlement_required",
      "cloud_organization_entitlement_required",
    ].includes(error.code)
  ) {
    return "cloud_entitlement_inactive";
  }
  if (error.code === "workspace_replica_device_proof_rejected") {
    return "device_authority_revoked";
  }
  return null;
}

type PendingProof = {
  deviceId: string;
  keyVersion: number;
  resolve: (response: CloudReplicaProofResponse["proof"]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class CloudReplicaRuntimeError extends Error {
  constructor(
    public readonly code:
      | "signed_out"
      | "device_enrollment_pending"
      | "identity_mismatch"
      | "invalid_request"
      | "replica_not_found"
      | "replica_not_paused"
      | "divergence_preserve_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudReplicaRuntimeError";
  }
}

export async function validateCloudReplicaDestination(
  value: string,
  options: { allowPopulated: boolean },
): Promise<string> {
  const root = path.resolve(value);
  if (
    root !== value ||
    root === path.parse(root).root ||
    (await realpath(root).catch(() => null)) !== root ||
    !(await lstat(root).catch(() => null))?.isDirectory() ||
    (!options.allowPopulated && (await readdir(root)).length !== 0)
  ) {
    throw new CloudReplicaRuntimeError(
      "invalid_request",
      options.allowPopulated
        ? "Local replica root must be an existing real directory"
        : "A new local replica requires an empty real directory",
    );
  }
  return root;
}

async function requireRealDirectory(
  directory: string,
  root: string,
): Promise<void> {
  const stat = await lstat(directory).catch(() => null);
  const physical = await realpath(directory).catch(() => null);
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    physical !== directory ||
    (directory !== root && !directory.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error("Replica recovery directory is unsafe");
  }
}

async function walkRecoveryDirectories(input: {
  root: string;
  components: readonly string[];
  create: boolean;
}): Promise<string | null> {
  let current = input.root;
  for (const component of input.components) {
    current = path.join(current, component);
    let stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat && input.create) {
      await mkdir(current, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          // A racing creator is acceptable only after the exact path is
          // independently revalidated below.
          if (error.code !== "EEXIST") throw error;
        },
      );
      stat = await lstat(current).catch(() => null);
    }
    if (!stat) {
      if (!input.create) return null;
      throw new Error("Replica recovery directory is unsafe");
    }
    await requireRealDirectory(current, input.root);
  }
  return current;
}

/** Preserve divergent receive-only replica content before an explicit cloud
 * replacement. Every source and recovery parent is walked without accepting a
 * symlink, so an existing backup tree cannot redirect the rename elsewhere. */
export async function preserveCloudReplicaDivergences(input: {
  rootPath: string;
  replicaId: string;
  divergences: readonly {
    path: string;
    detectedAt: number;
    observedSha256: string | null;
  }[];
}): Promise<void> {
  const root = path.resolve(input.rootPath);
  if (
    root !== input.rootPath ||
    root === path.parse(root).root ||
    !UUID_PATTERN.test(input.replicaId)
  ) {
    throw new Error("Replica recovery directory is unsafe");
  }
  await requireRealDirectory(root, root);
  const rootParent = path.dirname(root);
  await requireRealDirectory(rootParent, rootParent);

  const backupRoot = `${root}.zeros-local-changes`;
  await mkdir(backupRoot, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await requireRealDirectory(backupRoot, backupRoot);

  for (const divergence of input.divergences) {
    const relative = normalizeCloudReplicaPath(divergence.path);
    if (
      !Number.isSafeInteger(divergence.detectedAt) ||
      divergence.detectedAt < 0
    ) {
      throw new Error("Replica recovery directory is unsafe");
    }
    const components = relative.split("/");
    const leaf = components.pop()!;
    const sourceParent = await walkRecoveryDirectories({
      root,
      components,
      create: false,
    });
    const destinationParent = await walkRecoveryDirectories({
      root: backupRoot,
      components: [
        input.replicaId,
        String(divergence.detectedAt),
        ...components,
      ],
      create: true,
    });
    if (!destinationParent) {
      throw new Error("Replica recovery directory is unsafe");
    }
    const source = sourceParent ? path.join(sourceParent, leaf) : null;
    const destination = path.join(destinationParent, leaf);
    const sourceStat = source
      ? await lstat(source).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        })
      : null;
    const destinationStat = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (sourceStat && destinationStat) {
      throw new Error("Replica recovery destination is already occupied");
    }
    if (source && sourceStat && !destinationStat)
      await rename(source, destination);
    if (!sourceStat && !destinationStat && divergence.observedSha256 !== null) {
      throw new Error("Diverged local content disappeared before preservation");
    }
  }
}

function requestId(): string {
  return `crp_${randomBytes(16).toString("base64url")}`;
}

function assertIdempotency(value: string): string {
  if (!IDEMPOTENCY_PATTERN.test(value)) {
    throw new CloudReplicaRuntimeError(
      "invalid_request",
      "Cloud replica request identity is invalid",
    );
  }
  return value;
}

function assertRemoteIdentity(
  session: CloudReplicaHostSession,
  local: CloudReplicaLocalState | null,
  remote: CloudReplicaRemoteState,
  expected: { workspaceId: string; organizationId: string },
): void {
  if (
    remote.workspaceId !== expected.workspaceId ||
    remote.organizationId !== expected.organizationId ||
    remote.deviceId !== session.device.deviceId ||
    (local !== null && remote.id !== local.replicaId)
  ) {
    throw new CloudReplicaRuntimeError(
      "identity_mismatch",
      "Cloud replica response does not match this device",
    );
  }
}

class HostCloudReplicaSigner implements CloudReplicaProofSigner {
  readonly deviceId: string;

  constructor(
    private readonly runtime: CloudReplicaRuntime,
    private readonly accountUserId: string,
    deviceId: string,
    private readonly keyVersion: number,
  ) {
    this.deviceId = deviceId;
  }

  proof(action: string, payload: unknown) {
    return this.runtime.requestHostProof({
      accountUserId: this.accountUserId,
      deviceId: this.deviceId,
      keyVersion: this.keyVersion,
      action,
      payload,
    });
  }
}

export type CloudReplicaRuntimeDependencies = {
  fetch?: typeof fetch;
  inspectEntry?: typeof inspectCloudReplicaEntry;
  emitHostControl: (line: string) => void;
  now?: () => number;
  random?: () => number;
  logger?: Pick<Console, "warn">;
  syncIntervalMs?: number;
  deviceLabel?: string;
  platform?: "macos" | "windows" | "linux";
};

type ActiveCloudReplicaRuntime = {
  session: CloudReplicaHostSession;
  api: CloudWorkspaceDesktopApi;
  broker: CloudReplicaSyncBroker;
};

type CloudReplicaCreateInput = {
  organizationId: string;
  workspaceId: string;
  rootPath: string;
  pathLabel?: string | null;
  ignorePolicy?: CloudReplicaIgnorePolicy;
  idempotencyKey: string;
};

/** Desktop engine owner for receive-only cloud replicas. WorkOS bearer tokens
 * are short-lived in memory, Ed25519 private keys remain in Electron
 * safeStorage, and all durable local state is device-private SQLite. */
export class CloudReplicaRuntime {
  private readonly state: DatabaseCloudReplicaState;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly pendingProofs = new Map<string, PendingProof>();
  private readonly retry = new Map<
    string,
    { attempts: number; nextAt: number }
  >();
  private readonly scanCursor = new Map<string, number>();
  private replicaScheduleCursor: string | null = null;
  private session: CloudReplicaHostSession | null = null;
  private sessionEpoch = 0;
  private api: CloudWorkspaceDesktopApi | null = null;
  private broker: CloudReplicaSyncBroker | null = null;
  private brokerDrain: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<void> | null = null;
  private enrollment: Promise<void> | null = null;
  private disposed = false;

  constructor(
    db: Database.Database,
    private readonly dependencies: CloudReplicaRuntimeDependencies,
  ) {
    this.state = new DatabaseCloudReplicaState(db);
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    const interval = dependencies.syncIntervalMs ?? SYNC_INTERVAL_MS;
    if (
      !Number.isSafeInteger(interval) ||
      interval < 1_000 ||
      interval > 300_000
    ) {
      throw new Error("Cloud replica scheduler interval is invalid");
    }
  }

  private emit(
    value: CloudReplicaProofRequest | CloudReplicaDeviceRegistered,
  ): void {
    this.dependencies.emitHostControl(cloudReplicaHostControlLine(value));
  }

  private rejectPendingProofs(code: string): void {
    for (const pending of this.pendingProofs.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.pendingProofs.clear();
  }

  private drainBroker(broker: CloudReplicaSyncBroker | null): Promise<void> {
    const prior = this.brokerDrain;
    const current = broker?.cancelAndDrain();
    if (!prior && !current) return Promise.resolve();
    const work = Promise.all([prior, current]).then(() => undefined);
    this.brokerDrain = work;
    void work.then(
      () => {
        if (this.brokerDrain === work) this.brokerDrain = null;
      },
      () => {
        if (this.brokerDrain === work) this.brokerDrain = null;
      },
    );
    return work;
  }

  private runOperation<T>(epoch: number, operation: () => Promise<T>): Promise<T> {
    const work = this.operationTail.then(() => {
      if (this.disposed || this.sessionEpoch !== epoch) {
        throw new CloudReplicaRuntimeError(
          "signed_out",
          "Cloud account session changed before the operation started",
        );
      }
      return operation();
    });
    this.operationTail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private assertRuntimeCurrent(
    runtime: Omit<ActiveCloudReplicaRuntime, "broker">,
    epoch: number,
    broker: CloudReplicaSyncBroker | null,
  ): void {
    if (
      this.disposed ||
      this.sessionEpoch !== epoch ||
      this.session !== runtime.session ||
      this.api !== runtime.api ||
      this.broker !== broker
    ) {
      throw new CloudReplicaRuntimeError(
        "signed_out",
        "Cloud account session changed during the operation",
      );
    }
  }

  private async quiesceRuntime(
    runtime: ActiveCloudReplicaRuntime,
    epoch: number,
  ): Promise<CloudReplicaSyncBroker> {
    this.assertRuntimeCurrent(runtime, epoch, runtime.broker);
    this.clearTimer();
    const tick = this.tick;
    this.broker = null;
    await Promise.all([
      this.drainBroker(runtime.broker),
      tick?.catch(() => undefined),
    ]);
    this.assertRuntimeCurrent(runtime, epoch, null);
    return new CloudReplicaSyncBroker(runtime.api, this.state, this.now);
  }

  /** Called only with a message already validated by the private stdin parser. */
  async updateSession(next: CloudReplicaHostSession | null): Promise<void> {
    if (this.disposed) return;
    const priorBroker = this.broker;
    const priorTick = this.tick;
    const priorEnrollment = this.enrollment;
    const priorOperations = this.operationTail;
    this.sessionEpoch += 1;
    const epoch = this.sessionEpoch;
    this.clearTimer();
    const priorDrain = this.drainBroker(priorBroker);
    this.api = null;
    this.broker = null;
    this.retry.clear();
    this.scanCursor.clear();
    this.replicaScheduleCursor = null;
    this.rejectPendingProofs("cloud replica session changed");
    // A stale broker may be between network and filesystem/SQLite phases.
    // Wait for its cancellation boundary before binding a replacement account.
    this.session = null;
    await Promise.all([
      priorTick?.catch(() => undefined),
      priorEnrollment?.catch(() => undefined),
      priorDrain,
      priorOperations.catch(() => undefined),
    ]);
    if (this.disposed || this.sessionEpoch !== epoch) return;
    this.session = next && next.expiresAtMs > this.now() ? next : null;
    if (!this.session) return;

    // Construction validates HTTPS/origin policy before any request leaves the
    // process. A malformed host seed therefore disables only this subsystem.
    if (!this.session.device.deviceId) {
      const session = this.session;
      const work = this.enrollDevice(session, epoch).finally(() => {
        if (this.enrollment === work) this.enrollment = null;
      });
      this.enrollment = work;
      await work;
      return;
    }

    this.bindSession(this.session);
    this.schedule(0);
  }

  private async enrollDevice(
    session: CloudReplicaHostSession,
    epoch: number,
  ): Promise<void> {
    const client = new HttpCloudReplicaEnrollmentClient({
      baseUrl: session.baseUrl,
      getAccessToken: async () =>
        this.sessionEpoch === epoch ? this.currentAccessToken() : null,
      ...(this.dependencies.fetch ? { fetch: this.dependencies.fetch } : {}),
      allowInsecureLoopback: session.allowInsecureLoopback,
    });
    const result = await client.registerDevice({
      label: this.dependencies.deviceLabel ?? cloudDesktopDeviceLabel(),
      platform: this.dependencies.platform ?? cloudDesktopPlatform(),
      publicKey: session.device.publicKey,
      idempotencyKey: cloudDeviceEnrollmentIdempotencyKey(
        session.accountUserId,
        session.device.publicKey,
      ),
    });
    if (this.sessionEpoch !== epoch || this.session !== session) return;
    let expectedFingerprint: string;
    try {
      expectedFingerprint = cloudDevicePublicKeyFingerprint(
        session.device.publicKey,
      );
    } catch (error) {
      throw new CloudReplicaRuntimeError(
        "identity_mismatch",
        "Cloud device public key is invalid",
        { cause: error },
      );
    }
    if (
      result.device.keyVersion !== session.device.keyVersion ||
      result.device.keyFingerprint !== expectedFingerprint ||
      result.device.trustState !== "trusted"
    ) {
      throw new CloudReplicaRuntimeError(
        "identity_mismatch",
        "Cloud device enrollment did not match the local key",
      );
    }
    this.state.recordRegistration({
      accountUserId: session.accountUserId,
      deviceId: result.device.id,
      keyVersion: result.device.keyVersion,
      publicKey: session.device.publicKey,
    });
    // Electron atomically binds the returned device id to the still-pending
    // safeStorage key, then sends a new bound session seed. Until that happens
    // no signed request can be made.
    this.emit({
      type: "engine.cloudReplicaDeviceRegistered",
      accountUserId: session.accountUserId,
      deviceId: result.device.id,
      keyVersion: result.device.keyVersion,
      publicKey: session.device.publicKey,
      keyFingerprint: expectedFingerprint,
    });
  }

  private bindSession(session: CloudReplicaHostSession): void {
    const deviceId = session.device.deviceId!;
    const registration = this.state.registration(session.accountUserId);
    if (
      registration &&
      (registration.deviceId !== deviceId ||
        registration.keyVersion > session.device.keyVersion)
    ) {
      throw new CloudReplicaRuntimeError(
        "identity_mismatch",
        "Cloud device session conflicts with local state",
      );
    }
    this.state.recordRegistration({
      accountUserId: session.accountUserId,
      deviceId,
      keyVersion: session.device.keyVersion,
      publicKey: session.device.publicKey,
    });
    const signer = new HostCloudReplicaSigner(
      this,
      session.accountUserId,
      deviceId,
      session.device.keyVersion,
    );
    const api = new HttpCloudReplicaApi({
      baseUrl: session.baseUrl,
      getAccessToken: async () => this.currentAccessToken(),
      signer,
      ...(this.dependencies.fetch ? { fetch: this.dependencies.fetch } : {}),
      allowInsecureLoopback: session.allowInsecureLoopback,
    });
    this.api = api;
    this.broker = new CloudReplicaSyncBroker(api, this.state, this.now);
  }

  private currentAccessToken(): string | null {
    const session = this.session;
    return session && session.expiresAtMs > this.now() + 1_000
      ? session.accessToken
      : null;
  }

  requestHostProof(
    input: Omit<CloudReplicaProofRequest, "type" | "requestId">,
  ) {
    if (
      this.disposed ||
      !this.session ||
      this.session.accountUserId !== input.accountUserId ||
      this.session.device.deviceId !== input.deviceId ||
      this.session.device.keyVersion !== input.keyVersion ||
      this.currentAccessToken() === null
    ) {
      return Promise.reject(
        new CloudReplicaRuntimeError(
          "signed_out",
          "Cloud account session is unavailable",
        ),
      );
    }
    if (this.pendingProofs.size >= MAX_PENDING_PROOFS) {
      return Promise.reject(new Error("Cloud device signer is busy"));
    }
    const id = requestId();
    return new Promise<NonNullable<CloudReplicaProofResponse["proof"]>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingProofs.delete(id);
          reject(new Error("Cloud device proof timed out"));
        }, PROOF_TIMEOUT_MS);
        timer.unref?.();
        this.pendingProofs.set(id, {
          deviceId: input.deviceId,
          keyVersion: input.keyVersion,
          resolve: (proof) => {
            if (proof) resolve(proof);
            else reject(new Error("Cloud device proof was rejected"));
          },
          reject,
          timer,
        });
        try {
          this.emit({
            type: "engine.cloudReplicaProofRequest",
            requestId: id,
            ...input,
          });
        } catch (error) {
          clearTimeout(timer);
          this.pendingProofs.delete(id);
          reject(error);
        }
      },
    );
  }

  handleProofResponse(response: CloudReplicaProofResponse): boolean {
    const pending = this.pendingProofs.get(response.requestId);
    if (!pending) return false;
    this.pendingProofs.delete(response.requestId);
    clearTimeout(pending.timer);
    if (
      !response.proof ||
      response.errorCode !== null ||
      response.proof.deviceId !== pending.deviceId ||
      response.proof.keyVersion !== pending.keyVersion
    ) {
      pending.reject(new Error(response.errorCode ?? "identity_mismatch"));
      return true;
    }
    pending.resolve(response.proof);
    return true;
  }

  private currentRuntime(): ActiveCloudReplicaRuntime {
    if (
      !this.session ||
      !this.api ||
      !this.broker ||
      !this.session.device.deviceId
    ) {
      throw new CloudReplicaRuntimeError(
        this.session ? "device_enrollment_pending" : "signed_out",
        this.session
          ? "Cloud device enrollment is still completing"
          : "A current WorkOS desktop session is required",
      );
    }
    return { session: this.session, api: this.api, broker: this.broker };
  }

  /** Private desktop-engine seam shared with the copy/fork coordinator. It
   * exposes no bearer token or signing key; the strict client resolves the
   * current WorkOS token per request and delegates every proof to Electron. */
  cloudWorkspaceContext(): {
    accountUserId: string;
    api: CloudWorkspaceDesktopApi;
  } {
    const { session, api } = this.currentRuntime();
    return { accountUserId: session.accountUserId, api };
  }

  list(): CloudReplicaLocalState[] {
    const session = this.session;
    if (!session?.device.deviceId) return [];
    return this.state.replicas({
      accountUserId: session.accountUserId,
      deviceId: session.device.deviceId,
    });
  }

  divergences(replicaId: string) {
    return this.state.openDivergences(replicaId);
  }

  create(input: CloudReplicaCreateInput): Promise<CloudReplicaLocalState> {
    const epoch = this.sessionEpoch;
    return this.runOperation(epoch, () => this.createExclusive(input, epoch));
  }

  private async createExclusive(
    input: CloudReplicaCreateInput,
    epoch: number,
  ): Promise<CloudReplicaLocalState> {
    const runtime = this.currentRuntime();
    assertIdempotency(input.idempotencyKey);
    if (
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.workspaceId)
    ) {
      throw new CloudReplicaRuntimeError(
        "invalid_request",
        "Cloud workspace identity is invalid",
      );
    }
    const existingBinding = this.state
      .replicas({
        accountUserId: runtime.session.accountUserId,
        deviceId: runtime.session.device.deviceId!,
      })
      .find(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          candidate.organizationId === input.organizationId &&
          candidate.desiredState !== "removed",
      );
    if (existingBinding && existingBinding.rootPath !== input.rootPath) {
      throw new CloudReplicaRuntimeError(
        "identity_mismatch",
        "This cloud workspace is already bound to a different local path",
      );
    }
    const root = await validateCloudReplicaDestination(input.rootPath, {
      allowPopulated: existingBinding !== undefined,
    });
    this.assertRuntimeCurrent(runtime, epoch, runtime.broker);
    const policy = parseCloudReplicaIgnorePolicy(
      input.ignorePolicy ?? DEFAULT_CLOUD_REPLICA_IGNORE_POLICY,
    );
    const result = await runtime.api.createReplica({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      pathLabel: input.pathLabel ?? null,
      ignorePolicySha256: cloudReplicaIgnorePolicySha256(policy),
      idempotencyKey: input.idempotencyKey,
    });
    assertRemoteIdentity(
      runtime.session,
      existingBinding ?? null,
      result.replica,
      input,
    );
    if (
      !result.replica.checkpointId ||
      result.replica.manifestRevision === null
    ) {
      throw new CloudReplicaRuntimeError(
        "identity_mismatch",
        "Cloud replica did not include a durable checkpoint",
      );
    }
    let local: CloudReplicaLocalState;
    try {
      this.assertRuntimeCurrent(runtime, epoch, runtime.broker);
      const existing = this.state.replica(result.replica.id);
      local =
        existing ??
        this.state.createReplica({
          replicaId: result.replica.id,
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          accountUserId: runtime.session.accountUserId,
          deviceId: runtime.session.device.deviceId!,
          rootPath: root,
          checkpointId: result.replica.checkpointId,
          manifestRevision: result.replica.manifestRevision,
          workspaceAuthorityEpoch: result.replica.workspaceAuthorityEpoch,
          grantEpoch: result.replica.grantEpoch,
          ignorePolicy: policy,
        });
      if (
        local.rootPath !== root ||
        local.ignorePolicySha256 !== cloudReplicaIgnorePolicySha256(policy)
      ) {
        throw new CloudReplicaRuntimeError(
          "identity_mismatch",
          "Replayed cloud replica does not match its local request",
        );
      }
    } catch (error) {
      // Only a failure to persist the binding is safe to compensate remotely.
      // Once SQLite owns it, a transient bootstrap/network failure must leave
      // the replica resumable instead of turning a visible local folder into
      // an orphan by deleting its server identity.
      if (!this.state.replica(result.replica.id)) {
        await runtime.api
          .changeReplicaState({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            replicaId: result.replica.id,
            operation: "remove",
            idempotencyKey: `${input.idempotencyKey}.cleanup`.slice(0, 128),
          })
          .catch(() => undefined);
      }
      throw error;
    }
    this.assertRuntimeCurrent(runtime, epoch, runtime.broker);
    runtime.broker.seedGrant(local.replicaId, result.grant);
    return runtime.broker.sync(local.replicaId);
  }

  async pause(replicaId: string, idempotencyKey: string) {
    return this.changeState(replicaId, "pause", idempotencyKey, false);
  }

  async remove(replicaId: string, idempotencyKey: string) {
    return this.changeState(replicaId, "remove", idempotencyKey, false);
  }

  async resume(
    replicaId: string,
    idempotencyKey: string,
    replaceDiverged = false,
  ) {
    return this.changeState(
      replicaId,
      "resume",
      idempotencyKey,
      replaceDiverged,
    );
  }

  private changeState(
    replicaId: string,
    operation: "pause" | "resume" | "remove",
    idempotencyKey: string,
    replaceDiverged: boolean,
  ): Promise<CloudReplicaLocalState> {
    const epoch = this.sessionEpoch;
    return this.runOperation(epoch, () =>
      this.changeStateExclusive(
        replicaId,
        operation,
        idempotencyKey,
        replaceDiverged,
        epoch,
      ),
    );
  }

  private async changeStateExclusive(
    replicaId: string,
    operation: "pause" | "resume" | "remove",
    idempotencyKey: string,
    replaceDiverged: boolean,
    epoch: number,
  ): Promise<CloudReplicaLocalState> {
    const runtime = this.currentRuntime();
    assertIdempotency(idempotencyKey);
    const local = this.state.replica(replicaId);
    if (!local) {
      throw new CloudReplicaRuntimeError(
        "replica_not_found",
        "Cloud replica was not found",
      );
    }
    if (
      local.accountUserId !== runtime.session.accountUserId ||
      local.deviceId !== runtime.session.device.deviceId
    ) {
      throw new CloudReplicaRuntimeError(
        "identity_mismatch",
        "Cloud replica belongs to another account or device",
      );
    }
    const replacementBroker = await this.quiesceRuntime(runtime, epoch);
    try {
      const response = await runtime.api.changeReplicaState({
        organizationId: local.organizationId,
        workspaceId: local.workspaceId,
        replicaId,
        operation,
        ...(operation === "resume" ? { replaceDiverged } : {}),
        idempotencyKey,
      });
      this.assertRuntimeCurrent(runtime, epoch, null);
      assertRemoteIdentity(runtime.session, local, response.replica, local);
      const expectedDesiredState =
        operation === "pause"
          ? "paused"
          : operation === "remove"
            ? "removed"
            : "active";
      if (
        response.replica.desiredState !== expectedDesiredState ||
        (operation === "resume") !== (response.grant !== null)
      ) {
        throw new CloudReplicaRuntimeError(
          "identity_mismatch",
          "Cloud replica lifecycle response is inconsistent",
        );
      }
      const currentLocal = this.state.assertRemoteAuthority({
        replicaId,
        desiredState: response.replica.desiredState,
        workspaceAuthorityEpoch: response.replica.workspaceAuthorityEpoch,
        grantEpoch: response.replica.grantEpoch,
      });
      const needsReplacement =
        operation === "resume" &&
        replaceDiverged &&
        (!response.replayed ||
          response.replica.observedState === "bootstrapping");
      if (needsReplacement) {
        if (
          response.replica.observedState !== "bootstrapping" ||
          !response.replica.checkpointId ||
          response.replica.manifestRevision === null
        ) {
          throw new CloudReplicaRuntimeError(
            "identity_mismatch",
            "Cloud replacement did not return an exact durable snapshot",
          );
        }
        try {
          await this.preserveOpenDivergences(currentLocal);
        } catch (error) {
          await runtime.api
            .changeReplicaState({
              organizationId: local.organizationId,
              workspaceId: local.workspaceId,
              replicaId,
              operation: "pause",
              idempotencyKey: `${idempotencyKey}.preserve-failed`.slice(0, 128),
            })
            .catch(() => undefined);
          throw new CloudReplicaRuntimeError(
            "divergence_preserve_failed",
            "Local changes could not be preserved before cloud replacement",
            { cause: error },
          );
        }
        this.assertRuntimeCurrent(runtime, epoch, null);
      }
      const locallyDiverged =
        response.replica.desiredState === "active" &&
        this.state.hasOpenDivergences(replicaId);
      let updated = this.state.updateRemoteState({
        replicaId,
        desiredState: response.replica.desiredState,
        observedState: locallyDiverged
          ? "diverged"
          : (response.replica
              .observedState as CloudReplicaLocalState["observedState"]),
        workspaceAuthorityEpoch: response.replica.workspaceAuthorityEpoch,
        grantEpoch: response.replica.grantEpoch,
        checkpointId: response.replica.checkpointId,
        manifestRevision: response.replica.manifestRevision,
        lastErrorCode: locallyDiverged
          ? "local_content_changed"
          : response.replica.lastErrorCode,
      });
      if (operation === "resume" && response.grant) {
        replacementBroker.seedGrant(replicaId, response.grant);
        if (needsReplacement) {
          updated = this.state.resetForSnapshot({
            replicaId,
            checkpointId: response.replica.checkpointId!,
            manifestRevision: response.replica.manifestRevision!,
            workspaceAuthorityEpoch: response.replica.workspaceAuthorityEpoch,
            grantEpoch: response.replica.grantEpoch,
          });
        }
        this.assertRuntimeCurrent(runtime, epoch, null);
        this.broker = replacementBroker;
        updated = await replacementBroker.sync(replicaId);
        this.assertRuntimeCurrent(runtime, epoch, replacementBroker);
      }
      return updated;
    } finally {
      if (
        !this.disposed &&
        this.sessionEpoch === epoch &&
        this.session === runtime.session &&
        this.api === runtime.api &&
        (this.broker === null || this.broker === replacementBroker)
      ) {
        this.broker = replacementBroker;
        this.schedule(0);
      }
    }
  }

  relocate(
    replicaId: string,
    nextRootPath: string,
  ): Promise<CloudReplicaLocalState> {
    const epoch = this.sessionEpoch;
    return this.runOperation(epoch, () =>
      this.relocateExclusive(replicaId, nextRootPath),
    );
  }

  private async relocateExclusive(
    replicaId: string,
    nextRootPath: string,
  ): Promise<CloudReplicaLocalState> {
    const local = this.state.replica(replicaId);
    if (!local) {
      throw new CloudReplicaRuntimeError(
        "replica_not_found",
        "Cloud replica was not found",
      );
    }
    if (local.desiredState === "active") {
      throw new CloudReplicaRuntimeError(
        "replica_not_paused",
        "Pause the cloud replica before relocating it",
      );
    }
    const next = path.resolve(nextRootPath);
    if (
      next !== nextRootPath ||
      next === path.parse(next).root ||
      (await lstat(next).catch(() => null)) !== null ||
      (await realpath(path.dirname(next)).catch(() => null)) !==
        path.dirname(next)
    ) {
      throw new CloudReplicaRuntimeError(
        "invalid_request",
        "Replica destination must be a missing path below a real directory",
      );
    }
    await rename(local.rootPath, next);
    try {
      return this.state.relocateReplica(replicaId, next);
    } catch (error) {
      await rename(next, local.rootPath).catch(() => undefined);
      throw error;
    }
  }

  private async preserveOpenDivergences(
    local: CloudReplicaLocalState,
  ): Promise<void> {
    const divergences = this.state.openDivergences(local.replicaId);
    if (divergences.length === 0) return;
    await preserveCloudReplicaDivergences({
      rootPath: local.rootPath,
      replicaId: local.replicaId,
      divergences,
    });
    this.state.resolveDivergences({
      replicaId: local.replicaId,
      paths: divergences.map(({ path: entryPath, detectedAt }) => ({
        path: entryPath,
        detectedAt,
      })),
      resolution: "saved_as_copy",
    });
  }

  syncNow(replicaId: string): Promise<CloudReplicaLocalState> {
    const epoch = this.sessionEpoch;
    return this.runOperation(epoch, () => this.syncNowExclusive(replicaId, epoch));
  }

  private async syncNowExclusive(
    replicaId: string,
    epoch: number,
  ): Promise<CloudReplicaLocalState> {
    const runtime = this.currentRuntime();
    const local = this.state.replica(replicaId);
    if (!local) {
      throw new CloudReplicaRuntimeError(
        "replica_not_found",
        "Cloud replica was not found",
      );
    }
    if (local.desiredState !== "active") {
      throw new CloudReplicaRuntimeError(
        "replica_not_found",
        "Cloud replica is not active",
      );
    }
    await this.scanLocalProjection(local);
    if (
      this.disposed ||
      this.sessionEpoch !== epoch ||
      this.broker !== runtime.broker
    ) {
      throw new CloudReplicaRuntimeError(
        "signed_out",
        "Cloud account session changed during synchronization",
      );
    }
    return runtime.broker.sync(replicaId);
  }

  private async scanLocalProjection(
    local: CloudReplicaLocalState,
  ): Promise<void> {
    const entries = this.state.projectionEntries(local.replicaId);
    if (entries.length === 0) {
      this.scanCursor.delete(local.replicaId);
      return;
    }
    const start = Math.min(
      this.scanCursor.get(local.replicaId) ?? 0,
      Math.max(0, entries.length - 1),
    );
    const count = Math.min(256, entries.length);
    const projection = this.state.projection(local.replicaId);
    for (let offset = 0; offset < count; offset += 1) {
      const entry = entries[(start + offset) % entries.length]!;
      try {
        const observed = await (
          this.dependencies.inspectEntry ?? inspectCloudReplicaEntry
        )(local.rootPath, entry.path);
        if (
          observed.type !== entry.entryType ||
          observed.mode !== entry.mode ||
          observed.sha256 !== entry.contentSha256 ||
          observed.sizeBytes !== entry.sizeBytes
        ) {
          projection.divergence({
            path: entry.path,
            expectedSha256: entry.contentSha256,
            observedSha256: observed.sha256,
            cloudSha256: entry.contentSha256,
          });
        }
      } catch (error) {
        if (
          !(error instanceof CloudReplicaApplyError) ||
          error.code !== "path_rejected"
        ) {
          throw error;
        }
        projection.divergence({
          path: entry.path,
          expectedSha256: entry.contentSha256,
          observedSha256: null,
          cloudSha256: entry.contentSha256,
        });
      }
    }
    this.scanCursor.set(local.replicaId, (start + count) % entries.length);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.disposed || !this.broker || !this.session) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.runTick().catch((error) => {
          this.dependencies.logger?.warn(
            `[cloud-replica] scheduler failed (${error instanceof Error ? error.message : "unknown"})`,
          );
        });
      },
      Math.max(0, delayMs),
    );
    this.timer.unref?.();
  }

  private runTick(): Promise<void> {
    if (this.tick) return this.tick;
    const epoch = this.sessionEpoch;
    const work = this.runTickExclusive(epoch).finally(() => {
      if (this.tick === work) this.tick = null;
      if (
        !this.disposed &&
        this.sessionEpoch === epoch &&
        this.session &&
        this.broker
      ) {
        this.schedule(this.dependencies.syncIntervalMs ?? SYNC_INTERVAL_MS);
      }
    });
    this.tick = work;
    return work;
  }

  private async runTickExclusive(epoch: number): Promise<void> {
    if (this.disposed || this.sessionEpoch !== epoch) return;
    const runtime = this.currentRuntime();
    const due = this.state
      .activeReplicas({
        accountUserId: runtime.session.accountUserId,
        deviceId: runtime.session.device.deviceId!,
      })
      .filter(
        (replica) =>
          (this.retry.get(replica.replicaId)?.nextAt ?? 0) <= this.now(),
      );
    const selected = selectFairCloudReplicaBatch(
      due,
      this.replicaScheduleCursor,
      MAX_REPLICAS_PER_TICK,
    );
    this.replicaScheduleCursor = selected.cursor;
    const replicas = selected.replicas;
    for (const replica of replicas) {
      if (
        this.disposed ||
        this.sessionEpoch !== epoch ||
        this.broker !== runtime.broker
      ) {
        return;
      }
      try {
        await this.scanLocalProjection(replica);
        if (
          this.disposed ||
          this.sessionEpoch !== epoch ||
          this.broker !== runtime.broker
        ) {
          return;
        }
        await runtime.broker.sync(replica.replicaId);
        if (
          this.disposed ||
          this.sessionEpoch !== epoch ||
          this.broker !== runtime.broker
        ) {
          return;
        }
        this.retry.delete(replica.replicaId);
      } catch (error) {
        if (
          this.disposed ||
          this.sessionEpoch !== epoch ||
          this.broker !== runtime.broker
        ) {
          return;
        }
        const detached = cloudReplicaDetachmentCode(error);
        if (detached) {
          runtime.broker.revokeLocalGrant(replica.replicaId);
          this.state.markDetached(replica.replicaId, detached);
          this.retry.delete(replica.replicaId);
          continue;
        }
        const prior = this.retry.get(replica.replicaId)?.attempts ?? 0;
        const attempts = Math.min(prior + 1, 16);
        const base = Math.min(
          MAX_BACKOFF_MS,
          1_000 * 2 ** Math.min(attempts, 8),
        );
        const jitter = Math.floor(base * 0.2 * this.random());
        this.retry.set(replica.replicaId, {
          attempts,
          nextAt: this.now() + base + jitter,
        });
        this.dependencies.logger?.warn(
          `[cloud-replica] synchronization deferred (${error instanceof CloudReplicaClientError ? error.code : error instanceof Error ? error.name : "unknown"})`,
        );
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    const operations = this.operationTail;
    this.disposed = true;
    this.session = null;
    this.sessionEpoch += 1;
    this.clearTimer();
    const broker = this.broker;
    const drain = this.drainBroker(broker);
    this.api = null;
    this.broker = null;
    this.retry.clear();
    this.scanCursor.clear();
    this.replicaScheduleCursor = null;
    this.rejectPendingProofs("cloud replica runtime stopped");
    await Promise.all([
      this.tick?.catch(() => undefined),
      this.enrollment?.catch(() => undefined),
      drain,
      operations.catch(() => undefined),
    ]);
  }
}
