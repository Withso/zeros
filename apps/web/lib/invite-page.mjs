const INVITE_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;

export function invitationTokenFromSearchParams(searchParams) {
  const zerosTokens = searchParams.getAll("token");
  const workosTokens = searchParams.getAll("invitation_token");
  if (zerosTokens.length + workosTokens.length !== 1) {
    return { token: "", tokenParameter: "token" };
  }
  return workosTokens.length === 1
    ? { token: workosTokens[0] ?? "", tokenParameter: "invitation_token" }
    : { token: zerosTokens[0] ?? "", tokenParameter: "token" };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function responseHeaders(nonce) {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "content-security-policy": [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  });
}

function shell(title, inner, nonce) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <style nonce="${nonce}">
      :root { color-scheme: dark; }
      body {
        font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0c0c0d; color: #e6e6e6;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center;
      }
      .card { width: 100%; max-width: 360px; padding: 0 1.5rem; text-align: center; }
      .title { font-weight: 650; color: #f4f4f5; margin-bottom: 0.35rem; }
      .sub { color: #a1a1aa; font-size: 13px; line-height: 1.5; margin-bottom: 1.5rem; }
      a.btn, button.btn {
        display: flex; align-items: center; justify-content: center;
        width: 100%; box-sizing: border-box;
        margin-top: 0.6rem; padding: 0.65rem 1rem;
        color: #0c0c0d; font: inherit; font-weight: 600; cursor: pointer;
        text-decoration: none; background: #fff;
        border: 1px solid #fff; border-radius: 8px;
      }
      a.btn:hover, button.btn:hover { background: #e6e6e6; }
      a.btn.secondary, button.btn.secondary {
        background: transparent; color: #e6e6e6; border-color: #3f3f46;
      }
      a.btn.secondary:hover, button.btn.secondary:hover { background: #18181b; }
      .msg { color: #a1a1aa; font-size: 13px; line-height: 1.5; margin-top: 0.9rem; }
      .msg.error { color: #f87171; }
      .hint { color: #71717a; font-size: 12px; line-height: 1.5; margin-top: 1.25rem; }
      .hint a { color: #e6e6e6; }
      .hidden { display: none !important; }
    </style>
  </head>
  <body><main class="card">${inner}</main></body>
</html>`;
}

function invalidInner(marketingOrigin) {
  return `<div class="title">This invite link is incomplete</div>
          <div class="sub">Ask the person who invited you to send a fresh link.</div>
          <a class="btn" href="${escapeHtml(marketingOrigin)}">Get Zeros</a>`;
}

function landingInner(token, tokenParameter, scheme, marketingOrigin, nonce) {
  const encodedToken = encodeURIComponent(token);
  const desktopUrl = `${scheme}://invite?${tokenParameter}=${encodedToken}`;
  const webPath = `/invite?${tokenParameter}=${encodedToken}&mode=web`;
  const script = `
    const copy = document.getElementById("copy");
    const message = document.getElementById("message");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        message.textContent = "Link copied.";
      } catch {
        message.textContent = "Copy this page's URL from the address bar.";
      }
    });`;
  return `<div class="title">You've been invited to Zeros</div>
          <div class="sub">Choose where to accept this invitation. The link is single-use and tied to the invited email address.</div>
          <a class="btn" href="${escapeHtml(desktopUrl)}">Open in Zeros</a>
          <a class="btn secondary" href="${escapeHtml(webPath)}">Continue in browser</a>
          <button class="btn secondary" id="copy" type="button">Copy invite link</button>
          <div class="msg" id="message" aria-live="polite"></div>
          <div class="hint">Don't have Zeros yet? <a href="${escapeHtml(marketingOrigin)}">Download it</a>.</div>
          <script nonce="${nonce}">${script}</script>`;
}

function webInner(token, nonce) {
  const initialToken = INVITE_TOKEN.test(token) ? token : null;
  const returnPath = "/invite?mode=resume";
  const authStart = `/auth/start?return=${encodeURIComponent(returnPath)}`;
  const logout = `/auth/logout?return=${encodeURIComponent(returnPath)}`;
  const script = `
    const INITIAL_TOKEN = ${JSON.stringify(initialToken)};
    const STORAGE_KEY = "zeros:invitation:pending";
    const AUTH_ATTEMPT_KEY = "zeros:invitation:auth-attempted";
    const AUTH_START = ${JSON.stringify(authStart)};
    const message = document.getElementById("message");
    const retry = document.getElementById("retry");
    const another = document.getElementById("another");
    let stored = false;
    if (INITIAL_TOKEN) {
      try {
        sessionStorage.setItem(STORAGE_KEY, INITIAL_TOKEN);
        sessionStorage.removeItem(AUTH_ATTEMPT_KEY);
        stored = sessionStorage.getItem(STORAGE_KEY) === INITIAL_TOKEN;
      } catch {}
      history.replaceState(null, "", ${JSON.stringify(returnPath)});
    }
    let TOKEN = INITIAL_TOKEN;
    if (!TOKEN) {
      try {
        TOKEN = sessionStorage.getItem(STORAGE_KEY);
        stored = typeof TOKEN === "string";
      } catch {}
    }
    function forget() {
      try {
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(AUTH_ATTEMPT_KEY);
      } catch {}
      TOKEN = null;
    }
    async function accept() {
      retry.classList.add("hidden");
      another.classList.add("hidden");
      message.classList.remove("error");
      if (typeof TOKEN !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(TOKEN)) {
        forget();
        message.classList.add("error");
        message.textContent = "Invitation session expired. Open the original invitation email again.";
        return;
      }
      message.textContent = "Checking your invitation…";
      let response;
      try {
        response = await fetch("/api/v1/invitations/accept", {
          method:"POST",
          credentials:"same-origin",
          headers:{"Content-Type":"application/json","X-Zeros-Request":"dashboard"},
          body:JSON.stringify({token:TOKEN}),
        });
      } catch {
        message.classList.add("error");
        message.textContent = "Zeros is temporarily unreachable. Your invitation was not changed.";
        retry.classList.remove("hidden");
        return;
      }
      if (response.status === 401) {
        if (!stored) {
          message.classList.add("error");
          message.textContent = "This browser blocked the temporary invitation session. Allow tab storage and open the email link again.";
          return;
        }
        let authAttempted = false;
        try {
          authAttempted = sessionStorage.getItem(AUTH_ATTEMPT_KEY) === "1";
        } catch {}
        if (authAttempted) {
          message.classList.add("error");
          message.textContent = "Sign-in did not establish a Zeros session. Open the original invitation email and try again.";
          return;
        }
        try {
          sessionStorage.setItem(AUTH_ATTEMPT_KEY, "1");
          if (sessionStorage.getItem(AUTH_ATTEMPT_KEY) !== "1") {
            throw new Error("auth attempt storage unavailable");
          }
        } catch {
          message.classList.add("error");
          message.textContent = "This browser blocked the temporary invitation session. Allow tab storage and open the email link again.";
          return;
        }
        window.location.replace(AUTH_START);
        return;
      }
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        forget();
        const organizationId = payload?.organization?.id;
        const destination =
          typeof organizationId === "string" && /^[0-9a-f-]{36}$/i.test(organizationId)
            ? "/?organization=" + encodeURIComponent(organizationId) + "&section=general"
            : "/";
        window.location.replace(destination);
        return;
      }
      const code = payload?.error?.code;
      message.classList.add("error");
      if (code === "wrong_account") {
        message.textContent = "This invitation belongs to a different account. Sign out, then use the invited email address.";
        another.classList.remove("hidden");
      } else if (code === "invalid_invite") {
        forget();
        message.textContent = "This invitation is expired, revoked, or already used. Ask an organization admin for a fresh invitation.";
      } else if (code === "invite_preparing") {
        message.textContent = "Your invitation email arrived just before setup finished. Nothing was changed; try again.";
        retry.classList.remove("hidden");
      } else if (code === "auth_unavailable" || response.status >= 500) {
        message.textContent = "Zeros could not verify the invitation right now. Nothing was changed; try again.";
        retry.classList.remove("hidden");
      } else {
        message.textContent = "Zeros could not accept this invitation. Nothing was changed.";
        retry.classList.remove("hidden");
      }
    }
    retry.addEventListener("click", accept);
    another.addEventListener("click", () => {
      try { sessionStorage.removeItem(AUTH_ATTEMPT_KEY); } catch {}
    });
    accept();`;
  return `<div class="title">Accepting your invitation</div>
          <div class="sub">Zeros will verify your signed-in account before changing organization access.</div>
          <div class="msg" id="message" aria-live="polite">Checking your invitation…</div>
          <button class="btn secondary hidden" id="retry" type="button">Try again</button>
          <a class="btn secondary hidden" id="another" href="${escapeHtml(logout)}">Use another account</a>
          <script nonce="${nonce}">${script}</script>`;
}

export function renderInvitationPage({
  token,
  tokenParameter = "token",
  scheme,
  marketingOrigin,
  mode,
  nonce,
}) {
  if (!NONCE.test(nonce)) {
    throw new TypeError("Invitation page nonce has an invalid shape");
  }
  if (tokenParameter !== "token" && tokenParameter !== "invitation_token") {
    throw new TypeError("Invitation token parameter is not supported");
  }
  const headers = responseHeaders(nonce);
  if (!INVITE_TOKEN.test(token) && mode !== "resume") {
    return {
      html: shell(
        "Zeros — invitation",
        invalidInner(marketingOrigin),
        nonce,
      ),
      headers,
    };
  }
  return {
    html: shell(
      "Zeros — you're invited",
      mode === "web" || mode === "resume"
        ? webInner(token, nonce)
        : landingInner(token, tokenParameter, scheme, marketingOrigin, nonce),
      nonce,
    ),
    headers,
  };
}
