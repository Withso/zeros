import { shell } from "./page.ts";

const SECTIONS = ["profile", "general", "members", "teams", "billing"];
const COLLABORATIVE_SECTIONS = new Set(["members", "teams", "billing"]);
const ORGANIZATION_LOGO_MAX_CHARS = 200_000;
const ORGANIZATION_LOGO_RE =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const ORGANIZATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_CODE_RE = /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DELETION_CODE_RE = /^ZD-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DASHBOARD_ASSET_REVISION = "2026-10-31.1";
const BRAND_MARK =
  '<span class="brand-mark" aria-hidden="true"><img src="/zeros-logo.svg" width="18" height="18" alt="" /></span>';

function dashboardAsset(path) {
  return `${path}?v=${DASHBOARD_ASSET_REVISION}`;
}

export function organizationCreationAllowed(capabilities) {
  return capabilities?.createOrganization === true;
}

function organizationCreationMenu(allowed) {
  return allowed
    ? '<div class="menu-separator"></div><button class="menu-action" type="button" data-action="create-organization"><span aria-hidden="true">＋</span>Create organization</button>'
    : "";
}

function organizationCreationDialog(allowed) {
  return allowed
    ? `<dialog id="create-organization-dialog" class="dialog">
    <form method="dialog" id="create-organization-form">
      <div class="dialog-header"><div><h2>Create organization</h2><p>Organizations can own local and cloud workspaces.</p></div><button class="icon-button" type="button" value="cancel" data-action="close-dialog" aria-label="Close">×</button></div>
      <label class="field"><span>Organization name</span><input name="name" maxlength="80" required autocomplete="organization" placeholder="Acme" /></label>
      <div class="dialog-error" id="create-organization-error" role="alert"></div>
      <div class="dialog-actions"><button class="button secondary" type="button" value="cancel" data-action="close-dialog">Cancel</button><button class="button primary" type="submit" value="default">Create organization</button></div>
    </form>
  </dialog>`
    : "";
}

/** Preserve only dashboard navigation intent through a browser sign-in round
 * trip. Arbitrary query parameters must not be copied into the post-login
 * return URL. */
export function dashboardReturnUrl(appBase, requestUrl) {
  let source;
  try {
    source = new URL(requestUrl);
  } catch {
    return new URL("/", appBase).toString();
  }
  const destination = new URL("/", appBase);
  const organization = source.searchParams.get("organization");
  if (organization && ORGANIZATION_ID_RE.test(organization)) {
    destination.searchParams.set("organization", organization);
  }
  const section = source.searchParams.get("section");
  if (section && SECTIONS.includes(section)) {
    destination.searchParams.set("section", section);
  }
  const action = source.searchParams.get("action");
  if (
    ["create-organization", "delete-account", "delete-organization"].includes(
      action,
    )
  ) {
    destination.searchParams.set("action", action);
  }
  return destination.toString();
}

export function safeOrganizationLogo(value) {
  return typeof value === "string" &&
    value.length <= ORGANIZATION_LOGO_MAX_CHARS &&
    ORGANIZATION_LOGO_RE.test(value)
    ? value
    : null;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) =>
    character === "&"
      ? "&amp;"
      : character === "<"
        ? "&lt;"
        : character === ">"
          ? "&gt;"
          : character === '"'
            ? "&quot;"
            : "&#39;",
  );
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function initials(value) {
  const parts = (value || "Personal").trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "P"}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

/** Accept only the control plane's fixed machine code and public locator. The
 * provider/backend message is intentionally discarded so it cannot become UI. */
export function parseAccountRecoveryError(status, body) {
  const parsed = parseAccountResolutionError(status, body);
  return parsed?.kind === "recovery_required"
    ? { recoveryCode: parsed.recoveryCode }
    : null;
}

/** Map only fixed server machine codes into UI states. Provider/backend
 * messages are discarded and can never become trusted markup. */
export function parseAccountResolutionError(status, body) {
  if (
    !body ||
    typeof body !== "object" ||
    !body.error ||
    typeof body.error !== "object"
  ) {
    return null;
  }
  const code = body.error.code;
  if (status === 409 && code === "account_exists") {
    return { kind: "account_exists" };
  }
  if (status === 401 && code === "reauthentication_required") {
    return { kind: "reauthentication_required" };
  }
  if (
    status === 401 &&
    ["account_deleted", "account_suspended", "identity_superseded"].includes(
      code,
    )
  ) {
    return { kind: "account_unavailable" };
  }
  if (status !== 409 || code !== "account_recovery_required") return null;
  const candidate = body.error.details?.recoveryCode;
  return {
    kind: "recovery_required",
    recoveryCode:
      typeof candidate === "string" && RECOVERY_CODE_RE.test(candidate)
        ? candidate
        : null,
  };
}

