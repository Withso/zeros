import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../cloud-accepted-work";
import * as server from "../../../../apps/control-plane/src/cloud-workspaces/accepted-work-contract";

const scope = { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const command = { commandId: randomUUID(), conversationId: "chat:one", turnId: "turn:one", executionId: "execution:one",
  payloadSha256: "a".repeat(64), provider: "codex", model: "gpt-6", cwd: "/srv/zeros/workspace" };
const runtimeId = `r1-${"b".repeat(64)}`, actorSessionId = randomUUID();
const request = { version: 1, scope, runtimeId, actorSessionId, command,
  capability: ["a".repeat(24), "b".repeat(24), "c".repeat(86)].join("."),
  proof: { timestampMs: 1_000, nonce: "a".repeat(22), signature: "b".repeat(86) }, route: "direct" };
const receipt = { version: 1, acceptedWorkId: randomUUID(), revision: 1, scope, runtimeId, actorSessionId,
  actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1, role: "owner", fingerprint: "c".repeat(64) },
  sourceSessionId: randomUUID(), kid: "cap-2026-10-example", capabilityId: "a".repeat(22), devicePublicKey: "b".repeat(43),
  epochs: { wa: 1, wr: 1, me: 1, ac: 1, dk: 1 }, scopes: ["ws:read", "ws:prompt", "ws:edit"], command,
  acceptedAtMs: 1_000, capabilityExpiresAtMs: 301_000, providerExpiresAtMs: 3_601_000, providerProofVersion: 1 };
const operation = { version: 1, acceptedWorkId: receipt.acceptedWorkId, scope, runtimeId, command, operation: "context" };

describe("accepted work stays a closed engine-only contract across deployments", () => {
  it.each([
    ["CloudAcceptedWorkCommandSchema", command, true],
    ["CloudAcceptedWorkCommandSchema", { ...command, cwd: "relative" }, false],
    ["CloudAcceptedWorkCommandSchema", { ...command, payloadSha256: "missing" }, false],
    ["CloudAcceptedWorkCommandSchema", { ...command, cwd: "/srv/\u0000workspace" }, false],
    ["CloudAcceptedWorkEnrollRequestSchema", request, true],
    ["CloudAcceptedWorkEnrollRequestSchema", { ...request, bearer: "extra" }, false],
    ["CloudAcceptedWorkEnrollRequestSchema", { ...request, scope: { ...scope, ownerId: randomUUID() } }, false],
    ["CloudAcceptedWorkEnrollRequestSchema", { ...request, proof: { ...request.proof, nonce: "short" } }, false],
    ["CloudAcceptedWorkReceiptSchema", receipt, true],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, capability: request.capability }, false],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, actor: { ...receipt.actor, role: "developer" } }, false],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, actor: { ...receipt.actor, userId: randomUUID() } }, false],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, epochs: { ...receipt.epochs, dk: 2 } }, false],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, capabilityExpiresAtMs: receipt.acceptedAtMs }, false],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, providerExpiresAtMs: receipt.acceptedAtMs }, false],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, providerProofVersion: 0 }, false],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, scopes: ["ws:prompt", "ws:prompt"] }, false],
    ["CloudAcceptedWorkReceiptSchema", { ...receipt, scopes: ["ws:read"] }, false],
    ["CloudAcceptedWorkOperationSchema", operation, true],
    ["CloudAcceptedWorkOperationSchema", { ...operation, operation: "native-git" }, true],
    ["CloudAcceptedWorkOperationSchema", { ...operation, operation: "generic-grant" }, false],
    ["CloudAcceptedWorkOperationSchema", { ...operation, credentialId: randomUUID() }, false],
  ] as const)("keeps %s strict and aligned (%#)", (name, input, valid) => {
    const client = wire[name].safeParse(input), backend = server[name].safeParse(input);
    expect(client.success).toBe(valid); expect(backend.success).toBe(valid);
    if (client.success && backend.success) expect(client.data).toEqual(backend.data);
  });
});
