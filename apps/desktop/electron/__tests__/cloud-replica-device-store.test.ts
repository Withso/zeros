import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CloudReplicaDeviceSecretStore,
  CloudReplicaDeviceStoreError,
  type CloudReplicaSecretStoreDependencies,
} from "../cloud-replica-device-store";
import { cloudReplicaDeviceSecretAccount } from "../../src/engine/cloud-replica-device";

function memorySecrets() {
  const values = new Map<string, string>();
  const dependencies: CloudReplicaSecretStoreDependencies = {
    read: (account) => values.get(account) ?? null,
    has: (account) => values.has(account),
    write: (account, value) => void values.set(account, value),
    replace: (account, expected, next) => {
      if (values.get(account) !== expected) return false;
      if (next === null) values.delete(account);
      else values.set(account, next);
      return true;
    },
  };
  return { values, dependencies };
}

describe("main-owned cloud replica device secret", () => {
  it("persists registration and a crash-safe pending rotation with CAS", () => {
    const memory = memorySecrets();
    const store = new CloudReplicaDeviceSecretStore(memory.dependencies);
    const accountUserId = randomUUID();
    const pending = store.ensure(accountUserId);
    expect(pending.active.deviceId).toBeNull();
    const registered = store.bindRegistration({
      accountUserId,
      deviceId: randomUUID(),
      keyVersion: pending.active.keyVersion,
      publicKey: pending.active.publicKey,
    });
    const rotation = store.beginRotation(accountUserId);
    expect(rotation.pendingRotation).toMatchObject({
      candidate: {
        deviceId: registered.active.deviceId,
        keyVersion: 2,
      },
    });
    expect(store.beginRotation(accountUserId).pendingRotation).toEqual(
      rotation.pendingRotation,
    );
    const committed = store.commitRotation({
      accountUserId,
      publicKey: rotation.pendingRotation!.candidate.publicKey,
      keyVersion: 2,
    });
    expect(committed).toMatchObject({
      active: { keyVersion: 2 },
      pendingRotation: null,
    });
  });

  it("does not replace a present but undecryptable device key", () => {
    const accountUserId = randomUUID();
    const account = cloudReplicaDeviceSecretAccount(accountUserId);
    const dependencies: CloudReplicaSecretStoreDependencies = {
      read: () => null,
      has: (candidate) => candidate === account,
      write: () => {
        throw new Error("must not overwrite");
      },
      replace: () => false,
    };
    expect(() =>
      new CloudReplicaDeviceSecretStore(dependencies).ensure(accountUserId),
    ).toThrowError(
      expect.objectContaining<Partial<CloudReplicaDeviceStoreError>>({
        code: "secret_unavailable",
      }),
    );
  });

  it("does not create a replacement key when the whole secret store is unreadable", () => {
    let wrote = false;
    const dependencies: CloudReplicaSecretStoreDependencies = {
      read: () => {
        throw new Error("secrets.json is unreadable");
      },
      has: () => false,
      write: () => {
        wrote = true;
      },
      replace: () => false,
    };
    expect(() =>
      new CloudReplicaDeviceSecretStore(dependencies).ensure(randomUUID()),
    ).toThrowError(
      expect.objectContaining<Partial<CloudReplicaDeviceStoreError>>({
        code: "secret_unavailable",
      }),
    );
    expect(wrote).toBe(false);
  });

  it("rejects a server registration for a different public key", () => {
    const memory = memorySecrets();
    const store = new CloudReplicaDeviceSecretStore(memory.dependencies);
    const accountUserId = randomUUID();
    store.ensure(accountUserId);
    expect(() =>
      store.bindRegistration({
        accountUserId,
        deviceId: randomUUID(),
        keyVersion: 1,
        publicKey: "A".repeat(43),
      }),
    ).toThrowError(expect.objectContaining({ code: "identity_mismatch" }));
  });
});
