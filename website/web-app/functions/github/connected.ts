// app.zeros.build/github/connected#scheme=&nonce=&error=
//
// GitHub's confidential OAuth exchange finishes on the control plane, which
// redirects here with only the desktop handoff in the fragment. Fragments do
// not cross the HTTP boundary, so Cloudflare never receives the nonce. The
// page validates it in-browser, removes it from visible history, and offers a
// user-gesture-backed custom-protocol link to the exact Zeros release channel
// that started the connection.

import {
  GITHUB_COMPLETION_ERRORS,
  GITHUB_COMPLETION_SCHEMES,
  parseGithubCompletionFragment,
} from "../../lib/github-completion.mjs";
import { html, shell } from "../../lib/page";
import type { Env } from "../../lib/session";

function completionInner(): string {
  const script = `
    const parseFragment = ${parseGithubCompletionFragment.toString()};
    const parsed = parseFragment(
      window.location.hash,
      ${JSON.stringify(GITHUB_COMPLETION_SCHEMES)},
      ${JSON.stringify(GITHUB_COMPLETION_ERRORS)}
    );
    history.replaceState(null, "", window.location.pathname);

    const title = document.getElementById("github-title");
    const sub = document.getElementById("github-sub");
    const open = document.getElementById("github-open");
    const msg = document.getElementById("github-msg");

    if (parsed.kind === "invalid") {
      title.textContent = "This GitHub link is incomplete";
      sub.textContent = "Return to Zeros, open Settings → Integrations, and start the connection again.";
    } else {
      if (parsed.kind === "error") {
        title.textContent = parsed.error === "access_denied"
          ? "GitHub connection canceled"
          : "GitHub couldn’t connect";
        sub.textContent = "Open Zeros to finish returning to the app and see what to do next.";
      } else {
        title.textContent = "GitHub connected";
        sub.textContent = "Open Zeros to finish linking GitHub on this Mac.";
      }
      open.href = parsed.deepLink;
      open.hidden = false;
      open.addEventListener("click", () => {
        msg.textContent = "Opening Zeros… you can close this tab after the app opens.";
      });
    }
  `;

  return `<img class="hero-logo" src="/zeros-logo.svg" alt="" />
          <div class="hero-title" id="github-title">Finish GitHub connection</div>
          <div class="hero-sub" id="github-sub">Checking this secure handoff…</div>
          <a class="btn" id="github-open" hidden>Open Zeros</a>
          <div class="msg" id="github-msg" aria-live="polite"></div>
          <noscript><div class="msg">JavaScript is required to open the secure desktop handoff. Return to Zeros and try again.</div></noscript>
          <script>${script}</script>`;
}

export const onRequestGet: PagesFunction<Env> = () =>
  html(
    shell("Zeros — GitHub connection", completionInner(), {
      presentation: "hero",
    }),
  );
