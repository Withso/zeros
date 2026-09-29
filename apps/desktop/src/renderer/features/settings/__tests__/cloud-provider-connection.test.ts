import { beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: request }));
import { authorizeCloudProvider, disconnectCloudProvider, saveCloudProviderCredential, clearCloudProviderConnections,
  cloudProviderAccessCache, cloudProviderCredentialsCache } from "../cloud-provider-connection";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => request.mockReset());
describe("cloud provider connection routing", () => {
  it("forgets credential metadata and pending access reads at an account boundary", async () => {
    cloudProviderCredentialsCache.setData("account-a", [{ id, kind: "claude-api-key", displayName: "Private connection", revision: 1, revoked: false }]);
    let resolve!: (value: { compute: { fingerprint: string; trust: "zeros-managed" }; delegations: [] }) => void;
    const pending = cloudProviderAccessCache.load("account-a/workspace", () => new Promise(done => { resolve = done; }));
    await Promise.resolve();
    clearCloudProviderConnections();
    resolve({ compute: { fingerprint: "a".repeat(64), trust: "zeros-managed" }, delegations: [] });
    await pending;
    expect(cloudProviderCredentialsCache.getSnapshot("account-a").data).toBeUndefined();
    expect(cloudProviderAccessCache.getSnapshot("account-a/workspace").data).toBeUndefined();
  });
  it("saves a new credential through the authenticated cloud API with a stable operation identity", async () => {
    await saveCloudProviderCredential({ id, operationId: id, displayName: "Cloud test", agentId: "claude", token: "synthetic-test-token", setupToken: true });
    expect(request).toHaveBeenCalledWith(`/v1/cloud-agent-credentials/${id}`, expect.anything(), {
      method: "PUT", idempotencyKey: id, body: { operationId: id, expectedRevision: 0, displayName: "Cloud test",
        material: { kind: "claude-setup-token", accessToken: "synthetic-test-token" } },
    });
  });
  it("binds explicit authorization to the selected workspace, user, models and compute", async () => {
    const input = { id, credentialId: id, expectedRevision: 1, workspaceId: id, granteeUserId: id, models: ["test-model"],
      expiresAt: "2026-09-28T00:00:00Z", computeConsent: { fingerprint: "a".repeat(64), trust: "zeros-managed" as const } };
    await authorizeCloudProvider(input);
    expect(request).toHaveBeenCalledWith("/v1/cloud-agent-credentials/delegations", expect.anything(), { body: input, idempotencyKey: id });
  });
  it("disconnects only the selected workspace grant", async () => {
    await disconnectCloudProvider(id);
    expect(request).toHaveBeenCalledWith(`/v1/cloud-agent-credentials/delegations/${id}`, expect.anything(), expect.objectContaining({ method: "DELETE" }));
  });
  it("rejects unsupported credential kinds before sending material", () => {
    expect(() => saveCloudProviderCredential({ id, operationId: id, displayName: "test", agentId: "codex", token: "synthetic-test-token", setupToken: true })).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
