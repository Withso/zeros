import { shell as pageShell } from "./page.ts";

const INVITE_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
export {responseHeaders as invitationResponseHeaders,shell as invitationPageShell};

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
  return pageShell(title, inner, { nonce });
}

function invalidInner(marketingOrigin) {
  return `<div class="title">This invite link is incomplete</div>
          <div class="sub">Ask the person who invited you to send a fresh link.</div>
          <p class="meta">Don’t have Zeros? <a href="${escapeHtml(marketingOrigin)}">Download it</a></p>`;
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
        message.className = "msg ok";
        copy.setAttribute("aria-pressed", "true");
      } catch {
        message.textContent = "Copy this page’s address from the address bar.";
        message.className = "msg";
        copy.removeAttribute("aria-pressed");
      }
    });`;
  return `<div class="title">You’re invited to Zeros</div>
          <div class="sub">Accept with the email this invite was sent to.</div>
          <div class="acts"><a class="btn" href="${escapeHtml(desktopUrl)}">Open in Zeros</a><a class="btn ghost" href="${escapeHtml(webPath)}">Continue in browser</a><button class="btn ghost" id="copy" type="button">Copy link</button></div>
          <div class="msg" id="message" aria-live="polite"></div>
          <p class="meta">Don’t have Zeros? <a href="${escapeHtml(marketingOrigin)}">Download it</a></p>
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
    const sub = document.getElementById("sub");
    const retry = document.getElementById("retry");
    const another = document.getElementById("another");
    function again(label) {
      retry.textContent = label;
      retry.disabled = false;
      retry.classList.remove("hidden");
    }
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
      another.classList.add("hidden");
      message.classList.remove("error");
      if (typeof TOKEN !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(TOKEN)) {
        forget();
        retry.classList.add("hidden");
        message.classList.add("error");
        message.textContent = "This session expired. Open the invitation email again.";
        return;
      }
      retry.textContent = "Accepting…";
      retry.disabled = true;
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
        message.textContent = "Zeros is unreachable. Your invitation wasn’t changed.";
        again("Try again");
        return;
      }
      retry.classList.add("hidden");
      if (response.status === 401) {
        if (!stored) {
          message.classList.add("error");
          message.textContent = "Allow tab storage, then open the email link again.";
          return;
        }
        let authAttempted = false;
        try {
          authAttempted = sessionStorage.getItem(AUTH_ATTEMPT_KEY) === "1";
        } catch {}
        if (authAttempted) {
          message.classList.add("error");
          message.textContent = "Sign-in didn’t create a session. Open the email again.";
          return;
        }
        try {
          sessionStorage.setItem(AUTH_ATTEMPT_KEY, "1");
          if (sessionStorage.getItem(AUTH_ATTEMPT_KEY) !== "1") {
            throw new Error("auth attempt storage unavailable");
          }
        } catch {
          message.classList.add("error");
          message.textContent = "Allow tab storage, then open the email link again.";
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
        sub.textContent = "This invite is for another email. Switch accounts to accept.";
        message.classList.remove("error");
        message.textContent = "";
        another.classList.remove("hidden");
      } else if (code === "invalid_invite") {
        forget();
        message.textContent = "This invite expired or was used. Ask for a new one.";
      } else if (code === "invite_preparing") {
        message.textContent = "Setup was still finishing. Nothing changed; try again.";
        again("Try again");
      } else if (code === "auth_unavailable" || response.status >= 500) {
        message.textContent = "We couldn’t verify the invite. Nothing was changed.";
        again("Try again");
      } else {
        message.textContent = "We couldn’t accept this invite. Nothing was changed.";
        again("Try again");
      }
    }
    retry.addEventListener("click", accept);
    another.addEventListener("click", () => {
      try { sessionStorage.removeItem(AUTH_ATTEMPT_KEY); } catch {}
    });
    retry.classList.remove("hidden");`;
  return `<div class="title">Accept your invitation</div>
          <div class="sub" id="sub">Join using the account you’re signed in with.</div>
          <div class="acts"><button class="btn" id="retry" type="button">Accept invitation</button><a class="btn hidden" id="another" href="${escapeHtml(logout)}">Use another account</a></div>
          <div class="msg" id="message" aria-live="polite"></div>
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
