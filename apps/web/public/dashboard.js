export function organizationDisplayName(organization) {
  return organization?.name?.trim() || "Organization";
}

export function organizationCreationAllowed(capabilities) {
  return capabilities?.createOrganization === true;
}

const SEAT_BADGES = {
  pro: '<span class="badge success">Pro</span>',
  free: '<span class="badge">Free</span>',
  hold: '<span class="badge warning">On Hold</span>',
};

/** A member's seat; an older control plane sends none. */
export function seatBadgeHtml(seat) {
  return typeof seat === "string" && Object.hasOwn(SEAT_BADGES, seat)
    ? SEAT_BADGES[seat]
    : "";
}

export const HOLD_NOTICE_HTML =
  '<div class="notice"><strong>You\'re on Hold</strong><p>You\'re still a member, but this organization\'s cloud workspaces and chats are unavailable to you. Get Pro, or ask an owner to free a seat.</p></div>';

/** Seat usage for the member list, or null from an older control plane. */
export function seatSummary(seats) {
  if (!seats || typeof seats !== "object") return null;
  const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  const pending = count(seats.pendingInvitations);
  const held = count(seats.heldMembers);
  return `${count(seats.members)} of ${count(seats.memberLimit)} members${pending ? ` + ${pending} invited` : ""} · ${count(seats.freeMembers)} of ${count(seats.freeMemberLimit)} free seats${held ? ` · ${held} on Hold` : ""}`;
}

