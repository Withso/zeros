// app.zeros.build/invite?token=…  — the invitation email's landing page.
//
// The control plane's invite emails point here (INVITE_LINK_BASE). The page
// hands the token to the desktop app via the zeros:// deep link (which
// navigates Settings → Team and prefills the Join box), with a
// copy-link fallback for people who'd rather paste it into the app manually.
//
// No session logic, no server state: the token is opaque to this page (the
// control plane validates it at redemption; only its SHA-256 is stored
// server-side). The token is charset-validated before being echoed, and only
// ever emitted via JSON.stringify / encodeURIComponent — no markup injection.
//
// `?scheme=zeros-alpha` / `zeros-beta` / `zeros-dev` (allow-listed) targets that
// channel's app; real emails omit it and get the packaged app's zeros:// scheme.
// The values mirror the desktop's per-channel deep-link schemes
// (src/engine/runtime.ts schemeForChannel) so an invite opens the intended app.

import { marketingOrigin } from "../lib/hosts";
import type { Env } from "../lib/session";
// Allow-list lives in lib/schemes.mjs — imported, never re-declared. A local copy
// here silently sent every Alpha invite to the Production app.
import { schemeOrDefault } from "../lib/schemes.mjs";

// 32-byte base64url tokens are 43 chars; bounds guard against abuse.
const INVITE_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font: 14px -apple-system, system-ui, sans-serif;
        background: #0c0c0d; color: #e6e6e6;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center;
      }
      .card { width: 100%; max-width: 340px; padding: 0 1.5rem; text-align: center; }
      .title { font-weight: 600; color: #f4f4f5; margin-bottom: 0.35rem; }
      .sub { color: #a1a1aa; font-size: 13px; line-height: 1.5; margin-bottom: 1.5rem; }
      a.btn, button.btn {
        display: flex; align-items: center; justify-content: center;
        width: 100%; box-sizing: border-box;
        margin-top: 0.6rem; padding: 0.6rem 1rem;
        color: #0c0c0d; font: inherit; font-weight: 600; cursor: pointer;
        text-decoration: none; background: #ffffff;
        border: 1px solid #ffffff; border-radius: 8px;
      }
      a.btn:hover, button.btn:hover { background: #e6e6e6; }
      button.btn.secondary {
        background: transparent; color: #e6e6e6; border-color: #3f3f46;
      }
      button.btn.secondary:hover { background: #18181b; }
      .msg { color: #a1a1aa; font-size: 13px; margin-top: 0.75rem; }
      .hint { color: #71717a; font-size: 12px; line-height: 1.5; margin-top: 1.25rem; }
    </style>
  </head>
  <body><div class="card">${inner}</div></body>
</html>`;
}

function invalidInner(mkt: string): string {
  return `<div class="title">This invite link is incomplete</div>
          <div class="sub">Ask the person who invited you to send a fresh link — or paste the one from your email into Zeros under Settings → Team → Join a team.</div>
          <a class="btn" href="${mkt}">Get Zeros</a>`;
}

function inviteInner(scheme: string, token: string, mkt: string): string {
  // Both values are allow-list/charset validated; JSON.stringify keeps the
  // script injection-safe either way.
  const script = `
    const LINK = ${JSON.stringify(`${scheme}://invite?token=${encodeURIComponent(token)}`)};
    const open = document.getElementById("open");
    const copy = document.getElementById("copy");
    const msg = document.getElementById("msg");
    open.addEventListener("click", () => {
      window.location.href = LINK;
      msg.textContent = "Opening Zeros… if nothing happens, use “Copy invite link” and paste it in the app.";
    });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        msg.textContent = "Link copied — in Zeros: Settings → Team → Join a team.";
      } catch {
        msg.textContent = "Couldn't copy automatically — copy this page's URL from the address bar.";
      }
    });
  `;
  return `<div class="title">You've been invited to Zeros</div>
          <div class="sub">Accept the invitation in the desktop app — your team's workspaces, settings, and agents are waiting.</div>
          <button class="btn" id="open" type="button">Open in Zeros</button>
          <button class="btn secondary" id="copy" type="button">Copy invite link</button>
          <div class="msg" id="msg"></div>
          <div class="hint">Don't have Zeros yet? <a href="${mkt}" style="color:#e6e6e6">Download it</a>, sign in with the email this invite was sent to, then come back to this link.</div>
          <script>${script}</script>`;
}

export const onRequestGet: PagesFunction<Env> = ({ request, env }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const scheme = schemeOrDefault(url.searchParams.get("scheme") ?? "");
  const mkt = marketingOrigin(env);
  if (!INVITE_TOKEN.test(token)) {
    return html(shell("Zeros — invitation", invalidInner(mkt)));
  }
  return html(shell("Zeros — you're invited", inviteInner(scheme, token, mkt)));
};
