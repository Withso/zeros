import { randomUUID } from "node:crypto";

import {
  cloudReplicaDeviceSecretAccount,
  createCloudReplicaDeviceCredential,
  parseCloudReplicaDeviceCredential,
  rotateCloudReplicaDeviceCredential,
  type CloudReplicaDeviceCredential,
} from "../src/engine/cloud-replica-device";
import {
  getSecret,
  hasSecret,
  replaceSecretIfUnchanged,
  setSecret,
} from "./secret-store";

export type DeviceSecretEnvelope = {
  version: 1;
  active: CloudReplicaDeviceCredential;
  pendingRotation: {
    idempotencyKey: string;
    candidate: CloudReplicaDeviceCredential;
  } | null;
};

export class CloudReplicaDeviceStoreError extends Error {
  constructor(
    public readonly code:
      | "secret_unavailable"
      | "secret_corrupt"
      | "concurrent_update"
      | "identity_mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudReplicaDeviceStoreError";
  }
}

function parseEnvelope(
  raw: string,
  accountUserId: string,
): DeviceSecretEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CloudReplicaDeviceStoreError(
      "secret_corrupt",
      "Cloud device credential is corrupt",
      { cause: error },
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      ["active", "pendingRotation", "version"].sort().join("\0") ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new CloudReplicaDeviceStoreError(
      "secret_corrupt",
      "Cloud device credential is corrupt",
    );
  }
  const record = value as {
    active: unknown;
    pendingRotation: unknown;
  };
  let active: CloudReplicaDeviceCredential;
  try {
    active = parseCloudReplicaDeviceCredential(record.active);
  } catch (error) {
    throw new CloudReplicaDeviceStoreError(
      "secret_corrupt",
      "Cloud device credential is corrupt",
      { cause: error },
    );
  }
  if (active.accountUserId !== accountUserId) {
    throw new CloudReplicaDeviceStoreError(
      "identity_mismatch",
      "Cloud device credential belongs to another account",
    );
  }
  let pendingRotation: DeviceSecretEnvelope["pendingRotation"] = null;
  if (record.pendingRotation !== null) {
    const pending = record.pendingRotation;
    if (
      !pending ||
      typeof pending !== "object" ||
      Array.isArray(pending) ||
      Object.keys(pending).sort().join("\0") !==
        ["candidate", "idempotencyKey"].sort().join("\0") ||
      typeof (pending as { idempotencyKey?: unknown }).idempotencyKey !==
        "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(
        (pending as { idempotencyKey: string }).idempotencyKey,
      )
    ) {
      throw new CloudReplicaDeviceStoreError(
        "secret_corrupt",
        "Cloud device credential rotation is corrupt",
      );
    }
    let candidate: CloudReplicaDeviceCredential;
    try {
      candidate = parseCloudReplicaDeviceCredential(
        (pending as { candidate: unknown }).candidate,
      );
    } catch (error) {
      throw new CloudReplicaDeviceStoreError(
        "secret_corrupt",
        "Cloud device credential rotation is corrupt",
        { cause: error },
      );
    }
    if (
      candidate.accountUserId !== active.accountUserId ||
      candidate.deviceId !== active.deviceId ||
      candidate.keyVersion !== active.keyVersion + 1
    ) {
      throw new CloudReplicaDeviceStoreError(
        "identity_mismatch",
        "Cloud device rotation does not match its active key",
      );
    }
    pendingRotation = {
      idempotencyKey: (pending as { idempotencyKey: string }).idempotencyKey,
      candidate,
    };
  }
  return { version: 1, active, pendingRotation };
}

export interface CloudReplicaSecretStoreDependencies {
  read(account: string): string | null;
  has(account: string): boolean;
  write(account: string, value: string): void;
  replace(account: string, expected: string, next: string | null): boolean;
}

const defaultDependencies: CloudReplicaSecretStoreDependencies = {
  read: getSecret,
  has: hasSecret,
  write: setSecret,
  replace: replaceSecretIfUnchanged,
};

/** Main-process-only safeStorage owner. A decrypt failure never creates a new
 * identity over an unreadable key: doing so would strand every server replica
 * bound to the old public key. */
export class CloudReplicaDeviceSecretStore {
  constructor(
    private readonly secrets: CloudReplicaSecretStoreDependencies = defaultDependencies,
  ) {}

