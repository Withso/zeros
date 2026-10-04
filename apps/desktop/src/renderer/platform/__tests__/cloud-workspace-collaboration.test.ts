import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../cloud-workspaces", async importOriginal => ({
  ...await importOriginal<typeof import("../cloud-workspaces")>(), cloudAccountRequest: api.request,
}));
import {
  CloudWorkspaceCollaboratorsPageSchema, inviteCloudWorkspaceCollaborator, listCloudWorkspaceCollaborators,
  revokeCloudWorkspaceCollaborator, revokeCloudWorkspaceInvitation, setCloudWorkspaceCollaboratorRole, setCloudWorkspaceSharing,
} from "../cloud-workspace-collaboration";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const userId = "33333333-3333-4333-8333-333333333333";
const page = { ...target, accessRevision: 2, writers: { limit: 10, used: 1, available: 9 }, guests: [], invitations: [], members: [],
  guestCursor: null, invitationCursor: null, memberCursor: null };
beforeEach(() => api.request.mockReset());

describe("cloud collaborator API boundary", () => {
  it("validates page bounds and refuses a response for another organization", async () => {
    api.request.mockResolvedValue(page);
    await expect(listCloudWorkspaceCollaborators(target, { pageSize: 50, memberCursor: userId })).resolves.toEqual(page);
    expect(api.request.mock.calls[0][0]).toContain(`pageSize=50&memberCursor=${userId}`);
    await expect(listCloudWorkspaceCollaborators(target, { pageSize: 101 })).rejects.toThrow();
    expect(api.request).toHaveBeenCalledTimes(1);
    api.request.mockResolvedValue({ ...page, organizationId: userId });
    await expect(listCloudWorkspaceCollaborators(target)).rejects.toThrow("changed identity");
  });
  it("carries the exact sharing CAS revision and restricts role changes to the existing API", () => {
    setCloudWorkspaceSharing(target, "private", 7);
    expect(api.request.mock.calls[0][2]).toMatchObject({ method: "PATCH", body: { sharingMode: "private", expectedRevision: 7 } });
    setCloudWorkspaceCollaboratorRole(target, userId, "viewer");
    expect(api.request.mock.calls[1][2]).toMatchObject({ method: "PATCH", body: { role: "viewer" } });
    expect(() => setCloudWorkspaceCollaboratorRole(target, userId, "manager" as "developer")).toThrow();
    expect(() => setCloudWorkspaceSharing(target, "private", 0)).toThrow();
    expect(api.request).toHaveBeenCalledTimes(2);
  });
  it("preserves invitation request identity and uses the bounded revoke routes", () => {
    inviteCloudWorkspaceCollaborator(target, "fixture@example.test", "prompter", "invitation-fixture");
    expect(api.request.mock.calls[0][2]).toMatchObject({ idempotencyKey: "invitation-fixture", body: { role: "prompter" } });
    revokeCloudWorkspaceCollaborator(target, userId);
    revokeCloudWorkspaceInvitation(target, userId);
    expect(api.request.mock.calls.slice(1).map(call => [call[0], call[2].method])).toEqual([
      [`/v1/cloud-workspaces/${target.workspaceId}/collaborators/${userId}`, "DELETE"],
      [`/v1/cloud-workspaces/${target.workspaceId}/invitations/${userId}`, "DELETE"],
    ]);
  });
  it("rejects oversized pages and unknown role/delivery values at the response boundary", () => {
    expect(CloudWorkspaceCollaboratorsPageSchema.safeParse({ ...page, members: [{ userId, role: "admin" }] }).success).toBe(false);
    expect(CloudWorkspaceCollaboratorsPageSchema.safeParse({ ...page, members: Array.from({ length: 101 }, () => ({ userId, role: "viewer" })) }).success).toBe(false);
  });
});
