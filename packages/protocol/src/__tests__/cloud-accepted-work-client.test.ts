import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudAcceptedWorkClientProofSchema, cloudAcceptedWorkCommandBinding, cloudAcceptedWorkProofMessage } from "../cloud-accepted-work-client";
import { cloudAcceptedWorkProofMessage as serverMessage } from "../../../../apps/control-plane/src/cloud-workspaces/accepted-work-contract";

const scope = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 7, engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666", fundingOwnerEpoch: 2 };
const payload = { userMessageId: "turn:one", agentId: "claude", model: "claude-sonnet-4-6", modeRevision: 0,
  permissionMode: "default", prompt: [{ type: "text", text: "synthetic command" }] };
const mutation = { conversationId: "chat:one", operationId: "77777777-7777-4777-8777-777777777777", expectedRevision: 0,
  action: { kind: "enqueue", commandId: "88888888-8888-4888-8888-888888888888", payload } };
const proof = { timestampMs: 1792324800000, nonce: "a".repeat(22), signature: "b".repeat(86) };
const auth = { version: 1, capability: ["a".repeat(24), "b".repeat(24), "c".repeat(86)].join("."), proof, commandSignature: "c".repeat(86) };

describe("client proof for exact accepted work", () => {
  it("uses a separate signed domain while keeping the S1 proof unchanged", () => {
    expect(CloudAcceptedWorkClientProofSchema.parse(auth)).toEqual(auth);
    const fields = { aud: "zeros:engine" as const, wsp: scope.workspaceId, jti: "client-capability-1", scope,
      ...cloudAcceptedWorkCommandBinding(mutation), timestampMs: proof.timestampMs, nonce: proof.nonce, route: "direct" as const };
    const message = cloudAcceptedWorkProofMessage(fields);
    expect(serverMessage(fields)).toBe(message);
    expect(message).toBe(["zeros-accepted-work-v1", "zeros:engine", scope.workspaceId, fields.jti,
      JSON.stringify([scope.organizationId, scope.workspaceId, scope.generation, scope.engineInstanceId, scope.bootId,
        scope.writerEpoch, scope.fundingOwnerUserId, scope.fundingOwnerEpoch]), fields.commandId, fields.conversationId,
      fields.payloadSha256, String(proof.timestampMs), proof.nonce, "direct"].join("\n"));
    const keys = generateKeyPairSync("ed25519"), signature = sign(null, Buffer.from(message), keys.privateKey);
    expect(verify(null, Buffer.from(message), keys.publicKey, signature)).toBe(true);
    for (const change of [{ commandId: mutation.operationId }, { conversationId: "chat:two" }, { payloadSha256: "f".repeat(64) },
      { scope: { ...scope, fundingOwnerEpoch: 3 } }, { route: "relay" as const }, { jti: "client-capability-2" },
      { timestampMs: proof.timestampMs + 1 }, { nonce: "d".repeat(22) }])
      expect(verify(null, Buffer.from(cloudAcceptedWorkProofMessage({ ...fields, ...change })), keys.publicKey, signature)).toBe(false);
    expect(verify(null, Buffer.from(["zeros-capability-pop-v1", fields.aud, fields.wsp, fields.jti,
      String(proof.timestampMs), proof.nonce, fields.route].join("\n")), keys.publicKey, signature)).toBe(false);
  });

  it("hashes the parsed immutable payload independent of object key order", () => {
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
      value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
    expect(cloudAcceptedWorkCommandBinding(mutation)).toEqual({ commandId: mutation.action.commandId, conversationId: mutation.conversationId,
      payloadSha256: createHash("sha256").update(canonical(payload)).digest("hex") });
    expect(cloudAcceptedWorkCommandBinding({ ...mutation, action: { ...mutation.action, payload: Object.fromEntries(Object.entries(payload).reverse()) } }))
      .toEqual(cloudAcceptedWorkCommandBinding(mutation));
    expect(() => cloudAcceptedWorkCommandBinding({ ...mutation, action: { kind: "remove", commandId: mutation.action.commandId } })).toThrow();
    expect(() => cloudAcceptedWorkCommandBinding({ ...mutation, action: { ...mutation.action, payload: { ...payload, operation: { kind: "unknown" } } } })).toThrow();
  });

  it("rejects renderer-chosen authority fields and unbounded proof shapes", () => {
    for (const input of [{ ...auth, scope }, { ...auth, commandSignature: "short" }, { ...auth, proof: { ...proof, route: "direct" } },
      { ...auth, capability: "a".repeat(4097) }, { ...auth, version: 2 }]) expect(CloudAcceptedWorkClientProofSchema.safeParse(input).success).toBe(false);
  });
});
