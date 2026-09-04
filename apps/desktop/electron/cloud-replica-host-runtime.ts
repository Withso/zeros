import {
  cloudDesktopDeviceLabel,
  cloudDesktopPlatform,
  cloudDeviceEnrollmentIdempotencyKey,
  cloudDevicePublicKeyFingerprint,
} from "../src/engine/cloud-device-enrollment";
import { HttpCloudReplicaEnrollmentClient } from "../src/engine/cloud-replica-client";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../src/engine/cloud-workspace-capability";
import { CloudReplicaDeviceSigner } from "../src/engine/cloud-replica-device";
import {
  cloudReplicaHostControlLine,
  parseCloudReplicaDeviceRegistered,
  parseCloudReplicaProofRequest,
  type CloudReplicaHostSession,
  type CloudReplicaProofResponse,
} from "../src/engine/cloud-replica-host-control";
import {
  CloudReplicaDeviceSecretStore,
  CloudReplicaDeviceStoreError,
} from "./cloud-replica-device-store";
import {
  getValidSessionForMain,
  type MainAuthSession,
} from "./ipc/commands/auth-session";
import { IS_DEV } from "./runtime-mode";
import { controlPlaneBaseUrl } from "./workos-desktop-account";

const SIGNABLE_ACTIONS = new Set([
  "device.rotate",
  "fork.export.grant",
  "fork.export.manifest.read",
  "fork.export.records.read",
  "fork.export.blob.read",
  "replica.create",
  "replica.pause",
  "replica.resume",
  "replica.remove",
  "replica.grant",
  "replica.snapshot",
  "replica.bootstrap.read",
  "replica.events.read",
  "replica.blob.read",
  "replica.receipt",
]);

let deviceStore: CloudReplicaDeviceSecretStore | null = null;

function store(): CloudReplicaDeviceSecretStore {
  deviceStore ??= new CloudReplicaDeviceSecretStore();
  return deviceStore;
}

function jwtExpiryMs(token: string): number | null {
  try {
    const pieces = token.split(".");
    if (pieces.length !== 3 || !pieces[1]) return null;
    const claims = JSON.parse(
      Buffer.from(pieces[1], "base64url").toString("utf8"),
    ) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" && Number.isSafeInteger(claims.exp)
      ? claims.exp * 1_000
      : null;
  } catch {
    return null;
  }
}

function publicKeyFingerprint(publicKey: string): string {
  return cloudDevicePublicKeyFingerprint(publicKey);
}

type RegisteredCloudDevice = {
  id: string;
  keyVersion: number;
  keyFingerprint: string;
  trustState: string;
};

type CloudAccessDeviceAuthorityDependencies = {
  capabilityEnabled: () => boolean;
  store: CloudReplicaDeviceSecretStore;
  getSession: () => Promise<MainAuthSession | null>;
  register: (input: {
    accessToken: string;
    accountUserId: string;
    label: string;
    platform: "macos" | "windows" | "linux";
    publicKey: string;
    idempotencyKey: string;
  }) => Promise<RegisteredCloudDevice>;
};

export type CloudReplicaEngineControlDependencies = {
  capabilityEnabled: () => boolean;
  store: () => CloudReplicaDeviceSecretStore;
  getSession: () => Promise<MainAuthSession | null>;
  warn?: (reason: CloudReplicaHostWarningReason) => void;
};

export type CloudReplicaHostWarningReason =
  | "device_registration_fingerprint_mismatch"
  | "device_registration_secret_unavailable"
  | "device_registration_secret_corrupt"
  | "device_registration_concurrent_update"
  | "device_registration_identity_mismatch"
  | "device_registration_store_failed"
  | "device_registration_reseed_failed";

const defaultEngineControlDependencies: CloudReplicaEngineControlDependencies =
  {
    capabilityEnabled: cloudWorkspaceDesktopCapabilityEnabled,
    store,
    getSession: getValidSessionForMain,
  };

