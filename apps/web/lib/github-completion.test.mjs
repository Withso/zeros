import vm from "node:vm";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  armGithubCompletionExpiry,
  GITHUB_COMPLETION_ERRORS,
  GITHUB_COMPLETION_LINK_TTL_MS,
  GITHUB_COMPLETION_SCHEMES,
  parseGithubCompletionFragment,
  githubCompletionPage,
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
        scheme,
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
      scheme: "zeros",
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
        scheme: "zeros",
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
    assert.equal(open.href, "zeros://");
    assert.equal(open.hidden, false);
    assert.equal(title.textContent, "This GitHub handoff expired");
    assert.equal(sub.textContent, "In Zeros, open Settings › Integrations and connect again.");
    assert.equal(msg.textContent, "");
  });
});

describe("GitHub connection page", () => {
  it("checks the handoff, then names each outcome with Open Zeros", () => {
    const page = githubCompletionPage("zeros-alpha://");

    assert.match(page, /<div class="title" id="github-title">Finish GitHub connection<\/div>/);
    assert.match(page, /<div class="sub" id="github-sub">Checking the secure GitHub handoff\. This takes a moment\.<\/div>/);
    assert.match(page, /<div class="acts"><a class="btn" id="github-open" hidden>Open Zeros<\/a><\/div>/);
    for (const copy of [
      '"This GitHub link is incomplete"',
      '"In Zeros, open Settings › Integrations and connect again."',
      'open.href = "zeros-alpha://"',
      '"GitHub connection canceled"',
      '"Nothing was connected. Return to Zeros to try again."',
      '"GitHub couldn’t connect"',
      '"Open Zeros to see what went wrong and try again."',
      '"Open Zeros to finish linking GitHub on this Mac."',
      '"Opening Zeros… You can close this tab."',
    ]) {
      assert.ok(page.includes(copy), copy);
    }
    assert.doesNotMatch(page, /<img /);
  });

  it("shows the 16px loader only until the page has named the outcome", () => {
    const page = githubCompletionPage("zeros-alpha://");
    assert.match(page, /<div class="sub" id="github-sub">[^<]*<\/div>\s*<div class="spin" id="github-spin"><span class="orb" aria-hidden="true"><\/span><\/div>/);
    const open = page.indexOf("<script>") + "<script>".length;
    const script = page.slice(open, page.indexOf("</script>", open));
    const nonce = "n".repeat(32);
    for (const hash of ["", `#scheme=zeros-alpha&nonce=${nonce}`, `#scheme=zeros-alpha&nonce=${nonce}&error=access_denied`]) {
      const elements = new Map(["github-title", "github-sub", "github-spin", "github-open", "github-msg"].map((id) => [
        id, { textContent: "", className: "", href: "", hidden: false, addEventListener() {} },
      ]));
      vm.runInNewContext(script, {
        URLSearchParams,
        window: { location: { hash, pathname: "/github/connected" }, addEventListener() {} },
        history: { replaceState() {} },
        document: { getElementById: (id) => elements.get(id) },
        setTimeout() {},
      });
      assert.equal(elements.get("github-spin").hidden, true, hash || "no fragment");
      assert.equal(elements.get("github-open").hidden, false, hash || "no fragment");
    }
  });

  it("shows Turn on JavaScript when scripts are off", () => {
    const page = githubCompletionPage("zeros://");

    assert.match(page, /<noscript><style>#github-live \{ display: none; \}<\/style><\/noscript>/);
    assert.match(
      page,
      /<noscript><div class="title">Turn on JavaScript<\/div><div class="sub">Enable JavaScript to finish connecting GitHub\.<\/div><\/noscript>/,
    );
  });
});
