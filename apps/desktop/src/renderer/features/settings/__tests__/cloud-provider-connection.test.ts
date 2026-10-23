import { beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: request }));
import { saveCloudProviderCredential, clearCloudProviderConnections,
  cloudProviderCredentialsCache, readCloudOrganizationConnections } from "../cloud-provider-connection";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { request.mockReset(); });
describe("cloud provider connection routing", () => {
  const health = { version: 1, status: "expired", observedAt: "2026-10-15T11:00:00Z",
    selectedCredentialRevision: 7, credentialRevision: 7, materialVersion: 3,
    expiresAt: "2026-10-15T10:59:00Z", refresh: "reconnect_required" };
  const connection = { provider: "codex", revision: 12, credentialId: id, models: [], connected: false };

  it("retains the exact selected account health through the public metadata parser", async () => {
    request.mockImplementation(async (_path, schema) => schema.parse({ credentials: [], connections: [{ ...connection, health }] }));
    const result = await readCloudOrganizationConnections(id);
    expect(result.connections[0]).toEqual({ ...connection, health });
    expect(request).toHaveBeenCalledExactlyOnceWith(`/v1/organizations/${id}/agent-connections`, expect.anything());
  });

  it.each([{ ...health, status: "unknown" }, { ...health, version: 2 },
    { ...health, expiresAt: "2026-10-15T11:01:00Z" }, { ...health, providerDetail: "untrusted" }])(
    "rejects malformed health without treating it as a legacy ready connection", async invalid => {
      request.mockImplementation(async (_path, schema) => schema.parse({ credentials: [], connections: [{ ...connection, health: invalid }] }));
      await expect(readCloudOrganizationConnections(id)).rejects.toThrow();
    },
  );

  it("keeps an absent legacy health field absent without fabricating readiness or expiry", async () => {
    request.mockImplementation(async (_path, schema) => schema.parse({ credentials: [], connections: [connection] }));
    expect((await readCloudOrganizationConnections(id)).connections[0]).toEqual(connection);
  });
  it("forgets credential metadata at an account boundary", () => {
    cloudProviderCredentialsCache.setData("account-a", [{ id, kind: "claude-api-key", displayName: "Private connection", revision: 1, revoked: false }]);
    clearCloudProviderConnections();
    expect(cloudProviderCredentialsCache.getSnapshot("account-a").data).toBeUndefined();
  });
  it("saves a new credential through the authenticated cloud API with a stable operation identity", async () => {
    await saveCloudProviderCredential({ id, operationId: id, displayName: "Cloud test", agentId: "claude", token: "synthetic-test-token", setupToken: true });
    expect(request).toHaveBeenCalledWith(`/v1/cloud-agent-credentials/${id}`, expect.anything(), {
      method: "PUT", idempotencyKey: id, body: { operationId: id, expectedRevision: 0, displayName: "Cloud test",
        material: { kind: "claude-setup-token", accessToken: "synthetic-test-token" } },
    });
  });
  it("rejects unsupported credential kinds before sending material", () => {
    expect(() => saveCloudProviderCredential({ id, operationId: id, displayName: "test", agentId: "codex", token: "synthetic-test-token", setupToken: true })).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
