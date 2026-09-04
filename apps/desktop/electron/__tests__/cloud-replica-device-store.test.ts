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
    create: (account, value) => {
      if (values.has(account)) return false;
      values.set(account, value);
      return true;
    },
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
      create: () => {
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
      create: () => {
        wrote = true;
        return true;
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

  it("returns the envelope created by the winner of a concurrent ensure", () => {
    const accountUserId = randomUUID();
    const winner = memorySecrets();
    const winnerStore = new CloudReplicaDeviceSecretStore(winner.dependencies);
    const winnerEnvelope = winnerStore.ensure(accountUserId);
    const account = cloudReplicaDeviceSecretAccount(accountUserId);
    const values = new Map<string, string>();
    const dependencies: CloudReplicaSecretStoreDependencies = {
      read: (candidate) => values.get(candidate) ?? null,
      has: (candidate) => values.has(candidate),
      create: (candidate) => {
        values.set(candidate, winner.values.get(account)!);
        return false;
      },
      replace: () => false,
    };

    const result = new CloudReplicaDeviceSecretStore(dependencies).ensure(
      accountUserId,
    );

    expect(result).toEqual(winnerEnvelope);
  });

  it("fails closed when a concurrent ensure winner vanishes before re-read", () => {
    const dependencies: CloudReplicaSecretStoreDependencies = {
      read: () => null,
      has: () => false,
      create: () => false,
      replace: () => false,
    };

    expect(() =>
      new CloudReplicaDeviceSecretStore(dependencies).ensure(randomUUID()),
    ).toThrowError(
      expect.objectContaining<Partial<CloudReplicaDeviceStoreError>>({
        code: "concurrent_update",
      }),
    );
  });

  it("fails closed when a concurrent ensure winner is corrupt", () => {
    const dependencies: CloudReplicaSecretStoreDependencies = {
      read: () => "not-json",
      has: () => true,
      create: () => false,
      replace: () => false,
    };

    expect(() =>
      new CloudReplicaDeviceSecretStore(dependencies).ensure(randomUUID()),
    ).toThrowError(
      expect.objectContaining<Partial<CloudReplicaDeviceStoreError>>({
        code: "secret_corrupt",
      }),
    );
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