export function formatLifecycleDate(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "the scheduled date";
  return new Date(timestamp).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const ORGANIZATION_LOGO_MAX_CHARS = 200_000;
const ORGANIZATION_LOGO_RE =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export function safeOrganizationLogo(value) {
  return typeof value === "string" &&
    value.length <= ORGANIZATION_LOGO_MAX_CHARS &&
    ORGANIZATION_LOGO_RE.test(value)
    ? value
    : null;
}

/** Weakly keyed so detached, client-rendered forms are never retained. */
export function createSubmissionGate() {
  const active = new WeakSet();
  return {
    enter(key) {
      if (active.has(key)) return false;
      active.add(key);
      return true;
    },
    leave(key) {
      active.delete(key);
    },
  };
}

export async function tryWriteClipboard(clipboard, value) {
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

const COLLABORATIVE_SECTIONS = new Set(["members", "teams", "billing"]);
const SECURITY_REVALIDATE_SILENCE_MS = 60_000;

export function securityEventAction(kind) {
  if (kind === "account.revoked" || kind === "session.revoked") {
    return { signOut: true, refreshOrganizations: false };
  }
  if (
    kind === "account.authorization_changed" ||
    kind === "organization.access_revoked" ||
    kind === "organization.authorization_changed" ||
    kind === "organization.data_changed" ||
    kind === "workspace.authorization_changed"
  ) {
    return { signOut: false, refreshOrganizations: true };
  }
  return { signOut: false, refreshOrganizations: false };
}

function securitySnapshotSignature(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const organizations = Array.isArray(snapshot.organizations)
    ? snapshot.organizations
        .map((organization) => [
          organization.id,
          organization.role,
          organization.authorizationRevision,
          organization.membershipRevision,
          organization.dataRevision,
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    : [];
  return JSON.stringify([
    snapshot.account?.id,
    snapshot.account?.status,
    snapshot.account?.revision,
    snapshot.session?.id,
    snapshot.session?.status,
    organizations,
    Array.isArray(snapshot.workspaces) ? snapshot.workspaces.map(workspace=>[
      workspace.id,workspace.organizationId,workspace.role,workspace.accessRevision,workspace.dataRevision??1,
    ]).sort((left,right)=>String(left[0]).localeCompare(String(right[0]))) : [],
    snapshot.workspacesTruncated===true,
  ]);
}

export function securitySnapshotChanged(previous, next) {
  return (
    next?.workspacesTruncated===true ||
    securitySnapshotSignature(previous) !== securitySnapshotSignature(next)
  );
}

/** Drop only retained server state owned by the organization named by an
 * event. Account-wide/lifecycle changes have no exact owner and clear all
 * section snapshots. The confirmed organization shell stays visible while
 * render() revalidates the affected exact keys. */
export function invalidateExactSnapshot(snapshots, key, options = {}) {
  snapshots.delete(key);
  options.inflight?.delete(key);
  if (options.generations) {
    options.generations.set(key, (options.generations.get(key) || 0) + 1);
  }
}

export function invalidateOrganizationSnapshots(
  snapshots,
  organizationId,
  options = {},
) {
  const keys = new Set(snapshots.keys());
  for (const key of options.inflight?.keys() || []) keys.add(key);
  for (const key of options.generations?.keys() || []) keys.add(key);
  const prefix = organizationId ? `${organizationId}:` : null;
  for (const key of keys) {
    if (prefix === null || String(key).startsWith(prefix)) {
      invalidateExactSnapshot(snapshots, key, options);
    }
  }
}

/** Share one exact-key request while it is current. If a security event
 * invalidates that key before the response arrives, every waiter follows the
 * replacement request and the stale response can neither publish nor render. */
export function loadExactSnapshot(cache, key, loader) {
  const existing = cache.inflight.get(key);
  if (existing) return existing;
  const generation = cache.generations.get(key) || 0;
  let task;
  task = Promise.resolve()
    .then(loader)
    .then(
      (value) => {
        if ((cache.generations.get(key) || 0) !== generation) {
          if (cache.inflight.get(key) === task) cache.inflight.delete(key);
          return loadExactSnapshot(cache, key, loader);
        }
        cache.snapshots.set(key, value);
        return value;
      },
      (error) => {
        if ((cache.generations.get(key) || 0) !== generation) {
          if (cache.inflight.get(key) === task) cache.inflight.delete(key);
          return loadExactSnapshot(cache, key, loader);
        }
        throw error;
      },
    )
    .finally(() => {
      if (cache.inflight.get(key) === task) cache.inflight.delete(key);
    });
  cache.inflight.set(key, task);
  return task;
}

export function shouldRevalidateSecurityLifecycle(lastContactAt, now) {
  return now - lastContactAt >= SECURITY_REVALIDATE_SILENCE_MS;
}

export function collaborationSectionDisabled(organization, section) {
  return (
    (!organization || organization.isPersonal) &&
    COLLABORATIVE_SECTIONS.has(section)
  );
}

export function dashboardOrganizationDataUnavailable({
  loadError,
  organizations,
}) {
  return Boolean(loadError && organizations.length === 0);
}

export function sectionLoadErrorNeedsInlineRetry(snapshot) {
  return snapshot == null;
}

export function sectionRequestStillCurrent(
  activeOrganizationId,
  activeSection,
  requestedOrganizationId,
  requestedSection,
) {
  return (
    activeOrganizationId === requestedOrganizationId &&
    activeSection === requestedSection
  );
}

export function memberPermissions({
  actorRole,
  targetRole,
  isSelf,
  ownerCount,
  directoryManaged = false,
}) {
  if (directoryManaged) {
    return { canChangeRole: false, canRemove: false, availableRoles: [] };
  }
  const lastOwner = targetRole === "owner" && ownerCount <= 1;
  const ownerMayManage = actorRole === "owner";
  const adminMayManage = actorRole === "admin" && targetRole !== "owner";
  return {
    canChangeRole: !lastOwner && (ownerMayManage || adminMayManage),
    canRemove: !lastOwner && (isSelf || ownerMayManage || adminMayManage),
    availableRoles: ownerMayManage
      ? ["owner", "admin", "member"]
      : adminMayManage
        ? ["admin", "member"]
        : [],
  };
}

// ── Markup ─────────────────────────────────────────────────────────────────
// The page's markup, shared by the server's first paint (lib/dashboard.mjs)
// and every re-render here, so the two cannot drift. It follows the Zeros
// Design canvas's Web app dashboard frames. Every value is escaped here.

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
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

export function initials(value) {
  const words = String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
}

/** The web manages cloud organizations only: Personal is each device's local
 * account space, so it never appears in the list or the switcher. */
export function cloudOrganizations(organizations) {
  return (Array.isArray(organizations) ? organizations : [])
    .filter((organization) => organization && organization.isPersonal !== true)
    .map((organization) => ({
      ...organization,
      logo: safeOrganizationLogo(organization.logo),
    }));
}

const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };

export function roleLabel(role) {
  return Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role] : String(role ?? "");
}

export function formatShortDate(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const icon = (size, body, className = "") =>
  `<svg${className ? ` class="${className}"` : ""} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  profile: icon(14, '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  general: icon(14, '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  members: icon(14, '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  teams: icon(14, '<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>'),
  billing: icon(14, '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>'),
  chevrons: icon(12, '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>', "chevron"),
  plus: icon(14, '<path d="M5 12h14"/><path d="M12 5v14"/>'),
  copy: icon(12, '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  more: icon(14, '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  remove: icon(14, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  close: icon(12, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  mail: icon(12, '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  ok: icon(16, '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>', "toast-icon"),
  error: icon(16, '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>', "toast-icon"),
  // The 32px empty-state marks.
  organizations: icon(32, '<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>'),
  offline: icon(32, '<path d="m2 2 20 20"/><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/>'),
  alert: icon(32, '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'),
};

const ACCOUNT_SECTIONS = [["profile", "Profile"]];
const ORGANIZATION_SECTIONS = [
  ["general", "General"],
  ["members", "Members"],
  ["teams", "Teams"],
  ["billing", "Billing"],
];

export const SECTION_COPY = {
  members: { title: "Members", line: "Members join the default team automatically." },
  teams: { title: "Teams", line: "Teams group members and workspace access." },
  billing: { title: "Billing", line: "Plan, seats and payment for this organization." },
};

export function organizationAvatarHtml(organization, size = 28) {
  const logo = safeOrganizationLogo(organization?.logo);
  return `<span class="avatar square${size === 20 ? " size-20" : ""}" aria-hidden="true">${
    logo
      ? `<img class="avatar-image" src="${escapeHtml(logo)}" alt="" />`
      : escapeHtml(initials(organizationDisplayName(organization)))
  }</span>`;
}

function navRowHtml(id, name, section) {
  return `<button class="nav-row" type="button" data-section="${id}" aria-current="${section === id ? "page" : "false"}">${ICONS[id]}<span class="nav-name">${name}</span></button>`;
}

/** The switcher's menu items, one per cloud organization, with the role you
 * hold in it. */
function organizationMenuHtml(organizations, activeId, email, canCreate) {
  const items = organizations
    .map(
      (organization) =>
        `<button class="menu-item" type="button" role="menuitemradio" aria-checked="${organization.id === activeId}" data-org-id="${escapeHtml(organization.id)}">${organizationAvatarHtml(organization, 20)}<span class="menu-name">${escapeHtml(organizationDisplayName(organization))}</span><span class="menu-meta">${escapeHtml(roleLabel(organization.role))}</span><span class="menu-check" aria-hidden="true">${organization.id === activeId ? "✓" : ""}</span></button>`,
    )
    .join("");
  const create = canCreate
    ? `<div class="menu-sep" role="separator"></div><button class="menu-item" type="button" role="menuitem" data-action="create-organization">${ICONS.plus}Create organization</button>`
    : "";
  return `<div class="menu org-menu" role="menu" aria-label="Organizations">${email ? `<p class="menu-label">${escapeHtml(email)}</p>` : ""}${items}${create}</div>`;
}

/** The sidebar's rows: the organization switcher first, then Account and,
 * with an organization, Organization. `orgList` is "ready", "loading" (a
 * retry in flight) or "unavailable" (the list couldn't load). */
export function navHtml({
  organizations = [],
  activeId = null,
  section = "profile",
  canCreate = false,
  email = "",
  orgList = "ready",
}) {
  const active =
    organizations.find((organization) => organization.id === activeId) ??
    organizations[0] ??
    null;
  let first = "";
  if (orgList === "loading") {
    first = '<div class="nav-row org-row" aria-hidden="true"><span class="skel-av square"></span><span class="skel name"></span></div>';
  } else if (orgList === "ready" && active) {
    first = `<details class="org-switcher" id="org-switcher"><summary class="nav-row org-row">${organizationAvatarHtml(active, 20)}<span class="nav-name">${escapeHtml(organizationDisplayName(active))}</span>${ICONS.chevrons}</summary>${organizationMenuHtml(organizations, active.id, email, canCreate)}</details>`;
  } else if (orgList === "ready" && canCreate) {
    first = `<button class="nav-row org-row" type="button" data-action="create-organization">${ICONS.plus}<span class="nav-name">Create organization</span></button>`;
  }
  const list = (rows) =>
    `<div class="nav-list">${rows.map(([id, name]) => navRowHtml(id, name, section)).join("")}</div>`;
  return `${first}<p class="nav-label${first ? "" : " first"}">Account</p>${list(ACCOUNT_SECTIONS)}${
    orgList === "ready" && active
      ? `<p class="nav-label">Organization</p>${list(ORGANIZATION_SECTIONS)}`
      : ""
  }`;
}

function headHtml(title, line = "") {
  return `<header class="page-head"><div><h1>${escapeHtml(title)}</h1>${line ? `<p>${escapeHtml(line)}</p>` : ""}</div></header>`;
}

function groupHtml(title, description, body) {
  return `<section class="group">${title ? `<h2 class="group-title">${escapeHtml(title)}</h2>` : ""}${description ? `<p class="group-desc">${escapeHtml(description)}</p>` : ""}${body}</section>`;
}

function textHtml(name, hint = "") {
  return `<span class="row-text"><span class="row-name">${name}</span>${hint ? `<span class="row-hint">${hint}</span>` : ""}</span>`;
}

function rowHtml(text, controls = "", who = "") {
  return `<div class="row">${who ? `<span class="row-who">${who}${text}</span>` : text}${controls ? `<span class="row-ctl">${controls}</span>` : ""}</div>`;
}

function emptyCardHtml(mark, line, action = "") {
  return `<div class="card"><div class="empty">${mark}<p>${escapeHtml(line)}</p>${action}</div></div>`;
}

/** Profile: who you are, Organizations when you have none (or while the list
 * is loading or unavailable), recoverable organizations, Sessions and Delete
 * account. */
export function profileHtml({
  user,
  signOutHref,
  deletions = [],
  hasOrganizations = true,
  canCreate = false,
  orgList = "ready",
}) {
  const name = user?.displayName || "Zeros user";
  const identity = groupHtml(
    "",
    "",
    `<div class="card">${rowHtml(
      textHtml(escapeHtml(name), escapeHtml(user?.email)),
      '<span class="badge">Sign-in profile</span>',
      `<span class="avatar size-40" aria-hidden="true">${escapeHtml(initials(user?.displayName || user?.email))}</span>`,
    )}</div><p class="group-line">Name and avatar come from your sign-in provider.</p>`,
  );
  let organizations = "";
  if (orgList === "loading") {
    organizations = groupHtml(
      "Organizations",
      "",
      '<div class="card"><div class="empty" aria-busy="true"><span class="orb" aria-hidden="true"></span><p>Loading your organizations…</p></div></div>',
    );
  } else if (orgList === "unavailable") {
    organizations = groupHtml(
      "Organizations",
      "",
      emptyCardHtml(
        ICONS.offline,
        "Couldn’t reach Zeros. You’re still signed in.",
        '<button class="button secondary" type="button" data-action="retry-me">Try again</button>',
      ),
    );
  } else if (!hasOrganizations && canCreate) {
    organizations = groupHtml(
      "Organizations",
      "",
      emptyCardHtml(
        ICONS.organizations,
        "Create a cloud organization to share workspaces, members and settings.",
        `<button class="button primary" type="button" data-action="create-organization">${ICONS.plus}Create organization</button>`,
      ),
    );
  }
  const recoverable = deletions.length
    ? groupHtml(
        "Recoverable organizations",
        "An owner can restore these within 30 days.",
        `<div class="card">${deletions
          .map((deletion) => {
            const label = deletion.targetName || "Organization";
            return rowHtml(
              textHtml(
                escapeHtml(label),
                `Restore before ${escapeHtml(formatLifecycleDate(deletion.purgeAfter))} · ${escapeHtml(deletion.recoveryCode)}`,
              ),
              `<button class="button secondary" type="button" data-restore-organization="${escapeHtml(deletion.targetId)}" data-deletion-request="${escapeHtml(deletion.id)}" aria-label="Restore ${escapeHtml(label)}">Restore</button>`,
              `<span class="avatar square" aria-hidden="true">${escapeHtml(initials(label))}</span>`,
            );
          })
          .join("")}</div>`,
      )
    : "";
  const sessions = groupHtml(
    "Sessions",
    "",
    `<div class="card">${rowHtml(
      textHtml("Sign out", "Sign out of Zeros in this browser."),
      `<a class="button secondary" href="${escapeHtml(signOutHref)}">Sign out</a>`,
    )}</div>`,
  );
  const deleteAccount = groupHtml(
    "Delete account",
    "",
    `<div class="card">${rowHtml(
      textHtml("Delete account", "Signs out everywhere. Recoverable for 30 days; local work stays."),
      '<button class="button danger-secondary" type="button" data-action="delete-account">Delete account</button>',
    )}</div>`,
  );
  return `${headHtml("Profile")}${identity}${organizations}${recoverable}${sessions}${deleteAccount}`;
}

const canAdminister = (organization) =>
  organization?.role === "owner" || organization?.role === "admin";

/** General: the organization's logo, name, ID and your role; owners can
 * schedule its deletion. */
export function generalHtml(organization) {
  const editable = canAdminister(organization);
  const name = organizationDisplayName(organization);
  const logo = safeOrganizationLogo(organization.logo);
  const logoControls = editable
    ? `<label class="button secondary">Change<input class="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-organization-logo /></label>${logo ? '<button class="button ghost" type="button" data-action="remove-organization-logo">Remove</button>' : ""}`
    : "";
  const nameText = textHtml("Name", "Shown across Zeros and in invitations.");
  const nameRow = editable
    ? `<form class="row" data-form="rename-organization">${nameText}<span class="row-ctl"><input class="input" name="name" required maxlength="80" value="${escapeHtml(organization.name)}" aria-label="Organization name" /><button class="button secondary" type="submit">Save</button></span></form>`
    : rowHtml(nameText, `<span class="row-value">${escapeHtml(name)}</span>`);
  const seat = seatBadgeHtml(organization.seat);
  const rows = [
    rowHtml(
      textHtml("Logo", `Shown for ${escapeHtml(name)} across Zeros.`),
      logoControls,
      organizationAvatarHtml(organization),
    ),
    nameRow,
    rowHtml(
      textHtml("Organization ID", "Your stable tenant identifier."),
      `<code class="id-code">${escapeHtml(organization.id)}</code><button class="icon-button" type="button" data-copy-organization-id="${escapeHtml(organization.id)}" aria-label="Copy organization ID">${ICONS.copy}</button>`,
    ),
    rowHtml(textHtml("Your role"), `<span class="badge">${escapeHtml(roleLabel(organization.role))}</span>`),
    seat
      ? rowHtml(textHtml("Your seat", "Pro, a free seat, or On Hold while the free seats are taken."), seat)
      : "",
  ].join("");
  return `${headHtml("General")}${groupHtml("Organization", "", `<div class="card">${rows}</div>${organization.seat === "hold" ? HOLD_NOTICE_HTML : ""}`)}${
    organization.role === "owner"
      ? groupHtml(
          "Delete organization",
          "",
          `<div class="card">${rowHtml(
            textHtml("Delete organization", "Removes access now. An owner can restore it for 30 days."),
            '<button class="button danger-secondary" type="button" data-action="delete-organization">Delete organization</button>',
          )}</div>`,
        )
      : ""
  }`;
}

function memberActionsHtml(member, name, isSelf) {
  return `<button class="icon-button standard" type="button" aria-label="More actions for ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false" data-member-menu="${escapeHtml(member.id)}">${ICONS.more}</button><div class="menu row-menu" role="menu" hidden><button class="menu-item danger" type="button" role="menuitem" data-remove-member="${escapeHtml(member.id)}">${isSelf ? "Leave organization" : "Remove from organization"}</button></div>`;
}

function memberRowHtml(member, { organization, userId, ownerCount, aligned }) {
  const name = member.display_name || member.email;
  const isSelf = member.id === userId;
  const directoryManaged = member.directory_managed === true;
  const permissions = memberPermissions({
    actorRole: organization.role,
    targetRole: member.role,
    isSelf,
    ownerCount,
    directoryManaged,
  });
  const role = permissions.canChangeRole
    ? `<select class="select compact" aria-label="Role for ${escapeHtml(name)}" data-member-role="${escapeHtml(member.id)}">${permissions.availableRoles
        .map(
          (option) =>
            `<option value="${option}"${member.role === option ? " selected" : ""}>${roleLabel(option)}</option>`,
        )
        .join("")}</select>`
    : `<span class="badge">${escapeHtml(roleLabel(member.role))}</span>`;
  const action = !permissions.canRemove
    ? aligned
      ? '<span class="slot" aria-hidden="true"></span>'
      : ""
    : isSelf && !permissions.canChangeRole
      ? `<button class="button ghost" type="button" data-remove-member="${escapeHtml(member.id)}">Leave</button>`
      : memberActionsHtml(member, name, isSelf);
  return rowHtml(
    textHtml(
      `${escapeHtml(name)}${isSelf ? " (you)" : ""}`,
      `${escapeHtml(member.email)}${directoryManaged ? " · Directory managed" : ""}`,
    ),
    `${seatBadgeHtml(member.seat)}${role}${action}`,
    `<span class="avatar" aria-hidden="true">${escapeHtml(initials(name))}</span>`,
  );
}

/** Members: the invite form for admins, every member with the controls your
 * role allows, then pending invitations. */
export function membersHtml({ organization, data, userId }) {
  const admin = canAdminister(organization);
  const members = Array.isArray(data?.members) ? data.members : [];
  const invitations = Array.isArray(data?.invitations) ? data.invitations : [];
  const seats = seatSummary(data?.seats);
  const ownerCount = members.filter((member) => member.role === "owner").length;
  const held = members.some((member) => member.id === userId && member.seat === "hold");
  const invite = admin
    ? groupHtml(
        "Invite member",
        "They sign in with this exact email address.",
        '<div class="card"><form class="invite-form" data-form="invite-member"><label>Email address<input class="input" name="email" type="email" maxlength="254" required autocomplete="off" placeholder="teammate@example.com" /></label><label>Role<select class="select" name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label><button class="button primary" type="submit">Send invite</button></form></div>',
      )
    : "";
  const list = groupHtml(
    "Members",
    seats ?? `${members.length} ${members.length === 1 ? "member" : "members"}`,
    `<div class="card">${members
      .map((member) => memberRowHtml(member, { organization, userId, ownerCount, aligned: admin }))
      .join("")}</div>`,
  );
  const pending =
    admin && invitations.length
      ? groupHtml(
          "Pending invitations",
          `Unused invitations expire on their own.${seats ? " Each one holds a seat until then." : ""}`,
          `<div class="card">${invitations
            .map((invite) => {
              const expires = formatShortDate(invite.expires_at);
              return rowHtml(
                textHtml(escapeHtml(invite.email), expires ? `Expires ${escapeHtml(expires)}` : "Pending"),
                `<span class="badge">${escapeHtml(roleLabel(invite.role))}</span><button class="icon-button standard" type="button" data-revoke-invite="${escapeHtml(invite.id)}" aria-label="Revoke invitation for ${escapeHtml(invite.email)}">${ICONS.remove}</button>`,
                `<span class="avatar vacant" aria-hidden="true">${ICONS.mail}</span>`,
              );
            })
            .join("")}</div>`,
        )
      : "";
  return `${headHtml("Members", `${SECTION_COPY.members.line}${admin ? "" : " Only admins can invite."}`)}${held ? HOLD_NOTICE_HTML : ""}${invite}${list}${pending}`;
}

/** Teams: one default team for now. */
export function teamsHtml({ organization, data }) {
  const teams = Array.isArray(data?.teams) ? data.teams : [];
  const name = organizationDisplayName(organization);
  return `${headHtml(SECTION_COPY.teams.title, SECTION_COPY.teams.line)}${groupHtml(
    "Organization teams",
    "More teams are coming. Everyone is in the default team.",
    `<div class="card">${teams
      .map((team) =>
        rowHtml(
          textHtml(escapeHtml(team.name), team.is_default ? `Everyone in ${escapeHtml(name)}` : escapeHtml(team.slug)),
          `<span class="badge">${team.is_default ? "Default" : escapeHtml(roleLabel(team.role))}</span>`,
          `<span class="avatar square" aria-hidden="true">${escapeHtml(initials(team.name))}</span>`,
        ),
      )
      .join("")}</div>`,
  )}`;
}

const capitalize = (value) => {
  const text = String(value ?? "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
};

/** Billing: the plan, until checkout and invoices arrive. */
export function billingHtml({ data }) {
  const billing = data?.billing ?? {};
  const subscription = billing.subscription ?? null;
  const count = Number.isSafeInteger(billing.memberCount) && billing.memberCount > 0 ? billing.memberCount : 1;
  const hint = subscription
    ? `${capitalize(subscription.status)} · ${subscription.seats} ${subscription.seats === 1 ? "seat" : "seats"}`
    : `${count} ${count === 1 ? "member" : "members"}`;
  const badge = subscription
    ? `<span class="badge${subscription.status === "active" ? " success" : ""}">${escapeHtml(capitalize(subscription.status))}</span>`
    : '<span class="badge">No subscription</span>';
  return `${headHtml(SECTION_COPY.billing.title, SECTION_COPY.billing.line)}${groupHtml(
    "Plan",
    "Checkout, invoices and payment methods are coming soon.",
    `<div class="card">${rowHtml(textHtml(escapeHtml(capitalize(subscription?.plan) || "Free"), escapeHtml(hint)), badge)}</div>`,
  )}`;
}

/** A section's first load: its heading over three skeleton rows. */
export function sectionLoadingHtml(section) {
  const copy = SECTION_COPY[section];
  const skeleton =
    '<div class="row"><span class="row-who"><span class="skel-av"></span><span class="row-text"><span class="skel name"></span><span class="skel hint"></span></span></span><span class="skel ctl"></span></div>';
  return `${headHtml(copy.title, copy.line)}<section class="group" aria-busy="true" aria-label="Loading ${copy.title.toLowerCase()}"><div class="card">${skeleton.repeat(3)}</div></section>`;
}

/** A section whose first load failed, with a retry. */
export function sectionErrorHtml(section) {
  const copy = SECTION_COPY[section];
  return `${headHtml(copy.title)}<section class="group">${emptyCardHtml(
    ICONS.alert,
    `Zeros couldn’t load ${copy.title.toLowerCase()}. Try again.`,
    '<button class="button secondary" type="button" data-action="retry-section">Try again</button>',
  )}</section>`;
}

function dialogHtml({ id, title, line, field, error, submit, destructive = false }) {
  return `<dialog id="${id}-dialog" class="dialog" aria-labelledby="${id}-title">
    <form method="dialog" id="${id}-form">
      <div class="dialog-head"><div class="dialog-titlerow"><h2 class="dialog-title" id="${id}-title">${title}</h2><button class="icon-button" type="button" value="cancel" data-action="close-dialog" aria-label="Close">${ICONS.close}</button></div><p class="dialog-desc">${line}</p></div>
      <div class="dialog-body">${field}<div class="dialog-error" id="${error}" role="alert"></div></div>
      <div class="dialog-foot"><button class="button ghost" type="button" value="cancel" data-action="close-dialog">Cancel</button><button class="button ${destructive ? "danger" : "primary"}" type="submit" value="default">${submit}</button></div>
    </form>
  </dialog>`;
}

export function createOrganizationDialogHtml() {
  return dialogHtml({
    id: "create-organization",
    title: "Create organization",
    line: "Organizations share workspaces, members and settings.",
    field: '<label class="field"><span>Organization name</span><input class="input" name="name" maxlength="80" required autocomplete="organization" placeholder="Acme" /></label>',
    error: "create-organization-error",
    submit: "Create organization",
  });
}

/** The confirmation names the organization; opening the dialog refreshes it
 * for the active one. */
export function deleteOrganizationDialogHtml(name = "") {
  return dialogHtml({
    id: "delete-organization",
    title: "Delete organization",
    line: "Access stops now. An owner can restore it for 30 days.",
    field: `<label class="field"><span data-confirmation-label>Type ${escapeHtml(name)} to confirm</span><input class="input" name="confirmation" maxlength="500" required autocomplete="off" placeholder="${escapeHtml(name)}" /></label>`,
    error: "delete-organization-error",
    submit: "Schedule deletion",
    destructive: true,
  });
}

export function deleteAccountDialogHtml() {
  return dialogHtml({
    id: "delete-account",
    title: "Delete account",
    line: "Signs out every device. Recoverable for 30 days; local work stays.",
    field: '<label class="field"><span>Type DELETE MY ACCOUNT to confirm</span><input class="input" name="confirmation" maxlength="64" required autocomplete="off" placeholder="DELETE MY ACCOUNT" /></label>',
    error: "delete-account-error",
    submit: "Schedule deletion",
    destructive: true,
  });
}

const TOAST_LIMIT = 3;

function bootDashboard() {
  "use strict";

  const bootNode = document.getElementById("dashboard-data");
  const content = document.getElementById("dashboard-content");
  const nav = document.getElementById("dashboard-nav");
  if (!bootNode || !content) return;

  const boot = JSON.parse(bootNode.textContent || "{}");
  const state = {
    user: boot.user,
    capabilities: boot.capabilities || {},
    organizations: cloudOrganizations(boot.organizations),
    activeOrganizationId: boot.activeOrganizationId,
    section: boot.section || "profile",
    loadError: boot.loadError || null,
    signOutHref: boot.signOutHref || "/auth/logout",
    organizationsLoading: false,
    deletions: [],
  };
  const snapshots = new Map();
  const inflight = new Map();
  const snapshotGenerations = new Map();
  const snapshotCache = {
    snapshots,
    inflight,
    generations: snapshotGenerations,
  };
  const submissions = createSubmissionGate();
  let securitySnapshot = null;
  let securityEventSource = null;
  let securityRevalidation = null;
  let securityRefreshQueued = false;
  let securitySigningOut = false;
  let lastSecurityContactAt = 0;

  const replaceOrganization = (organization) => {
    const index = state.organizations.findIndex(
      (item) => item.id === organization?.id,
    );
    // Rename and logo responses carry no seat, and neither edit changes it.
    const seat = organization?.seat ?? state.organizations[index]?.seat;
    const [next] = cloudOrganizations([
      seat ? { ...organization, seat } : organization,
    ]);
    if (index >= 0 && next) state.organizations[index] = next;
    return next;
  };

  async function fileToOrganizationLogo(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(
        "That file doesn't look like an image — use a PNG, JPEG, WebP, or GIF.",
      );
    }
    try {
      const side = Math.min(bitmap.width, bitmap.height);
      if (side < 1) throw new Error("That image is empty.");
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Couldn't process the image — try a different file.");
      }
      context.imageSmoothingQuality = "high";
      context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        256,
        256,
      );
      let url = canvas.toDataURL("image/webp", 0.85);
      if (!url.startsWith("data:image/webp")) {
        url = canvas.toDataURL("image/png");
      }
      if (!safeOrganizationLogo(url)) {
        throw new Error(
          "That image is too detailed to compress — try a simpler one.",
        );
      }
      return url;
    } finally {
      bitmap.close?.();
    }
  }
  const activeOrganization = () =>
    state.organizations.find(
      (organization) => organization.id === state.activeOrganizationId,
    ) ||
    state.organizations[0] ||
    null;
  const canAdmin = (organization) =>
    organization &&
    (organization.role === "owner" || organization.role === "admin");
  const orgList = () =>
    dashboardOrganizationDataUnavailable(state)
      ? state.organizationsLoading
        ? "loading"
        : "unavailable"
      : "ready";
  const navModel = () => ({
    organizations: state.organizations,
    activeId: activeOrganization()?.id ?? null,
    canCreate: organizationCreationAllowed(state.capabilities),
    email: state.user?.email || "",
    orgList: orgList(),
  });
  const profileModel = () => ({
    user: state.user,
    signOutHref: state.signOutHref,
    deletions: state.deletions,
    hasOrganizations: state.organizations.length > 0,
    canCreate: organizationCreationAllowed(state.capabilities),
    orgList: orgList(),
  });

  function syncOrganizationCreationSurface() {
    const allowed = organizationCreationAllowed(state.capabilities);
    const slot = document.getElementById("create-organization-dialog-slot");
    if (!slot || slot.dataset.enabled === String(allowed)) return;
    slot.innerHTML = allowed ? createOrganizationDialogHtml() : "";
    slot.dataset.enabled = String(allowed);
  }

  function toast(message, error = false) {
    const region = document.getElementById("toast-region");
    if (!region) return;
    const node = document.createElement("div");
    node.className = `toast${error ? " error" : ""}`;
    node.innerHTML = `${error ? ICONS.error : ICONS.ok}<span class="toast-title"></span><button class="icon-button" type="button" aria-label="Dismiss" data-action="dismiss-toast">${ICONS.close}</button>`;
    node.querySelector(".toast-title").textContent = message;
    region.append(node);
    while (region.childElementCount > TOAST_LIMIT) {
      region.firstElementChild?.remove();
    }
    window.setTimeout(() => node.remove(), 4500);
  }

  function setMobileNavigationOpen(open) {
    document.body.classList.toggle("mobile-nav-open", open);
    const toggle = document.querySelector('[data-action="toggle-mobile-nav"]');
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute(
        "aria-label",
        open ? "Close navigation" : "Open navigation",
      );
    }
  }

  /** Close the switcher and any member menu, except the one holding `keep`. */
  function closeMenus(keep = null) {
    const switcher = document.getElementById("org-switcher");
    if (switcher?.open && !(keep && switcher.contains(keep))) {
      switcher.removeAttribute("open");
    }
    document
      .querySelectorAll('[data-member-menu][aria-expanded="true"]')
      .forEach((button) => {
        if (keep && button.parentElement?.contains(keep)) return;
        button.setAttribute("aria-expanded", "false");
        const menu = button.nextElementSibling;
        if (menu) menu.hidden = true;
      });
  }

  async function api(path, options = {}) {
    const method = options.method || "GET";
    const response = await fetch(`/api${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(method !== "GET"
          ? {
              "content-type": "application/json",
              "x-zeros-request": "dashboard",
            }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        body?.error?.message ||
          (method === "GET"
            ? "Couldn’t reach Zeros. You’re still signed in."
            : "Zeros couldn’t save that change. Try again."),
      );
      error.code = body?.error?.code || "request_failed";
      error.status = response.status;
      error.details = body?.error?.details;
      throw error;
    }
    return body;
  }

  function beginStepUp(action) {
    const returnTo = new URL(window.location.href);
    returnTo.searchParams.set("action", action);
    window.location.assign(
      `/auth/start?max_age=300&return=${encodeURIComponent(returnTo.toString())}`,
    );
  }

  function updateUrl() {
    const url = new URL(window.location.href);
    if (state.activeOrganizationId)
      url.searchParams.set("organization", state.activeOrganizationId);
    else url.searchParams.delete("organization");
    url.searchParams.set("section", state.section);
    url.searchParams.delete("action");
    history.replaceState(null, "", url);
  }

  // The server painted the sidebar from the same boot data and builder, so
  // the first sync only marks the current section.
  let navStructure = navHtml({ ...navModel(), section: null });

  function syncChrome() {
    syncOrganizationCreationSurface();
    const organization = activeOrganization();
    state.activeOrganizationId = organization?.id ?? null;
    if (nav) {
      const model = navModel();
      const structure = navHtml({ ...model, section: null });
      if (structure !== navStructure) {
        // Re-rendering the rows drops focus; put it back on the same control.
        const active = document.activeElement;
        const focusedSection = nav.contains(active)
          ? active.closest?.("[data-section]")?.dataset.section
          : null;
        const switcherFocused = Boolean(active?.closest?.("#org-switcher"));
        nav.innerHTML = navHtml({ ...model, section: state.section });
        navStructure = structure;
        if (focusedSection) {
          nav.querySelector(`[data-section="${focusedSection}"]`)?.focus();
        } else if (switcherFocused) {
          nav.querySelector("#org-switcher > summary")?.focus();
        }
      }
      nav.querySelectorAll("[data-section]").forEach((node) => {
        node.setAttribute(
          "aria-current",
          node.dataset.section === state.section ? "page" : "false",
        );
      });
    }
    const mobileTitle = document.querySelector(".mobile-header strong");
    if (mobileTitle) {
      mobileTitle.textContent = organization
        ? organizationDisplayName(organization)
        : "";
    }
  }

  function syncDeleteOrganizationDialog(organization) {
    const dialog = document.getElementById("delete-organization-dialog");
    if (!dialog || !organization) return dialog;
    const name = organization.name || "";
    const label = dialog.querySelector("[data-confirmation-label]");
    if (label) label.textContent = `Type ${name} to confirm`;
    const input = dialog.querySelector('input[name="confirmation"]');
    if (input) {
      input.value = "";
      input.placeholder = name;
    }
    const errorNode = document.getElementById("delete-organization-error");
    if (errorNode) errorNode.textContent = "";
    return dialog;
  }

  async function loadExact(key, loader) {
    return loadExactSnapshot(snapshotCache, key, loader);
  }

  async function render() {
    if (!activeOrganization() && state.section !== "profile") {
      state.section = "profile";
    }
    syncChrome();
    updateUrl();
    const organization = activeOrganization();
    if (state.section === "profile") {
      content.innerHTML = profileHtml(profileModel());
      try {
        const value = await loadExact("account:deletions", () =>
          api("/v1/deletions"),
        );
        state.deletions = Array.isArray(value.deletions) ? value.deletions : [];
        if (state.section === "profile") {
          content.innerHTML = profileHtml(profileModel());
        }
      } catch (error) {
        // An unreachable control plane already shows its retry on the page.
        if (!dashboardOrganizationDataUnavailable(state)) {
          toast(error.message, true);
        }
      }
      return;
    }
    if (state.section === "general") {
      content.innerHTML = generalHtml(organization);
      return;
    }

    const section = state.section;
    const key = `${organization.id}:${section}`;
    const prior = snapshots.get(key);
    const paint = (value) =>
      section === "members"
        ? membersHtml({ organization, data: value, userId: state.user?.id })
        : section === "teams"
          ? teamsHtml({ organization, data: value })
          : billingHtml({ data: value });
    content.innerHTML = prior ? paint(prior) : sectionLoadingHtml(section);
    try {
      const value = await loadExact(key, async () => {
        if (section === "teams") {
          return api(`/v1/organizations/${organization.id}/teams`);
        }
        if (section === "billing") {
          return api(`/v1/organizations/${organization.id}/billing`);
        }
        const [members, invitations] = await Promise.all([
          api(`/v1/organizations/${organization.id}/members`),
          canAdmin(organization)
            ? api(`/v1/organizations/${organization.id}/invitations`)
            : Promise.resolve({ invitations: [] }),
        ]);
        return {
          members: members.members,
          seats: members.seats,
          invitations: invitations.invitations,
        };
      });
      if (
        sectionRequestStillCurrent(
          activeOrganization()?.id,
          state.section,
          organization.id,
          section,
        )
      ) {
        content.innerHTML = paint(value);
      }
    } catch (error) {
      if (
        !sectionRequestStillCurrent(
          activeOrganization()?.id,
          state.section,
          organization.id,
          section,
        )
      ) {
        return;
      }
      if (sectionLoadErrorNeedsInlineRetry(prior)) {
        content.innerHTML = sectionErrorHtml(section);
      } else {
        // The retained snapshot stays on screen; say it couldn't refresh.
        toast(error.message, true);
      }
    }
  }

  async function reloadMe() {
    const wasUnavailable = dashboardOrganizationDataUnavailable(state);
    if (wasUnavailable) {
      // Show the spinner without waiting on Profile's own requests.
      state.organizationsLoading = true;
      void render();
    }
    try {
      const me = await api("/v1/me");
      state.user = me.user;
      state.capabilities = me.capabilities || {};
      state.organizations = cloudOrganizations(me.organizations || me.teams);
      if (
        !state.organizations.some(
          (organization) => organization.id === state.activeOrganizationId,
        )
      ) {
        state.activeOrganizationId = state.organizations[0]?.id || null;
      }
      state.loadError = null;
    } catch (error) {
      state.organizationsLoading = false;
      toast(error.message, true);
      if (wasUnavailable) await render();
      return;
    }
    state.organizationsLoading = false;
    await render();
  }

  function signOutForSecurityEvent() {
    if (securitySigningOut) return;
    securitySigningOut = true;
    securityEventSource?.close();
    const returnTo = `${window.location.origin}/`;
    window.location.replace(
      `/auth/logout?return=${encodeURIComponent(returnTo)}`,
    );
  }

  function queueSecurityRefresh() {
    if (securityRefreshQueued || securitySigningOut) return;
    securityRefreshQueued = true;
    queueMicrotask(async () => {
      securityRefreshQueued = false;
      await reloadMe();
    });
  }

  function handleSecurityEvent(kind, event) {
    lastSecurityContactAt = Date.now();
    let data = null;
    try {
      data = event?.data ? JSON.parse(event.data) : null;
    } catch {
      return;
    }
    if (data && Number.isSafeInteger(data.sequence) && securitySnapshot) {
      securitySnapshot = {
        ...securitySnapshot,
        cursor: Math.max(securitySnapshot.cursor || 0, data.sequence),
      };
    }
    const action = securityEventAction(kind);
    if (action.signOut) signOutForSecurityEvent();
    else if (action.refreshOrganizations) {
      invalidateOrganizationSnapshots(
        snapshots,
        typeof data?.organizationId === "string" ? data.organizationId : null,
        { inflight, generations: snapshotGenerations },
      );
      queueSecurityRefresh();
    }
  }

  function connectSecurityEvents(cursor) {
    if (typeof EventSource !== "function" || securitySigningOut) return;
    securityEventSource?.close();
    const source = new EventSource(
      `/api/v1/auth/events?after=${encodeURIComponent(String(cursor || 0))}`,
    );
    securityEventSource = source;
    for (const kind of [
      "account.revoked",
      "account.authorization_changed",
      "session.revoked",
      "organization.access_revoked",
      "organization.authorization_changed",
      "organization.data_changed",
      "workspace.authorization_changed",
    ]) {
      source.addEventListener(kind, (event) =>
        handleSecurityEvent(kind, event),
      );
    }
    source.addEventListener("ready", () => {
      lastSecurityContactAt = Date.now();
    });
    source.addEventListener("heartbeat", () => {
      lastSecurityContactAt = Date.now();
    });
    source.onerror = () => {
      if (
        navigator.onLine !== false &&
        shouldRevalidateSecurityLifecycle(lastSecurityContactAt, Date.now())
      ) {
        void revalidateSecurityLifecycle();
      }
      // Native EventSource reconnects with Last-Event-ID. Do not create a
      // competing reconnect/poll loop here.
    };
  }

  function revalidateSecurityLifecycle() {
    if (securitySigningOut) return Promise.resolve();
    if (securityRevalidation) return securityRevalidation;
    securityRevalidation = (async () => {
      try {
        const next = await api("/v1/auth/snapshot");
        lastSecurityContactAt = Date.now();
        const changed =
          securitySnapshot !== null &&
          securitySnapshotChanged(securitySnapshot, next);
        securitySnapshot = next;
        if (changed) {
          // A lifecycle snapshot tells us that something changed but not which
          // retained section owns it. This is a rare silence/reconnect backstop,
          // so clear the bounded section cache once and refetch on render.
          invalidateOrganizationSnapshots(snapshots, null, {
            inflight,
            generations: snapshotGenerations,
          });
          queueSecurityRefresh();
        }
        if (
          !securityEventSource ||
          securityEventSource.readyState === EventSource.CLOSED
        ) {
          connectSecurityEvents(next.cursor);
        }
      } catch (error) {
        if (error?.status === 401) signOutForSecurityEvent();
        // A timeout/5xx is not evidence of revocation. Keep the last confirmed
        // UI and let EventSource/lifecycle recovery try again later.
      }
    })().finally(() => {
      securityRevalidation = null;
    });
    return securityRevalidation;
  }

  function onSecurityLifecycleHint() {
    if (
      document.visibilityState !== "hidden" &&
      navigator.onLine !== false &&
      shouldRevalidateSecurityLifecycle(lastSecurityContactAt, Date.now())
    ) {
      void revalidateSecurityLifecycle();
    }
  }

  document.addEventListener("click", async (event) => {
    closeMenus(event.target);
    const target = event.target.closest("button, [data-action]");
    if (!target) return;
    if (target.dataset.section && !target.disabled) {
      state.section = target.dataset.section;
      setMobileNavigationOpen(false);
      await render();
      return;
    }
    if (target.dataset.orgId) {
      state.activeOrganizationId = target.dataset.orgId;
      if (state.section === "profile") state.section = "general";
      document.getElementById("org-switcher")?.removeAttribute("open");
      setMobileNavigationOpen(false);
      await render();
      return;
    }
    if (target.dataset.memberMenu) {
      const open = target.getAttribute("aria-expanded") === "true";
      const menu = target.nextElementSibling;
      target.setAttribute("aria-expanded", String(!open));
      if (menu) {
        menu.hidden = open;
        if (!open) menu.querySelector("button")?.focus();
      }
      return;
    }
    const action = target.dataset.action;
    if (action === "close-dialog") {
      target.closest("dialog")?.close();
    } else if (action === "dismiss-toast") {
      target.closest(".toast")?.remove();
    } else if (action === "create-organization") {
      if (!organizationCreationAllowed(state.capabilities)) return;
      document.getElementById("org-switcher")?.removeAttribute("open");
      const errorNode = document.getElementById("create-organization-error");
      if (errorNode) errorNode.textContent = "";
      document.getElementById("create-organization-dialog")?.showModal();
    } else if (action === "toggle-mobile-nav") {
      setMobileNavigationOpen(
        !document.body.classList.contains("mobile-nav-open"),
      );
    } else if (action === "close-mobile-nav") {
      setMobileNavigationOpen(false);
    } else if (action === "retry-me") {
      await reloadMe();
    } else if (action === "retry-section") {
      const organization = activeOrganization();
      if (organization) {
        invalidateExactSnapshot(
          snapshots,
          `${organization.id}:${state.section}`,
          { inflight, generations: snapshotGenerations },
        );
      }
      await render();
    } else if (action === "remove-organization-logo") {
      const organization = activeOrganization();
      if (!organization || !canAdmin(organization)) return;
      target.disabled = true;
      try {
        const result = await api(`/v1/organizations/${organization.id}`, {
          method: "PATCH",
          body: { logo: null },
        });
        replaceOrganization(result.organization);
        toast("Organization logo removed");
        await render();
      } catch (error) {
        target.disabled = false;
        toast(error.message, true);
      }
    } else if (target.dataset.copyOrganizationId) {
      if (
        await tryWriteClipboard(
          navigator.clipboard,
          target.dataset.copyOrganizationId,
        )
      ) {
        toast("Organization ID copied");
      } else {
        toast("Couldn’t copy the organization ID", true);
      }
    } else if (action === "delete-organization") {
      const organization = activeOrganization();
      if (!organization) return;
      syncDeleteOrganizationDialog(organization)?.showModal();
    } else if (action === "delete-account") {
      const dialog = document.getElementById("delete-account-dialog");
      const input = dialog?.querySelector('input[name="confirmation"]');
      if (input) input.value = "";
      const errorNode = document.getElementById("delete-account-error");
      if (errorNode) errorNode.textContent = "";
      dialog?.showModal();
    } else if (target.dataset.restoreOrganization) {
      const organizationId = target.dataset.restoreOrganization;
      const requestId = target.dataset.deletionRequest;
      if (!requestId) return;
      target.disabled = true;
      try {
        await api(`/v1/organizations/${organizationId}/restore`, {
          method: "POST",
          body: { requestId },
        });
        invalidateExactSnapshot(snapshots, "account:deletions", {
          inflight,
          generations: snapshotGenerations,
        });
        toast("Organization restored");
        await reloadMe();
      } catch (error) {
        if (error.code === "reauthentication_required") {
          beginStepUp("restore-organization");
          return;
        }
        target.disabled = false;
        toast(error.message, true);
      }
    } else if (target.dataset.removeMember) {
      const organization = activeOrganization();
      if (!organization) return;
      const memberId = target.dataset.removeMember;
      const self = memberId === state.user.id;
      if (
        !window.confirm(
          self ? "Leave this organization?" : "Remove this member?",
        )
      )
        return;
      try {
        await api(`/v1/organizations/${organization.id}/members/${memberId}`, {
          method: "DELETE",
          body: {},
        });
        invalidateOrganizationSnapshots(snapshots, organization.id, {
          inflight,
          generations: snapshotGenerations,
        });
        if (self) await reloadMe();
        else await render();
      } catch (error) {
        toast(error.message, true);
      }
    } else if (target.dataset.revokeInvite) {
      const organization = activeOrganization();
      if (!organization) return;
      try {
        await api(
          `/v1/organizations/${organization.id}/invitations/${target.dataset.revokeInvite}`,
          { method: "DELETE", body: {} },
        );
        invalidateExactSnapshot(snapshots, `${organization.id}:members`, {
          inflight,
          generations: snapshotGenerations,
        });
        await render();
      } catch (error) {
        toast(error.message, true);
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const switcher = document.getElementById("org-switcher");
    const memberMenu = document.querySelector(
      '[data-member-menu][aria-expanded="true"]',
    );
    if (switcher?.open) {
      closeMenus();
      switcher.querySelector("summary")?.focus();
    } else if (memberMenu) {
      closeMenus();
      memberMenu.focus();
    } else if (document.body.classList.contains("mobile-nav-open")) {
      setMobileNavigationOpen(false);
      document.querySelector('[data-action="toggle-mobile-nav"]')?.focus();
    }
  });

  document.addEventListener("change", async (event) => {
    const logoInput = event.target.closest("input[data-organization-logo]");
    if (logoInput) {
      const organization = activeOrganization();
      const file = logoInput.files?.[0];
      if (!organization || !canAdmin(organization) || !file) {
        logoInput.value = "";
        return;
      }
      logoInput.disabled = true;
      try {
        const logo = await fileToOrganizationLogo(file);
        const result = await api(`/v1/organizations/${organization.id}`, {
          method: "PATCH",
          body: { logo },
        });
        replaceOrganization(result.organization);
        toast("Organization logo updated");
        await render();
      } catch (error) {
        toast(error.message, true);
      } finally {
        logoInput.disabled = false;
        logoInput.value = "";
      }
      return;
    }
    const select = event.target.closest("select[data-member-role]");
    if (!select) return;
    const organization = activeOrganization();
    if (!organization) return;
    try {
      await api(
        `/v1/organizations/${organization.id}/members/${select.dataset.memberRole}`,
        {
          method: "PATCH",
          body: { role: select.value },
        },
      );
      invalidateOrganizationSnapshots(snapshots, organization.id, {
        inflight,
        generations: snapshotGenerations,
      });
      toast("Member role updated");
      if (select.dataset.memberRole === state.user.id) await reloadMe();
      else await render();
    } catch (error) {
      toast(error.message, true);
      invalidateExactSnapshot(snapshots, `${organization.id}:members`, {
        inflight,
        generations: snapshotGenerations,
      });
      await render();
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      form.closest("dialog")?.close();
      return;
    }
    if (!submissions.enter(form)) return;
    form.setAttribute("aria-busy", "true");
    const submitter =
      event.submitter instanceof HTMLButtonElement ? event.submitter : null;
    if (submitter) submitter.disabled = true;
    const organization = activeOrganization();
    try {
      if (form.id === "create-organization-form") {
        if (!organizationCreationAllowed(state.capabilities)) return;
        const name = new FormData(form).get("name")?.toString().trim();
        const errorNode = document.getElementById("create-organization-error");
        if (!name) return;
        if (errorNode) errorNode.textContent = "";
        const result = await api("/v1/organizations", {
          method: "POST",
          body: { name },
        });
        const [created] = cloudOrganizations([result.organization]);
        if (created) {
          state.organizations.push(created);
          state.activeOrganizationId = created.id;
          state.section = "general";
        }
        form.reset();
        document.getElementById("create-organization-dialog")?.close();
        toast("Organization created");
        await render();
      } else if (form.id === "delete-organization-form" && organization) {
        const confirmation = new FormData(form)
          .get("confirmation")
          ?.toString()
          .trim();
        const errorNode = document.getElementById("delete-organization-error");
        if (!confirmation) return;
        if (errorNode) errorNode.textContent = "";
        try {
          const result = await api(`/v1/organizations/${organization.id}`, {
            method: "DELETE",
            body: { confirmation },
          });
          invalidateOrganizationSnapshots(snapshots, organization.id, {
            inflight,
            generations: snapshotGenerations,
          });
          invalidateExactSnapshot(snapshots, "account:deletions", {
            inflight,
            generations: snapshotGenerations,
          });
          state.organizations = state.organizations.filter(
            (item) => item.id !== organization.id,
          );
          if (result.deletion) {
            state.deletions.unshift({
              ...result.deletion,
              targetName: organization.name,
            });
          }
          state.activeOrganizationId = state.organizations[0]?.id || null;
          state.section = "profile";
          form.reset();
          form.closest("dialog")?.close();
          toast("Organization deletion scheduled");
          await render();
        } catch (error) {
          if (error.code === "reauthentication_required") {
            beginStepUp("delete-organization");
            return;
          }
          if (errorNode) errorNode.textContent = error.message;
        }
      } else if (form.id === "delete-account-form") {
        const confirmation = new FormData(form)
          .get("confirmation")
          ?.toString()
          .trim();
        const errorNode = document.getElementById("delete-account-error");
        if (!confirmation) return;
        if (errorNode) errorNode.textContent = "";
        try {
          await api("/v1/account/deletion", {
            method: "POST",
            body: { confirmation },
          });
          window.location.replace(
            `/auth/logout?return=${encodeURIComponent(`${window.location.origin}/`)}`,
          );
          return;
        } catch (error) {
          if (error.code === "reauthentication_required") {
            beginStepUp("delete-account");
            return;
          }
          if (errorNode) errorNode.textContent = error.message;
        }
      } else if (form.dataset.form === "rename-organization" && organization) {
        const name = new FormData(form).get("name")?.toString().trim();
        if (!name) return;
        const result = await api(`/v1/organizations/${organization.id}`, {
          method: "PATCH",
          body: { name },
        });
        replaceOrganization(result.organization);
        toast("Organization updated");
        await render();
      } else if (form.dataset.form === "invite-member" && organization) {
        const data = new FormData(form);
        const result = await api(
          `/v1/organizations/${organization.id}/invitations`,
          {
            method: "POST",
            body: { email: data.get("email"), role: data.get("role") },
          },
        );
        invalidateExactSnapshot(snapshots, `${organization.id}:members`, {
          inflight,
          generations: snapshotGenerations,
        });
        form.reset();
        const link = result.invitation?.acceptUrl;
        if (link && (await tryWriteClipboard(navigator.clipboard, link))) {
          toast("Invitation created and link copied");
        } else toast("Invitation created");
        await render();
      }
    } catch (error) {
      if (form.id === "create-organization-form") {
        const errorNode = document.getElementById("create-organization-error");
        if (errorNode) errorNode.textContent = error.message;
      } else if (
        form.id !== "delete-organization-form" &&
        form.id !== "delete-account-form"
      ) {
        toast(error.message, true);
      }
    } finally {
      submissions.leave(form);
      form.removeAttribute("aria-busy");
      if (submitter?.isConnected) submitter.disabled = false;
    }
  });

  if (
    boot.action === "create-organization" &&
    organizationCreationAllowed(state.capabilities)
  ) {
    document.getElementById("create-organization-dialog")?.showModal();
  } else if (boot.action === "delete-account") {
    document.getElementById("delete-account-dialog")?.showModal();
  } else if (boot.action === "delete-organization" && activeOrganization()) {
    syncDeleteOrganizationDialog(activeOrganization())?.showModal();
  }
  window.addEventListener("focus", onSecurityLifecycleHint);
  window.addEventListener("online", onSecurityLifecycleHint);
  window.addEventListener("pageshow", onSecurityLifecycleHint);
  document.addEventListener("visibilitychange", onSecurityLifecycleHint);
  void revalidateSecurityLifecycle();
  void render();
}

if (typeof document !== "undefined") bootDashboard();
