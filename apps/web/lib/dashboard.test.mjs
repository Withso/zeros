import assert from "node:assert/strict";
import test from "node:test";
import {
  accountAccessPage,
  accountDeletionPage,
  accountRecoveryPage,
  dashboardPage,
  dashboardReturnUrl,
  parseAccountRecoveryError,
  parseAccountResolutionError,
} from "./dashboard.mjs";

const session = {
  sub: "user_01",
  email: "ada@example.com",
  name: "Ada Lovelace",
  accessToken: "secret-token-must-not-render",
  refreshToken: "refresh-secret-must-not-render",
};
const personal = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "personal-1",
  name: "Ada Lovelace",
  logo: null,
  role: "owner",
  isPersonal: true,
  defaultTeamId: "22222222-2222-4222-8222-222222222222",
  workspaceCapabilities: { local: true, cloud: false },
  teamCapabilities: { multiple: false, canCreate: false },
};
const org = {
  ...personal,
  id: "33333333-3333-4333-8333-333333333333",
  name: "Analytical <script>Engines</script>",
  slug: "analytical-engines",
  isPersonal: false,
  workspaceCapabilities: { local: true, cloud: true },
};

test("dashboard intent survives sign-in without carrying unrelated query state", () => {
  assert.equal(dashboardReturnUrl("https://app.zeros.build", `https://app.zeros.build/?organization=${org.id}&section=api-keys&key=private`),
    `https://app.zeros.build/?organization=${org.id}&section=api-keys`);
  assert.equal(
    dashboardReturnUrl(
      "https://app.zeros.build",
      `https://app.zeros.build/?organization=${org.id}&section=general&action=create-organization&scheme=zeros-dev&nonce=secret`,
    ),
    `https://app.zeros.build/?organization=${org.id}&section=general&action=create-organization`,
  );
  assert.equal(
    dashboardReturnUrl(
      "https://app.zeros.build",
      "https://app.zeros.build/?organization=not-a-uuid&section=unknown&action=delete-everything",
    ),
    "https://app.zeros.build/",
  );
  assert.equal(
    dashboardReturnUrl(
      "https://app.zeros.build",
      "https://app.zeros.build/launch",
    ),
    "https://app.zeros.build/",
  );
});

test("the API keys page is organization-only and boots with no credential material", () => {
  const page = dashboardPage({ session, me: { user: { id: "u1" }, organizations: [personal, org] },
    requestUrl: `https://app.zeros.build/?organization=${org.id}&section=api-keys`, signOutHref: "/auth/logout" });
  assert.match(page, /data-section="api-keys" aria-current="page"/);
  assert.match(page, /<h1>API keys<\/h1>/);
  assert.match(page, /id="api-key-dialog-slot"/);
  assert.doesNotMatch(page, /secret-token-must-not-render|refresh-secret-must-not-render/);
  const local = dashboardPage({ session, me: { user: { id: "u1" }, organizations: [personal] },
    requestUrl: "https://app.zeros.build/?section=api-keys", signOutHref: "/auth/logout" });
  assert.doesNotMatch(local, /data-section="api-keys"|<h1>API keys<\/h1>/);
});

test("the dashboard lists cloud organizations only and renders no bearer tokens", () => {
  const page = dashboardPage({
    session,
    me: {
      user: { id: "u1", email: session.email, displayName: session.name },
      capabilities: { createOrganization: true },
      organizations: [personal, org],
    },
    requestUrl: `https://app.zeros.build/?organization=${org.id}&section=members`,
    signOutHref: "/auth/logout",
  });
  assert.match(page, /data-action="create-organization"><svg[^>]*>[^]*?<\/svg>Create organization/);
  assert.match(page, /data-section="members" aria-current="page"/);
  assert.match(page, new RegExp(`data-org-id="${org.id}"`));
  assert.match(page, /<span class="nav-name">Analytical &lt;script&gt;Engines&lt;\/script&gt;<\/span>/);
  assert.match(page, /<p class="menu-label">ada@example\.com<\/p>/);
  assert.match(page, /<span class="menu-meta">Owner<\/span>/);
  // Personal is each device's local space; the web never lists it.
  assert.doesNotMatch(page, new RegExp(personal.id));
  assert.doesNotMatch(page, /Local workspaces only|Local \+ cloud workspaces/);
  assert.match(page, /<h1>Members<\/h1><p>Members join the default team automatically\.<\/p>/);
  assert.match(page, /aria-busy="true" aria-label="Loading members"/);
  assert.doesNotMatch(page, /<script>Engines/);
  assert.doesNotMatch(page, /secret-token-must-not-render/);
  assert.doesNotMatch(page, /refresh-secret-must-not-render/);
});

