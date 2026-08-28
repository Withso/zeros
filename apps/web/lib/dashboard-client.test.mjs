import assert from "node:assert/strict";
import test from "node:test";
import {
  collaborationSectionDisabled,
  createSubmissionGate,
  dashboardOrganizationDataUnavailable,
  memberPermissions,
  organizationDisplayName,
  safeOrganizationLogo,
  sectionLoadErrorNeedsInlineRetry,
  sectionRequestStillCurrent,
  securityEventAction,
  securitySnapshotChanged,
  shouldRevalidateSecurityLifecycle,
  tryWriteClipboard,
} from "../public/dashboard.js";

test("Personal uses the provider-backed name and retains a safe fallback", () => {
  assert.equal(
    organizationDisplayName({ name: "Ada Lovelace", isPersonal: true }),
    "Ada Lovelace",
  );
  assert.equal(organizationDisplayName({ name: "  ", isPersonal: true }), "Personal");
});

test("organization logos accept only bounded raster data URLs", () => {
  const logo = "data:image/png;base64,AA==";
  assert.equal(safeOrganizationLogo(logo), logo);
  assert.equal(
    safeOrganizationLogo("data:image/svg+xml;base64,PHN2Zz4="),
    null,
  );
  assert.equal(safeOrganizationLogo("https://example.com/logo.png"), null);
  assert.equal(
    safeOrganizationLogo(`data:image/webp;base64,${"A".repeat(200_001)}`),
    null,
  );
});

test("one form cannot start the same mutation twice while it is in flight", () => {
  const gate = createSubmissionGate();
  const form = {};
  assert.equal(gate.enter(form), true);
  assert.equal(gate.enter(form), false);
  gate.leave(form);
  assert.equal(gate.enter(form), true);
});

test("clipboard feedback reports the actual browser write result", async () => {
  let copied = "";
  assert.equal(
    await tryWriteClipboard(
      { writeText: async (value) => void (copied = value) },
      "invite-url",
    ),
    true,
  );
  assert.equal(copied, "invite-url");
  assert.equal(
    await tryWriteClipboard({ writeText: async () => Promise.reject(new Error("denied")) }, "x"),
    false,
  );
  assert.equal(await tryWriteClipboard(null, "x"), false);
});

test("admins cannot mutate owners or promote members to owner", () => {
  assert.deepEqual(
    memberPermissions({
      actorRole: "admin",
      targetRole: "owner",
      isSelf: false,
      ownerCount: 2,
    }),
    { canChangeRole: false, canRemove: false, availableRoles: [] },
  );
  assert.deepEqual(
    memberPermissions({
      actorRole: "admin",
      targetRole: "member",
      isSelf: false,
      ownerCount: 1,
    }),
    {
      canChangeRole: true,
      canRemove: true,
      availableRoles: ["admin", "member"],
    },
  );
});

test("directory-managed members cannot be edited or removed locally", () => {
  assert.deepEqual(
    memberPermissions({
      actorRole: "owner",
      targetRole: "member",
      isSelf: false,
      ownerCount: 2,
      directoryManaged: true,
    }),
    { canChangeRole: false, canRemove: false, availableRoles: [] },
  );
});

test("the final owner cannot demote, leave, or be removed", () => {
  assert.deepEqual(
    memberPermissions({
      actorRole: "owner",
      targetRole: "owner",
      isSelf: true,
      ownerCount: 1,
    }),
    { canChangeRole: false, canRemove: false, availableRoles: ["owner", "admin", "member"] },
  );
});

test("collaboration navigation stays disabled without a confirmed organization", () => {
  assert.equal(collaborationSectionDisabled(null, "members"), true);
  assert.equal(
    collaborationSectionDisabled({ isPersonal: true }, "billing"),
    true,
  );
  assert.equal(
    collaborationSectionDisabled({ isPersonal: false }, "members"),
    false,
  );
  assert.equal(collaborationSectionDisabled(null, "profile"), false);
});

test("an initial organization outage remains visible until a retry succeeds", () => {
  assert.equal(
    dashboardOrganizationDataUnavailable({
      loadError: "service unavailable",
      organizations: [],
    }),
    true,
  );
  assert.equal(
    dashboardOrganizationDataUnavailable({
      loadError: null,
      organizations: [],
    }),
    false,
  );
});

test("section failures replace only a first-load spinner, not a retained snapshot", () => {
  assert.equal(sectionLoadErrorNeedsInlineRetry(undefined), true);
  assert.equal(sectionLoadErrorNeedsInlineRetry(null), true);
  assert.equal(sectionLoadErrorNeedsInlineRetry({ teams: [] }), false);
});

test("section responses publish only into their exact organization and section", () => {
  assert.equal(
    sectionRequestStillCurrent("org-a", "members", "org-a", "members"),
    true,
  );
  assert.equal(
    sectionRequestStillCurrent("org-b", "members", "org-a", "members"),
    false,
  );
  assert.equal(
    sectionRequestStillCurrent("org-a", "billing", "org-a", "members"),
    false,
  );
});

test("security events distinguish terminal session loss from scoped data refresh", () => {
  assert.deepEqual(securityEventAction("account.revoked"), {
    signOut: true,
    refreshOrganizations: false,
  });
  assert.deepEqual(securityEventAction("session.revoked"), {
    signOut: true,
    refreshOrganizations: false,
  });
  assert.deepEqual(securityEventAction("organization.access_revoked"), {
    signOut: false,
    refreshOrganizations: true,
  });
  assert.deepEqual(securityEventAction("heartbeat"), {
    signOut: false,
    refreshOrganizations: false,
  });
});

test("security snapshots compare authorization/data revisions by exact organization", () => {
  const first = {
    account: { id: "user", status: "active", revision: 1 },
    session: { id: "session", status: "active" },
    organizations: [
      {
        id: "org-a",
        role: "member",
        authorizationRevision: 1,
        membershipRevision: 1,
        dataRevision: 1,
      },
    ],
  };
  assert.equal(securitySnapshotChanged(first, structuredClone(first)), false);
  const changed = structuredClone(first);
  changed.organizations[0].membershipRevision = 2;
  assert.equal(securitySnapshotChanged(first, changed), true);
  assert.equal(
    securitySnapshotChanged(first, { ...first, organizations: [] }),
    true,
  );
});

test("focus/visibility is a silence backstop, not a periodic poll", () => {
  assert.equal(shouldRevalidateSecurityLifecycle(1_000, 60_999), false);
  assert.equal(shouldRevalidateSecurityLifecycle(1_000, 61_000), true);
});
