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
  sub: "auth0|1",
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
    "https://app.zeros.build/launch",
  );
});

test("dashboard renders Personal first-class, organization sections, and no bearer tokens", () => {
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
  assert.match(page, /Create organization/);
  assert.match(page, /data-section="members"/);
  assert.match(page, /Local \+ cloud workspaces/);
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

test("Personal disables collaboration navigation and remains local-only", () => {
  const page = dashboardPage({
    session,
    me: { user: { id: "u1", email: session.email, displayName: session.name }, organizations: [personal] },
    requestUrl: "https://app.zeros.build/?section=general",
    signOutHref: "/auth/logout",
  });
  assert.match(page, /Local workspaces only/);
  assert.match(page, /<strong>Ada Lovelace<\/strong><small>Local workspaces only/);
  assert.match(page, /data-section="members"[\s\S]*?disabled/);
  assert.match(page, /Personal cannot be removed/);
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
    /avatar avatar-large">SN<\/span><div><strong>Stored Name<\/strong>/,
  );
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
    requestUrl: "https://app.zeros.build/",
    signOutHref: "/auth/logout",
  });
  assert.match(page, /id="dashboard-sidebar"/);
  assert.match(page, /aria-controls="dashboard-sidebar" aria-expanded="false"/);
  assert.match(page, /class="mobile-scrim"[^>]*data-action="close-mobile-nav"/);
  assert.match(page, /avatar avatar-large/);
  assert.match(page, /Provider-managed/);
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
  assert.match(page, /Delete organization/);
  assert.match(page, /Capability metadata; cloud provisioning will still enforce plan and quota/);
  assert.match(page, /deleted only after the grace period/);

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
  assert.match(page, /hello@zeros\.build/);
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
    assert.match(page, /Sign out/);
    assert.doesNotMatch(page, /Organization data is unavailable/);
    assert.doesNotMatch(page, /secret-token-must-not-render/);
    assert.doesNotMatch(page, /refresh-secret-must-not-render/);
    assert.doesNotMatch(page, /untrusted/);
  }
});
