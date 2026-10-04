import { describe, expect, it, vi } from "vitest";
import { verifySharingCases } from "../cloud-workspace-validation/verify-sharing-controls.mjs";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";
const otherUserId = "44444444-4444-4444-8444-444444444444";
const tokenEnv = "ZEROS_E5_ALPHA_OWNER_ACCESS_TOKEN";
const credentials = new Map([[tokenEnv, "fixture-session"]]);
const input = (actorRole: string | null, extra = {}) => [{ name: "role", tokenEnv, actorUserId, organizationId, workspaceId,
  expectedStatus: 200, actorRole, sharingMode: "organization", ...extra }];
const me = { user: { id: actorUserId, staffRole: "developer" }, organizations: [{ id: organizationId, role: "admin" }] };
const page = (extra = {}) => ({ workspaceId, organizationId, accessRevision: 2, writers: { limit: 10, used: 1, available: 9 },
  members: [{ userId: actorUserId }], guests: [], invitations: [], memberCursor: null, guestCursor: null, invitationCursor: null, ...extra });
const document = (role: string) => ({ id: workspaceId, organizationId, actorRole: role, sharingMode: "organization", accessRevision: 2,
  capabilities: { canWrite: role !== "viewer", canEdit: ["owner", "manager", "developer"].includes(role), canManage: ["owner", "manager"].includes(role) } });

describe("read-only Alpha sharing acceptance companion", () => {
  it.each(["owner", "manager", "developer", "prompter", "viewer"])("checks exact %s authority without issuing mutations", async role => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe("https://api-alpha.zeros.build");
      expect(init.method).toBe("GET"); expect(init.redirect).toBe("error"); expect(init.body).toBeUndefined();
      if (url.endsWith("/v1/me")) return Response.json(me);
      if (url.includes("/collaborators")) return ["owner", "manager"].includes(role) ? Response.json(page()) : Response.json({}, { status: 403 });
      return Response.json({ workspace: document(role) });
    });
    const result = await verifySharingCases(input(role, { organizationRole: "admin" }), credentials, { fetch });
    expect(result.pass).toBe(true); expect(result.createdResources).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("traverses each independent cursor without counting the repeated first pages", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/me")) return Response.json(me);
      if (!url.includes("/collaborators")) return Response.json({ workspace: document("owner") });
      return Response.json(new URL(url).searchParams.has("memberCursor") ? page({ members: [{ userId: otherUserId }] }) : page({ memberCursor: actorUserId }));
    });
    const result = await verifySharingCases(input("owner"), credentials, { fetch });
    expect(result.cases[0]).toMatchObject({ pass: true, pages: 2, counts: { members: 2, guests: 0, invitations: 0 } });
  });
  it("checks private or revoked access without creating any cleanup obligations", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/v1/me") ? Response.json(me) : Response.json({}, { status: 404 }));
    const result = await verifySharingCases(input("viewer", { expectedStatus: 404 }), credentials, { fetch });
    expect(result).toMatchObject({ pass: true, createdResources: 0 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("accepts owner data recovery without granting a live actor role or collaborator access", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/me")) return Response.json(me);
      if (url.includes("/collaborators")) return Response.json({}, { status: 404 });
      return Response.json({ workspace: { ...document("owner"), actorRole: null,
        capabilities: { canWrite: false, canEdit: false, canManage: false } } });
    });
    expect(await verifySharingCases(input(null), credentials, { fetch })).toMatchObject({ pass: true });
  });
  it("fails closed for an incorrect account or capability projection", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/v1/me") ? Response.json(me)
      : Response.json({ workspace: { ...document("prompter"), capabilities: { ...document("prompter").capabilities, canEdit: true } } }));
    const result = await verifySharingCases(input("prompter"), credentials, { fetch });
    expect(result.cases[0]).toMatchObject({ pass: false, check: "role_capabilities" });
    const wrongAccount = await verifySharingCases(input("owner", { actorUserId: otherUserId }), credentials, { fetch });
    expect(wrongAccount.cases[0]).toMatchObject({ pass: false, check: "staff_account_identity" });
  });
  it("keeps network errors and hostile response bodies out of diagnostics", async () => {
    const sensitive = "fixture-sensitive-response";
    const network = await verifySharingCases(input("owner"), credentials, { fetch: async () => { throw new Error(sensitive); } });
    const invalid = await verifySharingCases(input("owner"), credentials, { fetch: async () => Response.json({ sensitive }) });
    expect(JSON.stringify([network, invalid])).not.toContain(sensitive);
    expect(network.cases[0]).toMatchObject({ pass: false, check: "request_failed" });
  });
  it("rejects unbounded or unsafe configuration before using credentials", async () => {
    const fetch = vi.fn();
    const result = await verifySharingCases(input("owner", { name: "unsafe@example.test" }), credentials, { fetch });
    expect(result).toMatchObject({ pass: false, check: "case_configuration" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
