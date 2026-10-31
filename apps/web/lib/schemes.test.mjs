/**
 * Unit tests for the desktop deep-link scheme allow-list used by desktop sign-in
 * (lib/workos-desktop-authorization.mjs), GitHub connection completion
 * (lib/github-completion.mjs) and the invite page (functions/invite.ts).
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

// Every value schemeForChannel() can return. Kept honest against the desktop by
// scripts/check-deep-link-schemes.mjs.
const CHANNEL_SCHEMES = ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"];

describe("scheme allow-list", () => {
  it("contains exactly the four channel schemes — no more, no fewer", () => {
    assert.deepEqual([...SCHEMES].sort(), [...CHANNEL_SCHEMES].sort());
  });

  it("defaults to the packaged app's scheme", () => {
    assert.equal(DEFAULT_SCHEME, "zeros");
  });
});

describe("foreign schemes", () => {
  it("rejects every scheme no release channel registers", () => {
    for (const scheme of ["zeros-evil", "javascript", "http", "", "ZEROS", "zeros-alpha-evil"]) {
      assert.equal(SCHEMES.has(scheme), false, `${scheme} should be rejected`);
    }
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