test("ordinary accounts cannot discover or deep-link organization creation", () => {
  const page = dashboardPage({
    session,
    me: {
      user: { id: "u1", email: session.email, displayName: session.name },
      capabilities: { createOrganization: false },
      organizations: [personal],
    },
    requestUrl: "https://app.zeros.build/?action=create-organization",
    signOutHref: "/auth/logout",
  });
  assert.doesNotMatch(page, /Create organization/);
  assert.doesNotMatch(page, /create-organization-form/);
  assert.doesNotMatch(page, /"action":"create-organization"/);
});

test("dialog cancellation uses explicit non-submitting close controls", () => {
  const page = dashboardPage({
    session,
    me: {
      user: { id: "u1", email: session.email, displayName: session.name },
      capabilities: { createOrganization: true },
      organizations: [personal, org],
    },
    requestUrl: "https://app.zeros.build/",
    signOutHref: "/auth/logout",
  });
  const cancelControls = [
    ...page.matchAll(/<button\b[^>]*\bvalue="cancel"[^>]*>/g),
  ].map(([control]) => control);
  assert.equal(cancelControls.length, 6);
  for (const control of cancelControls) {
    assert.match(control, /\btype="button"/);
    assert.match(control, /\bdata-action="close-dialog"/);
  }
});

test("dashboard shell uses revisioned static assets", () => {
  const page = dashboardPage({
    session,
    me: {
      user: { id: "u1", email: session.email, displayName: session.name },
      organizations: [personal],
    },
    requestUrl: "https://app.zeros.build/",
    signOutHref: "/auth/logout",
  });
  assert.match(page, /href="\/dashboard\.css\?v=[a-z0-9.-]+"/i);
  assert.match(page, /src="\/dashboard\.js\?v=[a-z0-9.-]+"/i);

  const deletionPage = accountDeletionPage({
    session,
    deletion: {
      recoveryCode: "ZD-2345-WMGZ",
      scheduledPurgeAt: "2026-10-01T00:00:00.000Z",
    },
    signOutHref: "/auth/logout",
  });
  assert.match(
    deletionPage,
    /src="\/account-deletion\.js\?v=[a-z0-9.-]+"/i,
  );
});

test("an account with only Personal gets Profile, and Create organization when allowed", () => {
  const render = (createOrganization) =>
    dashboardPage({
      session,
      me: {
        user: { id: "u1", email: session.email, displayName: session.name },
        capabilities: { createOrganization },
        organizations: [personal],
      },
      requestUrl: "https://app.zeros.build/?section=general",
      signOutHref: "/auth/logout",
    });
  const page = render(true);
  assert.match(page, /<h1>Profile<\/h1>/);
  assert.match(page, /"section":"profile"/);
  assert.match(page, /<button class="nav-row org-row" type="button" data-action="create-organization">/);
  assert.match(page, /<h2 class="group-title">Organizations<\/h2><div class="card"><div class="empty"><svg[^>]*>[^]*?<\/svg><p>Create a cloud organization to share workspaces, members and settings\.<\/p><button class="button primary" type="button" data-action="create-organization">/);
  for (const section of ["general", "members", "teams", "billing"]) {
    assert.doesNotMatch(page, new RegExp(`data-section="${section}"`), section);
  }
  assert.doesNotMatch(page, /Organization<\/p>/);
  assert.doesNotMatch(page, /data-org-id=/);

  const ordinary = render(false);
  assert.doesNotMatch(ordinary, /Organizations<\/h2>/);
  assert.doesNotMatch(ordinary, /org-row/);
});

