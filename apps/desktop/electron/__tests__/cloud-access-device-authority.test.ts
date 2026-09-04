import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { cloudDevicePublicKeyFingerprint } from "../../src/engine/cloud-device-enrollment";
import {
  CloudReplicaDeviceSecretStore,
  type CloudReplicaSecretStoreDependencies,
} from "../cloud-replica-device-store";
import {
  CloudAccessDeviceAuthority,
  cloudReplicaSessionControlLine,
  handleCloudReplicaEngineControl,
} from "../cloud-replica-host-runtime";

function unexpiredAccessToken(): string {
  return [
    Buffer.from('{"alg":"none"}', "utf8").toString("base64url"),
    Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
      "utf8",
    ).toString("base64url"),
    "signature",
  ].join(".");
}

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
      capabilityEnabled: () => true,
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
      capabilityEnabled: () => true,
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

  it("rechecks the current WorkOS account before signing an engine proof", async () => {
    const accountId = randomUUID();
    const replacementAccountId = randomUUID();
    const store = memoryStore();
    const pending = store.ensure(accountId);
    const deviceId = randomUUID();
    store.bindRegistration({
      accountUserId: accountId,
      deviceId,
      keyVersion: pending.active.keyVersion,
      publicKey: pending.active.publicKey,
    });
    const lines: string[] = [];
    const handled = await handleCloudReplicaEngineControl(
      {
        type: "engine.cloudReplicaProofRequest",
        requestId: `crp_${Buffer.alloc(16, 7).toString("base64url")}`,
        accountUserId: accountId,
        deviceId,
        keyVersion: 1,
        action: "replica.events.read",
        payload: { afterRevision: 0, limit: 100 },
      },
      (line) => lines.push(line),
      {
        capabilityEnabled: () => true,
        store: () => store,
        getSession: async () => ({
          provider: "workos" as const,
          accountId: replacementAccountId,
          accessToken: unexpiredAccessToken(),
          sub: "user_replaced",
          email: "replacement@example.test",
          name: "Replacement",
          clientKind: "desktop" as const,
        }),
      },
    );

    expect(handled).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "host.cloudReplicaProofResponse",
      proof: null,
      errorCode: "identity_mismatch",
    });
  });

  it("does not create a safeStorage key or POST enrollment while disabled", async () => {
    const accountId = randomUUID();
    const store = memoryStore();
    const ensure = vi.spyOn(store, "ensure");
    const getSession = vi.fn(async () => ({
      provider: "workos" as const,
      accountId,
      accessToken: unexpiredAccessToken(),
      sub: "user_disabled",
      email: "disabled@example.test",
      name: null,
      clientKind: "desktop" as const,
    }));
    const register = vi.fn();
    const authority = new CloudAccessDeviceAuthority({
      capabilityEnabled: () => false,
      store,
      getSession,
      register,
    });

    await expect(authority.ensure()).rejects.toThrow(/not enabled/i);
    expect(getSession).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("does not read auth or safeStorage when a disabled session seed is requested", async () => {
    const getSession = vi.fn();
    const getStore = vi.fn();

    const line = await cloudReplicaSessionControlLine({
      capabilityEnabled: () => false,
      getSession,
      store: getStore,
    });

    expect(JSON.parse(line)).toEqual({
      type: "host.cloudReplicaSession",
      session: null,
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
  });

  it("retires delayed engine proof requests without reading auth or safeStorage while disabled", async () => {
    const accountId = randomUUID();
    const getSession = vi.fn();
    const getStore = vi.fn();
    const lines: string[] = [];

    const handled = await handleCloudReplicaEngineControl(
      {
        type: "engine.cloudReplicaProofRequest",
        requestId: `crp_${Buffer.alloc(16, 9).toString("base64url")}`,
        accountUserId: accountId,
        deviceId: randomUUID(),
        keyVersion: 1,
        action: "replica.events.read",
        payload: { afterRevision: 0, limit: 100 },
      },
      (line) => lines.push(line),
      {
        capabilityEnabled: () => false,
        getSession,
        store: getStore,
      },
    );

    expect(handled).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "host.cloudReplicaProofResponse",
      proof: null,
      errorCode: "signed_out",
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
  });

  it("ignores delayed device registration without mutating safeStorage while disabled", async () => {
    const getSession = vi.fn();
    const getStore = vi.fn();
    const publicKey = Buffer.alloc(32, 4).toString("base64url");

    const handled = await handleCloudReplicaEngineControl(
      {
        type: "engine.cloudReplicaDeviceRegistered",
        accountUserId: randomUUID(),
        deviceId: randomUUID(),
        keyVersion: 1,
        publicKey,
        keyFingerprint: cloudDevicePublicKeyFingerprint(publicKey),
      },
      vi.fn(),
      {
        capabilityEnabled: () => false,
        getSession,
        store: getStore,
      },
    );

    expect(handled).toBe(true);
    expect(getSession).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
  });
});
