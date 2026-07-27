/**
 * Unit tests for the desktop deep-link scheme allow-list used by the sign-in hub
 * (lib/hub.ts `valid()`) and the invite page (functions/invite.ts). No Workers
 * runtime required — mirrors the pure logic here, same as lib/hosts.test.mjs.
 *
 * Run: node --test lib/schemes.test.mjs  (from website/web-app)
 *
 * Contract under test: the three per-channel schemes from the desktop
 * (src/engine/runtime.ts schemeForChannel — zeros / zeros-beta / zeros-dev) are
 * accepted and echoed back, and anything else is rejected. zeros-beta MUST be
 * accepted: without it the hub drops a Beta sign-in's scheme and the returning
 * link resolves to whichever app owns bare zeros:// (the "Open Zeros Beta?"
 * mis-route this change fixes).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mirror of lib/hub.ts + functions/invite.ts.
const SCHEMES = new Set(["zeros", "zeros-beta", "zeros-dev"]);
const TOKENISH = /^[A-Za-z0-9_-]{1,512}$/; // lib/util.ts

// Mirror of hub.ts valid(): a handoff is usable only with an allow-listed scheme
// and tokenish nonce + challenge.
function validHandoff(h) {
  return (
    !!h &&
    SCHEMES.has(h.scheme) &&
    TOKENISH.test(h.nonce) &&
    TOKENISH.test(h.challenge)
  );
}

// Mirror of invite.ts: fall back to the packaged app's zeros:// for anything not
// allow-listed.
function inviteScheme(schemeParam) {
  return SCHEMES.has(schemeParam) ? schemeParam : "zeros";
}

const OK_TOKEN = "abc123_-DEF";

describe("hub handoff scheme allow-list", () => {
  it("accepts all three per-channel schemes", () => {
    for (const scheme of ["zeros", "zeros-beta", "zeros-dev"]) {
      assert.equal(
        validHandoff({ scheme, nonce: OK_TOKEN, challenge: OK_TOKEN }),
        true,
        `${scheme} should be accepted`,
      );
    }
  });

  it("rejects a foreign / unknown scheme even with valid tokens", () => {
    for (const scheme of ["zeros-evil", "javascript", "http", "", "ZEROS"]) {
      assert.equal(
        validHandoff({ scheme, nonce: OK_TOKEN, challenge: OK_TOKEN }),
        false,
        `${scheme} should be rejected`,
      );
    }
  });

  it("rejects an allow-listed scheme with a non-tokenish nonce/challenge", () => {
    assert.equal(
      validHandoff({ scheme: "zeros-beta", nonce: "has space", challenge: OK_TOKEN }),
      false,
    );
    assert.equal(
      validHandoff({ scheme: "zeros-beta", nonce: OK_TOKEN, challenge: "a/b" }),
      false,
    );
  });
});

describe("invite page scheme selection", () => {
  it("passes through the three per-channel schemes", () => {
    assert.equal(inviteScheme("zeros"), "zeros");
    assert.equal(inviteScheme("zeros-beta"), "zeros-beta");
    assert.equal(inviteScheme("zeros-dev"), "zeros-dev");
  });

  it("falls back to zeros:// for an unknown scheme (no open redirect to a foreign app)", () => {
    assert.equal(inviteScheme("zeros-evil"), "zeros");
    assert.equal(inviteScheme("javascript"), "zeros");
    assert.equal(inviteScheme(""), "zeros");
  });
});