  private readRaw(accountUserId: string): {
    account: string;
    raw: string | null;
    envelope: DeviceSecretEnvelope | null;
  } {
    const account = cloudReplicaDeviceSecretAccount(accountUserId);
    let raw: string | null;
    try {
      raw = this.secrets.read(account);
    } catch (error) {
      throw new CloudReplicaDeviceStoreError(
        "secret_unavailable",
        "Cloud device credential store cannot be read",
        { cause: error },
      );
    }
    if (raw === null) {
      let present: boolean;
      try {
        present = this.secrets.has(account);
      } catch (error) {
        throw new CloudReplicaDeviceStoreError(
          "secret_unavailable",
          "Cloud device credential store cannot be read",
          { cause: error },
        );
      }
      if (present) {
        throw new CloudReplicaDeviceStoreError(
          "secret_unavailable",
          "Cloud device credential cannot be decrypted",
        );
      }
      return { account, raw: null, envelope: null };
    }
    return { account, raw, envelope: parseEnvelope(raw, accountUserId) };
  }

  load(accountUserId: string): DeviceSecretEnvelope | null {
    return this.readRaw(accountUserId).envelope;
  }

  ensure(accountUserId: string): DeviceSecretEnvelope {
    const current = this.readRaw(accountUserId);
    if (current.envelope) return current.envelope;
    const envelope: DeviceSecretEnvelope = {
      version: 1,
      active: createCloudReplicaDeviceCredential(accountUserId),
      pendingRotation: null,
    };
    this.secrets.write(current.account, JSON.stringify(envelope));
    return envelope;
  }

  bindRegistration(input: {
    accountUserId: string;
    deviceId: string;
    keyVersion: number;
    publicKey: string;
  }): DeviceSecretEnvelope {
    const current = this.readRaw(input.accountUserId);
    if (!current.raw || !current.envelope) {
      throw new CloudReplicaDeviceStoreError(
        "concurrent_update",
        "Cloud device credential disappeared during registration",
      );
    }
    if (
      current.envelope.active.publicKey !== input.publicKey ||
      current.envelope.active.keyVersion !== input.keyVersion ||
      (current.envelope.active.deviceId !== null &&
        current.envelope.active.deviceId !== input.deviceId)
    ) {
      throw new CloudReplicaDeviceStoreError(
        "identity_mismatch",
        "Cloud device registration does not match the local key",
      );
    }
    const next: DeviceSecretEnvelope = {
      version: 1,
      active: { ...current.envelope.active, deviceId: input.deviceId },
      pendingRotation: null,
    };
    if (
      !this.secrets.replace(current.account, current.raw, JSON.stringify(next))
    ) {
      throw new CloudReplicaDeviceStoreError(
        "concurrent_update",
        "Cloud device credential changed concurrently",
      );
    }
    return next;
  }

  beginRotation(accountUserId: string): DeviceSecretEnvelope {
    const current = this.readRaw(accountUserId);
    if (!current.raw || !current.envelope?.active.deviceId) {
      throw new CloudReplicaDeviceStoreError(
        "identity_mismatch",
        "Cloud device must be registered before key rotation",
      );
    }
    if (current.envelope.pendingRotation) return current.envelope;
    const next: DeviceSecretEnvelope = {
      ...current.envelope,
      pendingRotation: {
        idempotencyKey: `device-rotate-${randomUUID()}`,
        candidate: rotateCloudReplicaDeviceCredential(current.envelope.active),
      },
    };
    if (
      !this.secrets.replace(current.account, current.raw, JSON.stringify(next))
    ) {
      throw new CloudReplicaDeviceStoreError(
        "concurrent_update",
        "Cloud device credential changed concurrently",
      );
    }
    return next;
  }

  commitRotation(input: {
    accountUserId: string;
    publicKey: string;
    keyVersion: number;
  }): DeviceSecretEnvelope {
    const current = this.readRaw(input.accountUserId);
    const pending = current.envelope?.pendingRotation;
    if (
      !current.raw ||
      !current.envelope ||
      !pending ||
      pending.candidate.publicKey !== input.publicKey ||
      pending.candidate.keyVersion !== input.keyVersion
    ) {
      throw new CloudReplicaDeviceStoreError(
        "identity_mismatch",
        "Cloud device rotation response does not match the pending key",
      );
    }
    const next: DeviceSecretEnvelope = {
      version: 1,
      active: pending.candidate,
      pendingRotation: null,
    };
    if (
      !this.secrets.replace(current.account, current.raw, JSON.stringify(next))
    ) {
      throw new CloudReplicaDeviceStoreError(
        "concurrent_update",
        "Cloud device credential changed concurrently",
      );
    }
    return next;
  }
}
