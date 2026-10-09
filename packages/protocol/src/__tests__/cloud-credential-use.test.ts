import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudAgentCredentialActualUseSchema } from "../cloud-events";
const scope = { version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 1,
  organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const run = { version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch, fundingOwnerUserId: scope.fundingOwnerUserId,
  fundingOwnerEpoch: 1, cacheRevision: 1, provider: "cursor", credentialId: randomUUID(), credentialRevision: 1,
  connectionRevision: 1, adoptionId: randomUUID(), materialVersion: 1, displayName: "Synthetic" };
const use = { version: 1, scope, credentialRun: run, conversationId: "chat", commandId: randomUUID(), turnId: "turn",
  executionId: "native", nativeStage: "native_write", firstUseSequence: 2, eventSequence: 2 };
describe("immutable actual cloud credential use", () => {
  it("retains exact original-run ownership and first-use ordering independently of arrival", () => {
    expect(CloudAgentCredentialActualUseSchema.parse(use)).toEqual(use);
    expect(CloudAgentCredentialActualUseSchema.parse({ ...use, eventSequence: 4 })).toMatchObject({ firstUseSequence: 2, eventSequence: 4 });
  });
  it.each([{ firstUseSequence: 3 }, { commandId: "foreign" }, { credentialRun: { ...run, writerEpoch: randomUUID() } },
    { credentialRun: { ...run, fundingOwnerEpoch: 2 } }, { nativeStage: "dispatch_committed" }, { material: "private" }])
    ("rejects contradictory or prelaunch use", fields => expect(CloudAgentCredentialActualUseSchema.safeParse({ ...use, ...fields }).success).toBe(false));
});
