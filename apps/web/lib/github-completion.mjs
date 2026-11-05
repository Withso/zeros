import { shell } from "./page.ts";
import { SCHEMES } from "./schemes.mjs";

export const GITHUB_COMPLETION_SCHEMES = Object.freeze([...SCHEMES]);
export const GITHUB_COMPLETION_ERRORS = Object.freeze([
  "access_denied",
  "authorization_expired",
  "github_unavailable",
  "handoff_expired",
  "invalid_callback",
  "nonce_mismatch",
  "not_configured",
  "oauth_failed",
  "signed_out",
  "storage_failed",
]);
/** The user has one minute to select Open Zeros. The backend retains a separate
 * 30-second grace period for the desktop's authenticated exchange. */
export const GITHUB_COMPLETION_LINK_TTL_MS = 60_000;

/** Parse the fragment without trusting it as a URL. This function is embedded
 * verbatim with Function.prototype.toString(), so it MUST remain self-contained
 * apart from browser-standard URLSearchParams. The serialization regression
 * test revives it without this module's scope to enforce that build contract. */
export function parseGithubCompletionFragment(
  rawFragment,
  allowedSchemes,
  allowedErrors,
) {
  const params = new URLSearchParams(
    rawFragment.startsWith("#") ? rawFragment.slice(1) : rawFragment,
  );
  const scheme = params.get("scheme") ?? "";
  const nonce = params.get("nonce") ?? "";
  const error = params.get("error") ?? "";
  if (
    !allowedSchemes.includes(scheme) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(nonce) ||
    (error && !allowedErrors.includes(error))
  ) {
    return { kind: "invalid" };
  }

  const handoff = new URLSearchParams({
    nonce,
    ...(error ? { error } : {}),
  });
  const deepLink = `${scheme}://github/connected#${handoff.toString()}`;
  return error
    ? { kind: "error", error, scheme, deepLink }
    : { kind: "connected", scheme, deepLink };
}

/** Remove the nonce from both live page state and the anchor after a short
 * gesture window. This function is embedded verbatim in the completion page,
 * so it must remain self-contained. Returning the idempotent expiry callback
 * also lets pagehide clear an abandoned page before the timer fires. */
export function armGithubCompletionExpiry(
  parsed,
  elements,
  schedule,
  timeoutMs,
) {
  const expire = () => {
    if ("deepLink" in parsed) parsed.deepLink = "";
    // The nonce-bearing link goes; Open Zeros stays and opens the app plainly.
    elements.open.href = `${parsed.scheme}://`;
    elements.open.hidden = false;
    elements.title.textContent = "This GitHub handoff expired";
    elements.sub.textContent =
      "In Zeros, open Settings › Integrations and connect again.";
    elements.msg.textContent = "";
  };
  schedule(expire, timeoutMs);
  return expire;
}

/** The /github/connected page. It checks the fragment in the browser, then
 * names the outcome; every outcome offers Open Zeros. `appLink` is this
 * deployment's app, for a fragment too incomplete to carry its own. */
export function githubCompletionPage(appLink) {
  const script = `
    const parseFragment = ${parseGithubCompletionFragment.toString()};
    const armExpiry = ${armGithubCompletionExpiry.toString()};
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
    document.getElementById("github-spin").hidden = true;

    if (parsed.kind === "invalid") {
      title.textContent = "This GitHub link is incomplete";
      sub.textContent = "In Zeros, open Settings › Integrations and connect again.";
      open.href = ${JSON.stringify(appLink)};
      open.hidden = false;
    } else {
      if (parsed.kind === "error") {
        const canceled = parsed.error === "access_denied";
        title.textContent = canceled ? "GitHub connection canceled" : "GitHub couldn’t connect";
        sub.textContent = canceled
          ? "Nothing was connected. Return to Zeros to try again."
          : "Open Zeros to see what went wrong and try again.";
      } else {
        title.textContent = "GitHub connected";
        sub.textContent = "Open Zeros to finish linking GitHub on this Mac.";
      }
      open.href = parsed.deepLink;
      open.hidden = false;
      open.addEventListener("click", () => {
        msg.textContent = "Opening Zeros… You can close this tab.";
        msg.className = "msg ok";
      });
      const expire = armExpiry(
        parsed,
        { title, sub, open, msg },
        setTimeout,
        ${GITHUB_COMPLETION_LINK_TTL_MS}
      );
      window.addEventListener("pagehide", expire, { once: true });
    }
  `;

  return shell(
    "Zeros — GitHub connection",
    `<div id="github-live">
            <div class="title" id="github-title">Finish GitHub connection</div>
            <div class="sub" id="github-sub">Checking the secure GitHub handoff. This takes a moment.</div>
            <div class="spin" id="github-spin"><span class="orb" aria-hidden="true"></span></div>
            <div class="acts"><a class="btn" id="github-open" hidden>Open Zeros</a></div>
            <div class="msg" id="github-msg" aria-live="polite"></div>
          </div>
          <noscript><div class="title">Turn on JavaScript</div><div class="sub">Enable JavaScript to finish connecting GitHub.</div></noscript>
          <script>${script}</script>`,
    { head: "<noscript><style>#github-live { display: none; }</style></noscript>" },
  );
}