test("an unreachable organization service keeps Profile with a retry", () => {
  const page = dashboardPage({
    session,
    me: null,
    requestUrl: `https://app.zeros.build/?organization=${org.id}&section=general`,
    signOutHref: "/auth/logout",
    loadError: "Couldn’t reach Zeros. You’re still signed in.",
  });
  assert.match(page, /<h1>Profile<\/h1>/);
  assert.match(page, /<p>Couldn’t reach Zeros\. You’re still signed in\.<\/p><button class="button secondary" type="button" data-action="retry-me">Try again<\/button>/);
  assert.doesNotMatch(page, /org-row|data-section="general"/);
  assert.match(page, /<span class="row-name">Ada Lovelace<\/span><span class="row-hint">ada@example\.com<\/span>/);
});

test("Personal organization-only deep links resolve to Profile on the first frame", () => {
  const page = dashboardPage({
    session,
    me: { user: { id: "u1", email: session.email, displayName: session.name }, organizations: [personal] },
    requestUrl: "https://app.zeros.build/?section=members",
    signOutHref: "/auth/logout",
  });
  assert.match(page, /data-section="profile"[\s\S]*?aria-current="page"/);
  assert.match(page, /<h1>Profile<\/h1>/);
  assert.doesNotMatch(page, /Loading the latest organization data/);
});

test("server Profile uses the same control-plane identity as hydration", () => {
  const page = dashboardPage({
    session,
    me: {
      user: {
        id: "u1",
        email: session.email,
        displayName: "Stored Name",
      },
      organizations: [personal],
    },
    requestUrl: "https://app.zeros.build/?section=profile",
    signOutHref: "/auth/logout",
  });
  assert.match(
    page,
    /<span class="avatar size-40" aria-hidden="true">SN<\/span><span class="row-text"><span class="row-name">Stored Name<\/span>/,
  );
  assert.match(page, /<a class="button secondary" href="\/auth\/logout">Sign out<\/a>/);
  assert.match(page, /Delete account/);
  assert.match(page, /30 days/);
  assert.match(page, /id="delete-account-dialog"/);
  assert.match(
    page,
    /id="delete-account-form"[\s\S]*name="confirmation" maxlength="64"/,
  );
});

test("a deletion-pending account gets an exact self-service restore page", () => {
  const page = accountDeletionPage({
    session,
    deletion: {
      id: "44444444-4444-4444-8444-444444444444",
      recoveryCode: "ZD-ABCD-2345",
      purgeAfter: "2026-10-01T00:00:00.000Z",
      state: "scheduled",
    },
    signOutHref: "/auth/logout",
  });
  assert.match(page, /Restore account/);
  assert.match(page, /ZD-ABCD-2345/);
  assert.match(page, /44444444-4444-4444-8444-444444444444/);
  assert.doesNotMatch(page, /secret-token-must-not-render/);
});

test("mobile navigation exposes a controlled sidebar and dismissing scrim", () => {
  const page = dashboardPage({
    session,
    me: { user: { id: "u1", email: session.email, displayName: session.name }, organizations: [personal, org] },
    requestUrl: "https://app.zeros.build/?section=profile",
    signOutHref: "/auth/logout",
  });
  assert.match(page, /id="dashboard-sidebar"/);
  assert.match(page, /aria-controls="dashboard-sidebar" aria-expanded="false"/);
  assert.match(page, /class="mobile-scrim"[^>]*data-action="close-mobile-nav"/);
  assert.match(page, /<header class="mobile-header"><a class="brand" href="\/" aria-label="Zeros home"><svg class="brand-mark"/);
  assert.match(page, /Sign-in profile/);
});