function hostWarning(
  dependencies: CloudReplicaEngineControlDependencies,
  reason: CloudReplicaHostWarningReason,
): void {
  if (dependencies.warn) {
    dependencies.warn(reason);
    return;
  }
  console.warn(`[cloud-replica] host operation failed (${reason})`);
}

function deviceRegistrationStoreReason(
  error: unknown,
): CloudReplicaHostWarningReason {
  if (!(error instanceof CloudReplicaDeviceStoreError)) {
    return "device_registration_store_failed";
  }
  switch (error.code) {
    case "secret_unavailable":
      return "device_registration_secret_unavailable";
    case "secret_corrupt":
      return "device_registration_secret_corrupt";
    case "concurrent_update":
      return "device_registration_concurrent_update";
    case "identity_mismatch":
      return "device_registration_identity_mismatch";
  }
}

function workosAccountSession(
  session: MainAuthSession | null,
): (MainAuthSession & { provider: "workos"; accountId: string }) | null {
  return session?.provider === "workos" &&
    typeof session.accountId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      session.accountId,
    )
    ? (session as MainAuthSession & {
        provider: "workos";
        accountId: string;
      })
    : null;
}

/** Main-process device authority shared by cloud access and replica setup.
 * Enrollment is coalesced by the exact account/key tuple; safeStorage remains
 * the only private-key owner and no key material crosses IPC or HTTP. */
export class CloudAccessDeviceAuthority {
  private pending: {
    key: string;
    promise: Promise<{ accountUserId: string; deviceId: string }>;
  } | null = null;

  constructor(
    private readonly dependencies: CloudAccessDeviceAuthorityDependencies,
  ) {}

  async ensure(): Promise<{ accountUserId: string; deviceId: string }> {
    if (!this.dependencies.capabilityEnabled()) {
      throw new Error("Cloud workspaces are not enabled in this desktop build");
    }
    const session = workosAccountSession(await this.dependencies.getSession());
    if (!session) {
      throw new Error("A current WorkOS desktop session is required");
    }
    const envelope = this.dependencies.store.ensure(session.accountId);
    if (envelope.active.deviceId) {
      return {
        accountUserId: session.accountId,
        deviceId: envelope.active.deviceId,
      };
    }
    const key = `${session.accountId}\0${envelope.active.publicKey}`;
    if (this.pending?.key === key) return this.pending.promise;

    const promise = this.register(session, envelope.active.publicKey).finally(
      () => {
        if (this.pending?.promise === promise) this.pending = null;
      },
    );
    this.pending = { key, promise };
    return promise;
  }

  private async register(
    session: MainAuthSession & { provider: "workos"; accountId: string },
    publicKey: string,
  ): Promise<{ accountUserId: string; deviceId: string }> {
    const expectedFingerprint = cloudDevicePublicKeyFingerprint(publicKey);
    const remote = await this.dependencies.register({
      accessToken: session.accessToken,
      accountUserId: session.accountId,
      label: cloudDesktopDeviceLabel(),
      platform: cloudDesktopPlatform(),
      publicKey,
      idempotencyKey: cloudDeviceEnrollmentIdempotencyKey(
        session.accountId,
        publicKey,
      ),
    });
    if (
      remote.keyVersion !== 1 ||
      remote.keyFingerprint !== expectedFingerprint ||
      remote.trustState !== "trusted"
    ) {
      throw new Error("Cloud device enrollment did not match this Mac");
    }
    // The registration request can outlive an account replacement. Do not
    // attach its device to a now-different signed-in account after the await.
    const current = workosAccountSession(await this.dependencies.getSession());
    if (!current || current.accountId !== session.accountId) {
      throw new Error("Cloud device enrollment session changed");
    }
    try {
      this.dependencies.store.bindRegistration({
        accountUserId: session.accountId,
        deviceId: remote.id,
        keyVersion: remote.keyVersion,
        publicKey,
      });
    } catch (error) {
      // Electron and the engine can complete the same deterministic request at
      // the same time. Accept only an exact identity already committed by the
      // winner; every other CAS failure remains fatal.
      const current = this.dependencies.store.load(session.accountId)?.active;
      if (
        current?.deviceId !== remote.id ||
        current.keyVersion !== remote.keyVersion ||
        current.publicKey !== publicKey
      ) {
        throw error;
      }
    }
    return { accountUserId: session.accountId, deviceId: remote.id };
  }
}

