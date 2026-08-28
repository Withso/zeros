// The desktop deep-link scheme allow-list — SINGLE SOURCE OF TRUTH.
//
// Mirrors apps/desktop/src/engine/runtime.ts `schemeForChannel`:
//   stable → zeros · alpha → zeros-alpha · beta → zeros-beta · dev → zeros-dev
//
// The desktop passes its own channel's scheme in `?scheme=`. Both consumers
// validate against this list before echoing it back as `<scheme>://…`, so the OS
// reopens the EXACT app that started the flow — not whichever sibling also
// registered bare `zeros://`. An unlisted scheme is never echoed, which is what
// stops `?scheme=javascript` or a foreign app from being handed the callback.
//
// Plain .mjs (typed by schemes.d.mts) on purpose: `lib/*.test.mjs` runs under a
// bare `node --test` with no TypeScript loader, so this is the one module shape
// the tests can import DIRECTLY. Every previous copy of this list was re-declared
// inside its own file — including the test's — so the test asserted against its
// own mirror and stayed green while hub.ts and invite.ts were both missing
// zeros-alpha. Import it; never re-declare it.
export const SCHEMES = new Set([
  "zeros",
  "zeros-alpha",
  "zeros-beta",
  "zeros-dev",
]);

/** The packaged app's scheme — the fallback when `?scheme=` is absent/unlisted. */
export const DEFAULT_SCHEME = "zeros";

const DEPLOYMENT_SCHEMES = Object.freeze({
  alpha: "zeros-alpha",
  beta: "zeros-beta",
  production: "zeros",
});

/** Allow-listed scheme, or DEFAULT_SCHEME. Never returns caller-controlled input. */
export function schemeOrDefault(scheme) {
  return SCHEMES.has(scheme) ? scheme : DEFAULT_SCHEME;
}

/**
 * Choose the invite target for this hosted deployment. A query-string scheme
 * remains useful for local/preview pages, but it must not be able to redirect a
 * deployed Alpha or Beta invitation into a sibling app. Cloudflare validates
 * ZEROS_DEPLOY_ENV against APP_ORIGIN at build time; this is the runtime half of
 * that channel binding.
 */
export function schemeForDeploymentEnvironment(environment, requestedScheme) {
  if (environment === undefined || environment === null || environment === "") {
    return schemeOrDefault(requestedScheme);
  }
  if (!Object.hasOwn(DEPLOYMENT_SCHEMES, environment)) {
    throw new Error("Invalid ZEROS_DEPLOY_ENV for hosted invitation");
  }
  return DEPLOYMENT_SCHEMES[environment];
}
