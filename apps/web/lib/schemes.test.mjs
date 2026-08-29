/**
 * Unit tests for the desktop deep-link scheme allow-list used by the sign-in hub
 * (lib/hub.ts `valid()`) and the invite page (functions/invite.ts).
 *
 * Run: node --test lib/schemes.test.mjs  (from apps/web)
 *
 * This file IMPORTS lib/schemes.mjs rather than mirroring it. That distinction is
 * the whole point: the previous version re-declared its own
 * `new Set(["zeros","zeros-beta","zeros-dev"])` and asserted against that copy, so
 * "accepts all per-channel schemes" passed while hub.ts and invite.ts were BOTH
 * missing zeros-alpha — Alpha users got no "Launch Zeros" button, and every Alpha
 * invite link silently opened Production. A mirror can only test itself.
 *
 * Contract: every scheme apps/desktop/src/engine/runtime.ts `schemeForChannel` can return is
 * accepted and echoed back; anything else falls back to zeros:// and is never
 * echoed (no open redirect into a foreign app).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMES,
  DEFAULT_SCHEME,
  schemeForDeploymentEnvironment,
  schemeOrDefault,
} from "./schemes.mjs";

const TOKENISH = /^[A-Za-z0-9_-]{1,512}$/; // lib/handoff-security.ts

/** Mirror of hub.ts valid() — the SHAPE of the check, using the REAL allow-list. */
function validHandoff(h) {
  return (
    !!h &&
    SCHEMES.has(h.scheme) &&
    TOKENISH.test(h.nonce) &&
    TOKENISH.test(h.challenge)
  );
}

// Every value schemeForChannel() can return. Kept honest against the desktop by
// scripts/check-deep-link-schemes.mjs.
const CHANNEL_SCHEMES = ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"];
const OK_TOKEN = "abc123_-DEF";

describe("scheme allow-list", () => {
  it("contains exactly the four channel schemes — no more, no fewer", () => {
    assert.deepEqual([...SCHEMES].sort(), [...CHANNEL_SCHEMES].sort());
  });

  it("defaults to the packaged app's scheme", () => {
    assert.equal(DEFAULT_SCHEME, "zeros");
  });
});

describe("hub handoff scheme allow-list", () => {
  it("accepts every per-channel scheme", () => {
    for (const scheme of CHANNEL_SCHEMES) {
      assert.equal(
        validHandoff({ scheme, nonce: OK_TOKEN, challenge: OK_TOKEN }),
        true,
        `${scheme} should be accepted`,
      );
    }
  });

  // The regression this change fixes: without zeros-alpha the hub dropped the
  // handoff, hasHandoff went false, and the page rendered the no-button variant.
  it("accepts zeros-alpha (regression: Alpha had no Launch button)", () => {
    assert.equal(
      validHandoff({
        scheme: "zeros-alpha",
        nonce: OK_TOKEN,
        challenge: OK_TOKEN,
      }),
      true,
    );
  });

  it("rejects a foreign / unknown scheme even with valid tokens", () => {
    for (const scheme of [
      "zeros-evil",
      "javascript",
      "http",
      "",
      "ZEROS",
      "zeros-alpha-evil",
    ]) {
      assert.equal(
        validHandoff({ scheme, nonce: OK_TOKEN, challenge: OK_TOKEN }),
        false,
        `${scheme} should be rejected`,
      );
    }
  });

  it("rejects an allow-listed scheme with a non-tokenish nonce/challenge", () => {
    assert.equal(
      validHandoff({
        scheme: "zeros-alpha",
        nonce: "has space",
        challenge: OK_TOKEN,
      }),
      false,
    );
    assert.equal(
      validHandoff({ scheme: "zeros-beta", nonce: OK_TOKEN, challenge: "a/b" }),
      false,
    );
  });
});

describe("invite page scheme selection", () => {
  it("binds hosted invite pages to their deployment channel", () => {
    assert.equal(
      schemeForDeploymentEnvironment("alpha", "zeros"),
      "zeros-alpha",
    );
    assert.equal(
      schemeForDeploymentEnvironment("beta", "zeros-alpha"),
      "zeros-beta",
    );
    assert.equal(
      schemeForDeploymentEnvironment("production", "zeros-dev"),
      "zeros",
    );
  });

  it("uses the allow-listed request only outside a hosted deployment", () => {
    assert.equal(
      schemeForDeploymentEnvironment(undefined, "zeros-dev"),
      "zeros-dev",
    );
    assert.equal(
      schemeForDeploymentEnvironment(undefined, "javascript"),
      "zeros",
    );
  });

  it("fails closed for an unknown hosted deployment environment", () => {
    for (const environment of ["staging", "constructor", "toString"]) {
      assert.throws(
        () => schemeForDeploymentEnvironment(environment, "zeros-alpha"),
        /ZEROS_DEPLOY_ENV/,
      );
    }
  });

  it("passes through every per-channel scheme", () => {
    for (const scheme of CHANNEL_SCHEMES) {
      assert.equal(schemeOrDefault(scheme), scheme);
    }
  });

  // The regression this change fixes: zeros-alpha fell through to zeros://, so an
  // Alpha invite opened the Production app against the wrong data dir.
  it("keeps zeros-alpha (regression: Alpha invites opened Production)", () => {
    assert.equal(schemeOrDefault("zeros-alpha"), "zeros-alpha");
  });

  it("falls back to zeros:// for an unknown scheme (no open redirect)", () => {
    for (const scheme of ["zeros-evil", "javascript", "", "zeros-alpha-evil"]) {
      assert.equal(schemeOrDefault(scheme), "zeros");
    }
  });
});