export function accountAccessPage({ kind, signOutHref }) {
  const content = {
    account_exists: {
      title: "Use your existing sign-in",
      line: "This email already signs in another way. Use that method.",
      primary: "Sign out",
    },
    // Signing out returns to the sign-in page, which is the fresh sign-in.
    reauthentication_required: {
      title: "Sign in again",
      line: "For your security, sign in once more to continue.",
      primary: "Sign in again",
    },
    account_unavailable: {
      title: "Account access unavailable",
      line: "This Zeros account is no longer active. Contact support if unexpected.",
      primary: "Sign out",
    },
  }[kind] ?? {
    title: "Account access unavailable",
    line: "Zeros couldn’t authorize this account. Contact support for help.",
    primary: "Sign out",
  };
  return shell(
    `Zeros · ${esc(content.title)}`,
    `<div class="title">${esc(content.title)}</div>
          <div class="sub">${esc(content.line)}</div>
          <div class="acts"><a class="btn" href="${esc(signOutHref)}">${esc(content.primary)}</a><a class="btn ghost" href="mailto:hi@zeros.build">Contact support</a></div>`,
  );
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

function recoveryCodeBox(code, hint) {
  return `<div class="box"><div class="box-row"><span class="box-text"><span class="box-name">Recovery code</span><span class="box-hint">${hint}</span></span><span class="box-ctl"><code class="code">${esc(code)}</code><button class="icon-btn" type="button" aria-label="Copy recovery code" data-copy="${esc(code)}">${COPY_ICON}</button></span></div></div>
          <script>document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => navigator.clipboard?.writeText(button.dataset.copy).catch(() => {})));</script>`;
}

/** A valid WorkOS ceremony can still require deliberate identity recovery.
 * Keep this out of the ordinary dashboard so it is never mislabeled as an
 * organization/network outage, and never serialize browser credentials. */
export function accountRecoveryPage({ recoveryCode, signOutHref }) {
  const safeRecoveryCode =
    typeof recoveryCode === "string" && RECOVERY_CODE_RE.test(recoveryCode)
      ? recoveryCode
      : null;
  return shell(
    "Zeros · Account recovery",
    `<div class="title">Account recovery required</div>
          <div class="sub">${safeRecoveryCode ? "Email hi@zeros.build with your recovery code to restore access." : "Email hi@zeros.build to ask for a reviewed recovery."}</div>
          ${safeRecoveryCode ? recoveryCodeBox(safeRecoveryCode, "Share only with Zeros support · expires in 24 hours") : ""}
          <div class="acts"><a class="btn" href="mailto:hi@zeros.build">Email support</a><a class="btn ghost" href="${esc(signOutHref)}">Sign out</a></div>`,
  );
}

/** A provider session may authenticate a deletion-pending identity only to the
 * exact lifecycle status/restore endpoints. This page contains no bearer or
 * sealed-session material; the host-only HttpOnly session remains server-side. */
export function accountDeletionPage({ deletion, signOutHref }) {
  const requestId =
    typeof deletion?.id === "string" && ORGANIZATION_ID_RE.test(deletion.id)
      ? deletion.id
      : null;
  const recoveryCode =
    typeof deletion?.recoveryCode === "string" &&
    DELETION_CODE_RE.test(deletion.recoveryCode)
      ? deletion.recoveryCode
      : null;
  const purgeDate = new Date(deletion?.purgeAfter ?? "");
  const purgeLabel = Number.isFinite(purgeDate.getTime())
    ? purgeDate.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : "the end of the recovery period";
  return shell(
    "Zeros · Restore account",
    `<div class="title">Account deletion scheduled</div>
          <div class="sub">Restore before ${esc(purgeLabel)} to keep your cloud account.</div>
          ${recoveryCode ? recoveryCodeBox(recoveryCode, "Identifies the request; it isn’t a password") : ""}
          <div class="acts"><button class="btn" id="restore-account" type="button" ${requestId ? "" : "disabled"}>Restore account</button><a class="btn ghost" href="${esc(signOutHref)}">Sign out</a></div>
          <div class="msg error" id="restore-account-error" role="alert"></div>
          <script type="application/json" id="account-deletion-data">${safeJson({ requestId })}</script>`,
    { head: `<script type="module" src="${dashboardAsset("/account-deletion.js")}"></script>` },
  );
}

function organizationLabel(org) {
  return org?.name?.trim() || "Personal";
}

function organizationAvatar(org, classes = "") {
  const logo = safeOrganizationLogo(org?.logo);
  return `<span class="avatar avatar-square ${classes}" aria-hidden="true">${
    logo
      ? `<img class="avatar-image" src="${esc(logo)}" alt="" />`
      : esc(initials(organizationLabel(org)))
  }</span>`;
}

function organizationOptions(organizations, activeId) {
  return organizations
    .map(
      (org) => `<button class="org-option" type="button" role="option"
        aria-selected="${org.id === activeId}" data-org-id="${esc(org.id)}">
        ${organizationAvatar(org)}
        <span class="org-option-copy"><strong>${esc(organizationLabel(org))}</strong><small>${org.isPersonal ? "Local workspaces only" : "Local + cloud workspaces"}</small></span>
        <span class="org-check" aria-hidden="true">${org.id === activeId ? "✓" : ""}</span>
      </button>`,
    )
    .join("");
}

function navButton(id, label, glyph, selected, disabled = false) {
  return `<button class="nav-item" type="button" data-section="${id}"
    aria-current="${selected === id ? "page" : "false"}" ${disabled ? "disabled" : ""}>
    <span aria-hidden="true">${glyph}</span><span>${label}</span>
  </button>`;
}

const SEAT_BADGES = {
  pro: '<span class="badge success">Pro</span>',
  free: '<span class="badge">Free</span>',
  hold: '<span class="badge warning">On Hold</span>',
};
const HOLD_NOTICE =
  '<div class="notice"><strong>You\'re on Hold</strong><p>You\'re still a member, but this organization\'s cloud workspaces and chats are unavailable to you. Get Pro, or ask an owner to free a seat.</p></div>';

function seatRow(seat) {
  if (typeof seat !== "string" || !Object.hasOwn(SEAT_BADGES, seat)) return "";
  return `<div class="settings-row"><span class="settings-copy"><strong>Your seat</strong><p>Pro, a free seat, or On Hold while the free seats are taken.</p></span><span class="settings-value">${SEAT_BADGES[seat]}</span></div>`;
}

function generalSection(org) {
  const editable = !org.isPersonal && ["owner", "admin"].includes(org.role);
  const logo = safeOrganizationLogo(org.logo);
  const logoActions = editable
    ? `<label class="button secondary file-button">Change<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-organization-logo hidden /></label>${logo ? '<button class="button secondary" type="button" data-action="remove-organization-logo">Remove</button>' : ""}`
    : "";
  const nameControl = editable
    ? `<form class="settings-row" data-form="rename-organization"><span class="settings-copy"><strong>Organization name</strong><p>Shown across Zeros and in invitations.</p></span><span class="settings-value settings-name-control"><input name="name" required maxlength="80" value="${esc(org.name)}" aria-label="Organization name" /><button class="button secondary" type="submit">Save</button></span></form>`
    : `<div class="settings-row"><span class="settings-copy"><strong>${org.isPersonal ? "Personal name" : "Organization name"}</strong><p>${org.isPersonal ? "Provided by your sign-in identity." : "Shown across Zeros and in invitations."}</p></span><span class="settings-value"><strong>${esc(organizationLabel(org))}</strong></span></div>`;
  return `<section class="section-stack"><div class="section-heading"><div><h1>General</h1><p>${org.isPersonal ? "Your permanent, device-local account space." : "Organization identity and workspace capabilities."}</p></div></div>
    <div class="card settings-card">
      <div class="settings-row"><span class="settings-copy"><strong>Logo</strong><p>Shown for this organization across Zeros.</p></span><span class="settings-value">${organizationAvatar(org, "avatar-large")}${logoActions}</span></div>
      ${nameControl}
      <div class="settings-row"><span class="settings-copy"><strong>Organization ID</strong><p>Your stable tenant identifier.</p></span><span class="settings-value"><code class="id-code">${esc(org.id)}</code><button class="icon-button copy-button" type="button" data-copy-organization-id="${esc(org.id)}" aria-label="Copy organization ID">▣</button></span></div>
      <div class="settings-row"><span class="settings-copy"><strong>Your role</strong><p>What you can do in this organization.</p></span><span class="settings-value"><span class="badge">${esc(org.role)}</span></span></div>
      ${seatRow(org.seat)}
    </div>
    ${org.seat === "hold" ? HOLD_NOTICE : ""}
    <div class="card"><div class="card-title"><div><strong>Workspace access</strong><p>Capability metadata; cloud provisioning will still enforce plan and quota.</p></div></div><div class="capability-grid"><div class="capability"><span class="status-dot success"></span><div><strong>Local workspaces</strong><p>Available on your Mac</p></div></div><div class="capability ${org.workspaceCapabilities?.cloud ? "" : "disabled"}"><span class="status-dot ${org.workspaceCapabilities?.cloud ? "success" : ""}"></span><div><strong>Cloud workspaces</strong><p>${org.workspaceCapabilities?.cloud ? "Organization eligible" : "Not available in Personal"}</p></div></div></div></div>
    ${org.isPersonal ? '<div class="notice"><strong>Personal is permanent</strong><p>Personal cannot be removed. It cannot invite members and stores workspace configuration locally.</p></div>' : org.role === "owner" ? `<div class="subsection-label">Danger zone</div><div class="card danger-card"><div class="card-title"><div><strong>Delete organization</strong><p>Revokes access immediately and keeps the organization recoverable for 30 days. The organization and retained cloud data are deleted only after the grace period.</p></div><button class="button danger" type="button" data-action="delete-organization">Delete organization</button></div></div>` : ""}
  </section>`;
}

function profileSection(user) {
  const displayName = user.name || "Zeros user";
  return `<section class="section-stack"><div class="section-heading"><div><h1>Profile</h1><p>Your browser account and sign-in identity.</p></div></div>
    <div class="card"><div class="identity-row"><span class="avatar avatar-large">${esc(initials(displayName || user.email))}</span><div><strong>${esc(displayName)}</strong><p>${esc(user.email)}</p></div></div></div>
    <div class="card"><div class="card-title"><div><strong>Account identity</strong><p>Your name and avatar come from your sign-in account. Profile editing will be available here later.</p></div><span class="badge">Sign-in profile</span></div></div>
    <div class="subsection-label">Danger zone</div><div class="card danger-card"><div class="card-title"><div><strong>Delete account</strong><p>Signs out every device immediately and keeps cloud account data recoverable for 30 days. Local Personal workspaces stay on each device.</p></div><button class="button danger" type="button" data-action="delete-account">Delete account</button></div></div>
  </section>`;
}

function initialSection(section, org, user, loadError) {
  if (loadError) {
    return `<div class="notice notice-error"><strong>Organization data is unavailable</strong><p>${esc(loadError)}</p><button class="button secondary" type="button" data-action="retry-me">Try again</button></div>`;
  }
  if (section === "profile") {
    return profileSection(user);
  }
  if (!org) {
    return `<div class="empty-state"><h1>Personal</h1><p>Your Personal space is being prepared. Refresh in a moment.</p></div>`;
  }
  if (section === "general") {
    return generalSection(org);
  }
  return `<section class="section-stack"><div class="section-heading"><div><h1>${section[0].toUpperCase() + section.slice(1)}</h1><p>Loading the latest organization data…</p></div></div><div class="card loading-card" aria-busy="true">Loading…</div></section>`;
}

export function dashboardPage({ session, me, requestUrl, signOutHref, loadError = null }) {
  const url = new URL(requestUrl);
  const organizations = (me?.organizations ?? me?.teams ?? []).map(
    (organization) => ({
      ...organization,
      logo: safeOrganizationLogo(organization.logo),
    }),
  );
  const requestedId = url.searchParams.get("organization");
  const active =
    organizations.find((org) => org.id === requestedId) ??
    organizations.find((org) => org.isPersonal) ??
    organizations[0] ??
    null;
  const requestedSection = url.searchParams.get("section");
  const candidateSection = SECTIONS.includes(requestedSection)
    ? requestedSection
    : active?.isPersonal
      ? "profile"
      : "general";
  // A copied organization-only deep link must never render a misleading
  // Personal loading state, even during the server-rendered first frame.
  const section =
    (!active || active.isPersonal) && COLLABORATIVE_SECTIONS.has(candidateSection)
      ? "profile"
      : candidateSection;
  const collaborativeDisabled = !active || active.isPersonal;
  const canCreateOrganization = organizationCreationAllowed(me?.capabilities);
  const requestedAction = url.searchParams.get("action");
  const action =
    requestedAction === "create-organization" && !canCreateOrganization
      ? null
      : requestedAction;
  const boot = {
    user: me?.user ?? {
      id: null,
      email: session.email,
      displayName: session.name,
      avatarUrl: null,
    },
    organizations,
    capabilities: me?.capabilities ?? { createOrganization: false },
    activeOrganizationId: active?.id ?? null,
    section,
    action,
    loadError,
  };
  const profileIdentity = {
    name: boot.user.displayName ?? session.name,
    email: boot.user.email ?? session.email,
  };

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Zeros · Organization settings</title>
  <link rel="stylesheet" href="${dashboardAsset("/dashboard.css")}" />
  <script type="module" src="${dashboardAsset("/dashboard.js")}"></script>
</head>
<body class="dashboard-page">
  <div class="app-shell">
    <aside class="sidebar" id="dashboard-sidebar" aria-label="Organization settings">
      <a class="brand" href="/" aria-label="Zeros home">${BRAND_MARK}<span>Zeros</span></a>
      <details class="org-switcher" id="org-switcher">
        <summary>${organizationAvatar(active)}<span class="summary-copy"><strong>${esc(organizationLabel(active))}</strong><small>${active?.isPersonal ? "Personal" : "Organization"}</small></span><span aria-hidden="true">⌄</span></summary>
        <div class="popover" role="listbox" aria-label="Organizations">
          <div class="popover-label">Organizations</div>
          <div id="organization-options">${organizationOptions(organizations, active?.id)}</div>
          <div id="create-organization-menu-slot" data-enabled="${String(canCreateOrganization)}">${organizationCreationMenu(canCreateOrganization)}</div>
        </div>
      </details>
      <nav class="section-nav" aria-label="Settings sections">
        <div class="nav-label">Account</div>
        ${navButton("profile", "Profile", "○", section)}
        <div class="nav-label">Organization</div>
        ${navButton("general", "General", "◇", section)}
        ${navButton("members", "Members", "♙", section, collaborativeDisabled)}
        ${navButton("teams", "Teams", "▦", section, collaborativeDisabled)}
        ${navButton("billing", "Billing", "▭", section, collaborativeDisabled)}
      </nav>
      <div class="sidebar-account"><span class="avatar">${esc(initials(session.name || session.email))}</span><span><strong>${esc(session.name || session.email)}</strong><small>${esc(session.email)}</small></span><a href="${esc(signOutHref)}">Sign out</a></div>
    </aside>
    <button class="mobile-scrim" type="button" data-action="close-mobile-nav" aria-label="Close navigation"></button>
    <main class="main-content">
      <header class="mobile-header">${BRAND_MARK}<strong>${esc(organizationLabel(active))}</strong><button type="button" data-action="toggle-mobile-nav" aria-label="Open navigation" aria-controls="dashboard-sidebar" aria-expanded="false"><span class="mobile-menu-glyph" aria-hidden="true"></span></button></header>
      <div class="content-column" id="dashboard-content">${initialSection(section, active, profileIdentity, loadError)}</div>
    </main>
  </div>
  <div id="create-organization-dialog-slot" data-enabled="${String(canCreateOrganization)}">${organizationCreationDialog(canCreateOrganization)}</div>
  <dialog id="delete-organization-dialog" class="dialog">
    <form method="dialog" id="delete-organization-form">
      <div class="dialog-header"><div><h2>Delete organization</h2><p>Access stops now. Recovery remains available to an owner for 30 days.</p></div><button class="icon-button" type="button" value="cancel" data-action="close-dialog" aria-label="Close">×</button></div>
      <label class="field"><span>Enter the exact organization name</span><input name="confirmation" maxlength="500" required autocomplete="off" /></label>
      <div class="dialog-error" id="delete-organization-error" role="alert"></div>
      <div class="dialog-actions"><button class="button secondary" type="button" value="cancel" data-action="close-dialog">Cancel</button><button class="button danger" type="submit" value="default">Schedule deletion</button></div>
    </form>
  </dialog>
  <dialog id="delete-account-dialog" class="dialog">
    <form method="dialog" id="delete-account-form">
      <div class="dialog-header"><div><h2>Delete account</h2><p>Every device is signed out now. Cloud account data is recoverable for 30 days; local Personal workspaces remain on your devices.</p></div><button class="icon-button" type="button" value="cancel" data-action="close-dialog" aria-label="Close">×</button></div>
      <label class="field"><span>Enter DELETE MY ACCOUNT</span><input name="confirmation" maxlength="64" required autocomplete="off" /></label>
      <div class="dialog-error" id="delete-account-error" role="alert"></div>
      <div class="dialog-actions"><button class="button secondary" type="button" value="cancel" data-action="close-dialog">Cancel</button><button class="button danger" type="submit" value="default">Schedule deletion</button></div>
    </form>
  </dialog>
  <div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="true"></div>
  <script type="application/json" id="dashboard-data">${safeJson(boot)}</script>
</body>
</html>`;
}
