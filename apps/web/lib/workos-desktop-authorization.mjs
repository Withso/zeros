import { fetchWorkOSRailway } from "./workos-railway.mjs";
import { html, shell } from "./page.ts";
import { SCHEMES } from "./schemes.mjs";

const TOKEN_PART = /^[A-Za-z0-9_-]{43}$/;
const MAX_CALLBACK_VALUE_LENGTH = 8_192;
const DEPLOYMENT_SCHEMES = {
  alpha: "zeros-alpha",
  beta: "zeros-beta",
  production: "zeros",
};

function noStorePage(body, status, scriptNonce = null) {
  const response = html(body, status);
  response.headers.set("cache-control", "no-store");
  response.headers.set("pragma", "no-cache");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set(
    "content-security-policy",
    `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src ${scriptNonce ? `'nonce-${scriptNonce}'` : "'none'"}`,
  );
  return response;
}

function configuredForWorkOS(env) {
  return (env.AUTH_PROVIDER || "auth0").trim().toLowerCase() === "workos";
}

function desktopState(raw, env) {
  if (typeof raw !== "string" || raw.length > 256) return null;
  const separator = raw.indexOf(".");
  if (separator < 1 || raw.indexOf(".", separator + 1) !== -1) return null;
  const scheme = raw.slice(0, separator);
  const nonce = raw.slice(separator + 1);
  if (!SCHEMES.has(scheme) || !TOKEN_PART.test(nonce)) return null;
  const expected = DEPLOYMENT_SCHEMES[(env.ZEROS_DEPLOY_ENV || "").trim()];
  if (expected && expected !== scheme) return null;
  return { value: raw, scheme };
}

function challenge(raw) {
  return typeof raw === "string" && TOKEN_PART.test(raw) ? raw : null;
}

function callbackValue(raw) {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= MAX_CALLBACK_VALUE_LENGTH
    ? raw
    : null;
}

function invalidPage(
  message = "This desktop sign-in link is invalid or expired.",
) {
  return noStorePage(
    shell(
      "Sign-in didn't finish",
      `<div class="title">Sign-in didn't finish</div><div class="sub">${message}</div>`,
    ),
    400,
  );
}

export function renderWorkOSDesktopAuthorizationPage(request, env) {
  if (!configuredForWorkOS(env)) return invalidPage();
  const url = new URL(request.url);
  const state = desktopState(url.searchParams.get("state"), env);
  const codeChallenge = challenge(url.searchParams.get("code_challenge"));
  if (!state || !codeChallenge) return invalidPage();

  const common = `state=${encodeURIComponent(state.value)}&amp;code_challenge=${encodeURIComponent(codeChallenge)}`;
  const inner = `<div class="title">Sign in to Zeros</div>
          <div class="sub">Choose a provider. New here? Signing in creates your account.</div>
          <a class="btn" href="/auth/desktop/start?provider=google&amp;${common}">Continue with Google</a>
          <a class="btn" href="/auth/desktop/start?provider=github&amp;${common}">Continue with GitHub</a>`;
  return noStorePage(shell("Sign in to Zeros", inner), 200);
}

export async function beginWorkOSDesktopAuthorization(
  request,
  env,
  options = {},
) {
  if (!configuredForWorkOS(env)) return invalidPage();
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider");
  const state = desktopState(url.searchParams.get("state"), env);
  const codeChallenge = challenge(url.searchParams.get("code_challenge"));
  if (
    !state ||
    !codeChallenge ||
    (provider !== "google" && provider !== "github")
  ) {
    return invalidPage();
  }
  const query = new URLSearchParams({
    provider,
    state: state.value,
    code_challenge: codeChallenge,
  });
  try {
    return await fetchWorkOSRailway(
      env,
      `/auth/desktop/start?${query.toString()}`,
      { method: "GET" },
      options.fetch || fetch,
    );
  } catch {
    return invalidPage(
      "The sign-in service is temporarily unavailable. Please try again.",
    );
  }
}

export function renderWorkOSDesktopCallback(request, env) {
  if (!configuredForWorkOS(env)) return invalidPage();
  const url = new URL(request.url);
  const state = desktopState(url.searchParams.get("state"), env);
  const code = callbackValue(url.searchParams.get("code"));
  const providerError = callbackValue(url.searchParams.get("error"));
  if (!state || (!code && !providerError) || (code && providerError)) {
    return invalidPage();
  }

  const nonce = crypto.randomUUID().replaceAll("-", "");
  const succeeded = Boolean(code);
  const script = `
    const SCHEME = ${JSON.stringify(state.scheme)};
    const SUCCEEDED = ${JSON.stringify(succeeded)};
    const params = new URLSearchParams(window.location.search);
    const state = params.get("state") || "";
    const code = params.get("code") || "";
    history.replaceState(null, "", window.location.pathname);
    const fragment = SUCCEEDED
      ? "code=" + encodeURIComponent(code) + "&state=" + encodeURIComponent(state)
      : "error=provider_error&state=" + encodeURIComponent(state);
    const target = SCHEME + "://auth/callback#" + fragment;
    const button = document.getElementById("open-zeros");
    button.href = target;
    if (SUCCEEDED) window.location.href = target;
  `;
  const title = succeeded ? "Opening Zeros…" : "Sign-in wasn't completed";
  const detail = succeeded
    ? "Your browser sign-in is complete. If the app does not open, use the button below."
    : "Return to the Zeros app and try signing in again.";
  const inner = `<div class="title">${title}</div>
          <div class="sub">${detail}</div>
          <a class="btn" id="open-zeros" href="#">Open Zeros</a>
          <div class="msg">You may close this tab after the app opens.</div>
          <script nonce="${nonce}">${script}</script>`;
  return noStorePage(shell(title, inner), 200, nonce);
}
