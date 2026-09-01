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
  getActiveOrganizationSnapshot,
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

  it("has the existing Personal selection before an account or network response exists", () => {
    expect(getActiveOrganizationSnapshot()).toMatchObject({
      id: "local-personal",
      name: "Personal",
      isPersonal: true,
      workspaceCapabilities: { local: true, cloud: false },
    });
    expect(getActiveOrganizationIdSnapshot()).toBeNull();
  });

  it("keeps one Personal identity and old local rows across account changes", () => {
    const account = (id: string): Me => ({
      user: {
        id,
        email: `${id}@example.test`,
        displayName: id,
        staffRole: null,
      },
      organizations: [
        organization(`personal_${id}`, true),
        organization(`org_${id}`, false),
      ],
      teams: [],
    });
    acceptOrganizationSnapshot(account("a"));
    const personal = getActiveOrganizationSnapshot();
    clearTeamStore({ resetSelection: true });
    expect(getActiveOrganizationSnapshot()).toBe(personal);
    acceptOrganizationSnapshot(account("b"));
    expect(getActiveOrganizationSnapshot()?.id).toBe(personal?.id);
    // Workspace lists memoize by the active scope. Learning B's old Personal
    // ID must invalidate that memo even before engine migration can run.
    expect(getActiveOrganizationSnapshot()).not.toBe(personal);
    expect(getActiveOrganizationIdSnapshot()).toBeNull();
    expect(
      filterRowsForOrganization(
        [
          { id: "legacy", organizationId: null },
          { id: "a-local", organizationId: "personal_a" },
          { id: "b-local", organizationId: "personal_b" },
          { id: "a-org", organizationId: "org_a" },
        ],
        getActiveOrganizationSnapshot(),
      ).map((row) => row.id),
    ).toEqual(["legacy", "a-local", "b-local"]);
  });

  it("retains the Personal scope reference when only account profile data changes", () => {
    const personal = organization("personal_a", true);
    const me: Me = {
      user: {
        id: "a",
        email: "a@example.test",
        displayName: "A",
        staffRole: null,
      },
      organizations: [personal],
      teams: [personal],
    };
    acceptOrganizationSnapshot(me);
    const before = getActiveOrganizationSnapshot();
    acceptOrganizationSnapshot({
      ...me,
      user: { ...me.user, displayName: "Updated" },
    });
    expect(getActiveOrganizationSnapshot()).toBe(before);
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
    expect(getActiveTeamId()).toBe("local-personal");
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
    expect(getActiveTeamId()).toBe("local-personal");

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