test("server-rendered organization identity uses safe raster logos only", () => {
  const page = dashboardPage({
    session,
    me: {
      user: { id: "u1", email: session.email, displayName: session.name },
      organizations: [
        personal,
        { ...org, logo: "data:image/png;base64,AA==" },
      ],
    },
    requestUrl: `https://app.zeros.build/?organization=${org.id}&section=general`,
    signOutHref: "/auth/logout",
  });
  assert.match(page, /class="avatar-image" src="data:image\/png;base64,AA=="/);
  assert.match(page, /data-organization-logo/);
  assert.match(page, /data-copy-organization-id/);
  assert.match(page, /data-action="delete-organization">Delete organization/);
  assert.match(page, /Removes access now\. An owner can restore it for 30 days\./);
  assert.match(page, /<span data-confirmation-label>Type Analytical &lt;script&gt;Engines&lt;\/script&gt; to confirm<\/span>/);
  assert.doesNotMatch(page, /Workspace access|Capability metadata/);

  const unsafe = dashboardPage({
    session,
    me: {
      user: { id: "u1", email: session.email, displayName: session.name },
      organizations: [personal, { ...org, logo: "data:image/svg+xml;base64,PHN2Zz4=" }],
    },
    requestUrl: `https://app.zeros.build/?organization=${org.id}&section=general`,
    signOutHref: "/auth/logout",
  });
  assert.doesNotMatch(unsafe, /data:image\/svg\+xml/);
});