let accessDeviceAuthority: CloudAccessDeviceAuthority | null = null;

export function ensureCloudAccessDeviceForMain(): Promise<{
  accountUserId: string;
  deviceId: string;
}> {
  if (!cloudWorkspaceDesktopCapabilityEnabled()) {
    return Promise.reject(
      new Error("Cloud workspaces are not enabled in this desktop build"),
    );
  }
  accessDeviceAuthority ??= new CloudAccessDeviceAuthority({
    capabilityEnabled: cloudWorkspaceDesktopCapabilityEnabled,
    store: store(),
    getSession: getValidSessionForMain,
    register: async (input) => {
      const result = await new HttpCloudReplicaEnrollmentClient({
        baseUrl: controlPlaneBaseUrl(),
        getAccessToken: async () => input.accessToken,
        allowInsecureLoopback: IS_DEV,
      }).registerDevice(input);
      return result.device;
    },
  });
  return accessDeviceAuthority.ensure();
}

/** Build the private stdin seed. Auth0 compatibility sessions deliberately
 * produce a clear message: replica authority is tied to canonical WorkOS
 * account UUIDs, never a provider subject or email. */
export async function cloudReplicaSessionControlLine(
  dependencies: CloudReplicaEngineControlDependencies = defaultEngineControlDependencies,
): Promise<string> {
  if (!dependencies.capabilityEnabled()) {
    return cloudReplicaHostControlLine({
      type: "host.cloudReplicaSession",
      session: null,
    });
  }
  const session = workosAccountSession(await dependencies.getSession());
  if (!session) {
    return cloudReplicaHostControlLine({
      type: "host.cloudReplicaSession",
      session: null,
    });
  }
  const expiresAtMs = jwtExpiryMs(session.accessToken);
  if (!expiresAtMs || expiresAtMs <= Date.now()) {
    return cloudReplicaHostControlLine({
      type: "host.cloudReplicaSession",
      session: null,
    });
  }
  const envelope = dependencies.store().ensure(session.accountId);
  const value: CloudReplicaHostSession = {
    version: 1,
    accountUserId: session.accountId,
    accessToken: session.accessToken,
    expiresAtMs,
    baseUrl: controlPlaneBaseUrl(),
    allowInsecureLoopback: IS_DEV,
    device: {
      deviceId: envelope.active.deviceId,
      keyVersion: envelope.active.keyVersion,
      publicKey: envelope.active.publicKey,
    },
  };
  return cloudReplicaHostControlLine({
    type: "host.cloudReplicaSession",
    session: value,
  });
}

function proofFailure(
  requestId: string,
  errorCode: NonNullable<CloudReplicaProofResponse["errorCode"]>,
): string {
  return cloudReplicaHostControlLine({
    type: "host.cloudReplicaProofResponse",
    requestId,
    proof: null,
    errorCode,
  } satisfies CloudReplicaProofResponse);
}

/** Handle one parsed engine→host control message. Returns true only for the
 * replica protocol so the sidecar can continue routing MCP/launch messages. */
