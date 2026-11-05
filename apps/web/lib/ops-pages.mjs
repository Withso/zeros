// Ops pages, following the Zeros Design canvas's Web app page: the four
// centred states use the shared shell with an Ops badge beside the logo, and
// the console uses the dashboard's sidebar layout. The Ops host allows no
// inline style or script, so each page sends its own policy that admits only
// its one inline block by nonce.
import { escapeHtml as esc, initials } from "../public/dashboard.js";
import { OPS_CSP } from "./hosts.ts";
import { BRAND_LOGO, shell } from "./page.ts";

export const OPS_ASSET_REVISION = "2026-11-05.1";

/** OPS_CSP, admitting one inline stylesheet or script by nonce. */
export function opsPolicy({ styleNonce = null, scriptNonce = null } = {}) {
  let policy = OPS_CSP;
  if (styleNonce) policy = policy.replace("style-src 'self'", `style-src 'self' 'nonce-${styleNonce}'`);
  if (scriptNonce) policy = policy.replace("script-src 'self'", `script-src 'self' 'nonce-${scriptNonce}'`);
  return policy;
}

const STATES = {
  signIn: {
    title: "Restricted operations",
    line: "Staff only. Sign in with an owner or developer account.",
    action: "Continue with WorkOS",
  },
  reauthenticate: {
    title: "Sign in again",
    line: "Ops needs a sign-in from the last 5 minutes.",
    action: "Reauthenticate",
  },
  denied: {
    title: "Access denied",
    line: "This account has no owner or developer role.",
    action: "Sign out",
    secondary: true,
  },
  unavailable: {
    title: "Ops is unavailable",
    line: "Couldn’t reach the control plane. Try again shortly.",
    action: "Try again",
  },
};

/** A centred Ops state. `href` is where its one action goes. */
export function opsStatePage(kind, { href, nonce }) {
  const state = STATES[kind];
  return shell(
    `${state.title} · Zeros Ops`,
    `<div class="title">${state.title}</div>
          <div class="sub">${state.line}</div>
          <div class="acts"><a class="btn${state.secondary ? " secondary" : ""}" href="${esc(href)}">${state.action}</a></div>`,
    { nonce, headerBadge: "Ops" },
  );
}

const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  deletion: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  identity: svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
  signOut: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>'),
};

// The console follows the system appearance before first paint.
const THEME_SCRIPT =
  '(()=>{const m=matchMedia("(prefers-color-scheme: light)");const s=()=>{document.documentElement.dataset.theme=m.matches?"light":"dark"};s();m.addEventListener("change",s)})();';

const ROLE_LABELS = { platform_owner: "Platform owner", developer: "Developer" };

function field({ name, hint = "", control }) {
  return `<label class="row"><span class="row-text"><span class="row-name">${name}</span>${hint ? `<span class="row-hint">${hint}</span>` : ""}</span><span class="row-ctl">${control}</span></label>`;
}

function locateFields({ codeName, codePattern, codePlaceholder }) {
  return `${field({
    name: codeName,
    hint: codePlaceholder,
    control: `<input class="input mono" name="code" required pattern="${codePattern}" placeholder="${codePlaceholder}" autocomplete="off" spellcheck="false" aria-label="${codeName}" />`,
  })}${field({
    name: "Support case",
    hint: "SUP-123456",
    control: '<input class="input mono" name="supportCaseReference" required minlength="6" maxlength="128" placeholder="SUP-123456" autocomplete="off" spellcheck="false" aria-label="Support case reference" />',
  })}${field({
    name: "Ownership verified",
    hint: "Out-of-band verification is recorded in the support case.",
    control: '<input class="check" name="ownershipVerified" type="checkbox" required aria-label="Ownership verified" />',
  })}`;
}

