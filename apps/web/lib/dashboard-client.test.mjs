import assert from "node:assert/strict";
import test from "node:test";
import {
  billingHtml,
  cloudOrganizations,
  collaborationSectionDisabled,
  createOrganizationDialogHtml,
  deleteAccountDialogHtml,
  deleteOrganizationDialogHtml,
  escapeHtml,
  formatShortDate,
  generalHtml,
  initials,
  membersHtml,
  navHtml,
  profileHtml,
  roleLabel,
  sectionErrorHtml,
  sectionLoadingHtml,
  teamsHtml,
  createSubmissionGate,
  dashboardOrganizationDataUnavailable,
  formatLifecycleDate,
  invalidateOrganizationSnapshots,
  loadExactSnapshot,
  memberPermissions,
  organizationDisplayName,
  organizationCreationAllowed,
  safeOrganizationLogo,
  seatBadgeHtml,
  seatSummary,
  sectionLoadErrorNeedsInlineRetry,
  sectionRequestStillCurrent,
  securityEventAction,
  securitySnapshotChanged,
  shouldRevalidateSecurityLifecycle,
  tryWriteClipboard,
} from "../public/dashboard.js";

test("a truncated workspace repair snapshot forces discovery refresh even when its bounded prefix is unchanged",()=>{
  const before={account:{id:"account",revision:1},session:{id:"session"},organizations:[],workspaces:[{id:"workspace",role:"viewer",accessRevision:1}],workspacesTruncated:true,cursor:1};
  assert.equal(securitySnapshotChanged(before,{...before,cursor:2}),true);
});

test("organization creation fails closed without an explicit server capability", () => {
  assert.equal(organizationCreationAllowed(undefined), false);
  assert.equal(organizationCreationAllowed({}), false);
  assert.equal(
    organizationCreationAllowed({ createOrganization: false }),
    false,
  );
  assert.equal(organizationCreationAllowed({ createOrganization: true }), true);
});

test("summarizes Pro organization seats and labels each member's seat", () => {
  assert.equal(
    seatSummary({ members: 8, pendingInvitations: 2, freeMembers: 5, heldMembers: 1, memberLimit: 10, freeMemberLimit: 5 }),
    "8 of 10 members + 2 invited · 5 of 5 free seats · 1 on Hold",
  );
  assert.equal(
    seatSummary({ members: 3, pendingInvitations: 0, freeMembers: 1, heldMembers: 0, memberLimit: 10, freeMemberLimit: 5 }),
    "3 of 10 members · 1 of 5 free seats",
  );
  assert.equal(seatSummary(undefined), null);
  assert.equal(seatBadgeHtml("pro"), '<span class="badge success">Pro</span>');
  assert.equal(seatBadgeHtml("free"), '<span class="badge">Free</span>');
  assert.equal(seatBadgeHtml("hold"), '<span class="badge warning">On Hold</span>');
  for (const value of [undefined, null, "constructor", "<b>"]) assert.equal(seatBadgeHtml(value), "");
});

test("formats lifecycle dates deterministically and rejects invalid timestamps", () => {
  assert.equal(
    formatLifecycleDate("2026-10-01T00:00:00.000Z"),
    "October 1, 2026",
  );
  assert.equal(formatLifecycleDate("not-a-date"), "the scheduled date");
});