test("server-rendered General shows the member's seat and explains Hold", () => {
  const render = (seat) => dashboardPage({
    session,
    me: {
      user: { id: "u1", email: session.email, displayName: session.name },
      organizations: [personal, { ...org, ...(seat ? { seat } : {}) }],
    },
    requestUrl: `https://app.zeros.build/?organization=${org.id}&section=general`,
    signOutHref: "/auth/logout",
  });
  assert.match(render("pro"), /Your seat[\s\S]*class="badge success">Pro</);
  assert.doesNotMatch(render("pro"), /You're on Hold/);
  const held = render("hold");
  assert.match(held, /class="badge warning">On Hold</);
  assert.match(held, /You're on Hold/);
  // An older control plane sends no seat, and unknown values never render.
  assert.doesNotMatch(render(null), /Your seat/);
  assert.doesNotMatch(render("constructor"), /Your seat/);
});

test("reviewed account recovery is distinct from an organization outage", () => {
  assert.deepEqual(
    parseAccountRecoveryError(409, {
      error: {
        code: "account_recovery_required",
        details: { recoveryCode: "ZR-ABCD-2345", expiresInSeconds: 86_400 },
      },
    }),
    { recoveryCode: "ZR-ABCD-2345" },
  );
  assert.equal(
    parseAccountRecoveryError(409, {
      error: {
        code: "account_recovery_required",
        details: { recoveryCode: "<script>alert(1)</script>" },
      },
    }).recoveryCode,
    null,
  );

  const page = accountRecoveryPage({
    session,
    recoveryCode: "ZR-ABCD-2345",
    signOutHref: "/auth/logout",
  });
  assert.match(page, /Account recovery required/);
  assert.match(page, /ZR-ABCD-2345/);
  assert.match(page, /mailto:hi@zeros\.build/);
  assert.match(page, /Sign out/);
  assert.doesNotMatch(page, /Organization data is unavailable/);
  assert.doesNotMatch(page, /secret-token-must-not-render/);
  assert.doesNotMatch(page, /refresh-secret-must-not-render/);
});

test("sign-in conflicts and fresh-auth requirements get dedicated safe guidance", () => {
  assert.deepEqual(
    parseAccountResolutionError(409, {
      error: { code: "account_exists", message: "<script>untrusted</script>" },
    }),
    { kind: "account_exists" },
  );
  assert.deepEqual(
    parseAccountResolutionError(401, {
      error: { code: "reauthentication_required" },
    }),
    { kind: "reauthentication_required" },
  );
  assert.deepEqual(
    parseAccountResolutionError(401, {
      error: { code: "account_suspended" },
    }),
    { kind: "account_unavailable" },
  );
  assert.equal(
    parseAccountResolutionError(503, {
      error: { code: "auth_unavailable" },
    }),
    null,
  );

  for (const kind of [
    "account_exists",
    "reauthentication_required",
    "account_unavailable",
  ]) {
    const page = accountAccessPage({
      session,
      kind,
      signOutHref: "/auth/logout",
    });
    assert.match(page, /href="\/auth\/logout"/);
    assert.match(page, /Contact support/);
    assert.doesNotMatch(page, /Organization data is unavailable/);
    assert.doesNotMatch(page, /secret-token-must-not-render/);
    assert.doesNotMatch(page, /refresh-secret-must-not-render/);
    assert.doesNotMatch(page, /untrusted/);
  }
});

test("account states are centred pages with the canvas copy and one primary", () => {
  const recovery = accountRecoveryPage({ session, recoveryCode: "ZR-ABCD-2345", signOutHref: "/auth/logout" });
  assert.match(recovery, /<main class="card">/);
  assert.match(recovery, /<div class="title">Account recovery required<\/div>/);
  assert.match(recovery, /<div class="sub">Email hi@zeros\.build with your recovery code to restore access\.<\/div>/);
  assert.match(recovery, /<span class="box-name">Recovery code<\/span><span class="box-hint">Share only with Zeros support · expires in 24 hours<\/span>/);
  assert.match(recovery, /<code class="code">ZR-ABCD-2345<\/code><button class="icon-btn" type="button" aria-label="Copy recovery code" data-copy="ZR-ABCD-2345"><svg/);
  assert.match(recovery, /navigator\.clipboard/);
  assert.match(recovery, /<div class="acts"><a class="btn" href="mailto:hi@zeros\.build">Email support<\/a><a class="btn ghost" href="\/auth\/logout">Sign out<\/a><\/div>/);
  assert.doesNotMatch(recovery, /class="sidebar"/);
  const noCode = accountRecoveryPage({ session, recoveryCode: null, signOutHref: "/auth/logout" });
  assert.match(noCode, /<div class="sub">Email hi@zeros\.build to ask for a reviewed recovery\.<\/div>/);
  assert.doesNotMatch(noCode, /class="box"/);

  const deletion = accountDeletionPage({
    session,
    deletion: { id: "44444444-4444-4444-8444-444444444444", recoveryCode: "ZD-ABCD-2345", purgeAfter: "2026-11-30T00:00:00.000Z" },
    signOutHref: "/auth/logout",
  });
  assert.match(deletion, /<div class="title">Account deletion scheduled<\/div>/);
  assert.match(deletion, /<div class="sub">Restore before November 30, 2026 to keep your cloud account\.<\/div>/);
  assert.match(deletion, /<span class="box-hint">Identifies the request; it isn’t a password<\/span>/);
  assert.match(deletion, /aria-label="Copy recovery code" data-copy="ZD-ABCD-2345"/);
  assert.match(deletion, /<div class="acts"><button class="btn" id="restore-account" type="button" >Restore account<\/button><a class="btn ghost" href="\/auth\/logout">Sign out<\/a><\/div>/);
  assert.match(deletion, /<div class="msg error" id="restore-account-error" role="alert"><\/div>/);

  const copy = {
    account_exists: ["Use your existing sign-in", "This email already signs in another way. Use that method.", "Sign out"],
    reauthentication_required: ["Sign in again", "For your security, sign in once more to continue.", "Sign in again"],
    account_unavailable: ["Account access unavailable", "This Zeros account is no longer active. Contact support if unexpected.", "Sign out"],
    unknown: ["Account access unavailable", "Zeros couldn’t authorize this account. Contact support for help.", "Sign out"],
  };
  for (const [kind, [title, line, primary]] of Object.entries(copy)) {
    const page = accountAccessPage({ session, kind, signOutHref: "/auth/logout" });
    assert.match(page, new RegExp(`<div class="title">${title}</div>`));
    assert.ok(page.includes(`<div class="sub">${line}</div>`), kind);
    assert.ok(
      page.includes(`<div class="acts"><a class="btn" href="/auth/logout">${primary}</a><a class="btn ghost" href="mailto:hi@zeros.build">Contact support</a></div>`),
      kind,
    );
  }
});
