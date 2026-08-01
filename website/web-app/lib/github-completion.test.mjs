import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GITHUB_COMPLETION_ERRORS,
  GITHUB_COMPLETION_SCHEMES,
  parseGithubCompletionFragment,
} from "./github-completion.mjs";

const NONCE = "n".repeat(43);

describe("GitHub browser completion handoff", () => {
  it("builds an exact-channel Open Zeros deep link", () => {
    for (const scheme of GITHUB_COMPLETION_SCHEMES) {
      const parsed = parseGithubCompletionFragment(
        `#scheme=${scheme}&nonce=${NONCE}`,
        GITHUB_COMPLETION_SCHEMES,
        GITHUB_COMPLETION_ERRORS,
      );

      assert.deepEqual(parsed, {
        kind: "connected",
        deepLink: `${scheme}://github/connected#nonce=${NONCE}`,
      });
    }
  });

  it("carries a fixed callback error back to the waiting desktop", () => {
    const parsed = parseGithubCompletionFragment(
      `#scheme=zeros&nonce=${NONCE}&error=access_denied`,
      GITHUB_COMPLETION_SCHEMES,
      GITHUB_COMPLETION_ERRORS,
    );

    assert.deepEqual(parsed, {
      kind: "error",
      error: "access_denied",
      deepLink:
        `zeros://github/connected#nonce=${NONCE}&error=access_denied`,
    });
  });

  it("rejects foreign schemes, malformed nonces, and invented errors", () => {
    for (const fragment of [
      `#scheme=javascript&nonce=${NONCE}`,
      "#scheme=zeros&nonce=short",
      `#scheme=zeros&nonce=${NONCE}&error=made_up`,
      "",
    ]) {
      assert.deepEqual(
        parseGithubCompletionFragment(
          fragment,
          GITHUB_COMPLETION_SCHEMES,
          GITHUB_COMPLETION_ERRORS,
        ),
        { kind: "invalid" },
      );
    }
  });
});
