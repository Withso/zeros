import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, OrganizationSummary } from "../control-plane";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  native: true,
  storageWritable: true,
  reassign: vi.fn(),
}));
vi.mock("../../../platform/settings", () => ({
  getSetting: (key: string, fallback: unknown) =>
    structuredClone(mocks.storage.get(key) ?? fallback),
  setSetting: (key: string, value: unknown) => {
    if (!mocks.storageWritable) return false;
    mocks.storage.set(key, structuredClone(value));
    return true;
  },
}));
vi.mock("../../../platform/git", () => ({
  workspaceReassignLocalOrganization: mocks.reassign,
}));
vi.mock("../../../platform/runtime", () => ({
  isNativeRuntime: () => mocks.native,
  isExpectedElectron: () => true,
}));

function organization(id: string, isPersonal: boolean): OrganizationSummary {
  return {
    id,
    slug: id,
    name: isPersonal ? "Account display name" : "Business",
    logo: null,
    role: "owner",
    isPersonal,
    defaultTeamId: `${id}-team`,
    workspaceCapabilities: { local: true, cloud: !isPersonal },
    teamCapabilities: { multiple: false, canCreate: false },
  };
}

function account(id: string, collaborativeIds: string[] = []): Me {
  const organizations = [
    organization(`personal_${id}`, true),
    ...collaborativeIds.map((orgId) => organization(orgId, false)),
  ];
  return {
    user: { id, email: `${id}@example.test`, displayName: id, staffRole: null },
    organizations,
    teams: organizations,
  };
}

