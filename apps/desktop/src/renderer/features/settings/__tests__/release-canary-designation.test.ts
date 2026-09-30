import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn<(path: string, schema: unknown, options?: unknown) => Promise<unknown>>(async () => ({ designationId: "42", enabled: true })));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: request }));
import { releaseCanaryDesignationKey, readReleaseCanaryDesignationKey, changeReleaseCanaryDesignation, releaseCanaryDesignationsCache,
  releaseCanaryDefaultModels } from "../release-canary-designation";
import { clearCloudProviderConnections } from "../cloud-provider-connection";
import { RELEASE_CANARY_MODELS } from "../../../../../../control-plane/src/cloud-workspaces/release-canary-contract";

const user = "11111111-1111-4111-8111-111111111111", organization = "22222222-2222-4222-8222-222222222222",
  credential = "33333333-3333-4333-8333-333333333333", operation = "44444444-4444-4444-8444-444444444444";
beforeEach(() => { request.mockReset(); releaseCanaryDesignationsCache.clear(); });
describe("release check designation boundary", () => {
  it("keeps account, organization, credential and revision reads keyed independently", async () => {
    const key = releaseCanaryDesignationKey(user, organization, credential, 1);
    for (const changed of [releaseCanaryDesignationKey(organization, organization, credential, 1),
      releaseCanaryDesignationKey(user, user, credential, 1), releaseCanaryDesignationKey(user, organization, user, 1),
      releaseCanaryDesignationKey(user, organization, credential, 2)]) expect(changed).not.toBe(key);
    await readReleaseCanaryDesignationKey(key);
    expect(request).toHaveBeenCalledWith(`/v1/cloud-agent-credentials/${credential}/release-canary`, expect.anything());
    expect(() => releaseCanaryDesignationKey(user, organization, credential, 0)).toThrow();
    await expect(readReleaseCanaryDesignationKey("another-scope")).rejects.toThrow();
  });
  it("uses the exact revision/model approval and original operation for idempotent revoke", async () => {
    const body = { operationId: operation, expectedDesignationId: "41", credentialRevision: 2, enabled: false, models: ["gpt-5.6-luna"] };
    await changeReleaseCanaryDesignation(credential, body); await changeReleaseCanaryDesignation(credential, body);
    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls) expect(call).toEqual([`/v1/cloud-agent-credentials/${credential}/release-canary`, expect.anything(),
      { method: "PUT", body, idempotencyKey: operation }]);
    expect(request.mock.calls[0]![2]).not.toHaveProperty("ownerUserId");
  });
  it("rejects authority/material fields and empty model approval before dispatch", () => {
    const body = { operationId: operation, expectedDesignationId: "0", credentialRevision: 1, enabled: true, models: ["claude-haiku-4-5"] };
    for (const changed of [{ models: [] }, { credentialRevision: 0 }, { expectedDesignationId: "-1" }, { ownerUserId: user }, { material: "synthetic-never-accepted" }])
      expect(() => changeReleaseCanaryDesignation(credential, { ...body, ...changed } as any)).toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(releaseCanaryDefaultModels).toEqual(RELEASE_CANARY_MODELS);
  });
  it("forgets confirmed and pending consent at sign-out instead of leaking an owner's switch", async () => {
    const key = releaseCanaryDesignationKey(user, organization, credential, 1);
    releaseCanaryDesignationsCache.setData(key, { designationId: "42", credentialRevision: 1, enabled: true, models: ["claude-haiku-4-5"], lastUsedAt: null });
    let complete!: (value: any) => void;
    const pending = releaseCanaryDesignationsCache.load(key, () => new Promise(resolve => { complete = resolve; }), { force: true });
    await Promise.resolve(); clearCloudProviderConnections();
    complete({ designationId: "43", credentialRevision: 1, enabled: true, models: ["claude-haiku-4-5"], lastUsedAt: null });
    await pending; expect(releaseCanaryDesignationsCache.getSnapshot(key).data).toBeUndefined();
  });
});
