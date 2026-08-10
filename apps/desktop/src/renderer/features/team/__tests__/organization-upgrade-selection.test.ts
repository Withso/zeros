import { beforeEach, describe, expect, it } from "vitest";
import type { Me, OrganizationSummary } from "../control-plane";

const storage = new Map<string, string>();
const stub: Storage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => void storage.set(key, value),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};
(globalThis as typeof globalThis & { localStorage: Storage }).localStorage =
  stub;

const { setSetting } = await import("../../../platform/settings");
const { getActiveTeamId, clearActiveOrganizationSelectionHint } =
  await import("../active-team");
const {
  acceptOrganizationSnapshot,
  clearTeamStore,
  getActiveOrganizationIdSnapshot,
} = await import("../team-store");
const { reconcileOrganizationWorkspaceOwnership } =
  await import("../organization-membership-history");
const { filterRowsForOrganization } =
  await import("../organization-capabilities");

function organization(id: string, isPersonal: boolean): OrganizationSummary {
  return {
    id,
    slug: id,
    name: isPersonal ? "Personal" : "Acme",
    logo: null,
    role: "owner",
    isPersonal,
    defaultTeamId: `${id}-team`,
    workspaceCapabilities: { local: true, cloud: !isPersonal },
    teamCapabilities: { multiple: false, canCreate: false },
  };
}

describe("first hierarchy-aware organization snapshot", () => {
  beforeEach(() => {
    storage.clear();
    clearActiveOrganizationSelectionHint();
    clearTeamStore();
  });

  it("normalizes a flat-Team selection to Personal so legacy local rows stay visible", () => {
    const personal = organization("personal_1", true);
    const collaborative = organization("legacy_team_1", false);
    const me: Me = {
      user: {
        id: "user_1",
        email: "user@example.test",
        displayName: "User",
        staffRole: null,
      },
      organizations: [personal, collaborative],
      teams: [personal, collaborative],
    };
    setSetting("team:active-id", collaborative.id);

    expect(acceptOrganizationSnapshot(me)).toBe(true);
    expect(getActiveTeamId()).toBe(personal.id);
    expect(
      filterRowsForOrganization(
        [{ id: "legacy", organizationId: null }],
        personal,
      ),
    ).toHaveLength(1);
  });

  it("does not repeat the one-time normalization before ownership repair can run", () => {
    const personal = organization("personal_1", true);
    const collaborative = organization("legacy_team_1", false);
    const me: Me = {
      user: {
        id: "user_1",
        email: "user@example.test",
        displayName: "User",
        staffRole: null,
      },
      organizations: [personal, collaborative],
      teams: [personal, collaborative],
    };
    setSetting("team:active-id", collaborative.id);

    acceptOrganizationSnapshot(me);
    expect(getActiveTeamId()).toBe(personal.id);

    setSetting("team:active-id", collaborative.id);
    acceptOrganizationSnapshot(me);

    expect(getActiveTeamId()).toBe(collaborative.id);
  });

  it("retains a confirmed owner for creates during a later cold refresh", async () => {
    const personal = organization("personal_1", true);
    const collaborative = organization("org_1", false);
    const me: Me = {
      user: {
        id: "user_1",
        email: "user@example.test",
        displayName: "User",
        staffRole: null,
      },
      organizations: [personal, collaborative],
      teams: [personal, collaborative],
    };
    await reconcileOrganizationWorkspaceOwnership(me);
    setSetting("team:active-id", collaborative.id);
    clearTeamStore();

    expect(getActiveOrganizationIdSnapshot()).toBe(collaborative.id);
  });

  it("does not replace confirmed ownership history with an empty rollout snapshot", async () => {
    const personal = organization("personal_1", true);
    const collaborative = organization("org_1", false);
    const me: Me = {
      user: {
        id: "user_1",
        email: "user@example.test",
        displayName: "User",
        staffRole: null,
      },
      organizations: [personal, collaborative],
      teams: [personal, collaborative],
    };
    await reconcileOrganizationWorkspaceOwnership(me);
    setSetting("team:active-id", collaborative.id);

    const empty: Me = { ...me, organizations: [], teams: [] };
    acceptOrganizationSnapshot(empty);
    await reconcileOrganizationWorkspaceOwnership(empty);

    expect(getActiveOrganizationIdSnapshot()).toBe(collaborative.id);
  });
});
