const SECTIONS = ["profile", "general", "members", "teams", "billing"];
const COLLABORATIVE_SECTIONS = new Set(["members", "teams", "billing"]);
const ORGANIZATION_LOGO_MAX_CHARS = 200_000;
const ORGANIZATION_LOGO_RE =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const ORGANIZATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_CODE_RE = /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DELETION_CODE_RE = /^ZD-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

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

/** Preserve only dashboard navigation intent through a browser OAuth round
 * trip. Desktop handoff credentials and arbitrary query parameters must not be
 * copied into the post-login return URL. */
export function dashboardReturnUrl(appBase, requestUrl) {
  let source;
  try {
    source = new URL(requestUrl);
  } catch {
    return new URL("/", appBase).toString();
  }
  // `/launch` remains desktop guidance when it has no handoff credentials;
  // do not turn an OAuth round trip from that explicit entry into Dashboard.
  const destination = new URL(
    source.pathname === "/launch" ? "/launch" : "/",
    appBase,
  );
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

export function accountAccessPage({ session, kind, signOutHref }) {
  const identity = session.name || session.email || "Zeros user";
  const content = {
    account_exists: {
      title: "Use your existing sign-in",
      summary:
        "A Zeros account already uses this verified email with a different sign-in identity.",
      detail:
        "For your security, Zeros never links identities by matching email alone. Sign out and use the sign-in method you originally used, or contact Zeros support for reviewed help.",
    },
    reauthentication_required: {
      title: "Sign in again",
      summary:
        "A recent authentication is required before this identity can continue.",
      detail:
        "Sign out, then complete Hosted AuthKit again. This fresh proof protects account recovery and other sensitive changes.",
    },
    account_unavailable: {
      title: "Account access unavailable",
      summary: "This Zeros account is no longer active.",
      detail:
        "Sign out before trying another account. If you believe this is unexpected, contact Zeros support.",
    },
  }[kind] ?? {
    title: "Account access unavailable",
    summary: "Zeros could not authorize this account.",
    detail: "Sign out and contact Zeros support if the problem continues.",
  };
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Zeros · ${esc(content.title)}</title>
  <link rel="stylesheet" href="/dashboard.css" />
</head>
<body class="dashboard-page">
  <div class="app-shell">
    <aside class="sidebar" aria-label="Zeros account">
      <a class="brand" href="/" aria-label="Zeros home"><span class="brand-mark">Z</span><span>Zeros</span></a>
      <div class="sidebar-account"><span class="avatar">${esc(initials(identity))}</span><span><strong>${esc(identity)}</strong><small>${esc(session.email || "")}</small></span><a href="${esc(signOutHref)}">Sign out</a></div>
    </aside>
    <main class="main-content">
      <div class="content-column">
        <section class="section-stack">
          <div class="section-heading"><div><h1>${esc(content.title)}</h1><p>${esc(content.summary)}</p></div></div>
          <div class="notice notice-error"><strong>Access was stopped safely</strong><p>${esc(content.detail)}</p></div>
          <div><a class="button secondary" href="${esc(signOutHref)}">Sign out</a> <a class="button secondary" href="mailto:hello@zeros.build">Contact support</a></div>
        </section>
      </div>
    </main>
  </div>
</body>
</html>`;
}

/** A valid WorkOS ceremony can still require deliberate identity recovery.
 * Keep this out of the ordinary dashboard so it is never mislabeled as an
 * organization/network outage, and never serialize browser credentials. */
export function accountRecoveryPage({ session, recoveryCode, signOutHref }) {
  const safeRecoveryCode =
    typeof recoveryCode === "string" && RECOVERY_CODE_RE.test(recoveryCode)
      ? recoveryCode
      : null;
  const identity = session.name || session.email || "Zeros user";
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Zeros · Account recovery</title>
  <link rel="stylesheet" href="/dashboard.css" />
</head>
<body class="dashboard-page">
  <div class="app-shell">
    <aside class="sidebar" aria-label="Zeros account">
      <a class="brand" href="/" aria-label="Zeros home"><span class="brand-mark">Z</span><span>Zeros</span></a>
      <div class="sidebar-account"><span class="avatar">${esc(initials(identity))}</span><span><strong>${esc(identity)}</strong><small>${esc(session.email || "")}</small></span><a href="${esc(signOutHref)}">Sign out</a></div>
    </aside>
    <main class="main-content">
      <div class="content-column">
        <section class="section-stack">
          <div class="section-heading"><div><h1>Account recovery required</h1><p>Your sign-in completed securely, but it cannot be linked automatically.</p></div></div>
          <div class="notice notice-error">
            <strong>We protected your existing Zeros account</strong>
            <p>A previous WorkOS identity for this verified email was removed. Zeros never links a new identity by email alone, because that could let the wrong person take over the account.</p>
          </div>
          <div class="card">
            <div class="card-title"><div><strong>What to do</strong><p>Email <a href="mailto:hello@zeros.build">hello@zeros.build</a>${safeRecoveryCode ? " and include the recovery code below" : " for a reviewed recovery"}. The code is a support locator, not a password, and expires after 24 hours.</p></div></div>
            ${safeRecoveryCode ? `<div class="settings-row"><span class="settings-copy"><strong>Recovery code</strong><p>Share this only with Zeros support.</p></span><span class="settings-value"><code class="id-code">${esc(safeRecoveryCode)}</code></span></div>` : ""}
          </div>
          <div><a class="button secondary" href="${esc(signOutHref)}">Sign out</a></div>
        </section>
      </div>
    </main>
  </div>
</body>
</html>`;
}

/** A provider session may authenticate a deletion-pending identity only to the
 * exact lifecycle status/restore endpoints. This page contains no bearer or
 * sealed-session material; the host-only HttpOnly session remains server-side. */
export function accountDeletionPage({ session, deletion, signOutHref }) {
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
  const identity = session.name || session.email || "Zeros user";
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Zeros · Restore account</title>
  <link rel="stylesheet" href="/dashboard.css" />
  <script type="module" src="/account-deletion.js"></script>
</head>
<body class="dashboard-page">
  <div class="app-shell">
    <aside class="sidebar" aria-label="Zeros account">
      <a class="brand" href="/" aria-label="Zeros home"><span class="brand-mark">Z</span><span>Zeros</span></a>
      <div class="sidebar-account"><span class="avatar">${esc(initials(identity))}</span><span><strong>${esc(identity)}</strong><small>${esc(session.email || "")}</small></span><a href="${esc(signOutHref)}">Sign out</a></div>
    </aside>
    <main class="main-content"><div class="content-column">
      <section class="section-stack">
        <div class="section-heading"><div><h1>Account deletion scheduled</h1><p>Cloud account access was stopped immediately. Local Personal workspaces remain on your devices.</p></div></div>
        <div class="notice notice-error"><strong>Recovery is available for 30 days</strong><p>Restore this account before ${esc(purgeLabel)}. After that point, Zeros will delete the WorkOS identity and erase the retained cloud account data.</p></div>
        ${recoveryCode ? `<div class="card settings-card"><div class="settings-row"><span class="settings-copy"><strong>Recovery code</strong><p>This identifies the request; it is not authentication.</p></span><span class="settings-value"><code class="id-code">${esc(recoveryCode)}</code></span></div></div>` : ""}
        <div class="card"><div class="card-title"><div><strong>Restore account</strong><p>A recent WorkOS authentication is required. Previously revoked sessions remain signed out.</p></div><button class="button primary" id="restore-account" type="button" ${requestId ? "" : "disabled"}>Restore account</button></div><div class="dialog-error" id="restore-account-error" role="alert"></div></div>
        <a class="button secondary" href="${esc(signOutHref)}">Sign out</a>
      </section>
    </div></main>
  </div>
  <script type="application/json" id="account-deletion-data">${safeJson({ requestId })}</script>
</body></html>`;
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
    </div>
    <div class="card"><div class="card-title"><div><strong>Workspace access</strong><p>Capability metadata; cloud provisioning will still enforce plan and quota.</p></div></div><div class="capability-grid"><div class="capability"><span class="status-dot success"></span><div><strong>Local workspaces</strong><p>Available on your Mac</p></div></div><div class="capability ${org.workspaceCapabilities?.cloud ? "" : "disabled"}"><span class="status-dot ${org.workspaceCapabilities?.cloud ? "success" : ""}"></span><div><strong>Cloud workspaces</strong><p>${org.workspaceCapabilities?.cloud ? "Organization eligible" : "Not available in Personal"}</p></div></div></div></div>
    ${org.isPersonal ? '<div class="notice"><strong>Personal is permanent</strong><p>Personal cannot be removed. It cannot invite members and stores workspace configuration locally.</p></div>' : org.role === "owner" ? `<div class="subsection-label">Danger zone</div><div class="card danger-card"><div class="card-title"><div><strong>Delete organization</strong><p>Revokes access immediately and keeps the organization recoverable for 30 days. WorkOS and retained cloud data are deleted only after the grace period.</p></div><button class="button danger" type="button" data-action="delete-organization">Delete organization</button></div></div>` : ""}
  </section>`;
}

function profileSection(user) {
  const displayName = user.name || "Zeros user";
  return `<section class="section-stack"><div class="section-heading"><div><h1>Profile</h1><p>Your browser account and sign-in identity.</p></div></div>
    <div class="card"><div class="identity-row"><span class="avatar avatar-large">${esc(initials(displayName || user.email))}</span><div><strong>${esc(displayName)}</strong><p>${esc(user.email)}</p></div></div></div>
    <div class="card"><div class="card-title"><div><strong>Account identity</strong><p>Name and avatar are currently provided by Hosted AuthKit. Profile editing will be available here later.</p></div><span class="badge">Provider-managed</span></div></div>
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
  <link rel="stylesheet" href="/dashboard.css" />
  <script type="module" src="/dashboard.js"></script>
</head>
<body class="dashboard-page">
  <div class="app-shell">
    <aside class="sidebar" id="dashboard-sidebar" aria-label="Organization settings">
      <a class="brand" href="/" aria-label="Zeros home"><span class="brand-mark">Z</span><span>Zeros</span></a>
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
      <header class="mobile-header"><span class="brand-mark">Z</span><strong>${esc(organizationLabel(active))}</strong><button type="button" data-action="toggle-mobile-nav" aria-label="Open navigation" aria-controls="dashboard-sidebar" aria-expanded="false"><span class="mobile-menu-glyph" aria-hidden="true"></span></button></header>
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
