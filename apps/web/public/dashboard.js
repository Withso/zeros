export function organizationDisplayName(organization) {
  return organization?.name?.trim() || "Personal";
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
    kind === "organization.data_changed"
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
  ]);
}

export function securitySnapshotChanged(previous, next) {
  return securitySnapshotSignature(previous) !== securitySnapshotSignature(next);
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
    canRemove:
      !lastOwner && (isSelf || ownerMayManage || adminMayManage),
    availableRoles: ownerMayManage
      ? ["owner", "admin", "member"]
      : adminMayManage
        ? ["admin", "member"]
        : [],
  };
}

function bootDashboard() {
  "use strict";

  const bootNode = document.getElementById("dashboard-data");
  const content = document.getElementById("dashboard-content");
  if (!bootNode || !content) return;

  const boot = JSON.parse(bootNode.textContent || "{}");
  const state = {
    user: boot.user,
    organizations: (boot.organizations || []).map((organization) => ({
      ...organization,
      logo: safeOrganizationLogo(organization.logo),
    })),
    activeOrganizationId: boot.activeOrganizationId,
    section: boot.section || "profile",
    loadError: boot.loadError || null,
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

  const normalizeOrganization = (organization) => ({
    ...organization,
    logo: safeOrganizationLogo(organization?.logo),
  });
  const replaceOrganization = (organization) => {
    const next = normalizeOrganization(organization);
    const index = state.organizations.findIndex((item) => item.id === next.id);
    if (index >= 0) state.organizations[index] = next;
    return next;
  };

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) =>
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
  const initials = (value) => {
    const words = String(value || "Personal").trim().split(/\s+/).filter(Boolean);
    return `${words[0]?.[0] || "P"}${words[1]?.[0] || ""}`.toUpperCase();
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
    state.organizations.find((organization) => organization.id === state.activeOrganizationId) ||
    state.organizations.find((organization) => organization.isPersonal) ||
    state.organizations[0] ||
    null;
  const label = organizationDisplayName;
  const organizationAvatarHtml = (organization, classes = "") => {
    const logo = safeOrganizationLogo(organization?.logo);
    return `<span class="avatar avatar-square ${classes}" aria-hidden="true">${
      logo
        ? `<img class="avatar-image" src="${escapeHtml(logo)}" alt="" />`
        : escapeHtml(initials(label(organization)))
    }</span>`;
  };
  const canAdmin = (organization) =>
    organization && (organization.role === "owner" || organization.role === "admin");
  const canOwn = (organization) => organization?.role === "owner";

  function toast(message, error = false) {
    const region = document.getElementById("toast-region");
    if (!region) return;
    const node = document.createElement("div");
    node.className = `toast${error ? " error" : ""}`;
    node.textContent = message;
    region.append(node);
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
      const error = new Error(body?.error?.message || `Request failed (${response.status})`);
      error.code = body?.error?.code || "request_failed";
      error.status = response.status;
      error.details = body?.error?.details;
      throw error;
    }
    return body;
  }

  function updateUrl() {
    const url = new URL(window.location.href);
    if (state.activeOrganizationId) url.searchParams.set("organization", state.activeOrganizationId);
    else url.searchParams.delete("organization");
    url.searchParams.set("section", state.section);
    url.searchParams.delete("action");
    history.replaceState(null, "", url);
  }

  function syncChrome() {
    const organization = activeOrganization();
    document.querySelectorAll("[data-section]").forEach((node) => {
      const section = node.dataset.section;
      node.setAttribute("aria-current", section === state.section ? "page" : "false");
      node.disabled = collaborationSectionDisabled(organization, section);
    });
    const summary = document.querySelector("#org-switcher > summary");
    if (summary) {
      summary.innerHTML = `${organizationAvatarHtml(organization)}<span class="summary-copy"><strong>${escapeHtml(label(organization))}</strong><small>${organization?.isPersonal ? "Personal" : "Organization"}</small></span><span aria-hidden="true">⌄</span>`;
    }
    const options = document.getElementById("organization-options");
    if (options) {
      options.innerHTML = state.organizations
        .map(
          (item) => `<button class="org-option" type="button" role="option" aria-selected="${item.id === organization?.id}" data-org-id="${escapeHtml(item.id)}">${organizationAvatarHtml(item)}<span class="org-option-copy"><strong>${escapeHtml(label(item))}</strong><small>${item.isPersonal ? "Local workspaces only" : "Local + cloud workspaces"}</small></span><span class="org-check" aria-hidden="true">${item.id === organization?.id ? "✓" : ""}</span></button>`,
        )
        .join("");
    }
    const mobileTitle = document.querySelector(".mobile-header strong");
    if (mobileTitle) mobileTitle.textContent = label(organization);
  }

  const heading = (title, description, action = "") =>
    `<div class="section-heading"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</div>`;

  function profileHtml() {
    const displayName = state.user.displayName || "Zeros user";
    return `<section class="section-stack">${heading("Profile", "Your browser account and sign-in identity.")}
      <div class="card"><div class="identity-row"><span class="avatar avatar-large">${escapeHtml(initials(displayName || state.user.email))}</span><div><strong>${escapeHtml(displayName)}</strong><p>${escapeHtml(state.user.email)}</p></div></div></div>
      <div class="card"><div class="card-title"><div><strong>Account identity</strong><p>Name and avatar are currently provided by Google or GitHub. Profile editing will be available here later.</p></div><span class="badge">Provider-managed</span></div></div>
    </section>`;
  }

  function generalHtml(organization) {
    if (!organization) return `<div class="empty-state"><h1>Personal</h1><p>Your account space is being prepared.</p></div>`;
    const editable = !organization.isPersonal && canAdmin(organization);
    const logo = safeOrganizationLogo(organization.logo);
    const logoActions = editable
      ? `<label class="button secondary file-button">Change<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-organization-logo hidden /></label>${logo ? '<button class="button secondary" type="button" data-action="remove-organization-logo">Remove</button>' : ""}`
      : "";
    const nameControl = editable
      ? `<form class="settings-row" data-form="rename-organization"><span class="settings-copy"><strong>Organization name</strong><p>Shown across Zeros and in invitations.</p></span><span class="settings-value settings-name-control"><input name="name" required maxlength="80" value="${escapeHtml(organization.name)}" aria-label="Organization name" /><button class="button secondary" type="submit">Save</button></span></form>`
      : `<div class="settings-row"><span class="settings-copy"><strong>${organization.isPersonal ? "Personal name" : "Organization name"}</strong><p>${organization.isPersonal ? "Provided by your sign-in identity." : "Shown across Zeros and in invitations."}</p></span><span class="settings-value"><strong>${escapeHtml(label(organization))}</strong></span></div>`;
    return `<section class="section-stack">${heading("General", organization.isPersonal ? "Your permanent, device-local account space." : "Organization identity and workspace capabilities.")}
      <div class="card settings-card">
        <div class="settings-row"><span class="settings-copy"><strong>Logo</strong><p>Shown for this organization across Zeros.</p></span><span class="settings-value">${organizationAvatarHtml(organization, "avatar-large")}${logoActions}</span></div>
        ${nameControl}
        <div class="settings-row"><span class="settings-copy"><strong>Organization ID</strong><p>Your stable tenant identifier.</p></span><span class="settings-value"><code class="id-code">${escapeHtml(organization.id)}</code><button class="icon-button copy-button" type="button" data-copy-organization-id="${escapeHtml(organization.id)}" aria-label="Copy organization ID">▣</button></span></div>
        <div class="settings-row"><span class="settings-copy"><strong>Your role</strong><p>What you can do in this organization.</p></span><span class="settings-value"><span class="badge">${escapeHtml(organization.role)}</span></span></div>
      </div>
      <div class="card"><div class="card-title"><div><strong>Workspace access</strong><p>Capability metadata; cloud provisioning will still enforce plan and quota.</p></div></div><div class="capability-grid"><div class="capability"><span class="status-dot success"></span><div><strong>Local workspaces</strong><p>Available on your Mac</p></div></div><div class="capability ${organization.workspaceCapabilities?.cloud ? "" : "disabled"}"><span class="status-dot ${organization.workspaceCapabilities?.cloud ? "success" : ""}"></span><div><strong>Cloud workspaces</strong><p>${organization.workspaceCapabilities?.cloud ? "Organization eligible" : "Not available in Personal"}</p></div></div></div></div>
      ${organization.isPersonal ? `<div class="notice"><strong>Personal is permanent</strong><p>Personal cannot be removed. It cannot invite members and stores workspace configuration locally.</p></div>` : canOwn(organization) ? `<div class="subsection-label">Danger zone</div><div class="card danger-card"><div class="card-title"><div><strong>Delete organization</strong><p>Revokes pending invitations and removes the organization from Zeros. Every cloud workspace must be deleted and provider cleanup verified first.</p></div><button class="button danger" type="button" data-action="delete-organization">Delete organization</button></div></div>` : ""}
    </section>`;
  }

  function loadingHtml(title, description, snapshot) {
    if (snapshot) return snapshot;
    return `<section class="section-stack">${heading(title, description)}<div class="card loading-card" aria-busy="true">Loading…</div></section>`;
  }

  function sectionErrorHtml(title, error) {
    return `<div class="notice notice-error"><strong>Couldn't load ${escapeHtml(title)}</strong><p>${escapeHtml(error.message)}</p><button class="button secondary" type="button" data-action="retry-section">Try again</button></div>`;
  }

  function memberRows(members, organization) {
    const ownerCount = members.filter((member) => member.role === "owner").length;
    return members
      .map((member) => {
        const name = member.display_name || member.email;
        const permissions = memberPermissions({
          actorRole: organization.role,
          targetRole: member.role,
          isSelf: member.id === state.user.id,
          ownerCount,
          directoryManaged: member.directory_managed === true,
        });
        const roleControl = permissions.canChangeRole
          ? `<select aria-label="Role for ${escapeHtml(name)}" data-member-role="${escapeHtml(member.id)}">${permissions.availableRoles.map((role) => `<option value="${role}" ${member.role === role ? "selected" : ""}>${role[0].toUpperCase() + role.slice(1)}</option>`).join("")}</select>`
          : `<span class="badge">${escapeHtml(member.role)}</span>`;
        const removeControl = permissions.canRemove
          ? `<button class="icon-button" type="button" data-remove-member="${escapeHtml(member.id)}" aria-label="${member.id === state.user.id ? "Leave organization" : `Remove ${escapeHtml(name)}`}">×</button>`
          : "";
        return `<div class="member-row"><span class="avatar">${escapeHtml(initials(name))}</span><span class="member-copy"><strong>${escapeHtml(name)}${member.id === state.user.id ? " (you)" : ""}</strong><small>${escapeHtml(member.email)}${member.directory_managed === true ? " · Directory managed" : ""}</small></span><span class="row-actions">${roleControl}${removeControl}</span></div>`;
      })
      .join("");
  }

  function membersHtml(organization, data) {
    const inviteForm = canAdmin(organization)
      ? `<form class="inline-form" data-form="invite-member"><label class="field"><span>Email address</span><input name="email" type="email" maxlength="254" required placeholder="teammate@example.com" /></label><label class="field"><span>Role</span><select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label><button class="button primary" type="submit">Send invite</button></form>`
      : "";
    const invitations = (data.invitations || [])
      .map((invite) => `<div class="member-row"><span class="avatar">✉</span><span class="member-copy"><strong>${escapeHtml(invite.email)}</strong><small>Pending · expires ${escapeHtml(new Date(invite.expires_at).toLocaleDateString())}</small></span><span class="row-actions"><span class="badge">${escapeHtml(invite.role)}</span>${canAdmin(organization) ? `<button class="icon-button" type="button" data-revoke-invite="${escapeHtml(invite.id)}" aria-label="Revoke invitation">×</button>` : ""}</span></div>`)
      .join("");
    return `<section class="section-stack">${heading("Members", "Organization members are automatically included in the default team.")}
      <div class="card"><div class="card-title"><div><strong>Invite member</strong><p>The recipient must sign in with this exact email address.</p></div></div>${inviteForm || `<div class="notice" style="margin-top:18px">Only organization admins can invite members.</div>`}</div>
      <div class="card"><div class="card-title"><div><strong>Members</strong><p>${data.members.length} ${data.members.length === 1 ? "member" : "members"}</p></div></div><div class="member-list">${memberRows(data.members, organization)}</div></div>
      ${invitations ? `<div class="card"><div class="card-title"><div><strong>Pending invitations</strong><p>Unused invitations expire automatically.</p></div></div><div class="member-list">${invitations}</div></div>` : ""}
    </section>`;
  }

  function teamsHtml(organization, data) {
    const rows = data.teams
      .map((team) => `<div class="team-row"><span class="avatar avatar-square">D</span><span class="member-copy"><strong>${escapeHtml(team.name)}</strong><small>${escapeHtml(team.slug)} · ${team.is_default ? "Default team" : "Team"}</small></span><span class="row-actions"><span class="badge success">${team.is_default ? "Default" : escapeHtml(team.role)}</span></span></div>`)
      .join("");
    return `<section class="section-stack">${heading("Teams", "Teams group organization members and workspace access.", `<button class="button secondary" type="button" disabled>New team · Coming later</button>`)}
      <div class="notice"><strong>One default team for now</strong><p>The hierarchy and membership metadata are ready. Creating additional teams will be enabled in a future release.</p></div>
      <div class="card"><div class="card-title"><div><strong>Organization teams</strong><p>Every organization member belongs to the default team.</p></div></div><div class="team-list">${rows}</div></div>
    </section>`;
  }

  function billingHtml(data) {
    const billing = data.billing;
    const subscription = billing.subscription;
    return `<section class="section-stack">${heading("Billing", "Plan, seats, and payment management for this organization.")}
      <div class="card"><div class="card-title"><div><strong>${escapeHtml(subscription?.plan || "Free")}</strong><p>${subscription ? `${escapeHtml(subscription.status)} · ${subscription.seats} seats` : `${billing.memberCount || 1} organization member${billing.memberCount === 1 ? "" : "s"}`}</p></div><span class="badge ${subscription?.status === "active" ? "success" : ""}">${escapeHtml(subscription?.status || "No subscription")}</span></div></div>
      <div class="notice"><strong>Billing management is coming soon</strong><p>The billing schema and organization boundary are ready. Checkout, invoices, and payment methods will be connected here in a later release.</p><button class="button secondary" type="button" disabled>Manage billing</button></div>
    </section>`;
  }

  async function loadExact(key, loader) {
    return loadExactSnapshot(snapshotCache, key, loader);
  }

  async function render() {
    syncChrome();
    updateUrl();
    const organization = activeOrganization();
    if (dashboardOrganizationDataUnavailable(state)) {
      content.innerHTML = `<div class="notice notice-error"><strong>Organization data is unavailable</strong><p>${escapeHtml(state.loadError)}</p><button class="button secondary" type="button" data-action="retry-me">Try again</button></div>`;
      return;
    }
    if (state.section === "profile") {
      content.innerHTML = profileHtml();
      return;
    }
    if (!organization) {
      content.innerHTML = `<div class="empty-state"><h1>Personal</h1><p>Your organization list is unavailable.</p><button class="button secondary" data-action="retry-me">Try again</button></div>`;
      return;
    }
    if (collaborationSectionDisabled(organization, state.section)) {
      state.section = "profile";
      await render();
      return;
    }
    if (state.section === "general") {
      content.innerHTML = generalHtml(organization);
      return;
    }

    const key = `${organization.id}:${state.section}`;
    const prior = snapshots.get(key);
    if (state.section === "members") {
      content.innerHTML = prior
        ? membersHtml(organization, prior)
        : loadingHtml("Members", "Loading organization members…");
      try {
        const value = await loadExact(key, async () => {
          const [members, invitations] = await Promise.all([
            api(`/v1/organizations/${organization.id}/members`),
            canAdmin(organization)
              ? api(`/v1/organizations/${organization.id}/invitations`)
              : Promise.resolve({ invitations: [] }),
          ]);
          return { members: members.members, invitations: invitations.invitations };
        });
        if (
          sectionRequestStillCurrent(
            activeOrganization()?.id,
            state.section,
            organization.id,
            "members",
          )
        ) {
          content.innerHTML = membersHtml(organization, value);
        }
      } catch (error) {
        if (
          !sectionRequestStillCurrent(
            activeOrganization()?.id,
            state.section,
            organization.id,
            "members",
          )
        ) {
          return;
        }
        toast(error.message, true);
        if (sectionLoadErrorNeedsInlineRetry(prior)) {
          content.innerHTML = sectionErrorHtml("members", error);
        }
      }
      return;
    }
    if (state.section === "teams") {
      content.innerHTML = prior ? teamsHtml(organization, prior) : loadingHtml("Teams", "Loading teams…");
      try {
        const value = await loadExact(key, () => api(`/v1/organizations/${organization.id}/teams`));
        if (
          sectionRequestStillCurrent(
            activeOrganization()?.id,
            state.section,
            organization.id,
            "teams",
          )
        ) {
          content.innerHTML = teamsHtml(organization, value);
        }
      } catch (error) {
        if (
          !sectionRequestStillCurrent(
            activeOrganization()?.id,
            state.section,
            organization.id,
            "teams",
          )
        ) {
          return;
        }
        toast(error.message, true);
        if (sectionLoadErrorNeedsInlineRetry(prior)) {
          content.innerHTML = sectionErrorHtml("teams", error);
        }
      }
      return;
    }
    if (state.section === "billing") {
      content.innerHTML = prior ? billingHtml(prior) : loadingHtml("Billing", "Loading billing status…");
      try {
        const value = await loadExact(key, () => api(`/v1/organizations/${organization.id}/billing`));
        if (
          sectionRequestStillCurrent(
            activeOrganization()?.id,
            state.section,
            organization.id,
            "billing",
          )
        ) {
          content.innerHTML = billingHtml(value);
        }
      } catch (error) {
        if (
          !sectionRequestStillCurrent(
            activeOrganization()?.id,
            state.section,
            organization.id,
            "billing",
          )
        ) {
          return;
        }
        toast(error.message, true);
        if (sectionLoadErrorNeedsInlineRetry(prior)) {
          content.innerHTML = sectionErrorHtml("billing", error);
        }
      }
    }
  }

  async function reloadMe() {
    try {
      const me = await api("/v1/me");
      state.user = me.user;
      state.organizations = (me.organizations || me.teams || []).map(
        normalizeOrganization,
      );
      if (!state.organizations.some((organization) => organization.id === state.activeOrganizationId)) {
        state.activeOrganizationId = state.organizations.find((organization) => organization.isPersonal)?.id || state.organizations[0]?.id || null;
      }
      state.loadError = null;
      await render();
    } catch (error) {
      toast(error.message, true);
    }
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
        typeof data?.organizationId === "string"
          ? data.organizationId
          : null,
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
    ]) {
      source.addEventListener(kind, (event) => handleSecurityEvent(kind, event));
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
      const organization = activeOrganization();
      if (organization?.isPersonal && ["members", "teams", "billing"].includes(state.section)) state.section = "profile";
      else if (state.section === "profile" && !organization?.isPersonal) state.section = "general";
      document.getElementById("org-switcher")?.removeAttribute("open");
      setMobileNavigationOpen(false);
      await render();
      return;
    }
    const action = target.dataset.action;
    if (action === "create-organization") {
      document.getElementById("org-switcher")?.removeAttribute("open");
      const errorNode = document.getElementById("create-organization-error");
      if (errorNode) errorNode.textContent = "";
      document.getElementById("create-organization-dialog")?.showModal();
    } else if (action === "toggle-mobile-nav") {
      setMobileNavigationOpen(!document.body.classList.contains("mobile-nav-open"));
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
      if (!organization || organization.isPersonal || !canAdmin(organization)) return;
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
        toast("Couldn't copy the organization ID", true);
      }
    } else if (action === "delete-organization") {
      const organization = activeOrganization();
      if (!organization || organization.isPersonal) return;
      if (!window.confirm(`Delete ${organization.name}? This cannot be undone.`)) return;
      try {
        await api(`/v1/organizations/${organization.id}`, { method: "DELETE", body: {} });
        invalidateOrganizationSnapshots(snapshots, organization.id, {
          inflight,
          generations: snapshotGenerations,
        });
        state.organizations = state.organizations.filter((item) => item.id !== organization.id);
        state.activeOrganizationId = state.organizations.find((item) => item.isPersonal)?.id || null;
        state.section = "profile";
        toast("Organization deleted");
        await render();
      } catch (error) {
        toast(error.message, true);
      }
    } else if (target.dataset.removeMember) {
      const organization = activeOrganization();
      if (!organization) return;
      const memberId = target.dataset.removeMember;
      const self = memberId === state.user.id;
      if (!window.confirm(self ? "Leave this organization?" : "Remove this member?")) return;
      try {
        await api(`/v1/organizations/${organization.id}/members/${memberId}`, { method: "DELETE", body: {} });
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
        await api(`/v1/organizations/${organization.id}/invitations/${target.dataset.revokeInvite}`, { method: "DELETE", body: {} });
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
    if (event.key === "Escape" && document.body.classList.contains("mobile-nav-open")) {
      setMobileNavigationOpen(false);
      document.querySelector('[data-action="toggle-mobile-nav"]')?.focus();
    }
  });

  document.addEventListener("change", async (event) => {
    const logoInput = event.target.closest("input[data-organization-logo]");
    if (logoInput) {
      const organization = activeOrganization();
      const file = logoInput.files?.[0];
      if (
        !organization ||
        organization.isPersonal ||
        !canAdmin(organization) ||
        !file
      ) {
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
      await api(`/v1/organizations/${organization.id}/members/${select.dataset.memberRole}`, {
        method: "PATCH",
        body: { role: select.value },
      });
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
    if (
      form.id === "create-organization-form" &&
      event.submitter?.value === "cancel"
    ) {
      document.getElementById("create-organization-dialog")?.close();
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
        const name = new FormData(form).get("name")?.toString().trim();
        const errorNode = document.getElementById("create-organization-error");
        if (!name) return;
        if (errorNode) errorNode.textContent = "";
        const result = await api("/v1/organizations", { method: "POST", body: { name } });
        const created = normalizeOrganization(result.organization);
        state.organizations.push(created);
        state.activeOrganizationId = created.id;
        state.section = "general";
        form.reset();
        document.getElementById("create-organization-dialog")?.close();
        toast("Organization created");
        await render();
      } else if (form.dataset.form === "rename-organization" && organization) {
        const name = new FormData(form).get("name")?.toString().trim();
        if (!name) return;
        const result = await api(`/v1/organizations/${organization.id}`, { method: "PATCH", body: { name } });
        replaceOrganization(result.organization);
        toast("Organization updated");
        await render();
      } else if (form.dataset.form === "invite-member" && organization) {
        const data = new FormData(form);
        const result = await api(`/v1/organizations/${organization.id}/invitations`, {
          method: "POST",
          body: { email: data.get("email"), role: data.get("role") },
        });
        invalidateExactSnapshot(snapshots, `${organization.id}:members`, {
          inflight,
          generations: snapshotGenerations,
        });
        form.reset();
        const link = result.invitation?.acceptUrl;
        if (link && await tryWriteClipboard(navigator.clipboard, link)) {
          toast("Invitation created and link copied");
        } else toast("Invitation created");
        await render();
      }
    } catch (error) {
      if (form.id === "create-organization-form") {
        const errorNode = document.getElementById("create-organization-error");
        if (errorNode) errorNode.textContent = error.message;
      } else {
        toast(error.message, true);
      }
    } finally {
      submissions.leave(form);
      form.removeAttribute("aria-busy");
      if (submitter?.isConnected) submitter.disabled = false;
    }
  });

  if (boot.action === "create-organization") {
    document.getElementById("create-organization-dialog")?.showModal();
  }
  window.addEventListener("focus", onSecurityLifecycleHint);
  window.addEventListener("online", onSecurityLifecycleHint);
  window.addEventListener("pageshow", onSecurityLifecycleHint);
  document.addEventListener("visibilitychange", onSecurityLifecycleHint);
  void revalidateSecurityLifecycle();
  void render();
}

if (typeof document !== "undefined") bootDashboard();
