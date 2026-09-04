import { proxyControlPlane } from "./control-plane-proxy";
import { appOrigin } from "./hosts";
import { esc, html } from "./page";
import { getVerifiedSessionWithId, type Env } from "./session";

const OPS_ASSET_REVISION = "2026-09-03.1";

function opsShell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${esc(title)} · Zeros Ops</title>
    <link rel="stylesheet" href="/ops.css?v=${OPS_ASSET_REVISION}" />
  </head>
  <body>${inner}</body>
</html>`;
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function signInPage(env: Env): Response {
  const returnTo = `${appOrigin(env)}/`;
  return noStore(
    html(
      opsShell(
        "Sign in",
        `<main class="center-card">
          <div class="wordmark">zeros <span>ops</span></div>
          <h1>Restricted operations</h1>
          <p>Sign in with an authorized Zeros owner or developer account.</p>
          <a class="button primary" href="/auth/start?max_age=300&amp;return=${encodeURIComponent(returnTo)}">Continue with WorkOS</a>
        </main>`,
      ),
      401,
    ),
  );
}

function reauthenticationPage(env: Env): Response {
  const returnTo = `${appOrigin(env)}/`;
  return noStore(
    html(
      opsShell(
        "Reauthenticate",
        `<main class="center-card">
          <div class="wordmark">zeros <span>ops</span></div>
          <h1>Reauthentication required</h1>
          <p>Ops requires a WorkOS authentication ceremony completed within the last five minutes.</p>
          <a class="button primary" href="/auth/start?max_age=300&amp;return=${encodeURIComponent(returnTo)}">Reauthenticate</a>
        </main>`,
      ),
      401,
    ),
  );
}

function deniedPage(env: Env): Response {
  return noStore(
    html(
      opsShell(
        "Access denied",
        `<main class="center-card">
          <div class="wordmark">zeros <span>ops</span></div>
          <h1>Access denied</h1>
          <p>This account has no Zeros owner or developer role.</p>
          <a class="button" href="/auth/logout?return=${encodeURIComponent(`${appOrigin(env)}/`)}">Sign out</a>
        </main>`,
      ),
      404,
    ),
  );
}

type OpsSession = {
  user: {
    id: string;
    displayName: string | null;
    email: string;
    role: "platform_owner" | "developer";
  };
  deploymentChannel: "development" | "alpha" | "production";
};

function workspace(env: Env, session: OpsSession): Response {
  const roleLabel =
    session.user.role === "platform_owner" ? "Platform owner" : "Developer";
  return noStore(
    html(
      opsShell(
        "Deletion recovery",
        `<header class="topbar">
          <div class="wordmark">zeros <span>ops</span></div>
          <div class="operator">
            <span>${esc(session.user.email)}</span>
            <span class="badge">${esc(roleLabel)}</span>
            <span class="badge channel">${esc(session.deploymentChannel)}</span>
            <a href="/auth/logout?return=${encodeURIComponent(`${appOrigin(env)}/`)}">Sign out</a>
          </div>
        </header>
        <main class="layout" data-role="${esc(session.user.role)}">
          <section class="intro">
            <h1>Deletion recovery</h1>
            <p>Exact recovery code and support case only. Email lookup and bulk customer browsing are intentionally unavailable.</p>
          </section>
          <section class="panel">
            <h2>Locate a request</h2>
            <form id="lookup-form">
              <label>Deletion recovery code
                <input name="code" required pattern="ZD-[A-Z2-9]{4}-[A-Z2-9]{4}" placeholder="ZD-XXXX-XXXX" autocomplete="off" spellcheck="false" />
              </label>
              <label>Support case reference
                <input name="supportCaseReference" required minlength="6" maxlength="128" placeholder="SUP-123456" autocomplete="off" />
              </label>
              <label class="check"><input name="ownershipVerified" type="checkbox" required /> Out-of-band ownership verification is recorded in the support case.</label>
              <button class="button primary" type="submit">Look up exact request</button>
            </form>
            <p id="lookup-error" class="error" role="alert"></p>
          </section>
          <section id="request-panel" class="panel" hidden aria-live="polite">
            <div class="request-heading">
              <div><h2 id="request-title">Request</h2><p id="request-summary"></p></div>
              <span id="request-state" class="badge"></span>
            </div>
            <dl id="request-details"></dl>
            <div id="owner-grant" hidden>
              <hr />
              <h3>Grant a developer one exact operation</h3>
              <form id="grant-form">
                <label>Developer<select name="granteeUserId" required></select></label>
                <label>Capability<select name="capability" required>
                  <option value="deletion.restore">Restore</option>
                  <option value="deletion.force_purge">Force purge</option>
                  <option value="deletion.read">Read only</option>
                </select></label>
                <label>Expires in<select name="expiresInMinutes"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select></label>
                <button class="button" type="submit">Create approval</button>
              </form>
              <p id="grant-result" class="notice"></p>
            </div>
            <hr />
            <div class="actions">
              <button id="restore-button" class="button primary" type="button">Restore</button>
              <button id="purge-button" class="button danger" type="button">Force purge</button>
            </div>
            <div id="purge-confirmation" hidden>
              <label>Type <strong id="purge-phrase"></strong> to continue
                <input id="purge-input" autocomplete="off" spellcheck="false" />
              </label>
              <button id="purge-confirm-button" class="button danger" type="button">Permanently purge now</button>
            </div>
            <p id="action-result" class="notice" role="status"></p>
          </section>
          <section class="panel compact" ${session.user.role === "platform_owner" ? "" : "hidden"}>
            <h2>Provider identity recovery</h2>
            <p>Use only when WorkOS identity deletion produced a reviewed <code>ZR-XXXX-XXXX</code> recovery request.</p>
            <form id="identity-recovery-form">
              <label>Identity recovery code<input name="code" required pattern="ZR-[A-Z2-9]{4}-[A-Z2-9]{4}" placeholder="ZR-XXXX-XXXX" autocomplete="off" /></label>
              <label>Support case reference<input name="supportCaseReference" required minlength="6" maxlength="128" placeholder="SUP-123456" autocomplete="off" /></label>
              <label class="check"><input name="ownershipVerified" type="checkbox" required /> Out-of-band ownership verification is recorded in the support case.</label>
              <button class="button" type="submit">Approve reviewed identity link</button>
            </form>
            <p id="identity-result" class="notice"></p>
          </section>
        </main>
        <script type="module" src="/ops.js?v=${OPS_ASSET_REVISION}"></script>`,
      ),
    ),
  );
}

export async function renderOps(request: Request, env: Env): Promise<Response> {
  const verified = await getVerifiedSessionWithId(env, request).catch(() => null);
  if (!verified) return signInPage(env);
  const headers = new Headers({ accept: "application/json" });
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);
  const response = await proxyControlPlane(
    new Request(new URL("/api/v1/ops/session", request.url), { headers }),
    env,
    verified,
  );
  if (response.status === 401) return reauthenticationPage(env);
  if (response.status === 403 || response.status === 404) return deniedPage(env);
  if (!response.ok) {
    return noStore(
      html(
        opsShell(
          "Unavailable",
          `<main class="center-card"><h1>Ops is unavailable</h1><p>The control plane could not be reached safely. Retry shortly.</p></main>`,
        ),
        503,
      ),
    );
  }
  const session = (await response.json()) as OpsSession;
  return workspace(env, session);
}
