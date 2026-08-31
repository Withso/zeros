import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { cloudDevicePublicKeyFingerprint } from "../../src/engine/cloud-device-enrollment";
import {
  CloudReplicaDeviceSecretStore,
  type CloudReplicaSecretStoreDependencies,
} from "../cloud-replica-device-store";
import { CloudAccessDeviceAuthority } from "../cloud-replica-host-runtime";

function memoryStore(): CloudReplicaDeviceSecretStore {
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
  return new CloudReplicaDeviceSecretStore(dependencies);
}

describe("main cloud access device authority", () => {
  it("coalesces enrollment and binds the exact server device to safeStorage", async () => {
    const accountId = randomUUID();
    const deviceId = randomUUID();
    const store = memoryStore();
    const register = vi.fn(async (input: { publicKey: string }) => ({
      id: deviceId,
      keyVersion: 1,
      keyFingerprint: cloudDevicePublicKeyFingerprint(input.publicKey),
      trustState: "trusted",
    }));
    const authority = new CloudAccessDeviceAuthority({
      store,
      getSession: async () => ({
        provider: "workos" as const,
        accountId,
        accessToken: "header.payload.signature",
        sub: "user_01",
        email: "device@example.test",
        name: "Device",
        clientKind: "desktop" as const,
      }),
      register,
    });

    const [first, second] = await Promise.all([
      authority.ensure(),
      authority.ensure(),
    ]);
    expect(first).toEqual({ accountUserId: accountId, deviceId });
    expect(second).toEqual(first);
    expect(register).toHaveBeenCalledOnce();
    expect(store.load(accountId)?.active.deviceId).toBe(deviceId);
    await expect(authority.ensure()).resolves.toEqual(first);
    expect(register).toHaveBeenCalledOnce();
  });

  it("never binds a mismatched enrollment response", async () => {
    const accountId = randomUUID();
    const store = memoryStore();
    const authority = new CloudAccessDeviceAuthority({
      store,
      getSession: async () => ({
        provider: "workos" as const,
        accountId,
        accessToken: "header.payload.signature",
        sub: "user_02",
        email: "mismatch@example.test",
        name: null,
        clientKind: "desktop" as const,
      }),
      register: async () => ({
        id: randomUUID(),
        keyVersion: 1,
        keyFingerprint: "0".repeat(64),
        trustState: "trusted",
      }),
    });

    await expect(authority.ensure()).rejects.toThrow(/did not match/i);
    expect(store.load(accountId)?.active.deviceId).toBeNull();
  });
});