function deletionSection() {
  return `<header class="page-head"><div><h1>Deletion recovery</h1><p>Look up one request by recovery code and support case.</p></div></header>
        <form id="lookup-form" class="contents">
          <section class="group"><h2 class="group-title">Locate a request</h2><div class="card">${locateFields({ codeName: "Deletion recovery code", codePattern: "ZD-[A-Z2-9]{4}-[A-Z2-9]{4}", codePlaceholder: "ZD-XXXX-XXXX" })}</div></section>
          <div class="form-acts"><button class="button primary" type="submit">Look up request</button></div>
        </form>
        <p id="lookup-error" class="form-msg error" role="alert"></p>
        <div id="request-panel" class="contents" hidden aria-live="polite">
          <section class="group"><h2 class="group-title">Request</h2><div class="card">
            <div class="row"><span class="row-who"><span class="avatar square" id="request-avatar" aria-hidden="true"></span><span class="row-text"><span class="row-name" id="request-summary"></span><span class="row-hint" id="request-title"></span></span></span><span class="row-ctl"><span id="request-state" class="badge"></span></span></div>
            <dl id="request-details" class="kv"></dl>
          </div></section>
          <div class="form-acts"><button id="purge-button" class="button danger-secondary" type="button">Force purge</button><button id="restore-button" class="button primary" type="button">Restore</button></div>
          <div id="owner-grant" class="contents" hidden>
            <form id="grant-form" class="contents">
              <section class="group"><h2 class="group-title">Grant a developer one operation</h2><div class="card">
                ${field({ name: "Developer", control: '<select class="select compact" name="granteeUserId" required aria-label="Developer"></select>' })}
                <div class="row"><span class="row-text"><span class="row-name" id="capability-label">Capability</span></span><span class="row-ctl"><span class="seg" role="radiogroup" aria-labelledby="capability-label"><label class="seg-item"><input type="radio" name="capability" value="deletion.restore" checked />Restore</label><label class="seg-item"><input type="radio" name="capability" value="deletion.force_purge" />Force purge</label><label class="seg-item"><input type="radio" name="capability" value="deletion.read" />Read only</label></span></span></div>
                ${field({ name: "Expires in", control: '<select class="select compact" name="expiresInMinutes" aria-label="Expires in"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select>' })}
              </div></section>
              <div class="form-acts"><button class="button primary" type="submit">Create approval</button></div>
            </form>
            <p id="grant-result" class="form-msg"></p>
          </div>
          <div id="purge-confirmation" class="contents" hidden>
            <section class="group"><h2 class="group-title">Force purge</h2><div class="card">${field({
              name: "Confirm purge",
              hint: 'Type <span class="phrase" id="purge-phrase"></span> to continue.',
              control: '<input class="input mono" id="purge-input" autocomplete="off" spellcheck="false" aria-label="Force purge phrase" />',
            })}</div></section>
            <div class="form-acts"><button id="purge-confirm-button" class="button danger" type="button">Permanently purge now</button></div>
          </div>
          <p id="action-result" class="form-msg" role="status"></p>
        </div>`;
}

function identitySection() {
  return `<header class="page-head"><div><h1>Identity recovery</h1><p>Approve a reviewed ZR-XXXX-XXXX link after a WorkOS identity deletion.</p></div></header>
        <form id="identity-recovery-form" class="contents">
          <section class="group"><h2 class="group-title">Locate a request</h2><div class="card">${locateFields({ codeName: "Identity recovery code", codePattern: "ZR-[A-Z2-9]{4}-[A-Z2-9]{4}", codePlaceholder: "ZR-XXXX-XXXX" })}</div></section>
          <div class="form-acts"><button class="button primary" type="submit">Approve identity link</button></div>
        </form>
        <p id="identity-result" class="form-msg" role="status"></p>`;
}

/** The Ops console. Platform owners also get Identity recovery. */
export function opsConsolePage({ session, section, signOutHref, nonce }) {
  const role = session.user.role;
  const owner = role === "platform_owner";
  const current = owner && section === "identity" ? "identity" : "deletion";
  const navRow = (id, href, name) =>
    `<a class="nav-row" href="${href}" aria-current="${current === id ? "page" : "false"}">${ICONS[id]}<span class="nav-name">${name}</span></a>`;
  const label = ROLE_LABELS[role] ?? "Staff";
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${current === "identity" ? "Identity recovery" : "Deletion recovery"} · Zeros Ops</title>
  <script nonce="${esc(nonce)}">${THEME_SCRIPT}</script>
  <link rel="stylesheet" href="/dashboard.css?v=${OPS_ASSET_REVISION}" />
  <link rel="stylesheet" href="/ops.css?v=${OPS_ASSET_REVISION}" />
</head>
<body class="dashboard-page ops-page">
  <div class="app-shell">
    <aside class="sidebar" aria-label="Ops sections">
      <div class="sidebar-band"><a class="brand" href="/" aria-label="Zeros home">${BRAND_LOGO}</a><span class="badge ops-badge">Ops</span></div>
      <nav class="sidebar-nav" aria-label="Ops">
        <p class="nav-label first">Recovery</p>
        <div class="nav-list">${navRow("deletion", "/", "Deletion recovery")}${owner ? navRow("identity", "/?section=identity", "Identity recovery") : ""}</div>
        <div class="nav-foot">
          <div class="nav-me"><span class="avatar" aria-hidden="true">${esc(initials(session.user.displayName || session.user.email))}</span><span class="row-text"><span class="row-name">${esc(session.user.email)}</span><span class="row-hint">${esc(label)} · ${esc(session.deploymentChannel)}</span></span></div>
          <a class="nav-row" href="${esc(signOutHref)}">${ICONS.signOut}<span class="nav-name">Sign out</span></a>
        </div>
      </nav>
    </aside>
    <main class="main-content layout" data-role="${esc(role)}">
      <div class="content-scroll"><div class="content-column">
        ${current === "identity" ? identitySection() : deletionSection()}
      </div></div>
    </main>
  </div>
  <script type="module" src="/ops.js?v=${OPS_ASSET_REVISION}"></script>
</body>
</html>`;
}