export async function handleCloudReplicaEngineControl(
  value: unknown,
  writeToEngine: (line: string) => void,
  dependencies: CloudReplicaEngineControlDependencies = defaultEngineControlDependencies,
  reseedSession?: () => Promise<void> | void,
): Promise<boolean> {
  const proofRequest = parseCloudReplicaProofRequest(value);
  if (!dependencies.capabilityEnabled()) {
    if (proofRequest) {
      writeToEngine(proofFailure(proofRequest.requestId, "signed_out"));
      return true;
    }
    return parseCloudReplicaDeviceRegistered(value) !== null;
  }
  if (proofRequest) {
    if (!SIGNABLE_ACTIONS.has(proofRequest.action)) {
      writeToEngine(proofFailure(proofRequest.requestId, "signing_failed"));
      return true;
    }
    let session:
      | (MainAuthSession & {
          provider: "workos";
          accountId: string;
        })
      | null;
    try {
      session = workosAccountSession(await dependencies.getSession());
    } catch {
      writeToEngine(proofFailure(proofRequest.requestId, "signed_out"));
      return true;
    }
    if (
      !session ||
      jwtExpiryMs(session.accessToken) === null ||
      jwtExpiryMs(session.accessToken)! <= Date.now()
    ) {
      writeToEngine(proofFailure(proofRequest.requestId, "signed_out"));
      return true;
    }
    if (session.accountId !== proofRequest.accountUserId) {
      writeToEngine(proofFailure(proofRequest.requestId, "identity_mismatch"));
      return true;
    }
    try {
      const envelope = dependencies.store().load(proofRequest.accountUserId);
      if (!envelope) {
        writeToEngine(proofFailure(proofRequest.requestId, "signed_out"));
        return true;
      }
      if (
        envelope.active.deviceId !== proofRequest.deviceId ||
        envelope.active.keyVersion !== proofRequest.keyVersion
      ) {
        writeToEngine(
          proofFailure(proofRequest.requestId, "identity_mismatch"),
        );
        return true;
      }
      const proof = new CloudReplicaDeviceSigner(envelope.active).proof(
        proofRequest.action,
        proofRequest.payload,
      );
      writeToEngine(
        cloudReplicaHostControlLine({
          type: "host.cloudReplicaProofResponse",
          requestId: proofRequest.requestId,
          proof,
          errorCode: null,
        } satisfies CloudReplicaProofResponse),
      );
    } catch {
      writeToEngine(proofFailure(proofRequest.requestId, "signing_failed"));
    }
    return true;
  }

  const registration = parseCloudReplicaDeviceRegistered(value);
  if (!registration) return false;
  try {
    if (
      publicKeyFingerprint(registration.publicKey) !==
      registration.keyFingerprint
    ) {
      hostWarning(dependencies, "device_registration_fingerprint_mismatch");
      return true;
    }
    dependencies.store().bindRegistration(registration);
  } catch (error) {
    // A CAS/identity mismatch must not be repaired by silently creating a new
    // key. The next explicit auth/session seed will retry deterministic
    // enrollment or surface the protected credential error.
    hostWarning(dependencies, deviceRegistrationStoreReason(error));
    return true;
  }
  // Production routes registration through the sidecar's shared latest-wins
  // writer. The fallback keeps the helper self-contained for non-sidecar
  // callers while still containing synchronous pipe failures.
  if (reseedSession) {
    try {
      await reseedSession();
    } catch {
      hostWarning(dependencies, "device_registration_reseed_failed");
    }
    return true;
  }

  const signedOutLine = cloudReplicaHostControlLine({
    type: "host.cloudReplicaSession",
    session: null,
  });
  let line: string;
  let fallback = false;
  try {
    line = await cloudReplicaSessionControlLine(dependencies);
  } catch {
    fallback = true;
    line = signedOutLine;
  }
  try {
    writeToEngine(line);
  } catch {
    // Preserve the prior fail-closed retry when the normal write throws, but
    // contain a second synchronous pipe failure as well.
    if (!fallback) {
      try {
        writeToEngine(signedOutLine);
      } catch {
        // The active engine is exiting; its replacement receives a fresh seed.
      }
    }
    fallback = true;
  }
  if (fallback) {
    hostWarning(dependencies, "device_registration_reseed_failed");
  }
  return true;
}
