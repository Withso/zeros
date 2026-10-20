import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../cloud-execution-authority";
import * as server from "../../../../apps/control-plane/src/cloud-workspaces/execution-authority-contract";
import { cloudGithubNativeSourceSchema as nativeWire } from "../github-auth";
import { cloudGithubNativeSourceSchema as nativeServer } from "../../../../apps/control-plane/src/cloud-workspaces/github-native-schema";

const scope = { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const command = { commandId: randomUUID(), conversationId: "chat:one", turnId: "turn:one", executionId: "execution:one",
  payloadSha256: "a".repeat(64), provider: "codex", model: "gpt-6", cwd: "/srv/zeros/workspace" };
const request = { version: 1, scope, runtimeId: `r1-${"b".repeat(64)}`, actorSessionId: randomUUID(),
  contextId: randomUUID(), contextRevision: "c".repeat(64), claimId: randomUUID(), command };
const receipt = { ...request, mode: "boot-execution-v1", acceptedWorkId: randomUUID(), revision: 1,
  actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1, role: "owner", fingerprint: "d".repeat(64) },
  fundingGrant: { kind: "owner" }, sourceSessionId: randomUUID(), epochs: { wa: 1, wr: 1, me: 1, ac: 1, dk: 1 },
  credentialId: randomUUID(), credentialRevision: 1, acceptedAtMs: 1000, admissionExpiresAtMs: 2000,
  providerExpiresAtMs: 3_601_000, providerProofVersion: 1 };
const operation = { version: 1, scope, acceptedWorkId: receipt.acceptedWorkId, commandId: command.commandId,
  claimId: request.claimId, executionId: command.executionId };
const native = { kind: "boot-execution", contextId: request.contextId, acceptedWorkId: receipt.acceptedWorkId,
  commandId: command.commandId, claimId: request.claimId, executionId: command.executionId };

describe("execution authority contract parity", () => {
  it.each([
    ["CloudExecutionEnrollRequestSchema", request, true],
    ["CloudExecutionEnrollRequestSchema", { ...request, bearer: "extra" }, false],
    ["CloudExecutionEnrollRequestSchema", { ...request, claimId: undefined }, false],
    ["CloudExecutionEnrollRequestSchema", { ...request, contextRevision: "short" }, false],
    ["CloudExecutionEnrollRequestSchema", { ...request, scope: { ...scope, userId: randomUUID() } }, false],
    ["CloudExecutionEnrollRequestSchema", { ...request, command: { ...command, cwd: "relative" } }, false],
    ["CloudExecutionAuthorityReceiptSchema", receipt, true],
    ["CloudExecutionAuthorityReceiptSchema", { ...receipt, mode: "boot-owner-v1" }, false],
    ["CloudExecutionAuthorityReceiptSchema", { ...receipt, capability: "extra" }, false],
    ["CloudExecutionAuthorityReceiptSchema", { ...receipt, actor: { ...receipt.actor, role: "viewer" } }, false],
    ["CloudExecutionAuthorityReceiptSchema", { ...receipt, actor: { ...receipt.actor, userId: randomUUID() } }, false],
    ["CloudExecutionAuthorityReceiptSchema", { ...receipt, epochs: { ...receipt.epochs, dk: 2 } }, false],
    ["CloudExecutionAuthorityReceiptSchema", { ...receipt, providerExpiresAtMs: receipt.acceptedAtMs }, false],
    ["CloudExecutionAuthorityReceiptSchema", { ...receipt, admissionExpiresAtMs: receipt.acceptedAtMs }, false],
    ["CloudExecutionAuthorityReceiptSchema", { ...receipt, providerProofVersion: 0 }, false],
    ["CloudExecutionAuthorityOperationSchema", operation, true],
    ["CloudExecutionAuthorityOperationSchema", { ...operation, claimId: undefined }, false],
    ["CloudExecutionAuthorityOperationSchema", { ...operation, actorSessionId: request.actorSessionId }, false],
    ["CloudExecutionAuthorityCheckSchema", { version: 1, acceptedWorkId: receipt.acceptedWorkId, state: "current" }, true],
    ["CloudExecutionAuthorityCheckSchema", { version: 1, acceptedWorkId: receipt.acceptedWorkId, state: "revoked" }, true],
    ["CloudExecutionAuthorityCheckSchema", { version: 1, acceptedWorkId: receipt.acceptedWorkId, state: "unavailable" }, false],
  ] as const)("keeps %s closed and aligned (%#)", (name, value, valid) => {
    const client = wire[name].safeParse(value), backend = server[name].safeParse(value);
    expect(client.success).toBe(valid); expect(backend.success).toBe(valid);
    if (client.success && backend.success) expect(client.data).toEqual(backend.data);
  });
  it.each(["share", "general-access"])("keeps non-owner %s grant UUID and role validation aligned", kind => {
    for (const grantId of [randomUUID(), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "11111111-1111-9111-8111-111111111111", "11111111-1111-4111-1111-111111111111", "foreign"]) {
      const value = { ...receipt, actor: { ...receipt.actor, userId: randomUUID(), role: "prompter" },
        fundingGrant: { kind, grantId, grantRevision: 1 } };
      const client = wire.CloudExecutionAuthorityReceiptSchema.safeParse(value), backend = server.CloudExecutionAuthorityReceiptSchema.safeParse(value);
      expect(backend.success, grantId).toBe(client.success);
      if (client.success && backend.success) expect(client.data).toEqual(backend.data);
    }
  });
  it("requires every exact execution key at the native Git edge on both deployments", () => {
    for (const value of [native, ...Object.keys(native).map(key => ({ ...native, [key]: undefined })),
      { ...native, actorUserId: randomUUID() }, { ...native, executionId: "foreign/../execution" },
      { ...native, acceptedWorkId: "11111111-1111-9111-8111-111111111111" }]) {
      const client = nativeWire.safeParse(value), backend = nativeServer.safeParse(value);
      expect(client.success).toBe(value === native); expect(backend.success).toBe(client.success);
    }
  });
});
