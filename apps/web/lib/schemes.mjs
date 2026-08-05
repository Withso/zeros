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

/** Allow-listed scheme, or DEFAULT_SCHEME. Never returns caller-controlled input. */
export function schemeOrDefault(scheme) {
  return SCHEMES.has(scheme) ? scheme : DEFAULT_SCHEME;
}
