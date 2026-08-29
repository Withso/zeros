import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { renderInvitationPage } from "./invite-page.mjs";

const TOKEN = "A".repeat(43);

function webScript(page) {
  const match = page.html.match(
    /<script nonce="testnonce">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, "expected the invitation page to contain its bounded script");
  return match[1];
}

function testElement() {
  const classes = new Set(["hidden"]);
  return {
    addEventListener() {},
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
    },
    textContent: "",
  };
}

async function runWebScript(page, storage) {
  const elements = new Map([
    ["message", testElement()],
    ["retry", testElement()],
    ["another", testElement()],
  ]);
  const replacements = [];
  const result = vm.runInNewContext(webScript(page), {
    document: {
      getElementById: (id) => elements.get(id),
    },
    fetch: async () => ({ status: 401 }),
    history: { replaceState() {} },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, value),
    },
    window: {
      location: {
        replace: (value) => replacements.push(value),
      },
    },
  });
  await result;
  return { elements, replacements };
}

test("the invitation landing page offers exact-channel desktop and explicit web acceptance", () => {
  const page = renderInvitationPage({
    token: TOKEN,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "landing",
    nonce: "testnonce",
  });

  assert.match(page.html, new RegExp(`zeros-alpha://invite\\?token=${TOKEN}`));
  assert.match(page.html, new RegExp(`/invite\\?token=${TOKEN}&amp;mode=web`));
  assert.doesNotMatch(page.html, /\/api\/v1\/invitations\/accept/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /script-src 'nonce-testnonce'/,
  );
});

test("web mode accepts only through the authenticated same-origin JSON facade", () => {
  const page = renderInvitationPage({
    token: TOKEN,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "web",
    nonce: "testnonce",
  });

  assert.match(page.html, /fetch\("\/api\/v1\/invitations\/accept"/);
  assert.match(page.html, /"X-Zeros-Request":"dashboard"/);
  assert.match(page.html, /credentials:"same-origin"/);
  assert.match(
    page.html,
    new RegExp(`/auth/start\\?return=${encodeURIComponent("/invite?mode=resume")}`),
  );
  assert.match(page.html, /sessionStorage\.setItem/);
  assert.doesNotMatch(
    page.html,
    new RegExp(`/auth/start[^"']*${TOKEN}`),
  );
  assert.match(page.html, /response\.status === 401/);
  assert.match(page.html, /wrong_account/);
  assert.doesNotMatch(page.html, /error\.message|response\.text/);
});

test("the post-AuthKit resume page recovers only the tab-scoped invitation", () => {
  const page = renderInvitationPage({
    token: "",
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "resume",
    nonce: "testnonce",
  });

  assert.match(page.html, /sessionStorage\.getItem/);
  assert.match(page.html, /Invitation session expired/);
  assert.doesNotMatch(page.html, /invite link is incomplete/i);
  assert.doesNotMatch(page.html, new RegExp(TOKEN));
});

test("a rejected post-AuthKit session stops after one authentication attempt", async () => {
  const storage = new Map();
  const initial = renderInvitationPage({
    token: TOKEN,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "web",
    nonce: "testnonce",
  });
  const firstAttempt = await runWebScript(initial, storage);

  assert.equal(firstAttempt.replacements.length, 1);
  assert.equal(storage.get("zeros:invitation:auth-attempted"), "1");

  const resume = renderInvitationPage({
    token: "",
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "resume",
    nonce: "testnonce",
  });
  const rejectedResume = await runWebScript(resume, storage);

  assert.deepEqual(rejectedResume.replacements, []);
  assert.equal(
    rejectedResume.elements.get("message").textContent,
    "Sign-in did not establish a Zeros session. Open the original invitation email and try again.",
  );
});

test("invalid tokens never enter script or deep-link output", () => {
  const page = renderInvitationPage({
    token: `bad"</script><script>alert(1)</script>`,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "web",
    nonce: "testnonce",
  });

  assert.match(page.html, /invite link is incomplete/i);
  assert.doesNotMatch(page.html, /alert\(1\)|\/api\/v1\/invitations\/accept/);
});
