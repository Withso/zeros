import { BRAND_LOGO, shell } from "./page.ts";
import {
  cloudOrganizations,
  createOrganizationDialogHtml,
  deleteAccountDialogHtml,
  deleteOrganizationDialogHtml,
  escapeHtml as esc,
  generalHtml,
  navHtml,
  organizationCreationAllowed,
  organizationDisplayName,
  profileHtml,
  safeOrganizationLogo,
  sectionLoadingHtml,
} from "../public/dashboard.js";

export { organizationCreationAllowed, safeOrganizationLogo };

const SECTIONS = ["profile", "general", "members", "teams", "billing"];
const ORGANIZATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_CODE_RE = /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DELETION_CODE_RE = /^ZD-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DASHBOARD_ASSET_REVISION = "2026-11-05.1";

// The page follows the system appearance before first paint, so a light
// system never flashes the dark default.
const THEME_SCRIPT =
  '<script>(()=>{const m=matchMedia("(prefers-color-scheme: light)");const s=()=>{document.documentElement.dataset.theme=m.matches?"light":"dark"};s();m.addEventListener("change",s)})();</script>';

function dashboardAsset(path) {
  return `${path}?v=${DASHBOARD_ASSET_REVISION}`;
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

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
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

/** The section a request opens on. Without a cloud organization only
 * Profile exists; otherwise a known section, defaulting to General. */
function initialSection(requested, active) {
  if (!active) return "profile";
  return SECTIONS.includes(requested) ? requested : "general";
}

export function dashboardPage({ session, me, requestUrl, signOutHref, loadError = null }) {
  const url = new URL(requestUrl);
  const organizations = cloudOrganizations(me?.organizations ?? me?.teams);
  const requestedId = url.searchParams.get("organization");
  const active =
    organizations.find((org) => org.id === requestedId) ?? organizations[0] ?? null;
  const section = initialSection(url.searchParams.get("section"), active);
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
    signOutHref,
  };
  const orgList = loadError && organizations.length === 0 ? "unavailable" : "ready";
  const content =
    section === "profile"
      ? profileHtml({
          user: {
            displayName: boot.user.displayName ?? session.name,
            email: boot.user.email ?? session.email,
          },
          signOutHref,
          hasOrganizations: organizations.length > 0,
          canCreate: canCreateOrganization,
          orgList,
        })
      : section === "general"
        ? generalHtml(active)
        : sectionLoadingHtml(section);

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Zeros · Organization settings</title>
  ${THEME_SCRIPT}
  <link rel="stylesheet" href="${dashboardAsset("/dashboard.css")}" />
  <script type="module" src="${dashboardAsset("/dashboard.js")}"></script>
</head>
<body class="dashboard-page">
  <div class="app-shell">
    <aside class="sidebar" id="dashboard-sidebar" aria-label="Settings sections">
      <div class="sidebar-band"><a class="brand" href="/" aria-label="Zeros home">${BRAND_LOGO}</a></div>
      <nav class="sidebar-nav" id="dashboard-nav" aria-label="Settings">${navHtml({
        organizations,
        activeId: active?.id ?? null,
        section,
        canCreate: canCreateOrganization,
        email: boot.user.email ?? session.email,
        orgList,
      })}</nav>
    </aside>
    <button class="mobile-scrim" type="button" data-action="close-mobile-nav" aria-label="Close navigation"></button>
    <main class="main-content">
      <header class="mobile-header"><a class="brand" href="/" aria-label="Zeros home">${BRAND_LOGO}</a><strong>${active ? esc(organizationDisplayName(active)) : ""}</strong><button type="button" data-action="toggle-mobile-nav" aria-label="Open navigation" aria-controls="dashboard-sidebar" aria-expanded="false"><span class="mobile-menu-glyph" aria-hidden="true"></span></button></header>
      <div class="content-scroll"><div class="content-column" id="dashboard-content">${content}</div></div>
    </main>
  </div>
  <div id="create-organization-dialog-slot" data-enabled="${String(canCreateOrganization)}">${canCreateOrganization ? createOrganizationDialogHtml() : ""}</div>
  ${deleteOrganizationDialogHtml(active?.name ?? "")}
  ${deleteAccountDialogHtml()}
  <div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="false"></div>
  <script type="application/json" id="dashboard-data">${safeJson(boot)}</script>
</body>
</html>`;
}
