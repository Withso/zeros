import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  armGithubCompletionExpiry,
  GITHUB_COMPLETION_ERRORS,
  GITHUB_COMPLETION_LINK_TTL_MS,
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
      deepLink: `zeros://github/connected#nonce=${NONCE}&error=access_denied`,
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

  it("remains self-contained when embedded into the browser page", () => {
    const revived = Function(
      `"use strict"; return (${parseGithubCompletionFragment.toString()});`,
    )();

    assert.deepEqual(
      revived(
        `#scheme=zeros&nonce=${NONCE}`,
        GITHUB_COMPLETION_SCHEMES,
        GITHUB_COMPLETION_ERRORS,
      ),
      {
        kind: "connected",
        deepLink: `zeros://github/connected#nonce=${NONCE}`,
      },
    );
  });

  it("removes an abandoned nonce-bearing link after one minute", () => {
    const parsed = parseGithubCompletionFragment(
      `#scheme=zeros&nonce=${NONCE}`,
      GITHUB_COMPLETION_SCHEMES,
      GITHUB_COMPLETION_ERRORS,
    );
    const title = { textContent: "GitHub connected" };
    const sub = { textContent: "Open Zeros to finish linking GitHub." };
    const msg = { textContent: "" };
    const open = {
      hidden: false,
      href: parsed.deepLink,
      removeAttribute(name) {
        delete this[name];
      },
    };
    let scheduled;

    const revivedArmExpiry = Function(
      `"use strict"; return (${armGithubCompletionExpiry.toString()});`,
    )();
    const expire = revivedArmExpiry(
      parsed,
      { title, sub, open, msg },
      (callback, delayMs) => {
        scheduled = { callback, delayMs };
      },
      GITHUB_COMPLETION_LINK_TTL_MS,
    );

    assert.equal(scheduled.delayMs, 60_000);
    assert.equal(typeof expire, "function");
    scheduled.callback();
    assert.equal(parsed.deepLink, "");
    assert.equal("href" in open, false);
    assert.equal(open.hidden, true);
    assert.equal(title.textContent, "This GitHub handoff has expired");
    assert.match(sub.textContent, /start the connection again/);
    assert.equal(msg.textContent, "");
  });
});
