import { describe, it, expect, vi } from "vitest";
import { fixtureIssues, bindFixture, seedHostedFixture, verifyFixtureMembership, bootstrapFixtureOrganization } from "../dev-environment/hosted-fixtures.mjs";
import { validateStaffRoleRequest } from "../../apps/control-plane/src/manage-staff";
import { validateCloudWorkspaceQuotaRequest } from "../../apps/control-plane/src/manage-cloud-workspace-quota";

const fixture = { workosUserId: "user_test", workosOrganizationId: "org_test", expectedEmail: "dev@example.test",
  expectedOrganizationSlug: "test-org", computeAllowance: "pro-monthly" };
const userId = "11111111-1111-4111-8111-111111111111", orgId = "22222222-2222-4222-8222-222222222222";
function setup(rows: any[] = []) {
  const state: any = { owner: "a".repeat(24), generation: "33333333-3333-4333-8333-333333333333" };
  const manage = vi.fn(async (pool, request) => ({ state: request.execute ? "changed" : "planned", approval: "bound-plan" }));
  const credit = vi.fn(async () => ({ state: "ready", periodId: "period" }));
  const allowance = vi.fn(function () { return { ensure: credit }; });
  const modules: any = {
    "manage-staff.js": { validateStaffRoleRequest, manageStaffRole: manage },
    "manage-cloud-workspace-quota.js": { validateCloudWorkspaceQuotaRequest, manageCloudWorkspaceQuota: manage },
    "cloud-workspaces/pro-allowance.js": { DatabaseProMonthlyAllowance: allowance },
  };
  const query = vi.fn(async () => ({ rows }));
  const f = { runtime: {}, migration: {}, withSystemTx: vi.fn(async (pool, fn) => fn({ query })), module: vi.fn(async name => modules[name]),
    request: { ...state, fixture: bindFixture(state, fixture), roles: { runtime: { url: "postgresql://runtime@localhost/postgres" },
      migration: { url: "postgresql://owner@localhost/postgres" } }, worker: { storageMiB: 20480 }, boat: { secondsPerDollar: 100_000 } } };
  return { ...f, manage, credit, allowance, query, state };
}
describe("explicit hosted Dev fixture", () => {
  it("imports only a verified Dev organization after the selected account signs in", async () => {
    const selected = { ...fixture, bootstrapOrganization: true };
    const proof = await verifyFixtureMembership(selected, async route => route.startsWith("/organizations/")
      ? { id: fixture.workosOrganizationId, name: "Dev Test", external_id: orgId, metadata: { purpose: "zeros-development" } }
      : route.startsWith("/user_management/users/")
        ? { id: fixture.workosUserId, email: fixture.expectedEmail, email_verified: true }
        : { data: [{ id: "om_test", organization_id: fixture.workosOrganizationId, user_id: fixture.workosUserId, status: "active", role: { slug: "owner" }, updated_at: new Date().toISOString() }], list_metadata: {} });
    let signedIn = false;
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM user_identities")
      ? signedIn ? [{ user_id: userId, email: fixture.expectedEmail }] : []
      : sql.includes("RETURNING id") ? [{ id: orgId }] : [] }));
    const args = { fixture: selected, proof, runtime: {}, withSystemTx: async (_pool, fn) => fn({ query }) };
    expect(await bootstrapFixtureOrganization(args)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
    signedIn = true;
    expect(await bootstrapFixtureOrganization(args)).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO workos_organization_links"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO workos_membership_projections"))).toBe(true);
  });
  it("refuses unverified, inactive, or unrelated provider membership before importing authority", async () => {
    const selected = { ...fixture, bootstrapOrganization: true };
    await expect(verifyFixtureMembership(selected, async () => ({ data: [] }))).rejects.toThrow(/verify/);
    const query = vi.fn();
    await expect(bootstrapFixtureOrganization({ fixture: selected, proof: { verifiedAt: 0 }, runtime: {},
      withSystemTx: async (_pool, fn) => fn({ query }) })).rejects.toThrow(/proof/);
    expect(query).not.toHaveBeenCalled();
  });
  it("requires explicit Pro allowance selection and binds it to the generation", () => {
    const state = setup().state;
    expect(fixtureIssues(fixture)).toEqual([]);
    expect(fixtureIssues({ ...fixture, computeCreditMicroUsd: 1_000_000 })).not.toEqual([]);
    expect(bindFixture(state, fixture)).toEqual(bindFixture(state, fixture));
    expect(() => bindFixture(state, { ...fixture, expectedOrganizationSlug: "different" })).toThrow(/archive/);
  });
  it("uses one clock reading so the credit period never exceeds its seven-day limit", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    try {
      const value = bindFixture({}, fixture);
      expect(Date.parse(value.endsAt) - Date.parse(value.startsAt)).toBe(7 * 86400_000);
    } finally { clock.mockRestore(); }
  });
  it("does not fabricate identity, membership or paid authority before normal sign-in", async () => {
    const f = setup(); expect(await seedHostedFixture(f)).toEqual({ seeded: false, needsSignIn: true });
    expect(f.module).not.toHaveBeenCalled(); expect(f.manage).not.toHaveBeenCalled();
    expect(f.query.mock.calls[0][1]).toEqual([fixture.workosUserId, fixture.workosOrganizationId]);
    expect(f.query.mock.calls[0][0]).toContain("o.is_personal=false");
  });
  it("refuses identity mismatch before promoting staff or granting credits", async () => {
    const f = setup([{ user_id: userId, organization_id: orgId, email: "different@example.test", slug: "test-org" }]);
    await expect(seedHostedFixture(f)).rejects.toThrow(/differs/); expect(f.manage).not.toHaveBeenCalled();
  });
  it("uses the release Pro allowance policy instead of conflicting organization funding", async () => {
    const f = setup([{ user_id: userId, organization_id: orgId, email: fixture.expectedEmail, slug: fixture.expectedOrganizationSlug }]);
    expect(await seedHostedFixture(f)).toEqual({ seeded: true });
    expect(f.manage).toHaveBeenCalledTimes(4);
    expect(f.manage.mock.calls.every(([pool, input]) => pool === f.migration && input.channel === "development")).toBe(true);
    expect(f.allowance).toHaveBeenCalledWith(f.runtime, { policyId: "hosted-dev", secondsPerDollar: 100_000 });
    expect(f.credit).toHaveBeenCalledWith(userId);
    await seedHostedFixture(f);
    expect(f.credit.mock.calls[0]).toEqual(f.credit.mock.calls[1]);
  });
  it("keeps legacy profiles readable for cleanup but requires explicit migration before seeding", async () => {
    const f = setup([{ user_id: userId, organization_id: orgId, email: fixture.expectedEmail, slug: fixture.expectedOrganizationSlug }]);
    const { computeAllowance: _allowance, ...identity } = fixture;
    const legacy = { ...identity, computeCreditMicroUsd: 1_000_000 };
    expect(fixtureIssues(legacy)).toEqual([]);
    f.request.fixture = bindFixture({}, legacy);
    await expect(seedHostedFixture(f)).rejects.toThrow(/organization.*credit.*Pro.*archive/i);
    expect(f.manage).not.toHaveBeenCalled();
    expect(f.credit).not.toHaveBeenCalled();
  });
  it("reports allowance conflicts without claiming a successful seed", async () => {
    const f = setup([{ user_id: userId, organization_id: orgId, email: fixture.expectedEmail, slug: fixture.expectedOrganizationSlug }]);
    f.credit.mockResolvedValue({ state: "legacy_conflict" } as any);
    await expect(seedHostedFixture(f)).rejects.toThrow(/legacy_conflict/);
  });
});
