import {
  cloudDesktopDeviceLabel,
  cloudDesktopPlatform,
  cloudDeviceEnrollmentIdempotencyKey,
  cloudDevicePublicKeyFingerprint,
} from "../src/engine/cloud-device-enrollment";
import { HttpCloudReplicaEnrollmentClient } from "../src/engine/cloud-replica-client";
import { CloudReplicaDeviceSigner } from "../src/engine/cloud-replica-device";
import {
  cloudReplicaHostControlLine,
  parseCloudReplicaDeviceRegistered,
  parseCloudReplicaProofRequest,
  type CloudReplicaHostSession,
  type CloudReplicaProofResponse,
} from "../src/engine/cloud-replica-host-control";
import { CloudReplicaDeviceSecretStore } from "./cloud-replica-device-store";
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
    const claims = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8")) as {
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
  private pending:
    | { key: string; promise: Promise<{ accountUserId: string; deviceId: string }> }
    | null = null;

  constructor(private readonly dependencies: CloudAccessDeviceAuthorityDependencies) {}

  async ensure(): Promise<{ accountUserId: string; deviceId: string }> {
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

    const promise = this.register(session, envelope.active.publicKey).finally(() => {
      if (this.pending?.promise === promise) this.pending = null;
    });
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
  accessDeviceAuthority ??= new CloudAccessDeviceAuthority({
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
export async function cloudReplicaSessionControlLine(): Promise<string> {
  const session = workosAccountSession(await getValidSessionForMain());
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
  const envelope = store().ensure(session.accountId);
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
export function handleCloudReplicaEngineControl(
  value: unknown,
  writeToEngine: (line: string) => void,
): boolean {
  const proofRequest = parseCloudReplicaProofRequest(value);
  if (proofRequest) {
    if (!SIGNABLE_ACTIONS.has(proofRequest.action)) {
      writeToEngine(proofFailure(proofRequest.requestId, "signing_failed"));
      return true;
    }
    try {
      const envelope = store().load(proofRequest.accountUserId);
      if (!envelope) {
        writeToEngine(proofFailure(proofRequest.requestId, "signed_out"));
        return true;
      }
      if (
        envelope.active.deviceId !== proofRequest.deviceId ||
        envelope.active.keyVersion !== proofRequest.keyVersion
      ) {
        writeToEngine(proofFailure(proofRequest.requestId, "identity_mismatch"));
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
      return true;
    }
    store().bindRegistration(registration);
    // Re-seed immediately with the now-bound safeStorage identity. The engine
    // remains unable to request signatures until it receives this message.
    void cloudReplicaSessionControlLine().then(writeToEngine).catch(() => {
      writeToEngine(
        cloudReplicaHostControlLine({
          type: "host.cloudReplicaSession",
          session: null,
        }),
      );
    });
  } catch {
    // A CAS/identity mismatch must not be repaired by silently creating a new
    // key. The next explicit auth/session seed will retry deterministic
    // enrollment or surface the protected credential error.
  }
  return true;
}