test("an organization without a name falls back to a neutral label", () => {
  assert.equal(organizationDisplayName({ name: " Acme " }), "Acme");
  assert.equal(organizationDisplayName({ name: "  " }), "Organization");
  assert.equal(organizationDisplayName(null), "Organization");
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
    await tryWriteClipboard(
      { writeText: async () => Promise.reject(new Error("denied")) },
      "x",
    ),
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
    {
      canChangeRole: false,
      canRemove: false,
      availableRoles: ["owner", "admin", "member"],
    },
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

test("organization events invalidate only that organization's retained sections", () => {
  const snapshots = new Map([
    ["org-a:members", { members: ["stale"] }],
    ["org-a:billing", { memberCount: 1 }],
    ["org-b:members", { members: ["retained"] }],
  ]);
  invalidateOrganizationSnapshots(snapshots, "org-a");
  assert.deepEqual([...snapshots.keys()], ["org-b:members"]);

  invalidateOrganizationSnapshots(snapshots, null);
  assert.equal(snapshots.size, 0);
});

test("an invalidated in-flight section cannot republish its stale snapshot", async () => {
  const snapshots = new Map();
  const inflight = new Map();
  const generations = new Map();
  const resolutions = [];
  const loader = () =>
    new Promise((resolve) => {
      resolutions.push(resolve);
    });
  const cache = { snapshots, inflight, generations };

  const staleRequest = loadExactSnapshot(cache, "org-a:members", loader);
  await Promise.resolve();
  assert.equal(resolutions.length, 1);
  invalidateOrganizationSnapshots(snapshots, "org-a", {
    inflight,
    generations,
  });
  const freshRequest = loadExactSnapshot(cache, "org-a:members", loader);
  await Promise.resolve();
  assert.equal(resolutions.length, 2);

  resolutions[0]({ members: ["removed"] });
  resolutions[1]({ members: ["current"] });
  assert.deepEqual(await staleRequest, { members: ["current"] });
  assert.deepEqual(await freshRequest, { members: ["current"] });
  assert.deepEqual(snapshots.get("org-a:members"), {
    members: ["current"],
  });
  assert.equal(inflight.size, 0);
});

test("an invalidated in-flight failure follows the replacement request", async () => {
  const snapshots = new Map();
  const inflight = new Map();
  const generations = new Map();
  const settlements = [];
  const loader = () =>
    new Promise((resolve, reject) => {
      settlements.push({ resolve, reject });
    });
  const cache = { snapshots, inflight, generations };

  const staleRequest = loadExactSnapshot(cache, "org-a:members", loader);
  await Promise.resolve();
  invalidateOrganizationSnapshots(snapshots, "org-a", {
    inflight,
    generations,
  });
  const freshRequest = loadExactSnapshot(cache, "org-a:members", loader);
  await Promise.resolve();

  settlements[0].reject(new Error("superseded outage"));
  settlements[1].resolve({ members: ["current"] });
  assert.deepEqual(await staleRequest, { members: ["current"] });
  assert.deepEqual(await freshRequest, { members: ["current"] });
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

// ── Markup: each dashboard frame of the Zeros Design canvas's Web app page ──

const acme = {
  id: "5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35",
  name: "Acme",
  logo: null,
  role: "owner",
  isPersonal: false,
};
const northwind = { ...acme, id: "6e3a9d2b-4c8f-4a01-b7e5-0d2f3c8a9b46", name: "Northwind", role: "member" };
const alex = { displayName: "Alex Morgan", email: "alex@example.com" };

test("the web lists cloud organizations only, with safe logos", () => {
  const listed = cloudOrganizations([
    { ...acme, logo: "data:image/svg+xml;base64,PHN2Zz4=" },
    { id: "personal", name: "Alex Morgan", isPersonal: true },
    null,
  ]);
  assert.deepEqual(listed.map((organization) => organization.id), [acme.id]);
  assert.equal(listed[0].logo, null);
  assert.deepEqual(cloudOrganizations(undefined), []);
});

test("the sidebar starts with the organization switcher, then Account and Organization", () => {
  const nav = navHtml({
    organizations: [acme, northwind],
    activeId: acme.id,
    section: "members",
    canCreate: true,
    email: "alex@example.com",
  });
  assert.ok(nav.startsWith('<details class="org-switcher" id="org-switcher"><summary class="nav-row org-row"><span class="avatar square size-20" aria-hidden="true">A</span><span class="nav-name">Acme</span><svg class="chevron"'));
  assert.match(nav, /<p class="menu-label">alex@example\.com<\/p>/);
  assert.match(nav, new RegExp(`role="menuitemradio" aria-checked="true" data-org-id="${acme.id}">[^]*?<span class="menu-name">Acme</span><span class="menu-meta">Owner</span><span class="menu-check" aria-hidden="true">✓</span>`));
  assert.match(nav, new RegExp(`aria-checked="false" data-org-id="${northwind.id}">[^]*?<span class="menu-meta">Member</span><span class="menu-check" aria-hidden="true"></span>`));
  assert.match(nav, /<div class="menu-sep" role="separator"><\/div><button class="menu-item" type="button" role="menuitem" data-action="create-organization"><svg[^>]*>[^]*?<\/svg>Create organization<\/button>/);
  // Under the switcher the Account label keeps its full 16px top padding.
  assert.match(nav, /<\/details><p class="nav-label">Account<\/p><div class="nav-list"><button class="nav-row" type="button" data-section="profile" aria-current="false">/);
  assert.match(nav, /<p class="nav-label">Organization<\/p>/);
  assert.match(nav, /data-section="members" aria-current="page">/);
  for (const name of ["Profile", "General", "Members", "Teams", "Billing"]) {
    assert.match(nav, new RegExp(`<svg[^>]*>[^]*?</svg><span class="nav-name">${name}</span>`), name);
  }
  assert.doesNotMatch(navHtml({ organizations: [acme], activeId: acme.id, canCreate: false }), /Create organization/);
});

test("without a cloud organization the sidebar offers creation, or only Profile", () => {
  const create = navHtml({ organizations: [], canCreate: true });
  assert.ok(create.startsWith('<button class="nav-row org-row" type="button" data-action="create-organization"><svg'));
  assert.match(create, /<span class="nav-name">Create organization<\/span>/);
  assert.doesNotMatch(create, /data-section="general"|Organization<\/p>/);
  assert.ok(navHtml({ organizations: [], canCreate: false }).startsWith('<p class="nav-label first">Account</p>'));
  assert.ok(navHtml({ organizations: [], orgList: "loading" }).startsWith('<div class="nav-row org-row" aria-hidden="true"><span class="skel-av square"></span><span class="skel name"></span></div>'));
  assert.ok(navHtml({ organizations: [], canCreate: true, orgList: "unavailable" }).startsWith('<p class="nav-label first">Account</p>'));
});

test("Profile shows the sign-in identity, Sessions and Delete account", () => {
  const page = profileHtml({ user: alex, signOutHref: '/auth/logout?return="x"' });
  assert.match(page, /^<header class="page-head"><div><h1>Profile<\/h1><\/div><\/header>/);
  assert.match(page, /<span class="row-who"><span class="avatar size-40" aria-hidden="true">AM<\/span><span class="row-text"><span class="row-name">Alex Morgan<\/span><span class="row-hint">alex@example\.com<\/span><\/span><\/span><span class="row-ctl"><span class="badge">Sign-in profile<\/span><\/span>/);
  assert.match(page, /<p class="group-line">Name and avatar come from your sign-in provider\.<\/p>/);
  assert.match(page, /<h2 class="group-title">Sessions<\/h2><div class="card"><div class="row"><span class="row-text"><span class="row-name">Sign out<\/span><span class="row-hint">Sign out of Zeros in this browser\.<\/span><\/span><span class="row-ctl"><a class="button secondary" href="\/auth\/logout\?return=&quot;x&quot;">Sign out<\/a>/);
  assert.match(page, /<span class="row-hint">Signs out everywhere\. Recoverable for 30 days; local work stays\.<\/span><\/span><span class="row-ctl"><button class="button danger-secondary" type="button" data-action="delete-account">Delete account<\/button>/);
  assert.doesNotMatch(page, /Organizations<\/h2>|Recoverable organizations/);
});

test("Profile's Organizations group covers creation, loading and an outage", () => {
  const create = profileHtml({ user: alex, signOutHref: "/out", hasOrganizations: false, canCreate: true });
  assert.match(create, /<h2 class="group-title">Organizations<\/h2><div class="card"><div class="empty"><svg[^>]*width="32"[^>]*>[^]*?<\/svg><p>Create a cloud organization to share workspaces, members and settings\.<\/p><button class="button primary" type="button" data-action="create-organization"><svg/);
  assert.doesNotMatch(profileHtml({ user: alex, signOutHref: "/out", hasOrganizations: false, canCreate: false }), /Organizations<\/h2>/);
  assert.match(
    profileHtml({ user: alex, signOutHref: "/out", orgList: "loading" }),
    /<div class="empty" aria-busy="true"><span class="orb" aria-hidden="true"><\/span><p>Loading your organizations…<\/p><\/div>/,
  );
  assert.match(
    profileHtml({ user: alex, signOutHref: "/out", orgList: "unavailable", canCreate: true }),
    /<div class="empty"><svg[^>]*width="32"[^>]*><path d="m2 2 20 20"\/>[^]*?<\/svg><p>Couldn’t reach Zeros\. You’re still signed in\.<\/p><button class="button secondary" type="button" data-action="retry-me">Try again<\/button>/,
  );
});

test("Profile lists recoverable organizations by name with their restore hooks", () => {
  const page = profileHtml({
    user: alex,
    signOutHref: "/out",
    deletions: [
      { id: "req-1", targetId: northwind.id, targetName: "North<wind>", recoveryCode: "ZD-7K4M-Q9TX", purgeAfter: "2026-11-30T00:00:00.000Z" },
      { id: "req-2", targetId: acme.id, recoveryCode: "ZD-2345-WMGZ", purgeAfter: "not-a-date" },
    ],
  });
  assert.match(page, /<h2 class="group-title">Recoverable organizations<\/h2><p class="group-desc">An owner can restore these within 30 days\.<\/p>/);
  assert.match(page, /<span class="avatar square" aria-hidden="true">N<\/span><span class="row-text"><span class="row-name">North&lt;wind&gt;<\/span><span class="row-hint">Restore before November 30, 2026 · ZD-7K4M-Q9TX<\/span>/);
  assert.match(page, new RegExp(`data-restore-organization="${northwind.id}" data-deletion-request="req-1" aria-label="Restore North&lt;wind&gt;">Restore</button>`));
  assert.match(page, /<span class="row-name">Organization<\/span><span class="row-hint">Restore before the scheduled date · ZD-2345-WMGZ<\/span>/);
});

test("General gives owners every control and members a read-only view", () => {
  const owner = generalHtml({ ...acme, logo: "data:image/png;base64,AA==" });
  assert.match(owner, /<h2 class="group-title">Organization<\/h2>/);
  assert.match(owner, /<img class="avatar-image" src="data:image\/png;base64,AA==" alt="" \/>/);
  assert.match(owner, /<span class="row-hint">Shown for Acme across Zeros\.<\/span><\/span><\/span><span class="row-ctl"><label class="button secondary">Change<input class="file-input" type="file" accept="image\/png,image\/jpeg,image\/webp,image\/gif" data-organization-logo \/><\/label><button class="button ghost" type="button" data-action="remove-organization-logo">Remove<\/button>/);
  assert.match(owner, /<form class="row" data-form="rename-organization"><span class="row-text"><span class="row-name">Name<\/span><span class="row-hint">Shown across Zeros and in invitations\.<\/span><\/span><span class="row-ctl"><input class="input" name="name" required maxlength="80" value="Acme" aria-label="Organization name" \/><button class="button secondary" type="submit">Save<\/button>/);
  assert.match(owner, new RegExp(`<code class="id-code">${acme.id}</code><button class="icon-button" type="button" data-copy-organization-id="${acme.id}" aria-label="Copy organization ID"><svg`));
  assert.match(owner, /<span class="row-name">Your role<\/span><\/span><span class="row-ctl"><span class="badge">Owner<\/span>/);
  assert.match(owner, /<h2 class="group-title">Delete organization<\/h2><div class="card"><div class="row"><span class="row-text"><span class="row-name">Delete organization<\/span><span class="row-hint">Removes access now\. An owner can restore it for 30 days\.<\/span><\/span><span class="row-ctl"><button class="button danger-secondary" type="button" data-action="delete-organization">Delete organization<\/button>/);
  assert.doesNotMatch(generalHtml(acme), /remove-organization-logo/);

  const admin = generalHtml({ ...acme, role: "admin" });
  assert.match(admin, /data-form="rename-organization"/);
  assert.doesNotMatch(admin, /Delete organization/);

  const member = generalHtml({ ...acme, name: "Ac<me>", role: "member" });
  assert.doesNotMatch(member, /data-organization-logo|data-form=|Delete organization/);
  assert.match(member, /<span class="row-hint">Shown for Ac&lt;me&gt; across Zeros\.<\/span><\/span><\/span><\/div>/);
  assert.match(member, /<span class="row-ctl"><span class="row-value">Ac&lt;me&gt;<\/span><\/span>/);
  assert.match(member, /<span class="badge">Member<\/span>/);
});

const people = [
  { id: "u-alex", display_name: "Alex Morgan", email: "alex@example.com", role: "owner" },
  { id: "u-priya", display_name: "Priya Shah", email: "priya@example.com", role: "admin" },
  { id: "u-sam", display_name: "Sam Lee", email: "sam@example.com", role: "member" },
  { id: "u-jordan", display_name: "Jordan Kim", email: "jordan@example.com", role: "member", directory_managed: true },
];

test("Members gives admins the invite form, role menus and pending invitations", () => {
  const page = membersHtml({
    organization: acme,
    userId: "u-alex",
    data: {
      members: people,
      invitations: [
        { id: "inv-1", email: "taylor@example.com", role: "member", expires_at: "2026-11-07T12:00:00.000Z" },
      ],
    },
  });
  assert.match(page, /^<header class="page-head"><div><h1>Members<\/h1><p>Members join the default team automatically\.<\/p><\/div><\/header>/);
  assert.match(page, /<h2 class="group-title">Invite member<\/h2><p class="group-desc">They sign in with this exact email address\.<\/p><div class="card"><form class="invite-form" data-form="invite-member"><label>Email address<input class="input" name="email" type="email" maxlength="254" required autocomplete="off" placeholder="teammate@example\.com" \/><\/label><label>Role<select class="select" name="role"><option value="member">Member<\/option><option value="admin">Admin<\/option><\/select><\/label><button class="button primary" type="submit">Send invite<\/button><\/form>/);
  assert.match(page, /<h2 class="group-title">Members<\/h2><p class="group-desc">4 members<\/p>/);
  // The sole owner can't change their role or leave: a badge and an empty slot.
  assert.match(page, /<span class="row-name">Alex Morgan \(you\)<\/span><span class="row-hint">alex@example\.com<\/span><\/span><\/span><span class="row-ctl"><span class="badge">Owner<\/span><span class="slot" aria-hidden="true"><\/span><\/span>/);
  assert.match(page, /<select class="select compact" aria-label="Role for Priya Shah" data-member-role="u-priya"><option value="owner">Owner<\/option><option value="admin" selected>Admin<\/option><option value="member">Member<\/option><\/select><button class="icon-button standard" type="button" aria-label="More actions for Priya Shah" aria-haspopup="menu" aria-expanded="false" data-member-menu="u-priya"><svg[^>]*>[^]*?<\/svg><\/button><div class="menu row-menu" role="menu" hidden><button class="menu-item danger" type="button" role="menuitem" data-remove-member="u-priya">Remove from organization<\/button><\/div>/);
  assert.match(page, /<span class="row-hint">jordan@example\.com · Directory managed<\/span><\/span><\/span><span class="row-ctl"><span class="badge">Member<\/span><span class="slot" aria-hidden="true"><\/span>/);
  assert.match(page, /<h2 class="group-title">Pending invitations<\/h2><p class="group-desc">Unused invitations expire on their own\.<\/p>/);
  assert.match(page, /<span class="avatar vacant" aria-hidden="true"><svg[^>]*>[^]*?<\/svg><\/span><span class="row-text"><span class="row-name">taylor@example\.com<\/span><span class="row-hint">Expires Nov 7, 2026<\/span>/);
  assert.match(page, /<span class="badge">Member<\/span><button class="icon-button standard" type="button" data-revoke-invite="inv-1" aria-label="Revoke invitation for taylor@example\.com">/);

  const seats = membersHtml({
    organization: acme,
    userId: "u-alex",
    data: { members: people, invitations: [{ id: "i", email: "x@example.com", role: "admin", expires_at: "bad" }], seats: { members: 4, memberLimit: 10, freeMembers: 2, freeMemberLimit: 5, pendingInvitations: 1, heldMembers: 0 } },
  });
  assert.match(seats, /<p class="group-desc">4 of 10 members \+ 1 invited · 2 of 5 free seats<\/p>/);
  assert.match(seats, /Unused invitations expire on their own\. Each one holds a seat until then\./);
  assert.match(seats, /<span class="row-hint">Pending<\/span>/);
});

test("Members shows members badges only, with Leave on their own row", () => {
  const page = membersHtml({
    organization: { ...acme, role: "member" },
    userId: "u-sam",
    data: { members: people, invitations: [] },
  });
  assert.match(page, /<p>Members join the default team automatically\. Only admins can invite\.<\/p>/);
  assert.doesNotMatch(page, /invite-form|data-member-role|data-member-menu|class="slot"|Pending invitations/);
  assert.match(page, /<span class="row-name">Sam Lee \(you\)<\/span><span class="row-hint">sam@example\.com<\/span><\/span><\/span><span class="row-ctl"><span class="badge">Member<\/span><button class="button ghost" type="button" data-remove-member="u-sam">Leave<\/button>/);
  assert.match(page, /<span class="row-name">Priya Shah<\/span><span class="row-hint">priya@example\.com<\/span><\/span><\/span><span class="row-ctl"><span class="badge">Admin<\/span><\/span>/);
});

test("an admin's own row offers Leave organization from its menu", () => {
  const page = membersHtml({ organization: { ...acme, role: "admin" }, userId: "u-priya", data: { members: people } });
  assert.match(page, /data-member-menu="u-priya">[^]*?data-remove-member="u-priya">Leave organization</);
  assert.doesNotMatch(page, /aria-label="Role for Alex Morgan"/);
});

test("Teams shows the default team for everyone in the organization", () => {
  const page = teamsHtml({ organization: acme, data: { teams: [{ id: "t", name: "Default", slug: "default", is_default: true, role: "maintainer" }] } });
  assert.match(page, /^<header class="page-head"><div><h1>Teams<\/h1><p>Teams group members and workspace access\.<\/p><\/div><\/header>/);
  assert.match(page, /<h2 class="group-title">Organization teams<\/h2><p class="group-desc">More teams are coming\. Everyone is in the default team\.<\/p>/);
  assert.match(page, /<span class="avatar square" aria-hidden="true">D<\/span><span class="row-text"><span class="row-name">Default<\/span><span class="row-hint">Everyone in Acme<\/span><\/span><\/span><span class="row-ctl"><span class="badge">Default<\/span>/);
});

test("Billing shows the plan, or Free with the member count", () => {
  const free = billingHtml({ data: { billing: { subscription: null, memberCount: 4 } } });
  assert.match(free, /<h1>Billing<\/h1><p>Plan, seats and payment for this organization\.<\/p>/);
  assert.match(free, /<h2 class="group-title">Plan<\/h2><p class="group-desc">Checkout, invoices and payment methods are coming soon\.<\/p><div class="card"><div class="row"><span class="row-text"><span class="row-name">Free<\/span><span class="row-hint">4 members<\/span><\/span><span class="row-ctl"><span class="badge">No subscription<\/span>/);
  assert.match(billingHtml({ data: { billing: { subscription: null, memberCount: 1 } } }), /<span class="row-hint">1 member<\/span>/);
  const paid = billingHtml({ data: { billing: { subscription: { plan: "pro", status: "active", seats: 5 }, memberCount: 4 } } });
  assert.match(paid, /<span class="row-name">Pro<\/span><span class="row-hint">Active · 5 seats<\/span><\/span><span class="row-ctl"><span class="badge success">Active<\/span>/);
});

test("a section's first load is a skeleton, and its failure offers a retry", () => {
  const loading = sectionLoadingHtml("teams");
  assert.match(loading, /^<header class="page-head"><div><h1>Teams<\/h1><p>Teams group members and workspace access\.<\/p><\/div><\/header><section class="group" aria-busy="true" aria-label="Loading teams"><div class="card">/);
  assert.equal(loading.match(/<span class="skel-av"><\/span>/g).length, 3);
  assert.match(loading, /<span class="skel name"><\/span><span class="skel hint"><\/span><\/span><\/span><span class="skel ctl"><\/span>/);
  assert.match(
    sectionErrorHtml("billing"),
    /^<header class="page-head"><div><h1>Billing<\/h1><\/div><\/header><section class="group"><div class="card"><div class="empty"><svg[^>]*width="32"[^>]*>[^]*?<\/svg><p>Zeros couldn’t load billing\. Try again\.<\/p><button class="button secondary" type="button" data-action="retry-section">Try again<\/button><\/div><\/div><\/section>$/,
  );
});

test("dialogs follow the 400px recipe with the canvas copy", () => {
  const create = createOrganizationDialogHtml();
  assert.match(create, /<h2 class="dialog-title" id="create-organization-title">Create organization<\/h2><button class="icon-button" type="button" value="cancel" data-action="close-dialog" aria-label="Close"><svg/);
  assert.match(create, /<p class="dialog-desc">Organizations share workspaces, members and settings\.<\/p>/);
  assert.match(create, /<div class="dialog-foot"><button class="button ghost" type="button" value="cancel" data-action="close-dialog">Cancel<\/button><button class="button primary" type="submit" value="default">Create organization<\/button><\/div>/);
  const remove = deleteOrganizationDialogHtml('Acme "Labs"');
  assert.match(remove, /<p class="dialog-desc">Access stops now\. An owner can restore it for 30 days\.<\/p>/);
  assert.match(remove, /<span data-confirmation-label>Type Acme &quot;Labs&quot; to confirm<\/span><input class="input" name="confirmation" maxlength="500" required autocomplete="off" placeholder="Acme &quot;Labs&quot;" \/>/);
  assert.match(remove, /<button class="button danger" type="submit" value="default">Schedule deletion<\/button>/);
  const account = deleteAccountDialogHtml();
  assert.match(account, /<p class="dialog-desc">Signs out every device\. Recoverable for 30 days; local work stays\.<\/p>/);
  assert.match(account, /<span>Type DELETE MY ACCOUNT to confirm<\/span><input class="input" name="confirmation" maxlength="64" required autocomplete="off" placeholder="DELETE MY ACCOUNT" \/>/);
});

test("markup helpers escape, abbreviate and format deterministically", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(initials(" alex  morgan lee "), "AM");
  assert.equal(initials(""), "");
  assert.equal(roleLabel("admin"), "Admin");
  assert.equal(roleLabel("constructor"), "constructor");
  assert.equal(formatShortDate("2026-11-07T23:30:00.000Z"), "Nov 7, 2026");
  assert.equal(formatShortDate("never"), null);
});