describe("device-local Personal", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.storage.clear();
    mocks.native = true;
    mocks.storageWritable = true;
    mocks.reassign.mockReset().mockResolvedValue({ changes: 0, repoSlugs: [] });
  });

  it("keeps exactly one identically named Personal before login and across accounts", async () => {
    const { desktopOrganizationChoices, PERSONAL_ORGANIZATION } =
      await import("../personal-organization");
    const a = account("a", ["org_a"]);
    const b = account("b", ["org_b"]);
    expect(desktopOrganizationChoices(null)).toEqual([PERSONAL_ORGANIZATION]);
    expect(desktopOrganizationChoices(a)[0]).toBe(PERSONAL_ORGANIZATION);
    expect(desktopOrganizationChoices(b)[0]).toBe(PERSONAL_ORGANIZATION);
    expect(PERSONAL_ORGANIZATION.name).toBe("Personal");
    expect(PERSONAL_ORGANIZATION.workspaceCapabilities.cloud).toBe(false);
    expect(desktopOrganizationChoices(a).map((org) => org.id)).toEqual([
      "local-personal",
      "org_a",
    ]);
    expect(a.organizations?.[0].id).toBe("personal_a");
    expect(desktopOrganizationChoices(a)).toBe(desktopOrganizationChoices(a));
    expect(desktopOrganizationChoices(account("c"))).toBe(
      desktopOrganizationChoices(null),
    );
  });

  it("migrates Personal IDs learned before upgrade without a current account", async () => {
    mocks.storage.set("organization:membership-history-v1", {
      version: 1,
      accounts: [
        {
          userId: "deleted_account",
          personalId: "old_personal",
          organizationIds: ["old_personal", "org_business"],
          retiredOrganizationIds: [],
          updatedAt: 1,
        },
      ],
    });
    const { reconcilePersonalWorkspaceOwnership } =
      await import("../organization-membership-history");
    await reconcilePersonalWorkspaceOwnership();
    expect(mocks.reassign.mock.calls).toEqual([
      [
        {
          fromOrganizationId: "old_personal",
          toOrganizationId: null,
        },
      ],
    ]);
  });

  it("retains Personal aliases when the account MRU evicts old accounts", async () => {
    const {
      reconcileOrganizationWorkspaceOwnership,
      getKnownPersonalOrganizationIds,
    } = await import("../organization-membership-history");
    for (let index = 0; index < 12; index++) {
      await reconcileOrganizationWorkspaceOwnership(account(`user${index}`));
    }
    const history = mocks.storage.get("organization:membership-history-v1") as {
      accounts: unknown[];
    };
    expect(history.accounts).toHaveLength(8);
    expect(getKnownPersonalOrganizationIds()).toContain("personal_user0");
    vi.resetModules();
    const reloaded = await import("../organization-membership-history");
    expect(reloaded.getKnownPersonalOrganizationIds()).toContain(
      "personal_user0",
    );
  });

  it("does not detach an organization just because another account signs in", async () => {
    const { reconcileOrganizationWorkspaceOwnership } =
      await import("../organization-membership-history");
    await reconcileOrganizationWorkspaceOwnership(
      account("a", ["personal_named_business"]),
    );
    mocks.reassign.mockClear();
    await reconcileOrganizationWorkspaceOwnership(account("b", ["org_b"]));
    expect(
      mocks.reassign.mock.calls.map(([args]) => args.fromOrganizationId),
    ).toEqual(["personal_a", "personal_b"]);
    expect(
      mocks.reassign.mock.calls.every(
        ([args]) => args.toOrganizationId === null,
      ),
    ).toBe(true);
  });

  it("moves a confirmed retired organization's local copies into device Personal", async () => {
    const { reconcileOrganizationWorkspaceOwnership } =
      await import("../organization-membership-history");
    await reconcileOrganizationWorkspaceOwnership(
      account("a", ["org_removed", "org_kept"]),
    );
    mocks.reassign.mockClear();
    await reconcileOrganizationWorkspaceOwnership(account("a", ["org_kept"]));
    expect(mocks.reassign).toHaveBeenCalledWith({
      fromOrganizationId: "org_removed",
      toOrganizationId: null,
    });
    expect(mocks.reassign).not.toHaveBeenCalledWith(
      expect.objectContaining({ fromOrganizationId: "org_kept" }),
    );
  });

  it("retries an unavailable bridge without losing the legacy owner evidence", async () => {
    const {
      reconcileOrganizationWorkspaceOwnership,
      reconcilePersonalWorkspaceOwnership,
    } = await import("../organization-membership-history");
    mocks.reassign.mockRejectedValueOnce(new Error("bridge disconnected"));
    await expect(
      reconcileOrganizationWorkspaceOwnership(account("a")),
    ).rejects.toThrow("bridge disconnected");
    mocks.reassign.mockClear();
    await reconcilePersonalWorkspaceOwnership();
    expect(mocks.reassign).toHaveBeenCalledWith({
      fromOrganizationId: "personal_a",
      toOrganizationId: null,
    });
  });

  it("does not apply a queued membership removal after the account changes", async () => {
    const { reconcileOrganizationWorkspaceOwnership } =
      await import("../organization-membership-history");
    await reconcileOrganizationWorkspaceOwnership(
      account("a", ["org_kept_by_b"]),
    );
    mocks.reassign.mockClear();
    let finishRepair!: () => void;
    let startedRepair!: () => void;
    const started = new Promise<void>((resolve) => {
      startedRepair = resolve;
    });
    mocks.reassign.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRepair = resolve;
          startedRepair();
        }),
    );
    let currentAccount = true;
    const pending = reconcileOrganizationWorkspaceOwnership(
      account("a"),
      () => currentAccount,
    );
    await started;
    currentAccount = false;
    finishRepair();
    await pending;
    expect(mocks.reassign).not.toHaveBeenCalledWith(
      expect.objectContaining({ fromOrganizationId: "org_kept_by_b" }),
    );
  });

  it("learns aliases without preload and repairs after reconnect without fetching WorkOS", async () => {
    const {
      rememberPersonalOrganizationOwnership,
      reconcilePersonalWorkspaceOwnership,
    } = await import("../organization-membership-history");
    mocks.native = false;
    rememberPersonalOrganizationOwnership(account("a"));
    await reconcilePersonalWorkspaceOwnership();
    expect(mocks.reassign).not.toHaveBeenCalled();
    mocks.native = true;
    await reconcilePersonalWorkspaceOwnership();
    expect(mocks.reassign).toHaveBeenCalledWith({
      fromOrganizationId: "personal_a",
      toOrganizationId: null,
    });
  });

  it("retains this session's Personal evidence when local storage is full", async () => {
    const {
      rememberPersonalOrganizationOwnership,
      getKnownPersonalOrganizationIds,
    } = await import("../organization-membership-history");
    mocks.storageWritable = false;
    rememberPersonalOrganizationOwnership(account("a"));
    rememberPersonalOrganizationOwnership(account("b"));
    expect(getKnownPersonalOrganizationIds()).toEqual([
      "personal_a",
      "personal_b",
    ]);
  });

  it("ignores malformed histories and bounds imported Personal aliases", async () => {
    mocks.storage.set("organization:membership-history-v1", {
      accounts: [{ personalId: "unproven" }],
    });
    mocks.storage.set("organization:personal-ids-v1", {
      version: 1,
      ids: [
        null,
        {},
        "",
        ...Array.from({ length: 300 }, (_, i) => `personal_${i}`),
      ],
    });
    const { getKnownPersonalOrganizationIds } =
      await import("../organization-membership-history");
    const ids = getKnownPersonalOrganizationIds();
    expect(ids).not.toContain("unproven");
    expect(ids).not.toContain("");
    expect(ids.length).toBeLessThanOrEqual(256);
  });
});
