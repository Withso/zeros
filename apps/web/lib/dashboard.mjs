const SECTIONS = ["profile", "general", "members", "teams", "billing"];
const COLLABORATIVE_SECTIONS = new Set(["members", "teams", "billing"]);
const ORGANIZATION_LOGO_MAX_CHARS = 200_000;
const ORGANIZATION_LOGO_RE =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const ORGANIZATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (source.searchParams.get("action") === "create-organization") {
    destination.searchParams.set("action", "create-organization");
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
    ${org.isPersonal ? '<div class="notice"><strong>Personal is permanent</strong><p>Personal cannot be removed. It cannot invite members and stores workspace configuration locally.</p></div>' : org.role === "owner" ? `<div class="subsection-label">Danger zone</div><div class="card danger-card"><div class="card-title"><div><strong>Delete organization</strong><p>Revokes pending invitations and removes the organization from Zeros. Cloud-resource cleanup will be coordinated here before cloud workspaces ship.</p></div><button class="button danger" type="button" data-action="delete-organization">Delete organization</button></div></div>` : ""}
  </section>`;
}

function profileSection(user) {
  const displayName = user.name || "Zeros user";
  return `<section class="section-stack"><div class="section-heading"><div><h1>Profile</h1><p>Your browser account and sign-in identity.</p></div></div>
    <div class="card"><div class="identity-row"><span class="avatar avatar-large">${esc(initials(displayName || user.email))}</span><div><strong>${esc(displayName)}</strong><p>${esc(user.email)}</p></div></div></div>
    <div class="card"><div class="card-title"><div><strong>Account identity</strong><p>Name and avatar are currently provided by Google or GitHub. Profile editing will be available here later.</p></div><span class="badge">Provider-managed</span></div></div>
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
  const boot = {
    user: me?.user ?? {
      id: null,
      email: session.email,
      displayName: session.name,
      avatarUrl: null,
    },
    organizations,
    activeOrganizationId: active?.id ?? null,
    section,
    action: url.searchParams.get("action"),
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
          <div class="menu-separator"></div>
          <button class="menu-action" type="button" data-action="create-organization"><span aria-hidden="true">＋</span>Create organization</button>
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
  <dialog id="create-organization-dialog" class="dialog">
    <form method="dialog" id="create-organization-form">
      <div class="dialog-header"><div><h2>Create organization</h2><p>Organizations can own local and cloud workspaces.</p></div><button class="icon-button" value="cancel" aria-label="Close">×</button></div>
      <label class="field"><span>Organization name</span><input name="name" maxlength="80" required autocomplete="organization" placeholder="Acme" /></label>
      <div class="dialog-error" id="create-organization-error" role="alert"></div>
      <div class="dialog-actions"><button class="button secondary" value="cancel">Cancel</button><button class="button primary" type="submit" value="default">Create organization</button></div>
    </form>
  </dialog>
  <div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="true"></div>
  <script type="application/json" id="dashboard-data">${safeJson(boot)}</script>
</body>
</html>`;
}
