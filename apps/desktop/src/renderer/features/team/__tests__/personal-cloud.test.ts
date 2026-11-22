import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, OrganizationSummary } from "../control-plane";

const flags = vi.hoisted(() => ({ unified: true, cloud: true }));
vi.mock("../../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: (feature: string) =>
    feature === "unified-workspaces" ? flags.unified : feature === "cloud-workspaces" ? flags.cloud : true,
}));

import { normalizeOrganizationSummary, personalCloudOffer, type OrganizationSummaryWire } from "../organization-summary";
import { cloudOrganizationFor as resolve, isPersonalCloudOrganization, personalCloudOrganization, personalEntryWithCloud } from "../personal-cloud";

const cloudOrganizationFor = (selected: OrganizationSummary | null, account: Me | null) =>
  resolve(selected?.isPersonal ? personalEntryWithCloud(selected, account) : selected);
import { PERSONAL_ORGANIZATION } from "../personal-organization";

const PERSONAL = "33333333-3333-4333-8333-333333333333", OTHER = "44444444-4444-4444-8444-444444444444";
// The Personal row a control plane with the switch on sends.
const row = (seat: "pro" | "free" | undefined, cloud = true, id = PERSONAL): OrganizationSummaryWire => ({ id, slug: `personal-${id.slice(0, 4)}`, name: "Ada",
  logo: null, role: "owner", isPersonal: true, defaultTeamId: null, workspaceCapabilities: { local: true, cloud },
  teamCapabilities: { multiple: false, canCreate: false }, ...(seat ? { seat } : {}) });
const me = (rows: OrganizationSummaryWire[], user = "user-1"): Me => {
  const organizations = rows.map(normalizeOrganizationSummary), personalCloud = personalCloudOffer(rows);
  return { user: { id: user, email: `${user}@example.test`, displayName: null, staffRole: null }, organizations, teams: organizations,
    ...(personalCloud ? { personalCloud } : {}) };
};

beforeEach(() => { flags.unified = true; flags.cloud = true; });

describe("the Personal row that now offers cloud", () => {
  it("parses through the released path exactly as before: local only, no seat", () => {
    for (const seat of ["pro", "free", undefined] as const)
      expect(normalizeOrganizationSummary(row(seat))).toEqual(normalizeOrganizationSummary(row(undefined, false)));
    expect(normalizeOrganizationSummary(row("pro"))).toMatchObject({ isPersonal: true, workspaceCapabilities: { local: true, cloud: false } });
    expect(normalizeOrganizationSummary(row("pro"))).not.toHaveProperty("seat");
  });

  it("is read beside it as an offer, only when the row says cloud", () => {
    expect(personalCloudOffer([row("pro")])).toEqual({ organizationId: PERSONAL, slug: `personal-${PERSONAL.slice(0, 4)}`, seat: "pro" });
    expect(personalCloudOffer([row(undefined)])?.seat).toBe("free");
    expect(personalCloudOffer([row("pro", false)])).toBeNull();
    expect(personalCloudOffer([])).toBeNull();
  });
});

describe("cloudOrganizationFor", () => {
  const organization = { ...normalizeOrganizationSummary({ id: OTHER, slug: "acme", name: "Acme", role: "member", isPersonal: false,
    workspaceCapabilities: { local: false, cloud: true } }) } as OrganizationSummary;

  it("resolves the Personal entry to the account's server Personal organization when every gate holds", () => {
    const account = me([row("pro")]);
    expect(cloudOrganizationFor(PERSONAL_ORGANIZATION, account)).toMatchObject({ id: PERSONAL, isPersonal: true, role: "owner",
      workspaceCapabilities: { local: true, cloud: true }, seat: "pro" });
    expect(cloudOrganizationFor(PERSONAL_ORGANIZATION, me([row("free")]))?.seat).toBe("free");
    expect(isPersonalCloudOrganization(PERSONAL.toUpperCase(), account)).toBe(true);
    expect(isPersonalCloudOrganization(OTHER, account)).toBe(false);
  });

  it("returns the same objects for the same account snapshot", () => {
    const account = me([row("pro")]);
    expect(personalCloudOrganization(account)).toBe(personalCloudOrganization(account));
    expect(personalEntryWithCloud(PERSONAL_ORGANIZATION, account)).toBe(personalEntryWithCloud(PERSONAL_ORGANIZATION, account));
    expect(personalEntryWithCloud(PERSONAL_ORGANIZATION, null)).toBe(PERSONAL_ORGANIZATION);
  });

  it("leaves an organization as it is and never changes the device's Personal entry", () => {
    expect(cloudOrganizationFor(organization, me([row("pro")]))).toBe(organization);
    expect(PERSONAL_ORGANIZATION).toMatchObject({ id: "local-personal", workspaceCapabilities: { local: true, cloud: false } });
    expect(cloudOrganizationFor(null, me([row("pro")]))).toBeNull();
  });

  it.each([
    ["unified-workspaces is off", () => { flags.unified = false; }, me([row("pro")])],
    ["cloud workspaces are off in this build", () => { flags.cloud = false; }, me([row("pro")])],
    ["the server's Personal row does not offer cloud", () => {}, me([row("pro", false)])],
    ["nobody is signed in", () => {}, null],
    ["the snapshot has no user", () => {}, { ...me([row("pro")]), user: { id: "", email: "", displayName: null, staffRole: null } }],
  ] as const)("keeps Personal local-only when %s", (_name, set, account) => {
    set();
    expect(cloudOrganizationFor(PERSONAL_ORGANIZATION, account)).toBeNull();
    expect(personalCloudOrganization(account)).toBeNull();
  });

  it("follows the signed-in account only: another account's Personal cloud never resolves", () => {
    const first = me([row("pro")], "user-1"), second = me([row("pro", true, OTHER)], "user-2"), signedOutOfCloud = me([row(undefined, false)], "user-3");
    expect(cloudOrganizationFor(PERSONAL_ORGANIZATION, first)?.id).toBe(PERSONAL);
    expect(cloudOrganizationFor(PERSONAL_ORGANIZATION, second)?.id).toBe(OTHER);
    expect(isPersonalCloudOrganization(PERSONAL, second)).toBe(false);
    expect(cloudOrganizationFor(PERSONAL_ORGANIZATION, signedOutOfCloud)).toBeNull();
  });
});
